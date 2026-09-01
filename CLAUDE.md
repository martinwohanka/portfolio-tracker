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
