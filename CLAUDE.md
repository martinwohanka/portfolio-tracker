# Portfolio Tracker — pokyny pro Claude

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

## Kontrola po každé změně

Po nasazení každé změny `web/index.html` je potřeba:

1. **Ověřit na ostrém webu** — `https://portfolio.wohanka.online` musí opravdu
   servírovat novou verzi (zkontrolovat `FOOTER_VERSION` a konkrétní změnu
   v HTML). Hosting má edge cache na 5 minut, takže je nutný cache-busting
   parametr, např. `curl -s "https://portfolio.wohanka.online/?v=$(date +%s%N)"`.
   Úspěšný běh GitHub Actions sám o sobě nestačí.
2. **Zkontrolovat zobrazení na mobilu** — appku používám hlavně na iPhonu.
   Ověřovat na šířkách 390 px (běžný iPhone) a 430 px (Pro Max), a to
   v tmavém i světlém režimu. Nic se nesmí ořezávat ani vodorovně scrollovat.
   Na kontrolu se hodí Playwright (Chromium je v prostředí předinstalovaný).
