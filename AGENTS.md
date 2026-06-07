# AGENTS.md

Pokyny pro AI kódovací agenty pracující v tomto repozitáři (Claude Code, Cursor, Aider, Copilot, …).

## Project overview

Statická archivační verze webu [drobnepamatky.cz](https://www.drobnepamatky.cz/) – komunitní databáze drobných sakrálních a profánních památek v ČR. Hostováno na GitHub Pages, data v GeoJSON, mapa pomocí Leaflet + Leaflet.glify (WebGL renderer, který kreslí všech ~81k bodů najednou bez clusteringu).

Dlouhodobá vize: stát se veřejným frontendem původního webu – data periodicky exportovaná z Drupalu na VPS sem do statického repa.

## Setup

Žádné závislosti k instalaci pro běh webu – všechny knihovny (Leaflet, Leaflet.glify, MiniSearch) se načítají z CDN přes `unpkg.com` / `cdn.jsdelivr.net` v `index.html`. Build pipeline pro export dat má vlastní závislosti v `scripts/snapshot/`:
- **Python (export.py, build_thumbnails.py):** `uv` ([install](https://docs.astral.sh/uv/getting-started/installation/)). První spuštění: `cd scripts/snapshot && uv sync` (vytvoří `.venv/` z `pyproject.toml` + `uv.lock`). Skripty pouštět přes `uv run python <skript>.py`.
- **Node (build_search_index.js):** `cd scripts/snapshot && npm install` (vlastní `package.json`).

## Rendering pipeline

- `data/pamatky.geojson` se načte jednorázově (`fetch` + `JSON.parse`).
- Features se převedou do TypedArrays (`coords` Float32Array, `katIdx` Uint8Array, `nids` Int32Array, `names` Array<string>) – heap ~6 MB místo ~80 MB pro 81k Leaflet markerů.
- Pole `[[lat, lng], …]` je předáno do `L.glify.points()`, který renderuje přes WebGL canvas v leaflet `overlayPane`.
- `color` callback v glify vrací barvu per bod podle kategorie (z `KAT_COLORS` lookup); search filter to využívá k zešednutí ne-matching bodů.
- Active marker (otevřený detail panel) je samostatný `L.marker` s teardrop DivIconou navrch glify canvasu.

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

## Issue tracker

Úkoly, bugy a návrhy vylepšení jsou vedeny jako **GitHub issues** v tomto repu: https://github.com/kratocz/drobne-pamatky/issues

Žádný `TODO.md` v repu nevedeme – issues jsou jediný zdroj pravdy pro stav prací.

- Před začátkem nové práce projít otevřené issues (`gh issue list`) a pokud k tématu existuje, navázat na něj (commit message `fix #N`, `closes #N`).
- Při nálezu nového bugu nebo nápadu založit issue (`gh issue create`), nepouštět se do implementace bez ticketu.
- Acceptance criteria patří do těla issue, ne do kódu ani commitu.

## Starý server (zdroj dat)

Produkční VPS s původním Drupal 6 webem, ze kterého se data periodicky exportují sem.

- **SSH:** `ssh root@drobnepamatky.cz` (ověřeno funkční přes `ssh root@drobnepamatky.cz whoami`)
- **Web root:** `/www/drobnepamatky.cz/www` – **POUZE READ-ONLY!** Nikdy zde nic neměnit.
- **Docker stack:** `/www/docker-compose.yml` – web i DB běží v kontejnerech, řízeno docker-compose
- **DB:** Drupal 6 schéma `gk66` v kontejneru `www_mysql_1` (MySQL **5.5.47**, ~144 tabulek), mapováno na hostu na `127.0.0.1:3306`
- **DB credentials (zdroj pravdy):** `/www/drobnepamatky.cz/www/sites/default/settings.php` (proměnná `$db_url`)
- **DB credentials (lokálně cache):** soubor `.env` v rootu projektu (necommitovaný, `chmod 600`, viz `.gitignore`). Pro bootstrap: `cp .env.example .env && chmod 600 .env` a doplnit hodnoty ze `settings.php`. Klíče: `OLD_DB_HOST`, `OLD_DB_PORT`, `OLD_DB_USER`, `OLD_DB_PASSWORD`, `OLD_DB_NAME`.
- **Přístup k DB zvenčí:** přes SSH tunel. Pohodlnější je tunel na pozadí (`-f -N`), takže příkazy jdou v jednom shellu:
  ```bash
  set -a; source .env; set +a
  ssh -f -N -L "${OLD_DB_PORT}:127.0.0.1:3306" -o ExitOnForwardFailure=yes root@drobnepamatky.cz
  mysql --skip-ssl -h "$OLD_DB_HOST" -P "$OLD_DB_PORT" \
        -u "$OLD_DB_USER" -p"$OLD_DB_PASSWORD" "$OLD_DB_NAME"
  # po skončení práce zavřít tunel:
  pkill -f "ssh.*-L ${OLD_DB_PORT}:127.0.0.1:3306.*drobnepamatky.cz"
  ```
  - `--skip-ssl` je nutné: aktuální MariaDB klient (12.3+) defaultně vynucuje TLS, ale starý MySQL 5.5 ho nepodporuje – jinak končí `ERROR 2026: SSL is required`.
  - Interaktivní varianta (`ssh -L … root@…` v jednom terminálu, `mysql` ve druhém) funguje taky, jen je upovídanější.
- **Snapshot / export DB:** `mysqldump` přes stejný tunel (read-only, žádný dopad na produkci):
  ```bash
  mysqldump --skip-ssl --single-transaction --quick --no-tablespaces \
            -h "$OLD_DB_HOST" -P "$OLD_DB_PORT" \
            -u "$OLD_DB_USER" -p"$OLD_DB_PASSWORD" "$OLD_DB_NAME" \
    | gzip > "gk66-$(date +%F).sql.gz"
  ```
  Výsledné `*.sql.gz` jsou v `.gitignore` (necommitovat – obsahují citlivá data a jsou velké).

> **Pravidlo:** Z původního webu pouze čteme (export dat → GeoJSON do `data/`). Veškeré úpravy obsahu probíhají přes Drupal admin na původním webu, ne odsud.
