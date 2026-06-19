# Design: Cloudflare Web Analytics beacon (issue #14)

- **Datum:** 2026-06-19
- **Issue:** [#14](https://github.com/kratocz/drobne-pamatky/issues/14)
- **Status:** schválený design, čeká na implementační plán

## Cíl

Vložit Cloudflare Web Analytics beacon do všech tří vstupních bodů webu (SPA `index.html`,
redirect `404.html`, per-pamatka `page.html.j2`) tak, aby:

- token žil v `.env` (lokálně) a GitHub variable `vars.CF_BEACON_TOKEN` (CI) — nikdy hardcoded ve zdroji
- **fork-friendly**: bez tokenu se beacon vůbec nevloží (žádná chyba, žádný mrtvý request)
- fungovalo v **obou** existujících deploy cestách bez přepsání deploy architektury

CF Web Analytics je cookie-less, GDPR-friendly bez consent banneru. Token je **public-by-design**
(objeví se ve `view-source` na produkci) — není to secret, je vázaný na hostname `kratocz.github.io`.

### Proč beacon NEMÁ `integrity` (SRI)

Ostatní CDN scripty v `index.html` (leaflet, glify, minisearch, dompurify) mají
`integrity="sha384-…"` — ale jsou **version-pinned immutable** (`@1.9.4`, `@3.2.4`).
Beacon je `static.cloudflareinsights.com/beacon.min.js` **bez verze** — Cloudflare ho
aktualizuje na stejné URL, takže SRI hash by se při každém update knihovny rozbil a beacon
by přestal fungovat. Proto oficiální CF snippet `integrity` nepoužívá a my ho záměrně
vynecháváme. Risk je nízký: beacon je cookie-less analytics ping bez přístupu k citlivým
datům, a `static.cloudflareinsights.com` provozuje sám Cloudflare (kompromis = kompromis
celého CF). Snippet ponecháváme **přesně jak ho CF generuje** (maximální kompatibilita).

## Mimo scope

- **Workflow full-rebuild + data-in-git** — zvažovaný přepis, kde by workflow byl jediný zdroj
  pravdy pro gh-pages a regeneroval `pamatka/` v CI. Vyžadoval by data (~850 MB) trackovaná v gitu,
  což ruší orphan-force-push strategii z `archive-plan.md` (git size). Samostatný spec, dotýká se #1/#11.
- **gitleaks allowlist** pro token — token zůstává v `.env` (gitignored) + placeholder ve zdrojích.
  V commitu se nemá objevit; pokud ano, gitleaks ho zablokuje (správně).

## Architektura

Placeholder `<!-- CF_BEACON -->` ve zdrojovém HTML. Token žije v `.env` (lokálně) a
`vars.CF_BEACON_TOKEN` (CI). Každá deploy cesta nahradí placeholder beacon snippetem
(s tokenem) nebo ho smaže (bez tokenu).

```
ZDROJ (main branch):
  index.html              → <!-- CF_BEACON --> v <head> (za assets/style.css)
  404.html                → <!-- CF_BEACON --> v <head>, PŘED redirect scriptem (beacon BEZ defer)
  scripts/snapshot/templates/page.html.j2  → {{ cf_beacon|safe }} v <head>

GENEROVÁNÍ (lokálně, build_static_pages.py):
  čte CF_BEACON_TOKEN z env (deploy.sh ho exportuje z .env)
  → vyrenderuje cf_beacon do každé pamatka/<nid>/index.html při generování
  → pamatka/ hotové, žádný post-process 82k souborů

DEPLOY CESTA A — deploy.sh (lokální, full force-push):
  source .env  →  CF_BEACON_TOKEN
  build_static_pages.py už vložil beacon do pamatka/ (přes Jinja var)
  scripts/inject-beacon.sh <worktree> "$CF_BEACON_TOKEN"
    → nahradí <!-- CF_BEACON --> v index.html + 404.html
    (pamatka/ už nemá placeholder → grep guard přeskočí, žádný konflikt)

DEPLOY CESTA B — workflow sync-code-to-pages.yml (CI, code-only):
  token z ${{ vars.CF_BEACON_TOKEN }}
  scripts/inject-beacon.sh <pages> "$CF_BEACON_TOKEN"
    → nahradí <!-- CF_BEACON --> v index.html + 404.html
    (workflow pamatka/ nekopíruje — gitignored, řeší deploy.sh)
```

### Soubory

| Soubor | Akce | Odpovědnost |
|---|---|---|
| `scripts/inject-beacon.sh` | create | Sdílený helper: placeholder → snippet / smazání |
| `index.html` | modify | + `<!-- CF_BEACON -->` v `<head>` |
| `404.html` | modify | + `<!-- CF_BEACON -->` před redirect scriptem |
| `scripts/snapshot/templates/page.html.j2` | modify | + `{{ cf_beacon|safe }}` |
| `scripts/snapshot/build_static_pages.py` | modify | `_cf_beacon_snippet()`, `cf_beacon` v `build_context` |
| `scripts/deploy.sh` | modify | `source .env` + zavolat helper |
| `.github/workflows/sync-code-to-pages.yml` | modify | krok inject-beacon s `vars.CF_BEACON_TOKEN` + paths |
| `.env.example` | modify | + `CF_BEACON_TOKEN=` |
| `scripts/snapshot/test_inject_beacon.sh` | create | Lightweight test helperu |
| `scripts/snapshot/test_build_static_pages.py` | modify | + case pro cf_beacon |
| `AGENTS.md`, `README.md` | modify | Dokumentace |

## Helper `inject-beacon.sh`

```bash
#!/usr/bin/env bash
# Nahradí placeholder <!-- CF_BEACON --> v HTML souborech za Cloudflare
# Web Analytics beacon snippet. Bez tokenu placeholder smaže (fork-friendly).
#
# Použití:
#   inject-beacon.sh <dir> <token>     # token "" = smazat placeholder
#
# Token je PUBLIC (objeví se v view-source), není to secret — vázaný na
# hostname kratocz.github.io, na cizí doméně CF data nezpracuje.

set -euo pipefail

DIR="${1:?Usage: inject-beacon.sh <dir> <token>}"
TOKEN="${2:-}"

PLACEHOLDER='<!-- CF_BEACON -->'

count=0
while IFS= read -r -d '' file; do
    if ! grep -qF "$PLACEHOLDER" "$file"; then
        continue
    fi
    # 404.html: bez defer (kvůli okamžitému location.replace). Ostatní: s defer.
    if [[ -z "$TOKEN" ]]; then
        SNIPPET=''
    elif [[ "$(basename "$file")" == "404.html" ]]; then
        SNIPPET="<script src=\"https://static.cloudflareinsights.com/beacon.min.js\" data-cf-beacon='{\"token\": \"${TOKEN}\"}'></script>"
    else
        SNIPPET="<script defer src=\"https://static.cloudflareinsights.com/beacon.min.js\" data-cf-beacon='{\"token\": \"${TOKEN}\"}'></script>"
    fi
    # Python str.replace (sed by kolidoval se / & " { } v URL/JSON).
    TOKEN_SNIPPET="$SNIPPET" python3 -c '
import os, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    html = f.read()
html = html.replace("<!-- CF_BEACON -->", os.environ["TOKEN_SNIPPET"])
with open(path, "w", encoding="utf-8") as f:
    f.write(html)
' "$file"
    count=$((count + 1))
done < <(find "$DIR" -name '*.html' -type f -print0)

echo "  inject-beacon: ${count} souborů, token=$([ -n "$TOKEN" ] && echo "nastaven" || echo "PRÁZDNÝ (placeholder smazán)")"
```

**Klíčové volby:**
- **Python pro replace, ne `sed`** — snippet obsahuje `/ & " { }` které by sed musel escapovat.
- **`grep -qF` guard** — skip souborů bez placeholderu (efektivní + idempotentní).
- **404.html bez defer** — `location.replace()` je okamžitý; s `defer` by se beacon nikdy nefiroval.
  Snippet bez `defer` zahájí fetch synchronně; CF beacon posílá hit přes `navigator.sendBeacon()`
  který přežije navigaci.
- **Prázdný token → placeholder smazán** — fork bez tokenu má čisté HTML.
- **Idempotentní** — po nahrazení placeholder zmizí, druhý běh skip.

## Per-pamatka cesta (build_static_pages.py + page.html.j2)

### page.html.j2

```jinja2
<meta name="twitter:card" content="summary{% if hero %}_large_image{% endif %}">
<script type="application/ld+json">{{ jsonld|safe }}</script>
<script type="application/ld+json">{{ jsonld_breadcrumb|safe }}</script>
{{ cf_beacon|safe }}
<link rel="stylesheet" href="{{ base_path }}assets/page.css">
```

### build_static_pages.py

```python
def _cf_beacon_snippet():
    """Cloudflare Web Analytics beacon snippet z env CF_BEACON_TOKEN.
    Prázdný string pokud token není nastaven (fork-friendly).
    Token musí být 32-hex (CF beacon formát) — jinak ignorován jako obrana
    proti injekci nevalidní hodnoty do HTML (defense in depth, viz #5 XSS)."""
    token = os.environ.get("CF_BEACON_TOKEN", "").strip()
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        return ""
    return (
        '<script defer src="https://static.cloudflareinsights.com/beacon.min.js" '
        f'data-cf-beacon=\'{{"token": "{token}"}}\'></script>'
    )
```

Snippet se vkládá do `_WORKER_STATE` v `_init_worker` (konzistentní s `lookups`/`tpl`,
funguje i na spawn platformách):

```python
def _init_worker(lookups_path, template_dir):
    _WORKER_STATE["lookups"] = json.loads(Path(lookups_path).read_text(encoding="utf-8"))
    _WORKER_STATE["cf_beacon"] = _cf_beacon_snippet()
    env = Environment(...)
    _WORKER_STATE["tpl"] = env.get_template("page.html.j2")
```

`build_context` bere `cf_beacon` jako **parametr s default `""`** (zůstává čistě testovatelný
bez globálního stavu — testy ho předají přímo) a vloží ho do návratového dictu:

```python
def build_context(nid, detail, lookups, cf_beacon=""):
    ...
    return {..., "cf_beacon": cf_beacon}
```

`_render_one` ho předá z `_WORKER_STATE`:

```python
def _render_one(args):
    nid, detail, kraj_tid = args
    ctx = build_context(nid, detail, _WORKER_STATE["lookups"],
                        cf_beacon=_WORKER_STATE.get("cf_beacon", ""))
    ...
```

**Bezpečnost:** validace `^[0-9a-f]{32}$` je levná pojistka proti injekci nevalidní hodnoty
do HTML. Token jde z env (kontroluješ ty), ale defense in depth konzistentní s #5.

### Lokální použití

```bash
cd scripts/snapshot
CF_BEACON_TOKEN=<32-hex> uv run python build_static_pages.py --limit 50
# bez env → cf_beacon prázdný, stránky bez beaconu
```

## Statická cesta (index.html, 404.html, deploy.sh)

### index.html

```html
    <link rel="stylesheet" href="assets/style.css">
    <!-- CF_BEACON -->
</head>
```

### 404.html

Placeholder **PŘED** redirect scriptem (aby beacon fetch začal než `location.replace()` doběhne):

```html
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Drobné památky – přesměrování</title>
    <!-- CF_BEACON -->
    <script>
        (function () {
            'use strict';
            // ... redirect logika beze změny ...
            window.location.replace(target.href);
        }());
    </script>
</head>
```

### deploy.sh

Po kopii souborů do worktree (za blok `cp pamatka/ + sitemap + robots`):

```bash
# Cloudflare Web Analytics beacon (#14) — z .env CF_BEACON_TOKEN.
# Token public-by-design; bez něj se placeholder smaže (fork-friendly).
if [[ -f "$REPO_ROOT/.env" ]]; then
    # shellcheck disable=SC1091
    set -a; source "$REPO_ROOT/.env"; set +a
fi
bash "$REPO_ROOT/scripts/inject-beacon.sh" . "${CF_BEACON_TOKEN:-}"
```

Běží ve worktree (cwd `.` = gh-pages worktree). `find . -name '*.html'` zachytí `index.html`,
`404.html` i 82k `pamatka/**/index.html`. Ale `pamatka/` už má beacon z `build_static_pages.py`
(placeholder nahrazen) → `grep -qF` guard je přeskočí. Helper reálně zpracuje jen `index.html`
+ `404.html`. Žádný konflikt, žádné dvojité vložení.

## CI cesta (workflow)

### .github/workflows/sync-code-to-pages.yml

Paths filter rozšířit o helper:

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'index.html'
      - '404.html'
      - 'src/**'
      - 'assets/**'
      - 'LICENSE'
      - 'scripts/inject-beacon.sh'
      - '.github/workflows/sync-code-to-pages.yml'
```

Nový krok mezi "Sync code soubory" a "Commit & push":

```yaml
      - name: Inject Cloudflare beacon
        working-directory: pages
        env:
          CF_BEACON_TOKEN: ${{ vars.CF_BEACON_TOKEN }}
        run: bash ../main/scripts/inject-beacon.sh . "$CF_BEACON_TOKEN"
```

`working-directory: pages` = gh-pages checkout. Helper běží na `index.html` + `404.html`
(jediné HTML, které workflow kopíruje). Bez `vars.CF_BEACON_TOKEN` (fork bez variable) →
prázdný token → placeholder smazán.

**Idempotence napříč běhy:** workflow vždy kopíruje `index.html`/`404.html` z `main` (s placeholderem),
helper nahradí. Příští push zopakuje. Žádná akumulace.

### GitHub variable

Token je public → GitHub **variable** (plaintext, čitelný v Settings), ne secret:

```bash
gh variable set CF_BEACON_TOKEN --body "<32-hex token>"
```

## Testing

Žádný test framework (per AGENTS.md). Pro tuto změnu:

1. **`scripts/snapshot/test_inject_beacon.sh`** (bash, bez frameworku):
   - temp HTML s placeholderem + token → snippet přítomen, `defer` u index.html
   - temp `404.html` s placeholderem + token → snippet přítomen, **bez** `defer`
   - prázdný token → placeholder zmizel, žádný `<script>`
   - HTML bez placeholderu → beze změny (idempotence)

2. **`test_build_static_pages.py`** rozšířit:
   - `build_context(..., cf_beacon=snippet)` → `ctx["cf_beacon"]` obsahuje snippet
   - `_cf_beacon_snippet()` s validním 32-hex env → snippet
   - `_cf_beacon_snippet()` s nevalidním tokenem (`xyz`, `'><script>`) → prázdný
   - `_cf_beacon_snippet()` bez env → prázdný

3. **Lokální e2e:**
   ```bash
   CF_BEACON_TOKEN=<token> bash scripts/deploy.sh --dry-run
   # ověřit index.html, 404.html, sample pamatka/ mají beacon (view-source / grep)
   ```

4. **Produkce po deploy:**
   ```bash
   curl -s https://kratocz.github.io/drobne-pamatky/ | grep cloudflareinsights
   curl -s https://kratocz.github.io/drobne-pamatky/404.html | grep cloudflareinsights  # bez defer
   curl -s https://kratocz.github.io/drobne-pamatky/pamatka/8980-.../ | grep cloudflareinsights
   # CF dashboard ukáže traffic (~pár minut)
   ```

## Acceptance criteria

- [ ] `scripts/inject-beacon.sh` — placeholder → snippet (token) / smazání (bez tokenu), 404.html bez defer
- [ ] `index.html` — `<!-- CF_BEACON -->` v `<head>`
- [ ] `404.html` — `<!-- CF_BEACON -->` před redirect scriptem
- [ ] `page.html.j2` — `{{ cf_beacon|safe }}`
- [ ] `build_static_pages.py` — `_cf_beacon_snippet()` + validace 32-hex + `cf_beacon` v `build_context`
- [ ] `deploy.sh` — source .env + zavolat helper (jen index/404 reálně, pamatka/ guard skip)
- [ ] workflow — krok inject-beacon s `vars.CF_BEACON_TOKEN` + paths filter
- [ ] `.env.example` — `CF_BEACON_TOKEN=` s komentářem
- [ ] `test_inject_beacon.sh` — 4 case projdou
- [ ] `test_build_static_pages.py` — nové cf_beacon case projdou
- [ ] GitHub variable `CF_BEACON_TOKEN` nastaven
- [ ] Lokální e2e: beacon ve všech 3 bodech (s tokenem), prázdné HTML bez tokenu
- [ ] Po deploy: beacon na produkci ve všech 3 bodech, 404.html bez defer
- [ ] CF dashboard sbírá traffic
- [ ] AGENTS.md / README dokumentace
- [ ] Issue #14 close
