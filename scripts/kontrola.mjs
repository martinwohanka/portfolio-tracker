/**
 * Rychlá kontrola aplikace před nasazením.
 *
 * Aplikace se na web nahrává automaticky, takže překlep v JavaScriptu by se
 * jinak projevil až bílou stránkou. Tahle kontrola ověří, že se hlavní
 * skript v index.html vůbec přeloží a že v souboru nezůstal servisní klíč.
 *
 * Spuštění:  node scripts/kontrola.mjs
 */
import { readFileSync } from 'node:fs';

const FILE = 'web/index.html';
const html = readFileSync(FILE, 'utf8');
const problems = [];

// 1) hlavní JavaScript (poslední inline <script> bez src) se musí přeložit
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const main = scripts.sort((a, b) => b[1].length - a[1].length)[0];
if (!main) {
  problems.push('V souboru chybí hlavní inline <script>.');
} else {
  try {
    new Function(main[1]);
  } catch (error) {
    problems.push(`Chyba v JavaScriptu: ${error.message}`);
  }
}

// 2) do prohlížeče nesmí servisní klíč
if (/service_role|sb_secret_/.test(html)) {
  problems.push('V souboru je servisní klíč Supabase – ten do prohlížeče nepatří.');
}

if (problems.length) {
  console.error(`✖ ${FILE}`);
  problems.forEach((p) => console.error('  ' + p));
  process.exit(1);
}
console.log(`✔ ${FILE} je v pořádku.`);
