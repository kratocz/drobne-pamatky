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
- **DB:** Drupal 6, DB `gk66` v kontejneru `www_mysql_1`, mapováno na hostu na `127.0.0.1:3306`
- **DB credentials (zdroj pravdy):** `/www/drobnepamatky.cz/www/sites/default/settings.php` (proměnná `$db_url`)
- **DB credentials (lokálně cache):** soubor `.env` v rootu projektu (necommitovaný, `chmod 600`, viz `.gitignore`). Klíče: `OLD_DB_HOST`, `OLD_DB_PORT`, `OLD_DB_USER`, `OLD_DB_PASSWORD`, `OLD_DB_NAME`.
- **Přístup k DB zvenčí:** přes SSH tunel:
  ```bash
  ssh -L 3307:127.0.0.1:3306 root@drobnepamatky.cz
  # v jiném terminálu lokálně (proměnné z .env):
  set -a; source .env; set +a
  mysql -h 127.0.0.1 -P "$OLD_DB_PORT" -u "$OLD_DB_USER" -p"$OLD_DB_PASSWORD" "$OLD_DB_NAME"
  ```

> **Pravidlo:** Z původního webu pouze čteme (export dat → GeoJSON do `data/`). Veškeré úpravy obsahu probíhají přes Drupal admin na původním webu, ne odsud.
