# Portfolio Tracker

Sledování akciového (a krypto) portfolia napříč brokery — hodnota, vývoj,
realizované zisky, alokace a daňový podklad pro ČR. Běží na mobilu i na
počítači, instalovat není potřeba nic.

Celá aplikace je **jeden soubor** [`web/index.html`](web/index.html) nad
databází Supabase. Nasazuje se prostým nahráním na webhosting.

```
web/index.html                        aplikace (jediný soubor, který jde na web)
scripts/kontrola.mjs                  kontrola souboru před nasazením
.github/workflows/deploy-ftp.yml      automatické nahrání na FTP při push
```

## Co aplikace umí

| | |
| --- | --- |
| Přístup | mobil i počítač, světlý i tmavý režim, na iPhonu lze přidat na plochu |
| Účty | přihlášení e-mailem (magic link nebo kód), bez hesla; přístup jen pro povolené e-maily, správa přímo v appce |
| Brokeři | import CSV/XLSX výpisu z XTB, Revolut, Conseq, Degiro, Interactive Brokers, Trading 212, Revolut crypto a Freedom 24 |
| Přehled | hodnota portfolia v čase, zisk (celkově i dnes), graf s výběrem období a porovnáním vůči vloženým prostředkům |
| Pozice | aktuální držené tituly, ceny přes Yahoo Finance, P/E, denní pohyb vč. pre/after-marketu |
| Watchlist | sledované tituly bez nákupu, cílové ceny s upozorněním, sdílení watchlistu mezi uživateli |
| Alokace | podle titulu, měny, sektoru, brokera i země |
| Daně (ČR) | podklad pro §10 (realizované prodeje, FIFO, časový test 3 roky, limit 100 000 Kč) a §8 (dividendy) — export XLSX/PDF |

Aplikace je čistě klientská (statický HTML + JS), data i logika běží nad
Supabase (auth, databáze, edge function jako proxy na Yahoo Finance).

## Vývoj

Soubor `web/index.html` jde otevřít i lokálně, ale kvůli načítání knihovny
Supabase ne dvojklikem z Finderu/Průzkumníka — je potřeba přes lokální server:

```bash
python3 -m http.server 4000 --directory web
# a otevřít http://localhost:4000
```

Bez platné Supabase konfigurace (`CONFIG` na začátku skriptu) appka zobrazí
upozornění a nenačte žádná data.

## Úpravy a nasazení

1. Upravte `web/index.html`.
2. Ověřte: `node scripts/kontrola.mjs` (ohlídá překlepy v JavaScriptu a to,
   že v souboru nezůstal servisní klíč Supabase).
3. `git push` — GitHub soubor sám nahraje na FTP (po jednorázovém nastavení
   níže).

### Automatické nasazení na FTP

V repozitáři je připravený workflow `.github/workflows/deploy-ftp.yml`. Po
každé změně `web/index.html` ho GitHub sám nahraje na FTP.

Jednorázové nastavení v GitHubu, **Settings → Secrets and variables → Actions**:

| Záložka | Název | Hodnota |
| --- | --- | --- |
| Secrets | `FTP_SERVER` | adresa FTP serveru, např. `ftp.gjk.cz` |
| Secrets | `FTP_USERNAME` | přihlašovací jméno k FTP |
| Secrets | `FTP_PASSWORD` | heslo k FTP |
| Variables | `FTP_DIR` | cílová složka na serveru, např. `./www/portfolio/` |

`FTP_DIR` musí odpovídat složce, kterou webhosting servíruje na zvolené
adrese. Dokud `FTP_SERVER` chybí, workflow doběhne a nahrání jen přeskočí.

## Bezpečnost v kostce

- V souboru je `anon` (publishable) klíč Supabase. Ten **patří** do prohlížeče
  — aplikace ho posílá každému návštěvníkovi. Přístup k datům hlídají RLS
  politiky v Supabase, ne utajení klíče.
- `service_role` klíč do `index.html` nikdy nepatří.
- Přístup mají jen e-maily povolené v administraci appky.
