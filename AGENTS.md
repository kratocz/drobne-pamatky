# AGENTS.md

Pokyny pro AI kódovací agenty pracující v tomto repozitáři (Claude Code, Cursor, Aider, Copilot, …).

## Project overview

Statická archivační verze webu [drobnepamatky.cz](https://www.drobnepamatky.cz/) – komunitní databáze drobných sakrálních a profánních památek v ČR. Hostováno na GitHub Pages, data v GeoJSON, mapa pomocí Leaflet + Leaflet.markercluster.

Dlouhodobá vize: stát se veřejným frontendem původního webu – data periodicky exportovaná z Drupalu na VPS sem do statického repa.

## Setup

Žádné závislosti k instalaci – všechny knihovny (Leaflet, markercluster) se načítají z CDN přes `unpkg.com` v `index.html`.

## Run / build / test

- **Run lokálně:** `python3 -m http.server 8000` nebo `npx serve .`, pak otevřít `http://localhost:8000`
- **Build:** žádný (čistě statické soubory)
- **Test:** zatím žádné

## Struktura

```
.
├── index.html          # vstupní stránka s mapou
├── src/                # JS moduly (vanilla JS, bez bundleru)
├── assets/             # CSS, statické soubory
├── data/               # GeoJSON s body památek
└── LICENSE             # MIT (kód); data dle licence drobnepamatky.cz
```

## Conventions

- Vanilla JS, bez build toolingu a bez frameworku – udržet to lehké a dlouhodobě udržovatelné bez závislosti na npm ekosystému.
- Knihovny třetích stran načítat z CDN (s `integrity` + `crossorigin` atributy, jak je to u Leafletu v `index.html`).
- Velké datové dumpy (`*.sql`, `*.sql.gz`) a `.env` soubory necommitovat – jsou v `.gitignore`.
- Commit messages: konvenční prefix (`docs:`, `feat:`, `fix:`, `chore:` …) + krátký český popis (viz git log).
