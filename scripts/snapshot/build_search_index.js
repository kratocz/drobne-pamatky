#!/usr/bin/env node
/**
 * Pre-build MiniSearch index z out/search-data.json (generuje export.py).
 * Vstup: pole {i, n, d, m} per památka.
 * Výstup: out/search-index.json (MiniSearch serialized JSON, klient ho načte přes
 *   MiniSearch.loadJSON()).
 *
 * Spuštění:
 *   cd scripts/snapshot
 *   npm install                 # jen poprvé
 *   node build_search_index.js
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import MiniSearch from "minisearch";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEARCH_DATA = resolve(__dirname, "out/search-data.json");
const SEARCH_INDEX = resolve(__dirname, "out/search-index.json");

const t0 = Date.now();

console.log(`Načítám ${SEARCH_DATA} …`);
const docs = JSON.parse(readFileSync(SEARCH_DATA, "utf-8"));
console.log(`  → ${docs.length} dokumentů`);

// processTerm: lowercase + strip diakritiky (NFD normalize + remove combining marks).
// Aplikuje se PŘI INDEXOVÁNÍ i PŘI SEARCH – garantuje, že 'kriz' najde 'Kříž',
// 'plzen' najde 'Plzeň' atd. Klient v app.js MUSÍ použít identický processor
// (jinak se index a query nesetkají).
const stripDiacritics = (s) =>
  s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

const miniSearch = new MiniSearch({
  idField: "i",
  fields: ["n", "d", "m"],         // hledat v: název, druh, místo
  processTerm: stripDiacritics,
  // storeFields záměrně PRÁZDNÉ – search vrátí jen IDs (nid),
  // klient si dohledá název/druh/místo v master + lookups (už jsou v paměti).
  // Snižuje velikost indexu cca o 30 %.
  searchOptions: {
    boost: { n: 2, m: 1.5 },       // název hlavní, místo střední, druh stejný
    fuzzy: 0.2,
    prefix: true,
    processTerm: stripDiacritics,
  },
});

console.log("Indexuju …");
miniSearch.addAll(docs);

console.log(`Serializuji do ${SEARCH_INDEX} …`);
const serialized = JSON.stringify(miniSearch);
writeFileSync(SEARCH_INDEX, serialized);

// Měření
const sizeRaw = statSync(SEARCH_INDEX).size;
const sizeGz = gzipSync(serialized, { level: 9 }).length;

const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nHotovo za ${dt}s.`);
console.log(`  raw:  ${(sizeRaw / 1024 / 1024).toFixed(2)} MB`);
console.log(`  gzip: ${(sizeGz / 1024 / 1024).toFixed(2)} MB (level 9)`);
console.log(`  ratio: ${((sizeGz / sizeRaw) * 100).toFixed(1)}%`);
