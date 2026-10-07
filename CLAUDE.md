# Fortivio — pokyny pro Claude

Jednosouborová appka `web/index.html` (viz README.md pro popis a nasazení).

## Seznam změn (changelog)

Appka má vlastní changelog viditelný uživatelům — klik na verzi v patičce
(`#footVer`) otevře okno se seznamem změn (`CHANGELOG` v `web/index.html`).

**Při každé úpravě `web/index.html`, která mění chování nebo vzhled appky
(nová funkce, oprava chyby, viditelná úprava UI), je potřeba:**

1. Přidat nový řádek na **začátek** pole `CHANGELOG` (kolem řádku 556) ve tvaru:
   ```js
   {v:"vX.YY", d:"D. M. RRRR", items:["Stručný popis změny", "…"]},
   ```
   - `v` navazuje na poslední `FOOTER_VERSION` o +0.01 (např. `v2.75` → `v2.76`)
   - `d` je dnešní datum ve formátu `D. M. RRRR`
   - `items` — jedna nebo víc vět v minulém/přítomném čase, srozumitelně pro
     uživatele appky (ne technický popis pro vývojáře)
2. Zvýšit `FOOTER_VERSION` (řádek 553) na stejné `vX.YY` a dnešní datum.
3. `APP_VERSION` (řádek 552) je skrytý technický údaj (element `#appVer` má
   `display:none`) — není potřeba ho měnit, pokud o to uživatel výslovně nepožádá.

Změny, které se uživatele appky netýkají (úpravy `README.md`, `CLAUDE.md`,
CI/FTP workflow, `scripts/kontrola.mjs` apod.), do changelogu nepatří.

Před commitem vždy spustit `node scripts/kontrola.mjs`.

## Limit 1 000 řádků v Supabase

Supabase (PostgREST, nastavení „Max rows“) vrátí na jeden dotaz nejvýš 1 000 řádků
— bez chyby, zbytek prostě chybí, i když dotaz má `limit=20000`. Transakce se proto
načítají po stránkách (`loadTx`, od v3.25). Každý nový dotaz na tabulku, která může
přerůst 1 000 řádků, musí stránkovat (`limit` + `offset`, stabilní `order` včetně `id`).

## Přidání nového brokera

Seznam brokerů není jen v appce — tabulka `transactions` v Supabase má na
sloupci `provider` kontrolní pravidlo `transactions_provider_check`, které
povoluje jen vyjmenované hodnoty. **Když se do `PROVIDERS` přidá nový broker,
je nutné rozšířit i tohle pravidlo**, jinak import skončí chybou
`Supabase 400 … violates check constraint "transactions_provider_check"`.

Schéma databáze není v repozitáři a `anon` klíč ho měnit nesmí, takže SQL musí
spustit majitel projektu v Supabase → SQL Editor:

```sql
alter table transactions drop constraint transactions_provider_check;
alter table transactions add constraint transactions_provider_check
  check (provider in ('XTB','REVOLUT','CONSEQ','DEGIRO','IBKR',
                      'TRADING212','REVOLUT_CRYPTO','REVOLUT_ROBO','FREEDOM24'));
```

Ostatní tabulky brokera neomezují — hotovost i pořadí brokerů se ukládají
jako JSON v `user_settings`.

## Sloupec `target_ref` ve watchlistu

Watchlist si ke cílové ceně ukládá i cenu v okamžiku nastavení cíle
(`target_ref`) — podle ní appka pozná, jestli se čeká na růst, nebo pokles.
Když sloupec v databázi chybí, appka uloží jen cíl a směr odhaduje z ceny při
přidání titulu (`added_price`). Sloupec přidá majitel projektu v Supabase → SQL Editor:

```sql
alter table watchlist add column if not exists target_ref numeric;
```

## Sloupec `total_czk` v transakcích

U obchodů z XTB (korunový účet) se ukládá i skutečná částka v Kč z výpisu
(`total_czk`) — obsahuje kurzovou přirážku XTB, takže zisk, vloženo i daňový
podklad sedí s XTB na korunu. Ostatní brokeři a starší řádky bez hodnoty se
přepočítávají kurzem ECB. Opakovaný import XTB výpisu hodnotu doplní i ke
stávajícím řádkům. Bez sloupce appka funguje dál, jen s kurzy ECB:

```sql
alter table transactions add column if not exists total_czk numeric;
```

## Sloupec `wht` v transakcích

Sražená daň z dividendy (withholding tax) ve stejné měně jako `total`. U XTB se
bere z řádků „Withholding tax“ výpisu, u Revolutu z výkazu zisků a ztrát
(trading-pnl-statement), který zároveň přepíše dividendy z výpisu obchodů
(ty jsou po zdanění) na hrubé částky. Zisk počítá s dividendou po zdanění,
daňový podklad s hrubou částkou a sraženou daní. Bez sloupce se výkaz Revolutu
nepoužije:

```sql
alter table transactions add column if not exists wht numeric;
```

## Upozornění na pohyb cen (Web Push)

Notifikace neposílá appka, ale serverová funkce Supabase
`supabase/functions/price-alerts/index.ts` (Edge Function `price-alerts`), kterou
každých 5 minut volá pg_cron. Funkce stahuje ceny přímo z Yahoo (ne přes proxy
`yahoo`, aby nespotřebovávala volání funkcí), porovná je se včerejším závěrem
a pošle notifikaci, když pohyb překročí práh. Tabulka `alert_log` hlídá, aby se
titul za den ohlásil jen jednou na každé úrovni.

- Appka (`web/index.html`, sekce UPOZORNĚNÍ) jen přihlásí zařízení k odběru
  (`push_subs`), ukládá nastavení a **seznam držených titulů s počty kusů**
  (`alert_settings.holdings`) — server transakce nepočítá. Seznam se aktualizuje
  po každém načtení dat.
- Výběr brokerů (od v3.23) je jen v appce: `alert_settings.providers` (jsonb pole,
  `null` = všichni včetně budoucích) určuje, z jakých brokerů appka počítá
  `holdings` — server o brokerech neví a nemění se. Bez sloupce appka uloží zbytek
  nastavení a výběr brokerů ukáže jako nedostupný (v produkci sloupec už je,
  spuštěno 1. 10. 2026, výběr ověřen na iPhonu):
  ```sql
  alter table alert_settings add column if not exists providers jsonb;
  ```
- `web/sw.js` je service worker jen pro notifikace, **nic necachuje** (kvůli
  `.htaccess` no-cache a okamžitým novým verzím). Nepřidávat do něj `fetch` handler.
- Na iPhonu push funguje jen v appce přidané na plochu s `web/manifest.json`.
- Klíče VAPID si funkce vytvoří sama a uloží do `push_config` (spolu s heslem pro
  cron) — do repozitáře ani do appky nepatří. Servisní klíč má funkce v prostředí
  Supabase automaticky.
- Změna funkce: upravit `index.ts` a majitel ji znovu nasadí v Supabase →
  Edge Functions → price-alerts → Code (Cmd+A, vložit celý soubor → Deploy).
  Kód kopírovat tlačítkem **Copy raw file** na GitHubu — při kopírování
  z náhledu souboru se konec ztratil a nasazení skončilo chybou „Unexpected eof“.
  Zkontrolovat, že vložený kód končí `});` a má stejný počet řádků jako soubor.
- Lokální test: Deno (`npx -y deno@2`) s podvrženým Supabase a push serverem.

**Stav: nasazeno a funguje (od v3.22, 1. 10. 2026).** Funkce `price-alerts`
je v Supabase nasazená, `supabase/upozorneni.sql` je spuštěné (tabulky + cron
`fortivio-upozorneni` každých 5 minut) a zkušební notifikace na iPhone (appka
z plochy) dorazila. Při novém projektu by se postup opakoval: nasadit funkci
a spustit SQL (místo `<ANON_KEY>` veřejný klíč z `CONFIG`).

Ověření, že funkce běží (bez přihlášení jde jen tohle — `test` a `run` chtějí
uživatele, resp. heslo cronu z `push_config`):

```sh
curl -s -X POST https://gqzkhvdnnndtvyvxmctx.supabase.co/functions/v1/price-alerts \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H 'content-type: application/json' -d '{"action":"vapid"}'   # → {"key":"B…"}
```

Pokud odpověď obsahuje `"source":"@supabase/server"`, běží v Supabase výchozí
šablona funkce místo `index.ts` — je potřeba kód znovu vložit a nasadit.
Jestli běží cron, ukáže Supabase → Edge Functions → price-alerts → Logs
(volání každých 5 minut se stavem 200).

## Import zkratkou z iPhonu (schránka)

Od v3.28. Zkratka „Do Fortivia“ v listu sdílení pošle soubor výpisu beze změny
(`Content-Type: application/octet-stream`) na `/rest/v1/rpc/inbox_upload` s hlavičkami
`apikey` (veřejný klíč) a `x-import-token`. SQL funkce (`supabase/import-zkratka.sql`,
security definer) ověří otisk klíče v `import_tokens` a uloží soubor do `import_inbox`.
Appka (sekce IMPORT ZKRATKOU) při startu a po návratu do popředí zavolá `checkInbox()`:
řádek nejdřív „zabere“ (PATCH `processed_at` jen když je null — kvůli dvěma zařízením),
pak ho naimportuje **stejným kódem jako ruční import** (`handleFiles(…, {auto:true})`
+ `doImport({auto:true})`) a uloží výsledek do `result`, obsah smaže.

- Parsování výpisů je jen v appce — server nic neparsuje, nic se nezdvojuje.
- V databázi je jen SHA-256 otisk klíče; klíč si appka pamatuje v `localStorage`
  zařízení, kde vznikl (aby šel znovu zkopírovat). Nový klíč starý zneplatní.
- Bez tabulek sekce v Nastavení napíše, že je potřeba spustit SQL, a schránka se nekontroluje.

## Kontrola po každé změně

Po nasazení každé změny `web/index.html` je potřeba:

1. **Ověřit na ostrém webu** — `https://portfolio.wohanka.online` musí opravdu
   servírovat novou verzi (zkontrolovat `FOOTER_VERSION` a konkrétní změnu
   v HTML). `web/.htaccess` posílá pro HTML `Cache-Control: no-cache`, takže CDN
   WEDOS stránku necachuje a prohlížeč ji vždy ověří (ETag → 304). Pro jistotu
   ověřuj s cache-busting parametrem, např.
   `curl -s "https://portfolio.wohanka.online/?v=$(date +%s%N)"`.
   Úspěšný běh GitHub Actions sám o sobě nestačí. `.htaccess` nesmazat — bez něj
   hosting drží HTML 5 minut a prohlížeč ukazuje starou verzi až hodinu.
2. **Zkontrolovat zobrazení na mobilu** — appku používám hlavně na iPhonu.
   Ověřovat na šířkách 390 px (běžný iPhone) a 430 px (Pro Max), a to
   v tmavém i světlém režimu. Nic se nesmí ořezávat ani vodorovně scrollovat.
   Na kontrolu se hodí Playwright (Chromium je v prostředí předinstalovaný).
