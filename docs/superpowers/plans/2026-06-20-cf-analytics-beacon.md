# CF Web Analytics beacon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vložit Cloudflare Web Analytics beacon do 3 vstupních bodů webu (SPA `index.html`, redirect `404.html`, per-pamatka `page.html.j2`) přes placeholder substituci, s tokenem z `.env`/`vars.CF_BEACON_TOKEN`, fork-friendly (bez tokenu = čisté HTML).

**Architecture:** Placeholder `<!-- CF_BEACON -->` ve zdroji. Per-pamatka beacon se vkládá při generování (`build_static_pages.py` přes Jinja `{{ cf_beacon|safe }}`). Statické `index.html`/`404.html` přes sdílený `scripts/inject-beacon.sh` (Python str.replace), volaný z `deploy.sh` (token z `.env`) i z workflow (token z `vars.CF_BEACON_TOKEN`). `404.html` dostane beacon bez `defer`.

**Tech Stack:** bash + Python 3.12 (str.replace, regex validace), Jinja2, GitHub Actions, Cloudflare Web Analytics.

**Spec:** `docs/superpowers/specs/2026-06-19-cf-analytics-beacon-design.md`

## Global Constraints

- Placeholder marker je přesně `<!-- CF_BEACON -->` (HTML komentář) — identický napříč všemi zdroji.
- Token je 32-hex (`^[0-9a-f]{32}$`), public-by-design (objeví se ve view-source), NIKDY hardcoded ve zdroji.
- Bez tokenu = placeholder smazán, žádný beacon, žádná chyba (fork-friendly).
- `404.html` beacon BEZ `defer` (kvůli okamžitému `location.replace()`); ostatní S `defer`.
- Beacon snippet ponecháváme přesně jak ho CF generuje — bez `integrity`/SRI (beacon.min.js je mutable URL).
- Conventional Commits, český krátký popis, žádný `Co-Authored-By` trailer.
- Pracuje se na `main` branchi (solo dev, direct-to-main je zavedený vzor).

---

## Task 1: `inject-beacon.sh` helper + test

**Files:**
- Create: `scripts/inject-beacon.sh`
- Create: `scripts/snapshot/test_inject_beacon.sh`

**Interfaces:**
- Produces: `inject-beacon.sh <dir> <token>` — projde `*.html` v `<dir>`, nahradí `<!-- CF_BEACON -->` za beacon snippet (s `defer` mimo `404.html`, bez `defer` v `404.html`); prázdný token → placeholder smazán. Idempotentní (po nahrazení placeholder zmizí).

- [ ] **Step 1: Napsat failing test**

Create `scripts/snapshot/test_inject_beacon.sh`:

```bash
#!/usr/bin/env bash
# Lightweight test pro scripts/inject-beacon.sh (bez frameworku).
# Spuštění: bash scripts/snapshot/test_inject_beacon.sh
# Exit 0 = pass, 1 = aspoň jeden FAIL.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$REPO_ROOT/scripts/inject-beacon.sh"
TOKEN="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
failed=0

check() {
    local label="$1" cond="$2"
    if [[ "$cond" == "ok" ]]; then
        echo "  OK    $label"
    else
        echo "  FAIL  $label"
        failed=$((failed + 1))
    fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Case 1: index.html + token → snippet s defer
cat > "$tmp/index.html" <<'EOF'
<head><title>X</title><!-- CF_BEACON --></head>
EOF
bash "$HELPER" "$tmp" "$TOKEN" >/dev/null
grep -qF 'cloudflareinsights.com/beacon.min.js' "$tmp/index.html" && c=ok || c=no
check "index.html: snippet vložen" "$c"
grep -qF '<script defer src=' "$tmp/index.html" && c=ok || c=no
check "index.html: má defer" "$c"
grep -qF "$TOKEN" "$tmp/index.html" && c=ok || c=no
check "index.html: token přítomen" "$c"
grep -qF '<!-- CF_BEACON -->' "$tmp/index.html" && c=no || c=ok
check "index.html: placeholder zmizel" "$c"

# Case 2: 404.html + token → snippet BEZ defer
cat > "$tmp/404.html" <<'EOF'
<head><title>X</title><!-- CF_BEACON --><script>redirect()</script></head>
EOF
bash "$HELPER" "$tmp" "$TOKEN" >/dev/null
grep -qF 'cloudflareinsights.com/beacon.min.js' "$tmp/404.html" && c=ok || c=no
check "404.html: snippet vložen" "$c"
grep -qE '<script src="https://static\.cloudflareinsights' "$tmp/404.html" && c=ok || c=no
check "404.html: BEZ defer" "$c"
grep -qF '<script defer' "$tmp/404.html" && c=no || c=ok
check "404.html: nemá defer" "$c"

# Case 3: prázdný token → placeholder smazán, žádný script
cat > "$tmp/empty.html" <<'EOF'
<head><title>X</title><!-- CF_BEACON --></head>
EOF
bash "$HELPER" "$tmp/empty.html.dir_nonexist" "" >/dev/null 2>&1 || true
# (helper bere dir; vytvoříme podadresář pro izolaci)
mkdir -p "$tmp/e"
cat > "$tmp/e/empty.html" <<'EOF'
<head><title>X</title><!-- CF_BEACON --></head>
EOF
bash "$HELPER" "$tmp/e" "" >/dev/null
grep -qF '<!-- CF_BEACON -->' "$tmp/e/empty.html" && c=no || c=ok
check "prázdný token: placeholder smazán" "$c"
grep -qF 'cloudflareinsights' "$tmp/e/empty.html" && c=no || c=ok
check "prázdný token: žádný script" "$c"

# Case 4: HTML bez placeholderu → beze změny (idempotence)
mkdir -p "$tmp/n"
cat > "$tmp/n/nomark.html" <<'EOF'
<head><title>X</title></head>
EOF
before="$(cat "$tmp/n/nomark.html")"
bash "$HELPER" "$tmp/n" "$TOKEN" >/dev/null
after="$(cat "$tmp/n/nomark.html")"
[[ "$before" == "$after" ]] && c=ok || c=no
check "bez placeholderu: beze změny" "$c"

echo
echo "$([ $failed -eq 0 ] && echo "VŠE OK" || echo "$failed FAIL")"
exit $([ $failed -eq 0 ] && echo 0 || echo 1)
```

- [ ] **Step 2: Spustit test, ověřit FAIL (helper neexistuje)**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
bash scripts/snapshot/test_inject_beacon.sh 2>&1 | tail -5
```

Expected: testy selžou (helper `scripts/inject-beacon.sh` neexistuje → `bash: No such file`). Aspoň jeden FAIL, exit ≠ 0.

- [ ] **Step 3: Vytvořit helper**

Create `scripts/inject-beacon.sh`:

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

```bash
chmod +x scripts/inject-beacon.sh
```

- [ ] **Step 4: Spustit test, ověřit PASS**

```bash
bash scripts/snapshot/test_inject_beacon.sh 2>&1 | tail -12
```

Expected: všechny case `OK`, poslední řádek `VŠE OK`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/inject-beacon.sh scripts/snapshot/test_inject_beacon.sh
git commit -m "feat(beacon): inject-beacon.sh helper + test (refs #14)"
```

---

## Task 2: `build_static_pages.py` — `_cf_beacon_snippet` + `cf_beacon` v `build_context`

**Files:**
- Modify: `scripts/snapshot/build_static_pages.py`
- Modify: `scripts/snapshot/test_build_static_pages.py`

**Interfaces:**
- Consumes: env `CF_BEACON_TOKEN`.
- Produces: `_cf_beacon_snippet() -> str` (snippet s defer pro validní 32-hex token, jinak `""`). `build_context(nid, detail, lookups, cf_beacon="")` vrací dict s klíčem `"cf_beacon"`.

- [ ] **Step 1: Napsat failing test**

V `scripts/snapshot/test_build_static_pages.py` najít konec souboru (za poslední `check(...)` před `print()` souhrnem). Přidat nový import a test sekci. Nejdřív rozšířit import na začátku souboru:

```python
from build_static_pages import slugify, build_context, _cf_beacon_snippet
```

(Pokud import už importuje `slugify, build_context`, přidat `, _cf_beacon_snippet`.)

Pak najít závěrečný souhrnný blok (úplný konec souboru — `print()`, `total = 29`, `sys.exit(...)`):

```python
print()
total = 29
print(f"{total - failed}/{total} passed")
sys.exit(0 if failed == 0 else 1)
```

PŘED tento blok (před řádek `print()`) vložit nové testy. Použít existující `check()` helper (signatura `check(label, actual, expected_substr_or_value, mode="eq")` z tohoto souboru — `mode="in"` / `mode="eq"` / `mode="not_in"`):

```python
# ── cf_beacon (issue #14) ──────────────────────────────────────────
print("\ncf_beacon:")
import os as _os

# build_context default cf_beacon → prázdný
check("build_context bez cf_beacon → prázdný", build_context(1234, minimal, LOOKUPS_FIXTURE).get("cf_beacon", "MISSING"), "")
# build_context s cf_beacon param → vloží
ctx_b = build_context(1234, minimal, LOOKUPS_FIXTURE, cf_beacon="<beacon-snippet>")
check("build_context s cf_beacon → vloží", ctx_b["cf_beacon"], "<beacon-snippet>")

# _cf_beacon_snippet: validní 32-hex token
_os.environ["CF_BEACON_TOKEN"] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
check("snippet validní token → obsahuje beacon.min.js", _cf_beacon_snippet(), "beacon.min.js", mode="in")
check("snippet validní token → obsahuje token", _cf_beacon_snippet(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mode="in")
check("snippet validní token → má defer", _cf_beacon_snippet(), "<script defer", mode="in")
# nevalidní token (krátký)
_os.environ["CF_BEACON_TOKEN"] = "xyz"
check("snippet nevalidní token → prázdný", _cf_beacon_snippet(), "")
# XSS pokus v tokenu
_os.environ["CF_BEACON_TOKEN"] = "'><script>alert(1)</script>"
check("snippet XSS token → prázdný", _cf_beacon_snippet(), "")
# bez env
del _os.environ["CF_BEACON_TOKEN"]
check("snippet bez env → prázdný", _cf_beacon_snippet(), "")
```

Pak v tom souhrnném bloku změnit `total = 29` na `total = 37` (přidali jsme 8 `check`).

- [ ] **Step 2: Spustit test, ověřit FAIL (import error)**

```bash
cd scripts/snapshot && uv run python test_build_static_pages.py 2>&1 | head -5
```

Expected: `ImportError: cannot import name '_cf_beacon_snippet'` (funkce ještě neexistuje).

- [ ] **Step 3: Přidat `_cf_beacon_snippet` do `build_static_pages.py`**

V `scripts/snapshot/build_static_pages.py` najít funkci `_jsonld_dump` (kolem řádku 133). PŘED ni (za `return` blok `build_context` na řádku 130, mezi `build_context` a `_jsonld_dump`) přidat:

```python
def _cf_beacon_snippet():
    """Cloudflare Web Analytics beacon snippet z env CF_BEACON_TOKEN (issue #14).
    Prázdný string pokud token není nastaven (fork-friendly).
    Token musí být 32-hex (CF beacon formát) — jinak ignorován jako obrana
    proti injekci nevalidní hodnoty do HTML (defense in depth, viz #5 XSS).
    SRI/integrity záměrně vynechán — beacon.min.js je mutable URL."""
    token = os.environ.get("CF_BEACON_TOKEN", "").strip()
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        return ""
    return (
        '<script defer src="https://static.cloudflareinsights.com/beacon.min.js" '
        f'data-cf-beacon=\'{{"token": "{token}"}}\'></script>'
    )
```

(`os` a `re` jsou už importované — řádky 21-22.)

- [ ] **Step 4: Rozšířit `build_context` signaturu o `cf_beacon`**

Najít řádek 57 `def build_context(nid, detail, lookups):` a změnit na:

```python
def build_context(nid, detail, lookups, cf_beacon=""):
```

Pak najít návratový dict (řádky 122-130) a přidat `cf_beacon` klíč:

```python
    return {
        "nid": nid, "slug": slug, "title": title, "description": description,
        "canonical": canonical, "base_path": BASE_PATH,
        "druh": druh, "misto": misto,
        "hero": hero, "hero_abs": hero_abs,
        "popis_html": popis_html, "lat": lat, "lng": lng,
        "jsonld": jsonld,
        "jsonld_breadcrumb": jsonld_breadcrumb,
        "cf_beacon": cf_beacon,
    }
```

- [ ] **Step 5: Spustit test, ověřit PASS**

```bash
cd scripts/snapshot && uv run python test_build_static_pages.py 2>&1 | tail -12
```

Expected: cf_beacon sekce `OK`, souhrn `37/37 passed` (nebo aktuální total), exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/snapshot/build_static_pages.py scripts/snapshot/test_build_static_pages.py
git commit -m "feat(snapshot): _cf_beacon_snippet + cf_beacon v build_context (refs #14)"
```

---

## Task 3: `page.html.j2` + `_init_worker` + `_render_one` propojení

**Files:**
- Modify: `scripts/snapshot/templates/page.html.j2`
- Modify: `scripts/snapshot/build_static_pages.py`

**Interfaces:**
- Consumes: `_cf_beacon_snippet()` (Task 2), `cf_beacon` param v `build_context` (Task 2).
- Produces: vygenerované `pamatka/<nid>/index.html` obsahují beacon (když je `CF_BEACON_TOKEN` v env).

- [ ] **Step 1: Přidat `{{ cf_beacon|safe }}` do šablony**

V `scripts/snapshot/templates/page.html.j2` najít blok s JSON-LD (2 `<script type="application/ld+json">` + `<link rel="stylesheet">`):

```jinja2
<script type="application/ld+json">{{ jsonld|safe }}</script>
<script type="application/ld+json">{{ jsonld_breadcrumb|safe }}</script>
<link rel="stylesheet" href="{{ base_path }}assets/page.css">
```

Vložit `{{ cf_beacon|safe }}` mezi druhý JSON-LD a `<link>`:

```jinja2
<script type="application/ld+json">{{ jsonld|safe }}</script>
<script type="application/ld+json">{{ jsonld_breadcrumb|safe }}</script>
{{ cf_beacon|safe }}
<link rel="stylesheet" href="{{ base_path }}assets/page.css">
```

- [ ] **Step 2: Vložit `cf_beacon` do `_WORKER_STATE` v `_init_worker`**

V `build_static_pages.py` najít `_init_worker` (řádek 147). Za řádek `_WORKER_STATE["lookups"] = ...` (řádek 149) přidat:

```python
    _WORKER_STATE["cf_beacon"] = _cf_beacon_snippet()
```

Výsledek (řádky 147-160):

```python
def _init_worker(lookups_path, template_dir):
    """Per-proces init: nahrát lookups + zkompilovat šablonu jednou."""
    _WORKER_STATE["lookups"] = json.loads(Path(lookups_path).read_text(encoding="utf-8"))
    _WORKER_STATE["cf_beacon"] = _cf_beacon_snippet()
    # nosemgrep: python.flask.security.xss.audit.direct-use-of-jinja2.direct-use-of-jinja2
    env = Environment(
        loader=FileSystemLoader(str(template_dir)),
        autoescape=select_autoescape(
            enabled_extensions=("html", "xml", "j2"),
            default_for_string=True,
            default=True,
        ),
        trim_blocks=True, lstrip_blocks=True,
    )
    _WORKER_STATE["tpl"] = env.get_template("page.html.j2")
```

- [ ] **Step 3: Předat `cf_beacon` z `_render_one` do `build_context`**

Najít `_render_one` (řádek 177). Najít volání `ctx = build_context(nid, detail, _WORKER_STATE["lookups"])` (řádek 181) a změnit na:

```python
        ctx = build_context(nid, detail, _WORKER_STATE["lookups"],
                            cf_beacon=_WORKER_STATE.get("cf_beacon", ""))
```

- [ ] **Step 4: Pilot smoke test s tokenem**

Vyžaduje existující `out/details/*.json` + `out/lookups.json`. Pokud chybí, zkopírovat z `data/` (jako v dřívějších taskách):

```bash
cd scripts/snapshot
mkdir -p out/details
[ -f out/lookups.json ] || cp ../../data/lookups.json out/
[ -z "$(ls -A out/details/ 2>/dev/null)" ] && cp ../../data/details/*.json out/details/ 2>/dev/null

# S tokenem:
CF_BEACON_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa uv run python build_static_pages.py --limit 10 2>&1 | tail -3
```

Expected: 10 stránek, 0 err. Ověřit beacon v sample:

```bash
sample=$(ls out/pamatka/ | head -1)
grep -c 'cloudflareinsights' "out/pamatka/$sample/index.html"
```

Expected: `1` (beacon přítomen).

- [ ] **Step 5: Ověřit fork-friendly (bez tokenu)**

```bash
cd scripts/snapshot
rm -rf out/pamatka
uv run python build_static_pages.py --limit 10 2>&1 | tail -2
sample=$(ls out/pamatka/ | head -1)
grep -c 'cloudflareinsights' "out/pamatka/$sample/index.html" || echo "0 (správně — bez tokenu žádný beacon)"
grep -c 'CF_BEACON' "out/pamatka/$sample/index.html" || echo "0 (placeholder vyrenderován jako prázdno)"
```

Expected: `0` výskytů beaconu, `0` výskytů `CF_BEACON` (Jinja `{{ cf_beacon|safe }}` s prázdnou hodnotou → prázdný řádek).

- [ ] **Step 6: Tests stále projdou**

```bash
cd scripts/snapshot && uv run python test_build_static_pages.py 2>&1 | tail -2
```

Expected: `37/37 passed` (beze změny — Task 3 nemění testovanou logiku, jen propojení).

- [ ] **Step 7: Commit**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
git add scripts/snapshot/templates/page.html.j2 scripts/snapshot/build_static_pages.py
git commit -m "feat(snapshot): cf_beacon v page.html.j2 + worker propojení (refs #14)"
```

---

## Task 4: `index.html` + `404.html` placeholdery

**Files:**
- Modify: `index.html`
- Modify: `404.html`

**Interfaces:**
- Produces: oba soubory obsahují `<!-- CF_BEACON -->` na správném místě pro `inject-beacon.sh` (Task 1).

- [ ] **Step 1: Přidat placeholder do `index.html`**

V `index.html` najít konec `<head>`:

```html
    <link rel="stylesheet" href="assets/style.css">
</head>
```

Vložit placeholder za `style.css` link:

```html
    <link rel="stylesheet" href="assets/style.css">
    <!-- CF_BEACON -->
</head>
```

- [ ] **Step 2: Přidat placeholder do `404.html`**

V `404.html` najít začátek `<head>` s title a redirect scriptem:

```html
    <title>Drobné památky – přesměrování</title>
    <script>
        (function () {
```

Vložit placeholder PŘED redirect `<script>` (aby beacon fetch začal než `location.replace()` doběhne):

```html
    <title>Drobné památky – přesměrování</title>
    <!-- CF_BEACON -->
    <script>
        (function () {
```

- [ ] **Step 3: Smoke test injekce na obou souborech**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
# Kopie do temp aby se neměnily zdroje
tmp=$(mktemp -d)
cp index.html 404.html "$tmp/"
bash scripts/inject-beacon.sh "$tmp" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
echo "--- index.html (má defer) ---"
grep -o '<script[^>]*cloudflareinsights[^>]*>' "$tmp/index.html"
echo "--- 404.html (bez defer) ---"
grep -o '<script[^>]*cloudflareinsights[^>]*>' "$tmp/404.html"
rm -rf "$tmp"
```

Expected:
- index.html: `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ...>`
- 404.html: `<script src="https://static.cloudflareinsights.com/beacon.min.js" ...>` (BEZ defer)

- [ ] **Step 4: Ověřit prázdný token (fork-friendly)**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
tmp=$(mktemp -d)
cp index.html 404.html "$tmp/"
bash scripts/inject-beacon.sh "$tmp" ""
grep -c 'CF_BEACON\|cloudflareinsights' "$tmp/index.html" || echo "0 (správně)"
grep -c 'CF_BEACON\|cloudflareinsights' "$tmp/404.html" || echo "0 (správně)"
rm -rf "$tmp"
```

Expected: `0` v obou (placeholder smazán, žádný beacon).

- [ ] **Step 5: Commit**

```bash
git add index.html 404.html
git commit -m "feat(ui): CF_BEACON placeholder v index.html + 404.html (refs #14)"
```

---

## Task 5: `deploy.sh` integrace

**Files:**
- Modify: `scripts/deploy.sh`

**Interfaces:**
- Consumes: `inject-beacon.sh` (Task 1), `CF_BEACON_TOKEN` z `.env`.
- Produces: deploy do gh-pages s beaconem v `index.html`/`404.html` (pamatka/ už má z build_static_pages).

- [ ] **Step 1: Přidat beacon injekci do `deploy.sh`**

V `scripts/deploy.sh` najít blok kopie souborů (řádky 126-128):

```bash
cp "$REPO_ROOT/index.html" .
cp "$REPO_ROOT/404.html" .
cp "$REPO_ROOT/LICENSE" .
```

Za `cp LICENSE` (řádek 128), PŘED `.gitignore` blok (řádek 130), vložit:

```bash

# Cloudflare Web Analytics beacon (#14) — z .env CF_BEACON_TOKEN.
# Token public-by-design; bez něj se placeholder smaže (fork-friendly).
# pamatka/ už má beacon z build_static_pages.py (placeholder nahrazen) →
# grep guard v inject-beacon.sh je přeskočí, reálně zpracuje jen index/404.
if [[ -f "$REPO_ROOT/.env" ]]; then
    # shellcheck disable=SC1091
    set -a; source "$REPO_ROOT/.env"; set +a
fi
bash "$REPO_ROOT/scripts/inject-beacon.sh" . "${CF_BEACON_TOKEN:-}"
```

- [ ] **Step 2: Syntax check**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
bash -n scripts/deploy.sh && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 3: Dry-run ověření (bez push)**

`deploy.sh --dry-run` skončí PŘED kopírováním (pre-flight only), takže beacon injekci nezasáhne. Místo toho ověříme manuálně, že blok je syntakticky a logicky správný — že `source .env` + `inject-beacon.sh` jsou před `git add`:

```bash
grep -n 'inject-beacon\|git add -A\|source.*.env' scripts/deploy.sh
```

Expected: `source .env` a `inject-beacon.sh` mají nižší číslo řádku než `git add -A` (injekce proběhne před commitem).

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat(deploy): CF beacon injekce z .env do gh-pages (refs #14)"
```

---

## Task 6: workflow integrace + `.env.example`

**Files:**
- Modify: `.github/workflows/sync-code-to-pages.yml`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `inject-beacon.sh` (Task 1), `vars.CF_BEACON_TOKEN` (GitHub variable).
- Produces: workflow vloží beacon do `index.html`/`404.html` v gh-pages při code-only push.

- [ ] **Step 1: Rozšířit paths filter o helper**

V `.github/workflows/sync-code-to-pages.yml` najít `paths:` blok (řádky 19-25):

```yaml
    paths:
      - 'index.html'
      - '404.html'
      - 'src/**'
      - 'assets/**'
      - 'LICENSE'
      - '.github/workflows/sync-code-to-pages.yml'
```

Přidat `scripts/inject-beacon.sh`:

```yaml
    paths:
      - 'index.html'
      - '404.html'
      - 'src/**'
      - 'assets/**'
      - 'LICENSE'
      - 'scripts/inject-beacon.sh'
      - '.github/workflows/sync-code-to-pages.yml'
```

- [ ] **Step 2: Přidat inject krok**

Najít krok "Sync code soubory (data ponechány)" a krok "Commit & push" za ním. Mezi ně vložit nový krok:

```yaml
      - name: Inject Cloudflare beacon
        working-directory: pages
        env:
          CF_BEACON_TOKEN: ${{ vars.CF_BEACON_TOKEN }}
        run: bash ../main/scripts/inject-beacon.sh . "$CF_BEACON_TOKEN"
```

(`main` a `pages` jsou checkout paths z existujícího workflow — `actions/checkout` s `path: main` a `path: pages`.)

- [ ] **Step 3: YAML lint**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/sync-code-to-pages.yml')); print('YAML OK')"
```

Expected: `YAML OK`.

- [ ] **Step 4: Přidat `CF_BEACON_TOKEN` do `.env.example`**

V `.env.example` najít konec souboru (za `OLD_DB_NAME=`). Přidat:

```bash

# Cloudflare Web Analytics beacon token (public, ne secret — vázaný na hostname).
# Získat: dash.cloudflare.com → Web Analytics → Add site → beacon token (32-hex).
# Prázdné = bez analytiky (fork-friendly). V CI nastav jako GitHub variable:
#   gh variable set CF_BEACON_TOKEN --body "<token>"
CF_BEACON_TOKEN=
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/sync-code-to-pages.yml .env.example
git commit -m "feat(ci): CF beacon injekce ve workflow + .env.example (refs #14)"
```

---

## Task 7: GitHub variable + lokální `.env` + dokumentace

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: vše z Task 1-6.
- Produces: token nastaven v obou prostředích (lokální `.env`, GitHub variable), dokumentace.

> **Token:** skutečnou 32-hex hodnotu vezmi z Cloudflare dashboardu
> (Web Analytics → site `kratocz.github.io` → snippet, klíč `"token"`).
> V příkazech níže je `<your-32-hex-token>` placeholder — nahraď ho tou
> hodnotou. Token je PUBLIC-by-design (je vidět ve view-source HTML), ale
> do gitu (ani do tohoto plánu) ho nepiš — gitleaks ho oprávněně blokuje.

- [ ] **Step 1: Nastavit GitHub variable**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
gh variable set CF_BEACON_TOKEN --body "<your-32-hex-token>"
gh variable list
```

Expected: `CF_BEACON_TOKEN` v seznamu (hodnota viditelná — je to variable, ne secret).

- [ ] **Step 2: Nastavit lokální `.env`**

```bash
grep -q '^CF_BEACON_TOKEN=' .env || echo 'CF_BEACON_TOKEN=<your-32-hex-token>' >> .env
grep '^CF_BEACON_TOKEN=' .env
```

Expected: `CF_BEACON_TOKEN=<your-32-hex-token>` (NEcommitne se — `.env` je gitignored).

- [ ] **Step 3: Dokumentace v AGENTS.md**

V `AGENTS.md` najít sekci "Gotchas a implementační poznámky" (přidaná v retru). Za poslední `###` podsekci přidat:

```markdown
### Cloudflare Web Analytics beacon (issue #14)

Beacon se vkládá do 3 vstupních bodů přes placeholder `<!-- CF_BEACON -->`:
- `index.html`, `404.html` — nahradí `scripts/inject-beacon.sh` v obou deploy cestách
  (`deploy.sh` z `.env`, workflow z `vars.CF_BEACON_TOKEN`)
- `pamatka/<nid>/index.html` — vloží `build_static_pages.py` při generování (Jinja `{{ cf_beacon }}`)

Token (`CF_BEACON_TOKEN`, 32-hex) je **public-by-design** (view-source ho ukáže), vázaný na hostname.
Lokálně v `.env`, v CI jako GitHub **variable** (ne secret) `vars.CF_BEACON_TOKEN`. Bez tokenu se
placeholder smaže — **fork-friendly**, žádný beacon, žádná chyba.

`404.html` má beacon **bez `defer`** (kvůli okamžitému `location.replace()`); helper to pozná
podle názvu souboru. SRI/`integrity` záměrně vynechán — `beacon.min.js` je mutable CDN URL.

Po klonu fork-owner nastaví vlastní token (nebo nechá prázdný). Po deploy ověřit:
`curl -s https://kratocz.github.io/drobne-pamatky/ | grep cloudflareinsights`.
```

- [ ] **Step 4: Dokumentace v README.md**

V `README.md` najít sekci "Plánovaná vylepšení a hlášení chyb" (nebo poslední tematickou sekci před Licencí). Před ni přidat krátkou sekci:

```markdown
## Analytika

Web používá [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/) — cookie-less,
GDPR-friendly, bez consent banneru. Beacon token se vkládá při buildu z env proměnné
`CF_BEACON_TOKEN` (lokálně `.env`, v CI GitHub variable). Při forku bez vlastního tokenu se
analytika prostě nevloží — repo funguje out-of-box.

```

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: CF Web Analytics beacon (AGENTS + README, refs #14)"
```

---

## Task 8: e2e deploy + produkční ověření + close #14

**Files:** žádný kód.

**Interfaces:**
- Consumes: vše z Task 1-7.
- Produces: beacon živý na produkci, issue #14 closed.

- [ ] **Step 1: Plný build per-pamatka s tokenem**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
# Token je v .env → exportovat pro build
set -a; source .env; set +a
cd scripts/snapshot
# Vyžaduje out/details + out/lookups (z dřívějška nebo kopie z data/)
[ -z "$(ls -A out/details/ 2>/dev/null)" ] && cp ../../data/details/*.json out/details/ 2>/dev/null
[ -f out/lookups.json ] || cp ../../data/lookups.json out/
rm -rf out/pamatka
uv run python build_static_pages.py 2>&1 | tail -3
```

Expected: ~82k stránek, 0 err.

- [ ] **Step 2: Zkopírovat výstup do repo root + ověřit beacon**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
rm -rf pamatka && cp -R scripts/snapshot/out/pamatka .
cp scripts/snapshot/out/sitemap.xml . && cp scripts/snapshot/out/sitemap-*.xml . && cp scripts/snapshot/out/robots.txt .
sample=$(ls pamatka/ | head -1)
echo "beacon v pamatka/$sample:"
grep -c 'cloudflareinsights' "pamatka/$sample/index.html"
```

Expected: `1` (per-pamatka stránky mají beacon).

- [ ] **Step 3: Deploy**

```bash
bash scripts/deploy.sh 2>&1 | tail -8
```

Expected: deploy proběhne, `inject-beacon: N souborů, token=nastaven` v outputu, force-push do gh-pages.

- [ ] **Step 4: Počkat na propagaci + ověřit produkci**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
# Počkat až beacon je live na index.html
until curl -s "https://kratocz.github.io/drobne-pamatky/" 2>/dev/null | grep -q 'cloudflareinsights'; do sleep 10; done
echo "=== index.html (má defer) ==="
curl -s "https://kratocz.github.io/drobne-pamatky/" | grep -o '<script[^>]*cloudflareinsights[^>]*>'
echo "=== 404.html (bez defer) ==="
curl -s "https://kratocz.github.io/drobne-pamatky/404.html" | grep -o '<script[^>]*cloudflareinsights[^>]*>'
echo "=== pamatka sample ==="
sample=$(ls pamatka/ | head -1)
curl -s "https://kratocz.github.io/drobne-pamatky/pamatka/$sample/" | grep -o '<script[^>]*cloudflareinsights[^>]*>'
```

Expected:
- index.html: `<script defer src="...">`
- 404.html: `<script src="...">` (BEZ defer)
- pamatka: `<script defer src="...">`

- [ ] **Step 5: Ověřit CF dashboard sbírá traffic**

Manuální (uživatel): otevřít https://dash.cloudflare.com → Web Analytics → kratocz.github.io. Po pár návštěvách (i vlastních) by se měl objevit první traffic do ~5 min. Lze urychlit otevřením https://kratocz.github.io/drobne-pamatky/ v reálném browseru.

- [ ] **Step 6: Close #14**

```bash
gh issue close 14 --comment "Implementováno + nasazeno. CF Web Analytics beacon ve 3 vstupních bodech (index.html, 404.html bez defer, per-pamatka). Token z .env (deploy.sh) + GitHub variable (workflow), fork-friendly. Spec + plán v docs/superpowers/."
```

---

## Spec coverage check

| Spec požadavek | Task |
|---|---|
| `scripts/inject-beacon.sh` (placeholder → snippet / smazání, 404 bez defer) | Task 1 |
| `index.html` placeholder | Task 4 |
| `404.html` placeholder před redirect | Task 4 |
| `page.html.j2` `{{ cf_beacon\|safe }}` | Task 3 |
| `_cf_beacon_snippet()` + 32-hex validace | Task 2 |
| `cf_beacon` v `build_context` | Task 2 |
| `_init_worker` + `_render_one` propojení | Task 3 |
| `deploy.sh` source .env + helper | Task 5 |
| workflow inject krok + paths | Task 6 |
| `.env.example` CF_BEACON_TOKEN | Task 6 |
| `test_inject_beacon.sh` 4 case | Task 1 |
| `test_build_static_pages.py` cf_beacon case | Task 2 |
| GitHub variable nastaven | Task 7 |
| Lokální e2e | Task 3 (smoke) + Task 8 (full) |
| Produkce ověření 3 body, 404 bez defer | Task 8 |
| CF dashboard traffic | Task 8 |
| AGENTS.md / README | Task 7 |
| Issue #14 close | Task 8 |

Vše pokryto.

## Type consistency check

- `_cf_beacon_snippet() -> str`: Task 2 definuje, Task 3 volá v `_init_worker`. ✓
- `build_context(nid, detail, lookups, cf_beacon="")`: Task 2 přidá param, Task 3 ho předá z `_render_one`. ✓
- `inject-beacon.sh <dir> <token>`: Task 1 definuje, Task 5 (deploy.sh) + Task 6 (workflow) volají. ✓
- Placeholder `<!-- CF_BEACON -->`: identický v Task 1 (helper grep), Task 3 (page.html.j2 jako Jinja var, ne komentář — pozn. níže), Task 4 (index/404). ✓
- **Pozn. k page.html.j2:** per-pamatka NEpoužívá `<!-- CF_BEACON -->` komentář ale `{{ cf_beacon|safe }}` Jinja var (beacon se vkládá při generování, ne post-process). Helper `inject-beacon.sh` na pamatka/ proto nic nenajde (žádný komentář-placeholder) — to je správně, pamatka/ řeší build_static_pages. Konzistentní se spec architekturou.
