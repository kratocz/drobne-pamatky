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

## Starý server (zdroj dat)

Produkční VPS s původním Drupal 6 webem, ze kterého se data periodicky exportují sem.

- **SSH:** `ssh root@drobnepamatky.cz` (ověřeno funkční přes `ssh root@drobnepamatky.cz whoami`)
- **Web root:** `/www/drobnepamatky.cz/www` – **POUZE READ-ONLY!** Nikdy zde nic neměnit.
- **Docker stack:** `/www/docker-compose.yml` – web i DB běží v kontejnerech, řízeno docker-compose
- **DB credentials:** `/www/drobnepamatky.cz/www/sites/default/settings.php` (Drupal `$databases` / `$db_url`)
- **Přístup k DB:** přes SSH tunel, např.:
  ```bash
  ssh -L 3307:127.0.0.1:3306 root@drobnepamatky.cz
  # pak v jiném terminálu lokálně:
  mysql -h 127.0.0.1 -P 3307 -u <user> -p <db>
  ```
  Přesný cílový host/port (lokální vs. docker network) je třeba ověřit v `docker-compose.yml` – pokud DB neposlouchá na `127.0.0.1:3306` hostitele, použít IP nebo název kontejneru jako tunnel target.

> **Pravidlo:** Z původního webu pouze čteme (export dat → GeoJSON do `data/`). Veškeré úpravy obsahu probíhají přes Drupal admin na původním webu, ne odsud.
