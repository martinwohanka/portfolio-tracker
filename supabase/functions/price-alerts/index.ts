// Fortivio — upozornění na pohyb cen (Web Push).
//
// Supabase Edge Function „price-alerts“. Každých 5 minut ji spouští pg_cron
// (viz supabase/upozorneni.sql) a pro každého uživatele se zapnutými
// upozorněními zkontroluje tituly z pozic a watchlistu: když se cena pohne
// proti včerejšímu závěru o víc než nastavený práh (i v pre-marketu
// a after-hours), pošle notifikaci do telefonu. Totéž za celé portfolio.
//
// Každý titul se za den ohlásí jen jednou na každé úrovni (2 %, 4 %, 6 %…),
// pamatuje si to tabulka alert_log.
//
// Akce (POST {action}):
//   vapid — veřejný klíč pro přihlášení k odběru (klíče se vytvoří samy při prvním volání)
//   test  — zkušební notifikace přihlášenému uživateli s přehledem, co se hlídá
//   run   — kontrola pohybů; s hlavičkou x-cron-secret pro všechny, jinak jen pro volajícího
//
// Servisní klíč i soukromý klíč VAPID zůstávají jen na serveru.
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
// servisní klíč: starý (JWT), nebo nový „sb_secret_…“ z SUPABASE_SECRET_KEYS ({"default": "…"})
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || (() => {
  try { return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch (_) { return ""; }
})();
const YAHOO = Deno.env.get("YAHOO_URL") || "https://query1.finance.yahoo.com";
const VAPID_SUBJECT = "https://portfolio.wohanka.online";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------- databáze (PostgREST se servisním klíčem) ---------- */
async function db(path: string, opts: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`db ${path.split("?")[0]} ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const upsert = (table: string, rows: unknown[]) =>
  db(table, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });

type Cfg = { cron_secret: string; vapid_public: string; vapid_private: string };
async function config(): Promise<Cfg> {
  let [c] = await db("push_config?id=eq.1&select=*");
  if (!c) { await upsert("push_config", [{ id: 1 }]); [c] = await db("push_config?id=eq.1&select=*"); }
  if (!c.vapid_public || !c.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    await db("push_config?id=eq.1", { method: "PATCH", body: JSON.stringify({ vapid_public: k.publicKey, vapid_private: k.privateKey }) });
    c = { ...c, vapid_public: k.publicKey, vapid_private: k.privateKey };
  }
  return c;
}

async function authUser(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u.id : null;
}

/* ---------- čas ---------- */
function prague(d = new Date()) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Prague", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d)) p[x.type] = x.value;
  return { wd: p.weekday, min: +p.hour * 60 + +p.minute, date: `${p.year}-${p.month}-${p.day}` };
}
const WORK = ["Mon", "Tue", "Wed", "Thu", "Fri"];
// Hlídá se v pracovní dny od 8:55 (Evropa otevírá v 9:00, americký pre-market v 10:00)
// do 2:10 další noci (konec after-hours v USA). Mimo to cron nic nestahuje.
function inWindow(t = prague()) {
  if (t.min >= 8 * 60 + 55) return WORK.includes(t.wd);
  if (t.min < 2 * 60 + 10) return ["Tue", "Wed", "Thu", "Fri", "Sat"].includes(t.wd);
  return false;
}
// Celé portfolio jen během řádných seancí (9:00–22:30): po půlnoci by se jinak
// včerejší pohyb amerických akcií započítal do nového dne podruhé.
const portfolioWindow = (t = prague()) => WORK.includes(t.wd) && t.min >= 9 * 60 && t.min <= 22 * 60 + 30;

/* ---------- ceny z Yahoo ---------- */
type Quote = {
  sym: string; cur: string; name: string;
  state: "pre" | "open" | "after" | null; // null = teď se neobchoduje
  price: number; ref: number; // aktuální cena a včerejší závěr
  day: string; // obchodní den v čase burzy
  regToday: boolean; regPrice: number; // dnešní řádná seance (pro celé portfolio)
};
async function quote(sym: string, now: number): Promise<Quote | null> {
  try {
    const r = await fetch(`${YAHOO}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m&includePrePost=true`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const res = (await r.json())?.chart?.result?.[0];
    const m = res?.meta;
    const reg = m?.currentTradingPeriod?.regular, pre = m?.currentTradingPeriod?.pre, post = m?.currentTradingPeriod?.post;
    if (!reg || m.regularMarketPrice == null) return null;
    let cur = m.currency || "USD", div = 1;
    if (cur === "GBp" || cur === "GBX") { cur = "GBP"; div = 100; }
    if (cur === "ZAc") { cur = "ZAR"; div = 100; }
    const ts: number[] = res.timestamp || [], cl: (number | null)[] = res.indicators?.quote?.[0]?.close || [];
    const last = (from: number, to: number) => {
      for (let i = ts.length - 1; i >= 0; i--) if (ts[i] >= from && ts[i] < to && cl[i] != null) return cl[i] as number;
      return null;
    };
    // Dnešní seance už začala → previousClose je včerejší závěr. Před otevřením (pre-market)
    // je včerejší závěr přímo regularMarketPrice; previousClose by byl o den starší.
    const regToday = m.regularMarketTime >= reg.start;
    const ref = regToday ? (m.previousClose ?? m.chartPreviousClose) : m.regularMarketPrice;
    let state: Quote["state"] = null, price: number | null = null;
    if (now >= reg.start && now < reg.end) { if (regToday) { state = "open"; price = m.regularMarketPrice; } }
    else if (pre && now >= pre.start && now < pre.end) { price = last(pre.start, reg.start); if (price != null) state = "pre"; }
    else if (post && regToday && now >= post.start && now < post.end) { price = last(post.start, post.end); if (price != null) state = "after"; }
    if (ref == null || !(ref > 0)) return null;
    return {
      sym, cur, name: m.shortName || sym, state,
      price: (price ?? m.regularMarketPrice) / div, ref: ref / div,
      day: new Date(reg.start * 1000).toLocaleDateString("sv-SE", { timeZone: m.exchangeTimezoneName || "UTC" }),
      regToday, regPrice: m.regularMarketPrice / div,
    };
  } catch (_) { return null; }
}
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/* ---------- formát (česky, jako v appce) ---------- */
const nf = (n: number, d: number) =>
  new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: d, maximumFractionDigits: d }).format(Math.abs(n));
const sgn = (n: number) => (n < 0 ? "−" : "+");
const pctS = (n: number) => sgn(n) + nf(n, 1) + " %";
const kc = (n: number) => sgn(n) + nf(n, 0) + " Kč";
const SYM: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CZK: "Kč" };
const pxS = (n: number, c: string) => nf(n, 2) + " " + (SYM[c] || c);
const STATE_LBL = { pre: " v pre-marketu", after: " v after-hours", open: "" };
const titulu = (n: number) => (n === 1 ? "titul" : n > 1 && n < 5 ? "tituly" : "titulů");
const thrS = (t: number) => nf(t, t % 1 ? 1 : 0) + " %";

/* ---------- hlavní kontrola ---------- */
type Settings = {
  user_id: string; threshold: number; portfolio_threshold: number;
  watchlist: boolean; extended: boolean; portfolio: boolean;
  holdings: { s: string; q: number }[];
};
type Msg = { title: string; body: string; tag: string; url: string };

async function evaluate(onlyUser: string | null, opts: { dry?: boolean; ignoreWindow?: boolean } = {}) {
  const t = prague();
  if (!opts.ignoreWindow && !inWindow(t)) return { skipped: "mimo obchodní dobu", users: [] as any[], subs: [] as any[], quotes: 0 };
  const uf = onlyUser ? `&user_id=eq.${onlyUser}` : "";
  const settings: Settings[] = await db(`alert_settings?select=*${uf}`);
  const subs: any[] = await db(`push_subs?select=*${uf}`);
  const users = settings.filter((s) => subs.some((x) => x.user_id === s.user_id));
  if (!users.length) return { users: [] as any[], subs, quotes: 0 };
  const wl: { user_id: string; ticker: string }[] = users.some((s) => s.watchlist)
    ? await db(`watchlist?select=user_id,ticker${uf}`) : [];

  // seznam titulů za všechny uživatele (každý se stahuje jen jednou)
  const want = new Map<string, Set<string>>(); // user -> symboly
  for (const s of users) {
    const set = new Set<string>((s.holdings || []).map((h) => h.s));
    if (s.watchlist) for (const w of wl) if (w.user_id === s.user_id && w.ticker && !w.ticker.startsWith("!")) set.add(w.ticker);
    want.set(s.user_id, set);
  }
  const all = [...new Set([...want.values()].flatMap((x) => [...x]))];
  const now = Date.now() / 1000;
  const Q = new Map<string, Quote>();
  (await pool(all, 8, (s) => quote(s, now))).forEach((q, i) => { if (q) Q.set(all[i], q); });
  // kurzy do Kč pro částky u pozic
  const curs = [...new Set([...Q.values()].map((q) => q.cur).filter((c) => c !== "CZK"))];
  const FX: Record<string, number> = { CZK: 1 };
  await pool(curs, 4, async (c) => { const q = await quote(`${c}CZK=X`, now); if (q) FX[c] = q.regPrice; });

  const since = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const logRows: any[] = await db(`alert_log?select=*&day=gte.${since}${uf}`);
  const LOG = new Map(logRows.map((r) => [`${r.user_id}|${r.ticker}|${r.day}`, r.lvl as number]));
  const isNew = (u: string, k: string, day: string, lvl: number) => {
    const p = LOG.get(`${u}|${k}|${day}`);
    return !p || Math.sign(p) !== Math.sign(lvl) || Math.abs(lvl) > Math.abs(p);
  };

  const report: any[] = [];
  for (const s of users) {
    const u = s.user_id, thr = Math.max(0.5, +s.threshold || 2), pthr = Math.max(0.5, +s.portfolio_threshold || 2);
    const held = new Map((s.holdings || []).map((h) => [h.s, +h.q]));
    const hits: any[] = [], logs: any[] = [], msgs: Msg[] = [];
    const watched = [...(want.get(u) || [])];
    for (const sym of watched) {
      const q = Q.get(sym);
      if (!q || !q.state || (q.state !== "open" && !s.extended)) continue;
      const pct = (q.price / q.ref - 1) * 100, lvl = Math.trunc(pct / thr);
      if (!lvl || !isNew(u, sym, q.day, lvl)) continue;
      const qty = held.get(sym);
      hits.push({ q, pct, czk: qty && FX[q.cur] ? qty * (q.price - q.ref) * FX[q.cur] : null });
      logs.push({ user_id: u, ticker: sym, day: q.day, lvl });
    }
    hits.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    const short = (h: any) => `${h.q.sym} ${pctS(h.pct)}${h.q.state === "pre" ? " (pre)" : h.q.state === "after" ? " (AH)" : ""}`;
    if (hits.length > 3) {
      const n = hits.length;
      msgs.push({
        title: `${n} ${n < 5 ? "tituly se pohnuly" : "titulů se pohnulo"} o víc než ${thrS(thr)}`,
        body: hits.slice(0, 6).map(short).join(", ") + (n > 6 ? " a další" : ""),
        tag: "group", url: "./",
      });
    } else {
      for (const h of hits) msgs.push({
        title: `${h.q.sym} ${pctS(h.pct)}${STATE_LBL[h.q.state as keyof typeof STATE_LBL]}`,
        body: `${pxS(h.q.price, h.q.cur)} · ${h.czk != null ? "pozice " + kc(h.czk) : "watchlist"}`,
        tag: `t:${h.q.sym}`, url: `./?t=${encodeURIComponent(h.q.sym)}`,
      });
    }
    // celé portfolio: jen řádné seance, změna proti včerejším závěrům
    let port: any = null;
    if (s.portfolio && held.size) {
      let base = 0, delta = 0; const contrib: any[] = [];
      for (const [sym, qty] of held) {
        const q = Q.get(sym), fx = q && FX[q.cur];
        if (!q || !fx) continue;
        if (q.regToday) {
          base += qty * q.ref * fx; const d = qty * (q.regPrice - q.ref) * fx; delta += d;
          contrib.push({ sym, d, pct: (q.regPrice / q.ref - 1) * 100 });
        } else base += qty * q.regPrice * fx;
      }
      if (base > 0) {
        const pct = (delta / base) * 100, lvl = Math.trunc(pct / pthr);
        port = { pct: Math.round(pct * 100) / 100, czk: Math.round(delta) };
        if (lvl && portfolioWindow(t) && isNew(u, "_PORTFOLIO", t.date, lvl)) {
          contrib.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
          msgs.push({
            title: `Portfolio dnes ${pctS(pct)}`,
            body: `${kc(delta)} · nejvíc ${contrib.slice(0, 3).map((c) => `${c.sym} ${pctS(c.pct)}`).join(", ")}`,
            tag: "portfolio", url: "./",
          });
          logs.push({ user_id: u, ticker: "_PORTFOLIO", day: t.date, lvl });
        }
      }
    }
    report.push({
      user_id: u, watched: watched.length, priced: watched.filter((x) => Q.has(x)).length,
      live: watched.filter((x) => Q.get(x)?.state).length, portfolio: port, msgs, logs,
      top: watched.map((x) => Q.get(x)).filter((q): q is Quote => !!q && !!q.state)
        .map((q) => ({ sym: q.sym, state: q.state, pct: (q.price / q.ref - 1) * 100 }))
        .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 3),
    });
  }
  return { users: report, subs, quotes: Q.size };
}

/* ---------- odeslání ---------- */
async function send(cfg: Cfg, subs: any[], userId: string, msgs: Msg[]) {
  webpush.setVapidDetails(VAPID_SUBJECT, cfg.vapid_public, cfg.vapid_private);
  let sent = 0;
  for (const sub of subs.filter((x) => x.user_id === userId)) {
    for (const m of msgs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(m), { TTL: 4 * 3600, urgency: "high" });
        sent++;
      } catch (e: any) {
        // odběr už neplatí (appka odebraná z plochy, zakázaná oznámení) → smazat
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await db(`push_subs?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" });
          break;
        }
        console.error("push", e?.statusCode, e?.body || e?.message);
      }
    }
  }
  return sent;
}

async function run(cfg: Cfg, onlyUser: string | null) {
  const r = await evaluate(onlyUser, { ignoreWindow: !!onlyUser });
  let sent = 0;
  for (const u of r.users) {
    if (!u.msgs.length) continue;
    sent += await send(cfg, r.subs, u.user_id, u.msgs);
    if (u.logs.length) await upsert("alert_log", u.logs.map((l: any) => ({ ...l, sent_at: new Date().toISOString() })));
  }
  if (!onlyUser) await db(`alert_log?day=lt.${new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)}`, { method: "DELETE" });
  return { ...r, subs: undefined, sent };
}

async function test(cfg: Cfg, userId: string) {
  const r = await evaluate(userId, { dry: true, ignoreWindow: true });
  const u = r.users[0];
  if (!u) return { sent: 0, error: "Pro tento účet není uložený odběr ani nastavení upozornění." };
  const top = u.top.map((x: any) => `${x.sym} ${pctS(x.pct)}${x.state === "pre" ? " (pre)" : x.state === "after" ? " (AH)" : ""}`).join(", ");
  const msg: Msg = {
    title: "Upozornění fungují ✓",
    body: `Hlídám ${u.watched} ${titulu(u.watched)}.` + (top ? ` Teď nejvíc: ${top}.` : " Trhy jsou teď zavřené.")
      + (u.portfolio ? ` Portfolio dnes ${pctS(u.portfolio.pct)}.` : ""),
    tag: "test", url: "./",
  };
  const sent = await send(cfg, r.subs, userId, [msg]);
  return { sent, watched: u.watched, priced: u.priced, live: u.live, portfolio: u.portfolio, pending: u.msgs };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "run";
    if (!SB_KEY) return json({ error: "Funkci chybí servisní klíč Supabase (SUPABASE_SERVICE_ROLE_KEY)." }, 500);
    const cfg = await config();
    if (action === "vapid") return json({ key: cfg.vapid_public });
    if (action === "run" && req.headers.get("x-cron-secret") === cfg.cron_secret) return json(await run(cfg, null));
    const user = await authUser(req);
    if (!user) return json({ error: "Nepřihlášený uživatel." }, 401);
    if (action === "test") return json(await test(cfg, user));
    if (action === "run") return json(await run(cfg, user));
    return json({ error: "Neznámá akce." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
