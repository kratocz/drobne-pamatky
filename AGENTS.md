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
- **Test:** lightweight skripty v `scripts/snapshot/` (bez frameworku) — `uv run python test_sanitize.py`, `uv run python test_manifest_diff.py`, `uv run python test_build_static_pages.py` a `bash test_inject_beacon.sh`.

## Sync ze zdroje (Drupal 6 → data/)

Aktualizace `data/` z produkční DB + filesystému na `drobnepamatky.cz`:

```bash
bash scripts/sync-from-source.sh            # full sync
bash scripts/sync-from-source.sh --limit 50 # pilot (50 záznamů z DB, ale manifest JPG je vždy celý)
```

Co skript dělá:
1. Pre-flight (env vars, tooling, port 13306 volný)
2. SSH tunel `root@drobnepamatky.cz:3306 → localhost:13306` (auto-cleanup)
3. `export.py` → JSON/GeoJSON do `scripts/snapshot/out/` + `files-manifest.json`
4. `build_search_index.js` → search index
5. `build_static_pages.py` → per-pamatka HTML do `out/pamatka/<nid>-<slug>/` + `sitemap*.xml` + `robots.txt` (čte `CF_BEACON_TOKEN` z env → vloží beacon)
6. `sync_manifest_diff.py` porovná `out/files-manifest.json` s `data/thumbs-manifest.json`
7. `rsync` jen chybějících/změněných JPG z VPS do tmp/
8. `build_thumbnails.py --only` vygeneruje nové thumbs (sips + avifenc, macOS only)
9. Smaže obsolete thumbs ze `data/thumbs/`
10. Zkopíruje `out/*` + nový thumbs-manifest do `data/` a `pamatka/` + `sitemap*.xml` + `robots.txt` do repo rootu

**Skript NEcommituje** — po doběhnutí zkontroluj `git diff data/` a `git status data/`, pak commitni ručně.

**První běh je drahý:** `data/thumbs-manifest.json` startuje jako `{}`, takže první sync stáhne všech ~112 k JPG a vygeneruje všech ~125 k thumbs (řádově hodiny + GB transferu). Následující inkrementální syncs už jsou rychlé (jen diff oproti předchozímu manifestu).

Pro nasazení změn do `gh-pages` po commitu: `bash scripts/deploy.sh`.

## SEO + Search Console (per-pamatka HTML, issue #5)

Statické per-pamatka HTML stránky (`/pamatka/<nid>-<slug>/index.html` × 82k) generuje `scripts/snapshot/build_static_pages.py` v rámci `sync-from-source.sh` (krok `[2b/8]`). Šablony v `scripts/snapshot/templates/`, šable `assets/page.css`. Sitemap rozdělen po 15 krajích/skupinách (14 krajů + `ostatni`) + master index, povolen v `robots.txt`.

**URL struktura na gh-pages:**
- `https://kratocz.github.io/drobne-pamatky/pamatka/<nid>-<slug>/` — statická HTML pro crawlery
- `https://kratocz.github.io/drobne-pamatky/sitemap.xml` — master sitemap index
- `https://kratocz.github.io/drobne-pamatky/sitemap-<kraj>.xml` — per-kraj chunk
- `https://kratocz.github.io/drobne-pamatky/robots.txt`

### Google Search Console setup

Jednorázová ruční operace pro prvotní registraci, dále už se nic nedělá (sitemap je submit-ovaný).

1. https://search.google.com/search-console → **Add property** → URL prefix `https://kratocz.github.io/drobne-pamatky/`
2. Verification method: **HTML file**. Google dá soubor typu `google<hash>.html`.
3. Stáhnout, položit do **repo ROOT** (NE do `data/`): `cp ~/Downloads/google*.html .`
4. Commit + push + `bash scripts/deploy.sh` (deploy.sh už má `for f in $REPO_ROOT/google*.html` glob, vezme to automaticky)
5. Po cca minutě na GSC kliknout **Verify** → "Verified ✓"
6. **Sitemaps** v levém menu → add `sitemap.xml` → Submit
7. **Pages** ukazuje status indexace (prvních pár dní prázdné, pak začnou stránky „Indexed")

Stejný postup funguje pro **Bing Webmaster Tools** — deploy.sh hledá také `BingSiteAuth.xml`.

### Per-pamatka HTML lokální regenerate

Bez SSH tunelu / DB (jen z existujícího exportu v `data/details/`):

```bash
cd scripts/snapshot
# Připravit input pro pilot (kopie z existing data):
mkdir -p out/details && cp ../../data/details/*.json out/details/ && cp ../../data/lookups.json out/
# Build
uv run python build_static_pages.py            # full 82k
uv run python build_static_pages.py --limit 50 # pilot
```

## Gotchas a implementační poznámky

Krátký seznam ne-očekávaných věcí, na které jsme narazili a které zaslouží vědomí před tím, než se na ně narazí znovu.

### URL struktura na GitHub Pages = 1:1 s repo

`deploy.sh` orphan-pushuje obsah repa do `gh-pages` branche. URL pak mapuje 1:1 strukturu repa. Konkrétně:

- `data/lookups.json` v repu → `https://kratocz.github.io/drobne-pamatky/data/lookups.json` (NE `/lookups.json`)
- `pamatka/<nid>-<slug>/index.html` v repu → `https://.../pamatka/<nid>-<slug>/`
- `index.html` v repu → `https://.../` (SPA mapa)

Důsledek: per-pamatka HTML stránky, `sitemap*.xml`, `robots.txt` musí být v **repo root**, ne v `data/`. Sync skript je tam kopíruje (`scripts/sync-from-source.sh` krok `[7/8]`), `.gitignore` má `/pamatka/`, `/sitemap*.xml`, `/robots.txt` na root úrovni.

### Jinja2 `autoescape` + `.j2` extension

`select_autoescape(["html", "xml"])` matchuje extensions `.html` a `.xml` — **NE** `.j2`. Naše šablony se jmenují `page.html.j2`, `sitemap.xml.j2`. Pro autoescape je nutno použít `enabled_extensions=("html", "xml", "j2")` + `default=True`.

### JSON-LD `<script type="application/ld+json">` musí escape `<` `>` `&`

JSON content uvnitř `<script type="application/ld+json">` neescapuje `<` `>` ze své povahy. Když title obsahuje `<script>...</script>`, browser ho interpretuje jako uzavření outer `<script>` bloku + nový exekuovatelný kód → XSS. Fix: post-process JSON output, escape `<` `>` `&` jako `<` `>` `&` (helper `_jsonld_dump` v `build_static_pages.py`).

### `build_thumbnails.convert_one` má "cached" check

Legacy chování: pokud výstupní AVIF už existuje, `convert_one` ho nepřepíše (vrátí status `cached`). Pro **refresh** scénář (změnil se zdrojový JPG → nutno re-encoduje) musí sync skript explicitně smazat target AVIF před voláním `build_thumbnails.py --only`. Implementováno v `sync-from-source.sh` krok `[5/8]`.

### Drupal 6 `files.filepath` má prefix `files/<rok>/...`

Ne `sites/default/files/<rok>/...` (běžný Drupal config), ale jen `files/<rok>/<basename>.jpg`. VPS web root `/www/drobnepamatky.cz/www/` je správný `rsync` source — `rsync --files-from` přijímá tyto cesty přímo. `filepath_to_thumb_path` v `sync_manifest_diff.py` z toho odvozuje thumb path `<rok>/<basename>.avif`.

### DB credentials z `.env`, nikdy hardcoded

`export.py`, `build_thumbnails.py`, `init_thumbs_manifest.py` čtou `OLD_DB_USER`, `OLD_DB_PASSWORD`, `OLD_DB_NAME` z env vars (typicky přes `set -a; source .env; set +a`). Sync skript (`sync-from-source.sh`) je nahraje sám. Host a port jsou hardcoded na `127.0.0.1:13306` (přes SSH tunel).

V git historii **byl** kdysi hardcoded `password="xnet"` — heslo smazáno přes `git-filter-repo` a repo přepnuto na private. Pre-commit hook `gitleaks` (globální, `core.hooksPath`) předchází opakování.

### Cloudflare Web Analytics beacon (issue #14)

Beacon se vkládá do 3 vstupních bodů přes placeholder `<!-- CF_BEACON -->`:
- `index.html`, `404.html` — nahradí `scripts/inject-beacon.sh` v obou deploy cestách
  (`deploy.sh` z `.env`, workflow z `vars.CF_BEACON_TOKEN`)
- `pamatka/<nid>-<slug>/index.html` — vloží `build_static_pages.py` při generování (Jinja `{{ cf_beacon|safe }}`)

Token (`CF_BEACON_TOKEN`, 32-hex) je **public-by-design** (view-source ho ukáže), vázaný na hostname.
Lokálně v `.env`, v CI jako GitHub **variable** (ne secret) `vars.CF_BEACON_TOKEN`. Bez tokenu se
placeholder smaže — **fork-friendly**, žádný beacon, žádná chyba.

`404.html` má beacon **bez `defer`** (kvůli okamžitému `location.replace()`); helper to pozná
podle názvu souboru. SRI/`integrity` záměrně vynechán — `beacon.min.js` je mutable CDN URL.

Po klonu fork-owner nastaví vlastní token (nebo nechá prázdný). Po deploy ověřit:
`curl -s https://kratocz.github.io/drobne-pamatky/ | grep cloudflareinsights`.

**gitleaks vs. public token (deploy gotcha):** `gitleaks` hlásí CF token v ~82k
vygenerovaných HTML jako `generic-api-key` a blokuje `deploy.sh` commit do gh-pages
(i workflow). Token je public-by-design, tak je v `.gitleaks.toml` allowlist cílený JEN
na `data-cf-beacon` kontext (`regexTarget = "line"` — stejný 32-hex jinde se dál detekuje;
`[extend] useDefault = true` zachová ostatní pravidla). Druhá vrstva: `deploy.sh` musí
`.gitleaks.toml` **zkopírovat do gh-pages worktree** (a gitignorovat, ať nejde na produkci),
protože pre-commit hook (`core.hooksPath`) hledá config v kořeni worktree, ne hlavního repa.

### `deploy.sh` orphan branch cleanup

`deploy.sh` dělá deploy přes dočasný orphan branch `gh-pages-deploy-<ts>` (force-push do
gh-pages, žádná historie = stabilní repo size). Branch + worktree se uklízí v `cleanup()`
trapu na `EXIT` — tedy i když push/commit **selže** (např. gitleaks blok). Bez toho se
orphan branche hromadily po každém neúspěšném běhu (guard `${ORPHAN_BRANCH:-}` ošetří pád
před definicí proměnné).

## Struktura

```
.
├── index.html          # vstupní stránka s mapou (SPA)
├── 404.html            # GitHub Pages SPA redirect (beacon bez defer)
├── src/                # JS moduly (vanilla JS, bez bundleru)
├── assets/             # CSS, statické soubory
├── data/               # GeoJSON, lookups, search index, details/, thumbs/
├── scripts/            # deploy.sh, sync-from-source.sh, inject-beacon.sh, snapshot/
├── .env.example        # šablona env (DB credentials, CF_BEACON_TOKEN)
├── .gitleaks.toml      # secret-scan allowlist (CF beacon token je public)
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
