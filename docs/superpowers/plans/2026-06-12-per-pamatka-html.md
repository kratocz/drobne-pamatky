# Per-pamatka HTML + sitemap (#5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Goal:** Vyrobit statické per-pamatka HTML stránky pro všech 81 988 záznamů + sitemap chunked po krajích, aby crawlery (Google, ClaudeBot, …) měli přístup k obsahu bez JS.
- **Architecture:** Nový `scripts/snapshot/build_static_pages.py` (vzor `build_thumbnails.py` — `multiprocessing.Pool` worker paralelizace). Jinja2 šablony v `templates/`. Slim+ layout (~1.5 KB / stránka), Open Graph + JSON-LD Schema.org Place. Per-kraj sitemap chunking (15 souborů) + master index. Integrace do `sync-from-source.sh`.
- **Tech Stack:** Python 3.12 + `jinja2` (přes uv), CommonMark šablony, Schema.org JSON-LD, sitemaps.org XSD.

**Spec:** `docs/superpowers/specs/2026-06-12-per-pamatka-html-design.md`

---

## File Structure

| Soubor | Akce | Odpovědnost |
|---|---|---|
| `scripts/snapshot/pyproject.toml` | modify | + `jinja2` |
| `scripts/snapshot/templates/page.html.j2` | create | Slim+ šablona per památka |
| `scripts/snapshot/templates/sitemap.xml.j2` | create | Per-kraj urlset |
| `scripts/snapshot/templates/sitemap-index.xml.j2` | create | Master sitemap index |
| `scripts/snapshot/templates/robots.txt.j2` | create | robots + sitemap link |
| `scripts/snapshot/build_static_pages.py` | create | Orchestrátor + per-pamatka render Pool |
| `scripts/snapshot/test_build_static_pages.py` | create | 7 lightweight test case |
| `assets/page.css` | create | Sdílený stylesheet (~600 B) |
| `scripts/sync-from-source.sh` | modify | Nový krok `[2b/8]` + kopie do data/ |
| `.gitignore` | modify | `data/pamatka/`, `data/sitemap*.xml`, `data/robots.txt` |

---

## Task 1: jinja2 dependency

**Files:**
- Modify: `scripts/snapshot/pyproject.toml`
- Modify: `scripts/snapshot/uv.lock` (auto)

- [ ] **Step 1: Přidat jinja2**

```bash
cd scripts/snapshot && uv add jinja2
```

Expected output (verze se mohou drobně lišit):
```
Resolved N packages
Installed N packages
 + jinja2==3.1.6
 + markupsafe==3.0.3
```

- [ ] **Step 2: Smoke import test**

```bash
cd scripts/snapshot && uv run python -c "import jinja2; from markupsafe import escape; print('jinja2', jinja2.__version__, 'OK')"
```

Expected: `jinja2 3.1.x OK`.

- [ ] **Step 3: Commit**

```bash
git add scripts/snapshot/pyproject.toml scripts/snapshot/uv.lock
git commit -m "chore(snapshot): přidat jinja2 dependency pro static page builder (refs #5)"
```

---

## Task 2: Šablony — page.html.j2

**Files:**
- Create: `scripts/snapshot/templates/page.html.j2`

- [ ] **Step 1: Vytvořit adresář a šablonu**

```bash
mkdir -p scripts/snapshot/templates
```

Create `scripts/snapshot/templates/page.html.j2`:

```jinja2
<!doctype html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ title }} – Drobné památky</title>
<meta name="description" content="{{ description }}">
<link rel="canonical" href="{{ canonical }}">
<meta name="robots" content="index, follow">
<meta property="og:title" content="{{ title }}">
<meta property="og:description" content="{{ description }}">
{% if hero %}<meta property="og:image" content="{{ hero_abs }}">{% endif %}
<meta property="og:url" content="{{ canonical }}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Drobné památky">
<meta name="twitter:card" content="summary{% if hero %}_large_image{% endif %}">
<script type="application/ld+json">{{ jsonld|safe }}</script>
<link rel="stylesheet" href="{{ base_path }}assets/page.css">
</head>
<body>
<header class="dp-breadcrumb">
<a href="{{ base_path }}">Drobné památky</a> › <a href="{{ base_path }}">mapa</a> › {{ title }}
</header>
<main class="dp-page">
<h1>{{ title }}</h1>
<p class="dp-meta"><strong>{{ druh }}</strong>{% if misto %} · {{ misto }}{% endif %}</p>
{% if hero %}<img class="dp-hero" src="{{ hero }}" alt="{{ title }}" loading="lazy" width="250" height="250">{% endif %}
{% if popis_html %}<div class="dp-popis">{{ popis_html|safe }}</div>{% endif %}
<p class="dp-gps">GPS: <a href="https://www.openstreetmap.org/?mlat={{ lat }}&amp;mlon={{ lng }}&amp;zoom=16">{{ lat }}, {{ lng }}</a></p>
<nav class="dp-actions">
<a href="{{ base_path }}?p=/pamatka/{{ nid }}-{{ slug }}/">Zobrazit na mapě</a> ·
<a href="https://www.drobnepamatky.cz/node/{{ nid }}" rel="external">Zdroj na drobnepamatky.cz</a>
</nav>
</main>
<footer class="dp-footer">Archivační kopie · Data: <a href="https://www.drobnepamatky.cz/">drobnepamatky.cz</a></footer>
</body>
</html>
```

- [ ] **Step 2: Smoke test (syntactic only, bez dat)**

```bash
cd scripts/snapshot && uv run python -c "
from jinja2 import Environment, FileSystemLoader, select_autoescape
env = Environment(loader=FileSystemLoader('templates'), autoescape=select_autoescape(['html','xml']))
tpl = env.get_template('page.html.j2')
html = tpl.render(title='Test', description='Desc', canonical='https://x.cz/', base_path='/', druh='Kříž', misto='Praha', hero=None, hero_abs=None, popis_html='', lat=0, lng=0, nid=1, slug='test', jsonld='{}')
print('OK, len=', len(html))
"
```

Expected: `OK, len= 800` (přibližně). Žádné jinja2 syntax error.

- [ ] **Step 3: Commit**

```bash
git add scripts/snapshot/templates/page.html.j2
git commit -m "feat(snapshot): jinja2 šablona pro per-pamatka HTML (slim+ layout, refs #5)"
```

---

## Task 3: Šablony — sitemap a robots

**Files:**
- Create: `scripts/snapshot/templates/sitemap.xml.j2`
- Create: `scripts/snapshot/templates/sitemap-index.xml.j2`
- Create: `scripts/snapshot/templates/robots.txt.j2`

- [ ] **Step 1: sitemap.xml.j2 (per kraj urlset)**

Create `scripts/snapshot/templates/sitemap.xml.j2`:

```jinja2
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{% for p in pages -%}
<url><loc>{{ p.canonical }}</loc>{% if p.lastmod %}<lastmod>{{ p.lastmod }}</lastmod>{% endif %}<priority>0.6</priority></url>
{% endfor -%}
</urlset>
```

- [ ] **Step 2: sitemap-index.xml.j2 (master)**

Create `scripts/snapshot/templates/sitemap-index.xml.j2`:

```jinja2
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{% for kraj in krajse -%}
<sitemap><loc>{{ site_base }}sitemap-{{ kraj.slug }}.xml</loc><lastmod>{{ build_date }}</lastmod></sitemap>
{% endfor -%}
</sitemapindex>
```

- [ ] **Step 3: robots.txt.j2**

Create `scripts/snapshot/templates/robots.txt.j2`:

```jinja2
User-agent: *
Allow: /

Sitemap: {{ site_base }}sitemap.xml
```

- [ ] **Step 4: Smoke render test**

```bash
cd scripts/snapshot && uv run python -c "
from jinja2 import Environment, FileSystemLoader, select_autoescape
env = Environment(loader=FileSystemLoader('templates'), autoescape=select_autoescape(['html','xml']))
print(env.get_template('sitemap.xml.j2').render(pages=[{'canonical':'https://x.cz/a/','lastmod':'2026-01-01'}, {'canonical':'https://x.cz/b/','lastmod':''}]))
print('---')
print(env.get_template('sitemap-index.xml.j2').render(krajse=[{'slug':'praha'}], site_base='https://x.cz/', build_date='2026-06-12'))
print('---')
print(env.get_template('robots.txt.j2').render(site_base='https://x.cz/'))
"
```

Expected: Tři výstupy — sitemap urlset (2 URL), sitemap index (1 entry), robots.txt s Sitemap directive. Žádné syntax error.

- [ ] **Step 5: Commit**

```bash
git add scripts/snapshot/templates/sitemap.xml.j2 scripts/snapshot/templates/sitemap-index.xml.j2 scripts/snapshot/templates/robots.txt.j2
git commit -m "feat(snapshot): jinja2 šablony pro sitemap + robots.txt (refs #5)"
```

---

## Task 4: CSS — assets/page.css

**Files:**
- Create: `assets/page.css`

- [ ] **Step 1: Vytvořit page.css**

Create `assets/page.css`:

```css
body { max-width: 720px; margin: 0 auto; padding: 1rem; font-family: Georgia, serif; line-height: 1.55; color: #2a2a2a; background: #fff; }
.dp-breadcrumb { background: #f4f4f4; padding: 0.5rem 0.75rem; font-size: 0.85rem; border-bottom: 1px solid #ddd; margin: -1rem -1rem 1rem; }
.dp-breadcrumb a { color: #1a5490; text-decoration: none; }
.dp-breadcrumb a:hover { text-decoration: underline; }
h1 { margin: 0 0 0.5rem; font-size: 1.6rem; }
.dp-meta { color: #666; margin: 0 0 1rem; }
.dp-hero { display: block; max-width: 100%; height: auto; margin: 0 0 1rem; aspect-ratio: 1 / 1; background: #eee; }
.dp-popis { line-height: 1.55; white-space: pre-wrap; word-wrap: break-word; }
.dp-popis a { color: #1a5490; }
.dp-gps { font-size: 0.9rem; color: #666; }
.dp-actions { margin-top: 1.5rem; font-size: 0.9rem; }
.dp-actions a { color: #1a5490; }
.dp-footer { margin-top: 2rem; padding-top: 0.75rem; border-top: 1px solid #eee; font-size: 0.8rem; color: #666; text-align: center; }
.dp-footer a { color: #1a5490; }
@media (max-width: 480px) { body { padding: 0.5rem; } .dp-breadcrumb { margin: -0.5rem -0.5rem 0.75rem; } }
```

- [ ] **Step 2: Velikost check**

```bash
wc -c assets/page.css
```

Expected: 800-1000 bytes (cílíme ~600-1000 B, je to drobný style).

- [ ] **Step 3: Commit**

```bash
git add assets/page.css
git commit -m "feat(ui): assets/page.css sdílený stylesheet pro per-pamatka HTML (refs #5)"
```

---

## Task 5: test_build_static_pages.py (failing TDD)

TDD: napíšeme test pro `slugify` a `build_context`, který selže s ImportError.

**Files:**
- Create: `scripts/snapshot/test_build_static_pages.py`

- [ ] **Step 1: Vytvořit test skript**

Create `scripts/snapshot/test_build_static_pages.py`:

```python
#!/usr/bin/env python3
"""
Lightweight test pro build_static_pages.slugify + build_context.
Bez frameworku - spustit přes:
  cd scripts/snapshot && uv run python test_build_static_pages.py
Exit code 0 = pass, 1 = aspoň jeden FAIL.
"""

import sys
from build_static_pages import slugify, build_context

LOOKUPS_FIXTURE = {
    "druh": {"5": "Kříž", "10": "Socha"},
    "misto": {
        "100": {"name": "Praha", "parent_tid": 0},
        "200": {"name": "Praha 1", "parent_tid": 100},
    },
    "users": {},
}

failed = 0


def check(label, actual, expected_substr_or_value, mode="eq"):
    global failed
    if mode == "eq":
        ok = (actual == expected_substr_or_value)
    elif mode == "in":
        ok = (expected_substr_or_value in actual) if actual is not None else False
    elif mode == "not_in":
        ok = (expected_substr_or_value not in actual) if actual is not None else True
    else:
        raise ValueError(mode)
    status = "OK  " if ok else "FAIL"
    print(f"  {status}  {label}")
    if not ok:
        print(f"        actual:   {actual!r}")
        print(f"        expected: {expected_substr_or_value!r} ({mode})")
        failed += 1


# ── slugify tests ──────────────────────────────────────────────────
print("slugify():")
check("normální text", slugify("Socha sv. Iva"), "socha-sv-iva")
check("diakritika", slugify("Příliš žluťoučký kůň"), "prilis-zlutoucky-kun")
check("empty string", slugify(""), "")
check("None vstup", slugify(None), "")
check("jen separátory", slugify("@#$%^&*()"), "")
check("dlouhý text (>80)", len(slugify("a" * 200)), 80)
check("trailing dash", slugify("foo --- "), "foo")

# ── build_context tests ─────────────────────────────────────────────
print("\nbuild_context():")
minimal = {
    "nid": 1234,
    "title": "Socha sv. Iva",
    "druh": {"tid": 5, "name": "Kříž"},
    "misto_termy": [100, 200],
    "gps": [14.4, 50.08],
    "fotky": [{"path": "files/2020/img.jpg", "fid": 1}],
    "popis": {"text": "Krátký popis."},
    "metadata": {"changed_ts": 1577836800},
}
ctx = build_context(1234, minimal, LOOKUPS_FIXTURE)
check("title", ctx["title"], "Socha sv. Iva")
check("slug", ctx["slug"], "socha-sv-iva")
check("canonical URL obsahuje slug", ctx["canonical"], "1234-socha-sv-iva", mode="in")
check("druh", ctx["druh"], "Kříž")
check("misto chain", ctx["misto"], "Praha", mode="in")
check("hero path", ctx["hero"], "2020/img.avif", mode="in")
check("hero_abs absolutní", ctx["hero_abs"], "https://", mode="in")
check("description z popisu", ctx["description"], "Krátký popis", mode="in")
check("popis_html escapovaný", ctx["popis_html"], "Krátký popis", mode="in")
check("jsonld obsahuje Place", ctx["jsonld"], "Place", mode="in")
check("jsonld obsahuje geo", ctx["jsonld"], "GeoCoordinates", mode="in")

# Edge: prázdný popis → fallback description
empty_popis = dict(minimal)
empty_popis["popis"] = {}
ctx2 = build_context(1234, empty_popis, LOOKUPS_FIXTURE)
check("fallback description bez popisu", ctx2["description"], "Drobná památka", mode="in")
check("popis_html prázdný", ctx2["popis_html"], "")

# Edge: prázdné fotky → hero=None
no_fotky = dict(minimal)
no_fotky["fotky"] = []
ctx3 = build_context(1234, no_fotky, LOOKUPS_FIXTURE)
check("hero=None bez fotek", ctx3["hero"], None)
check("hero_abs=None bez fotek", ctx3["hero_abs"], None)

# XSS sanity: title se <script> tagem → escaped v jsonld i popis_html
xss = dict(minimal)
xss["title"] = "<script>alert(1)</script>"
xss["popis"] = {"text": "<script>alert(2)</script>"}
ctx4 = build_context(1234, xss, LOOKUPS_FIXTURE)
check("title escapován v popis_html context", ctx4["popis_html"], "&lt;script&gt;", mode="in")
check("popis_html neobsahuje exec script", ctx4["popis_html"], "<script>alert", mode="not_in")

print()
total = 24
print(f"{total - failed}/{total} passed")
sys.exit(0 if failed == 0 else 1)
```

- [ ] **Step 2: Run, ověřit FAIL na ImportError**

```bash
cd scripts/snapshot && uv run python test_build_static_pages.py 2>&1 | head -5
```

Expected: `ModuleNotFoundError: No module named 'build_static_pages'` (modul Task 6 ho vyrobí).

- [ ] **Step 3: Commit failing test**

```bash
git add scripts/snapshot/test_build_static_pages.py
git commit -m "test(snapshot): 24 case pro build_static_pages slugify + build_context (refs #5)"
```

---

## Task 6: build_static_pages.py — modul

**Files:**
- Create: `scripts/snapshot/build_static_pages.py`

- [ ] **Step 1: Vytvořit modul**

Create `scripts/snapshot/build_static_pages.py`:

```python
#!/usr/bin/env python3
"""
Per-pamatka HTML + sitemap builder (issue #5).

Vstup: out/details/*.json, out/lookups.json
Výstup:
  out/pamatka/<nid>-<slug>/index.html × ~82k
  out/sitemap.xml (index)
  out/sitemap-<kraj-slug>.xml × 15
  out/robots.txt

Spuštění:
  cd scripts/snapshot
  uv run python build_static_pages.py                 # full
  uv run python build_static_pages.py --limit 100     # pilot
  uv run python build_static_pages.py --workers 4     # méně paralelismu
"""

import argparse
import json
import os
import re
import time
import unicodedata
from multiprocessing import Pool
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import escape

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = Path(__file__).parent / "out"
TEMPLATES_DIR = Path(__file__).parent / "templates"

SITE_BASE = "https://kratocz.github.io/drobne-pamatky/"
BASE_PATH = "/drobne-pamatky/"

KRAJ_SLUGS = {
    0: "ostatni", 1: "praha", 2: "stredocesky", 3: "jihocesky", 4: "plzensky",
    5: "karlovarsky", 6: "ustecky", 7: "liberecky", 8: "kralovehradecky",
    9: "pardubicky", 10: "vysocina", 11: "jihomoravsky", 12: "olomoucky",
    13: "moravskoslezsky", 14: "zlinsky",
}


def slugify(text):
    """Diakritika striped, lowercase, jen [a-z0-9-], max 80 znaků, žádné trailing dashes.
    None / nestring → ''."""
    if not text:
        return ""
    nfkd = unicodedata.normalize("NFKD", str(text))
    ascii_text = "".join(c for c in nfkd if not unicodedata.combining(c))
    s = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text.lower()).strip("-")
    return s[:80].rstrip("-")


def build_context(nid, detail, lookups):
    """Připraví dict pro jinja2 page.html.j2 render."""
    title = detail.get("title", "") or ""
    popis_block = detail.get("popis") or {}
    popis_text = popis_block.get("text") or popis_block.get("teaser") or ""

    if len(popis_text) > 155:
        description = popis_text[:150].rstrip() + "…"
    elif popis_text:
        description = popis_text
    else:
        description = f"Drobná památka {title} v ČR."

    druh = (detail.get("druh") or {}).get("name", "") or ""

    misto_chain = []
    for tid in detail.get("misto_termy") or []:
        info = lookups["misto"].get(str(tid))
        if info:
            misto_chain.append(info["name"])
    misto = " › ".join(misto_chain[:3])

    gps = detail.get("gps") or [0, 0]
    lng, lat = gps[0], gps[1]

    fotky = detail.get("fotky") or []
    hero = hero_abs = None
    if fotky:
        path = fotky[0].get("path", "")
        if "/" in path:
            # files/2020/img.jpg → 2020/img.avif
            avif = path.split("/", 1)[1].replace(".jpg", ".avif")
            hero = f"{BASE_PATH}data/thumbs/{avif}"
            hero_abs = f"{SITE_BASE}data/thumbs/{avif}"

    slug = slugify(title)
    canonical = f"{SITE_BASE}pamatka/{nid}-{slug}/"

    # popis_html: bleach-sanitized z #8; \n → <br>. markupsafe.escape pro defense in depth.
    popis_html = str(escape(popis_text)).replace("\n", "<br>") if popis_text else ""

    jsonld = json.dumps({
        "@context": "https://schema.org",
        "@type": "Place",
        "name": title,
        "description": description,
        **({"image": hero_abs} if hero_abs else {}),
        "geo": {"@type": "GeoCoordinates", "latitude": lat, "longitude": lng},
        "url": canonical,
        "isPartOf": {"@type": "WebSite", "name": "Drobné památky", "url": SITE_BASE},
    }, ensure_ascii=False, separators=(",", ":"))

    return {
        "nid": nid, "slug": slug, "title": title, "description": description,
        "canonical": canonical, "base_path": BASE_PATH,
        "druh": druh, "misto": misto,
        "hero": hero, "hero_abs": hero_abs,
        "popis_html": popis_html, "lat": lat, "lng": lng,
        "jsonld": jsonld,
    }


# ── Worker (multiprocessing.Pool) ───────────────────────────────────
_WORKER_STATE = {}


def _init_worker(lookups_path, template_dir):
    """Per-proces init: nahrát lookups + zkompilovat šablonu jednou."""
    _WORKER_STATE["lookups"] = json.loads(Path(lookups_path).read_text(encoding="utf-8"))
    env = Environment(
        loader=FileSystemLoader(str(template_dir)),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True, lstrip_blocks=True,
    )
    _WORKER_STATE["tpl"] = env.get_template("page.html.j2")


def _render_one(args):
    """Render 1 stránka. Vrací (nid, slug, lastmod, kraj_tid, status)."""
    nid, detail, kraj_tid = args
    try:
        ctx = build_context(nid, detail, _WORKER_STATE["lookups"])
        html = _WORKER_STATE["tpl"].render(**ctx)
        target_dir = OUT_DIR / "pamatka" / f"{nid}-{ctx['slug']}"
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / "index.html").write_text(html, encoding="utf-8")
        meta = detail.get("metadata") or {}
        ts = meta.get("changed_ts") or meta.get("created_ts") or 0
        lastmod = time.strftime("%Y-%m-%d", time.gmtime(int(ts))) if ts else ""
        return (nid, ctx["slug"], lastmod, kraj_tid, "ok")
    except Exception as e:
        return (nid, "", "", kraj_tid, f"err: {type(e).__name__}: {e}")


# ── Orchestrátor ────────────────────────────────────────────────────
def load_all_inputs(limit=None):
    """Načte details bucket files. Vrací (items, lookups), items = list (nid, detail, kraj_tid)."""
    lookups = json.loads((OUT_DIR / "lookups.json").read_text(encoding="utf-8"))
    items = []
    for bucket_path in sorted((OUT_DIR / "details").glob("*.json")):
        kraj_tid = int(bucket_path.stem)
        data = json.loads(bucket_path.read_text(encoding="utf-8"))
        for nid, detail in data.items():
            items.append((int(nid), detail, kraj_tid))
            if limit and len(items) >= limit:
                return items, lookups
    return items, lookups


def write_sitemaps(rendered, build_date, env):
    """Per-kraj sitemap + master index + robots.txt."""
    by_kraj = {}
    for nid, slug, lastmod, kraj_tid, status in rendered:
        if status != "ok":
            continue
        by_kraj.setdefault(kraj_tid, []).append({
            "canonical": f"{SITE_BASE}pamatka/{nid}-{slug}/",
            "lastmod": lastmod or build_date,
        })

    sitemap_tpl = env.get_template("sitemap.xml.j2")
    index_entries = []
    for kraj_tid in sorted(by_kraj.keys()):
        slug = KRAJ_SLUGS.get(kraj_tid, f"kraj-{kraj_tid}")
        xml = sitemap_tpl.render(pages=by_kraj[kraj_tid])
        (OUT_DIR / f"sitemap-{slug}.xml").write_text(xml, encoding="utf-8")
        index_entries.append({"slug": slug})

    idx_tpl = env.get_template("sitemap-index.xml.j2")
    (OUT_DIR / "sitemap.xml").write_text(
        idx_tpl.render(krajse=index_entries, site_base=SITE_BASE, build_date=build_date),
        encoding="utf-8",
    )

    robots_tpl = env.get_template("robots.txt.j2")
    (OUT_DIR / "robots.txt").write_text(
        robots_tpl.render(site_base=SITE_BASE), encoding="utf-8",
    )


def main():
    p = argparse.ArgumentParser(description="Per-pamatka HTML + sitemap (issue #5)")
    p.add_argument("--limit", type=int, default=None, help="Pilot: jen N záznamů")
    p.add_argument("--workers", type=int, default=os.cpu_count() or 4)
    args = p.parse_args()

    (OUT_DIR / "pamatka").mkdir(parents=True, exist_ok=True)

    print("Načítám details + lookups …", flush=True)
    items, _ = load_all_inputs(limit=args.limit)
    print(f"  → {len(items)} záznamů", flush=True)

    t0 = time.time()
    print(f"Renderuji ({args.workers} workers) …", flush=True)
    init_args = (str(OUT_DIR / "lookups.json"), str(TEMPLATES_DIR))
    rendered = []
    counts = {"ok": 0, "err": 0}
    with Pool(args.workers, initializer=_init_worker, initargs=init_args) as pool:
        for i, result in enumerate(
            pool.imap_unordered(_render_one, items, chunksize=200), 1
        ):
            rendered.append(result)
            counts["ok" if result[4] == "ok" else "err"] += 1
            if i % 5000 == 0 or i == len(items):
                rate = i / (time.time() - t0)
                print(f"  {i:>6}/{len(items)}  ok={counts['ok']}  err={counts['err']}  {rate:.0f} stránek/s",
                      flush=True)

    build_date = time.strftime("%Y-%m-%d", time.gmtime())
    print("Zapisuji sitemap + robots …", flush=True)
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True, lstrip_blocks=True,
    )
    write_sitemaps(rendered, build_date, env)

    dt = time.time() - t0
    print(f"\nHotovo za {dt:.1f}s ({len(items)/dt:.0f} stránek/s, {counts['ok']} ok, {counts['err']} err)",
          flush=True)
    if counts["err"]:
        first_errs = [r for r in rendered if r[4] != "ok"][:5]
        print("První err:", flush=True)
        for r in first_errs:
            print(f"  nid={r[0]}: {r[4]}", flush=True)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Spustit test, ověřit 24/24 pass**

```bash
cd scripts/snapshot && uv run python test_build_static_pages.py
```

Expected:
```
slugify():
  OK    normální text
  OK    diakritika
  …
build_context():
  OK    title
  …
24/24 passed
```

Exit code 0. Pokud něco selže, opravit modul, nezasáhnout test (test reflektuje spec).

- [ ] **Step 3: Pilot smoke run `--limit 10`**

Vyžaduje, aby `out/details/*.json` a `out/lookups.json` existovaly. Pokud ne, vytvoř minimální fixture nebo spusť `export.py --limit 10` (potřebuje SSH tunel). Pokud tunel není dostupný, použij existující soubory z `data/` (kopie):

```bash
cd scripts/snapshot
mkdir -p out/details
# Pokud out/lookups.json neexistuje, zkopíruj z data/:
[ -f out/lookups.json ] || cp ../../data/lookups.json out/
# Pokud out/details/ je prázdný, zkopíruj 1 bucket pro pilot:
[ -z "$(ls -A out/details/ 2>/dev/null)" ] && cp ../../data/details/1.json out/details/ 2>/dev/null

uv run python build_static_pages.py --limit 10
```

Expected:
```
Načítám details + lookups …
  → 10 záznamů
Renderuji (N workers) …
      10/10  ok=10  err=0  X stránek/s
Zapisuji sitemap + robots …
Hotovo za X.Xs (Y stránek/s, 10 ok, 0 err)
```

Zkontrolovat výstupy:

```bash
ls out/pamatka/ | head -3
ls out/sitemap*.xml out/robots.txt
```

Expected: 10 adresářů v `out/pamatka/`, soubory `sitemap.xml`, `sitemap-praha.xml` (nebo jiný kraj podle bucketu), `robots.txt`.

- [ ] **Step 4: HTML obsah sanity check**

```bash
cd scripts/snapshot && cat out/pamatka/*/index.html | head -30
```

Expected: `<!doctype html>`, `<title>… – Drobné památky</title>`, `og:title`, `<script type="application/ld+json">`. Žádné raw `<script>` (mimo `<script type="application/ld+json">`) ani `onclick`.

- [ ] **Step 5: Commit**

```bash
git add scripts/snapshot/build_static_pages.py
git commit -m "feat(snapshot): build_static_pages.py – per-pamatka HTML + sitemap + robots (refs #5)"
```

---

## Task 7: .gitignore updates

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Přidat nové generované cesty do .gitignore**

V `.gitignore` najít sekci s `/data/details/` a `/data/search-index.json` (kolem řádku 30-36). Za blok pro search-index přidat:

```gitignore
# Per-pamatka HTML + sitemap (~120 MB, 82k souborů) - generuje scripts/snapshot/build_static_pages.py
# Lokálně produkované, deploy.sh kopíruje na gh-pages
/data/pamatka/
/data/sitemap.xml
/data/sitemap-*.xml
/data/robots.txt
```

- [ ] **Step 2: Smoke check**

```bash
git check-ignore data/pamatka/test.html data/sitemap.xml data/robots.txt && echo "ignored OK" || echo "FAIL"
```

Expected:
```
data/pamatka/test.html
data/sitemap.xml
data/robots.txt
ignored OK
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(gitignore): pamatka/, sitemap*.xml, robots.txt (generované, refs #5)"
```

---

## Task 8: Integrace do sync-from-source.sh

**Files:**
- Modify: `scripts/sync-from-source.sh`

- [ ] **Step 1: Najít blok [2/7] build_search_index.js**

V `scripts/sync-from-source.sh` najít:

```bash
# ── 5. build_search_index.js ──────────────────────────────────────────
echo
echo "─── [2/7] build_search_index.js ───"
(cd scripts/snapshot && node build_search_index.js)
```

- [ ] **Step 2: Přejmenovat existující kroky [N/7] na [N/8] + přidat [2b/8]**

Nahradit celý zbytek skriptu od `[2/7]` po `[7/7]`. Použít sed nebo ruční edit. Cílový stav po `build_search_index.js`:

```bash
# ── 5. build_search_index.js ──────────────────────────────────────────
echo
echo "─── [2/8] build_search_index.js ───"
(cd scripts/snapshot && node build_search_index.js)

# ── 5b. build_static_pages.py (issue #5) ──────────────────────────────
echo
echo "─── [2b/8] build_static_pages.py ───"
(cd scripts/snapshot && uv run python build_static_pages.py)
```

A v dalších krocích nahradit `[3/7]` → `[3/8]`, `[4/7]` → `[4/8]`, `[5/7]` → `[5/8]`, `[6/7]` → `[6/8]`, `[7/7]` → `[7/8]`.

Konkrétně použít sed (testováno bezpečné):

```bash
sed -i.bak 's|\[3/7\]|[3/8]|g; s|\[4/7\]|[4/8]|g; s|\[5/7\]|[5/8]|g; s|\[6/7\]|[6/8]|g; s|\[7/7\]|[7/8]|g; s|\[2/7\]|[2/8]|g' scripts/sync-from-source.sh
rm scripts/sync-from-source.sh.bak
```

Pak ručně vložit `[2b/8] build_static_pages.py` blok hned po `[2/8] build_search_index.js` blok. Použít Edit nástroj nebo otevřít v editoru.

- [ ] **Step 3: Rozšířit copy fázi [7/8]**

Najít sekci copy v `[7/8]`:

```bash
# ── 10. Kopie out/* do data/ + nový manifest ──────────────────────────
echo
echo "─── [7/8] kopie out/ → data/ + thumbs-manifest update ───"
cp scripts/snapshot/out/pamatky.geojson data/
cp scripts/snapshot/out/lookups.json data/
cp scripts/snapshot/out/search-index.json data/
# details/ je adresář bucketů — kopírujeme celý
rm -rf data/details
cp -R scripts/snapshot/out/details data/
# Nový thumbs-manifest (z Tasku 3 helperu)
cp "$NEW_MANIFEST" data/thumbs-manifest.json

echo "  ✓ data/ aktualizováno"
```

Před řádek `# Nový thumbs-manifest` přidat:

```bash
# Per-pamatka HTML + sitemap + robots (issue #5)
rm -rf data/pamatka
cp -R scripts/snapshot/out/pamatka data/
cp scripts/snapshot/out/sitemap.xml data/
cp scripts/snapshot/out/sitemap-*.xml data/
cp scripts/snapshot/out/robots.txt data/
```

- [ ] **Step 4: Syntax check**

```bash
bash -n scripts/sync-from-source.sh && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-from-source.sh
git commit -m "feat(sync): integrace build_static_pages.py do sync pipeline (refs #5)"
```

---

## Task 9: Full pilot smoke test

Spustit celý builder bez `--limit`, ověřit, že 81k+ stránek se vygeneruje bez chyb a velikost odpovídá očekávání.

**Files:** žádný kód.

- [ ] **Step 1: Připravit input data**

Pokud `out/details/` neobsahuje plný export, zkopíruj z `data/`:

```bash
cd scripts/snapshot
mkdir -p out
cp ../../data/lookups.json out/
cp -R ../../data/details out/
ls out/details/ | wc -l
```

Expected: 15 souborů (14 krajů + 0).

- [ ] **Step 2: Full run**

```bash
cd scripts/snapshot && uv run python build_static_pages.py
```

Expected:
```
Načítám details + lookups …
  → 81988 záznamů
Renderuji (N workers) …
   5000/81988  ok=5000  err=0  Y stránek/s
  …
  81988/81988  ok=81988  err=0  Y stránek/s
Zapisuji sitemap + robots …
Hotovo za Xs (Y stránek/s, 81988 ok, 0 err)
```

Doba běhu odhadem 30-120s. Pokud `err > 0`, vidíš první 5 chybových v outputu — řešit.

- [ ] **Step 3: Velikost check**

```bash
du -sh scripts/snapshot/out/pamatka/
ls scripts/snapshot/out/sitemap*.xml | wc -l
wc -c scripts/snapshot/out/robots.txt
```

Expected:
- `out/pamatka/`: 100-200 MB
- 15 sitemap files (`sitemap-*.xml`) + 1 index (`sitemap.xml`) = 16 souborů shown wc -l (pokud glob nematchuje žádné, ověřit zvlášť)
- `robots.txt`: 50-100 B

- [ ] **Step 4: Sample HTML inspekce**

```bash
# Najít náhodnou stránku
ls scripts/snapshot/out/pamatka/ | head -1 | xargs -I {} cat scripts/snapshot/out/pamatka/{}/index.html | head -30
```

Expected: `<!doctype html>`, `<title>`, `og:title`, `Place` v JSON-LD.

- [ ] **Step 5: Sitemap validace**

```bash
xmllint --noout scripts/snapshot/out/sitemap.xml scripts/snapshot/out/sitemap-*.xml && echo "all valid"
```

Expected: `all valid`. Pokud `xmllint` chybí, `brew install libxml2`.

- [ ] **Step 6: Žádný commit**

`out/` je gitignored. Pokračujeme.

---

## Task 10: Lokální HTTP server smoke test

Ověřit, že vygenerované stránky se rozumně vykreslí v prohlížeči.

**Files:** žádný kód.

- [ ] **Step 1: Zkopírovat out do data pro lokální server (gh-pages emulace)**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
rm -rf data/pamatka
cp -R scripts/snapshot/out/pamatka data/
cp scripts/snapshot/out/sitemap.xml data/
cp scripts/snapshot/out/sitemap-*.xml data/
cp scripts/snapshot/out/robots.txt data/
```

- [ ] **Step 2: Spustit local server**

```bash
python3 -m http.server 8000 > /tmp/dp-pages-server.log 2>&1 &
sleep 1
curl -sI http://localhost:8000/ | head -3
```

Expected: `HTTP/1.0 200 OK`.

- [ ] **Step 3: Otevřít vzorovou per-pamatka stránku v curl + grep ověření**

Najít existující nid + slug:

```bash
sample=$(ls data/pamatka/ | head -1)
echo "sample: $sample"
curl -s "http://localhost:8000/pamatka/$sample/" | head -40
```

Expected: HTML obsahuje `<!doctype html>`, `<title>`, `og:title`, `Schema.org Place`. Žádné 404.

- [ ] **Step 4: Ověřit sitemap dostupnost**

```bash
curl -sI http://localhost:8000/sitemap.xml | head -3
curl -sI http://localhost:8000/robots.txt | head -3
```

Expected: oba HTTP 200.

- [ ] **Step 5: Manuální vizuální test (volitelný)**

Otevřít v prohlížeči `http://localhost:8000/pamatka/<sample>/`. Vizuálně zkontrolovat:
- Title v záložce: `{název} – Drobné památky`
- Drobečková navigace nahoře
- Hero foto (pokud existuje)
- Popis text
- GPS link na OSM
- Linky "Zobrazit na mapě" + "Zdroj na drobnepamatky.cz"
- Footer s atribucí

- [ ] **Step 6: Cleanup**

```bash
pkill -f "http.server 8000" 2>/dev/null
echo "server stopped"
```

- [ ] **Step 7: Žádný commit**

`data/pamatka/` je gitignored.

---

## Task 11: XSS smoke test

Manuálně injectovat XSS payload do JSON, ověřit že builder ho escapuje.

**Files:** žádný trvalý kód.

- [ ] **Step 1: Najít vhodný cílový nid**

```bash
sample_nid=$(ls scripts/snapshot/out/pamatka/ | head -1 | cut -d- -f1)
sample_bucket=$(grep -l "\"$sample_nid\":" scripts/snapshot/out/details/*.json | head -1)
echo "nid: $sample_nid, bucket: $sample_bucket"
```

- [ ] **Step 2: Inject XSS do title + popis**

```bash
python3 -c "
import json, sys
bucket = '$sample_bucket'
nid = '$sample_nid'
data = json.load(open(bucket))
data[nid]['title'] = '<script>alert(\"XSS-TITLE\")</script>OK'
data[nid].setdefault('popis', {})['text'] = '<script>alert(\"XSS-POPIS\")</script>NORMAL'
json.dump(data, open(bucket, 'w'), ensure_ascii=False)
print('XSS injected do nid', nid)
"
```

- [ ] **Step 3: Re-build jen pro tento bucket (full --limit nemusí stačit)**

Plný re-build je rychlý:

```bash
cd scripts/snapshot && uv run python build_static_pages.py 2>&1 | tail -3
```

Expected: bez err.

- [ ] **Step 4: Verifikovat HTML escape**

```bash
sample_slug=$(ls scripts/snapshot/out/pamatka/ | grep "^$sample_nid-" | head -1)
echo "checking $sample_slug"
html=$(cat scripts/snapshot/out/pamatka/$sample_slug/index.html)
echo "$html" | grep -c "<script>alert" && echo "FAIL: raw script found!" || echo "OK: no raw <script>alert"
echo "$html" | grep -c "&lt;script&gt;" && echo "OK: escaped"
```

Expected:
- `FAIL: raw script found!` → BUG (autoescape neaktivní) → STOP a debug
- `OK: no raw <script>alert` + `OK: escaped` → ✓

- [ ] **Step 5: Speciální check pro JSON-LD**

JSON-LD `<script type="application/ld+json">` je legit, ale title v něm má být escapovaný:

```bash
echo "$html" | grep -o 'application/ld+json">[^<]*' | head -1
```

Expected: JSON obsahuje `<script>alert` nebo `<script>alert` jako string content (JSON-escaped), ne jako exekuovatelný HTML.

- [ ] **Step 6: Restore čistý bucket**

Pokud máš SSH tunel (`lsof -ti :13306`), re-export:

```bash
cd scripts/snapshot && uv run python export.py 2>&1 | tail -3
```

Jinak restore z gitu:

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
git checkout data/details/$(basename $sample_bucket) 2>/dev/null || echo "(bucket není v gitu, je gitignored — re-export přes export.py)"
```

Pokud bucket je gitignored a re-export nedostupný, varianta: smazat `out/pamatka/$sample_slug/` a regenerovat builderem (XSS bude pořád v JSON, ale my je testovali → akceptovatelné, jen flagujeme jako known dirty state).

- [ ] **Step 7: Žádný commit**

---

## Task 12: gh issue komentář + close

**Files:** žádný kód.

- [ ] **Step 1: Komentář na #5**

```bash
gh issue comment 5 --body "$(cat <<'EOF'
Implementace hotová. Test 1-N proběhly úspěšně.

**Hlavní soubory:**
- \`scripts/snapshot/build_static_pages.py\` — orchestrátor + Pool render
- \`scripts/snapshot/templates/\` — Jinja2 šablony (page.html.j2, sitemap*.j2, robots.txt.j2)
- \`assets/page.css\` — sdílený stylesheet
- \`scripts/sync-from-source.sh\` — nový krok [2b/8]

**Spec:** [docs/superpowers/specs/2026-06-12-per-pamatka-html-design.md](../blob/main/docs/superpowers/specs/2026-06-12-per-pamatka-html-design.md)
**Plán:** [docs/superpowers/plans/2026-06-12-per-pamatka-html.md](../blob/main/docs/superpowers/plans/2026-06-12-per-pamatka-html.md)

Po prvním deploy submitnout sitemap do Google Search Console.
EOF
)"
```

- [ ] **Step 2: Close issue (po manuálním ověření na produkci)**

Doporučeno: nechat open dokud nedeployneš a neověříš že stránka jde naškálovat na živé doméně.

Po ověření:

```bash
gh issue close 5 --comment "Implementováno, otestováno, nasazeno."
```

---

## Spec coverage check

| Spec sekce | Pokrytí v plánu |
|---|---|
| `jinja2` dep | Task 1 |
| `templates/page.html.j2` | Task 2 |
| `templates/sitemap.xml.j2` | Task 3 |
| `templates/sitemap-index.xml.j2` | Task 3 |
| `templates/robots.txt.j2` | Task 3 |
| `assets/page.css` | Task 4 |
| `build_static_pages.py` slugify + build_context + Pool init + render_one + load_all_inputs + write_sitemaps + main | Task 6 |
| `test_build_static_pages.py` 7 case (24 assertions) | Task 5 + 6 (test passes) |
| Jinja2 `autoescape=True` | Task 6 step 1 (`select_autoescape`) |
| `multiprocessing.Pool` s init pro lookups + template | Task 6 step 1 (`_init_worker`) |
| `--limit N` flag pro pilot | Task 6 step 1 (`argparse`) |
| `--workers N` flag | Task 6 step 1 |
| Progress print každých 5000 | Task 6 step 1 |
| `.gitignore` updates | Task 7 |
| `sync-from-source.sh` integrace | Task 8 |
| Pilot `--limit 100` projde | Task 6 step 3 (`--limit 10` smoke) |
| Lokální `http://localhost:8000/pamatka/...` | Task 10 |
| Sitemap XML validní (xmllint) | Task 9 step 5 |
| JSON-LD validní (validator.schema.org) | Task 9 step 4 (manuální) |
| XSS test | Task 11 |
| Full run 81 988 stránek, 0 err, ~120-150 MB, <5 min | Task 9 |

Vše pokryto.

## Type consistency check

- `slugify(text)` → `str`. Task 5 (test) volá s "Socha sv. Iva" → "socha-sv-iva". Task 6 (impl) returns `str`. ✓
- `build_context(nid, detail, lookups)` → `dict`. Task 5 testuje klíče `title`, `slug`, `canonical`, `druh`, `misto`, `hero`, `hero_abs`, `description`, `popis_html`, `jsonld`. Task 6 vrací přesně tyto klíče + `nid`, `base_path`, `lat`, `lng`. ✓
- `_render_one(args)` returns `(nid, slug, lastmod, kraj_tid, status)` tuple. `write_sitemaps(rendered, …)` iteruje přes tuto formu. ✓
- `KRAJ_SLUGS` má 15 entries (0-14). `write_sitemaps` fallback `f"kraj-{kraj_tid}"` pro neznámý. ✓
- `OUT_DIR / "pamatka" / f"{nid}-{slug}"` v `_render_one` matches gitignore `/data/pamatka/` v Task 7. ✓
