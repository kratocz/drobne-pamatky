# Design: Per-pamatka HTML + sitemap (issue #5)

- **Datum:** 2026-06-12
- **Issue:** [#5](https://github.com/kratocz/drobne-pamatky/issues/5)
- **Status:** schválený design, čeká na implementační plán

## Cíl

Vyrobit statické per-pamatka HTML stránky pro všech 81 988 záznamů, aby crawlery (Google,
Seznam, Bing) a AI scrapery (GPTBot, ClaudeBot, Perplexity) měly přístup k obsahu i bez
JS. Současný SPA je pro většinu crawlerů neviditelný.

## Architektura

Nový builder `scripts/snapshot/build_static_pages.py` (vzor `build_thumbnails.py` — Pool worker
paralelizace). Vstup z existujícího exportu, výstup statické HTML soubory pro každou památku +
sitemap rozdělená po krajích.

```
out/details/<kraj>.json   ──┐
out/pamatky.geojson         ├─→  [build_static_pages.py]  ──→  out/pamatka/<nid>-<slug>/index.html × 82k
out/lookups.json            │                                  out/sitemap.xml (index)
                            │                                  out/sitemap-<kraj>.xml × 15
templates/page.html.j2      │                                  out/robots.txt
templates/sitemap.xml.j2    ┘
templates/sitemap-index.xml.j2
templates/robots.txt.j2

sync-from-source.sh kopíruje out/pamatka/, out/sitemap*.xml, out/robots.txt → data/
deploy.sh existujícím rsync přesune data/ → gh-pages root
```

## File structure

| Soubor | Akce | Odpovědnost |
|---|---|---|
| `scripts/snapshot/pyproject.toml` | modify | `uv add jinja2` |
| `scripts/snapshot/build_static_pages.py` | create | Orchestrátor + per-pamatka render Pool |
| `scripts/snapshot/test_build_static_pages.py` | create | 5-7 lightweight test case (slugify, build_context) |
| `scripts/snapshot/templates/page.html.j2` | create | Slim+ šablona (~1.5 KB raw) |
| `scripts/snapshot/templates/sitemap.xml.j2` | create | Per-kraj urlset |
| `scripts/snapshot/templates/sitemap-index.xml.j2` | create | Master index |
| `scripts/snapshot/templates/robots.txt.j2` | create | robots + sitemap link |
| `assets/page.css` | create | Sdílený stylesheet pro per-pamatka stránky (~600 B) |
| `scripts/sync-from-source.sh` | modify | Nový krok `[2b/N]` + kopie do data/ v `[7/N]` |
| `.gitignore` | modify | `data/pamatka/`, `data/sitemap*.xml`, `data/robots.txt` |

## Layout — slim+ (schválený)

**Klíčové rozhodnutí:** GitHub Pages má hard limit 1 GB publikovaného site. Reálné měření
na 200 vzorcích ukázalo:

| Varianta | Avg raw / stránka | 81k celkem | Po gzip |
|---|---:|---:|---:|
| full (2 JSON-LD + OG + Twitter + galerie) | 3.1 KB | 248 MB | 80 MB |
| opt (1 JSON-LD, minified, bez Twitter title/desc) | 2.2 KB | 174 MB | 63 MB |
| **slim+** (1 JSON-LD Place, OG, 1 hero, breadcrumb) | ~1.5 KB | ~120 MB | ~50 MB |
| slim (jen meta + title + content) | 0.85 KB | 66 MB | 37 MB |

**Celkem po nasazení s slim+:** 872 MB (aktuální `data/`) + 120 MB HTML + 16 MB sitemap = ~1.008 GB.
Mírné překročení limitu — akceptujeme jako risk, fallback varianty (q40 thumbs, dropnout
JSON-LD) připravené pokud GH zablokuje.

### Slim+ obsah per stránka

- `<title>{name} – Drobné památky</title>`
- `<meta description>` (ořezané z popis na 155 znaků)
- `<link rel="canonical">` (absolutní URL)
- `<meta robots="index, follow">`
- Open Graph: `og:title`, `og:description`, `og:image` (hero), `og:url`, `og:type=article`, `og:site_name`
- `<meta twitter:card="summary[_large_image]">` (jen card type, ostatní dědí z OG)
- **JSON-LD Schema.org Place** (name, description, image, geo, url, isPartOf)
- `<header>` — drobečková navigace: Drobné památky › mapa › {název}
- `<h1>{name}</h1>`
- `<p><strong>{druh}</strong> · {kraj › okres › obec}</p>`
- 1 hero `<img>` (250×250 AVIF, lazy load) — žádná plná galerie
- `<div>{popis_html|safe}</div>` (bleach-sanitized z #8, `\n` → `<br>`)
- `<p>GPS: <a href="osm">{lat}, {lng}</a></p>` (OSM link s pinem)
- `<nav>` — link na mapu + link na drobnepamatky.cz zdroj
- `<footer>` atribuce
- `<link rel="stylesheet" href="assets/page.css">`

**Sémantika pro crawlery i lidi bez JS — bez search inputu** (bez JS nefunguje, byl by mrtvá UI).

## SQL / data flow

`build_static_pages.py` čte:
- `out/lookups.json` — druh/místo lookup (sdílený mezi workery přes Pool initializer)
- `out/details/*.json` — per-bucket data (`build_thumbnails.py`-style iterace)
- `out/pamatky.geojson` — *nepotřebujeme*, vše je v details

Nepotřebujeme DB query — všechny vstupy jsou z exportu `export.py`. Builder běží **po**
`export.py` a `build_search_index.js`.

## Šablona — page.html.j2

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

## Sitemap — per-kraj chunking

Sitemaps spec povoluje max 50 000 URL per sitemap, my máme 82k → rozděleno po 15 krajích
(14 krajů ČR + bucket 0 pro "neznámý kraj"). Index `sitemap.xml` odkazuje na 15 chunků.

```jinja2
{# sitemap.xml.j2 — per kraj #}
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{% for p in pages -%}
<url><loc>{{ p.canonical }}</loc><lastmod>{{ p.lastmod }}</lastmod><priority>0.6</priority></url>
{% endfor -%}
</urlset>

{# sitemap-index.xml.j2 #}
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{% for kraj in krajse -%}
<sitemap><loc>{{ site_base }}sitemap-{{ kraj.slug }}.xml</loc><lastmod>{{ build_date }}</lastmod></sitemap>
{% endfor -%}
</sitemapindex>

{# robots.txt.j2 #}
User-agent: *
Allow: /

Sitemap: {{ site_base }}sitemap.xml
```

`lastmod` per stránka: `metadata.changed_ts` nebo `metadata.created_ts` z details JSON,
formátováno jako `YYYY-MM-DD`.

## Builder logika

```python
# scripts/snapshot/build_static_pages.py — struktura

import argparse, json, os, time, unicodedata, re
from multiprocessing import Pool
from pathlib import Path
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import escape

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "scripts" / "snapshot" / "out"
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
    """Diakritika striped, lowercase, max 80 znaků."""
    nfkd = unicodedata.normalize("NFKD", text or "")
    ascii_text = "".join(c for c in nfkd if not unicodedata.combining(c))
    s = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text.lower()).strip("-")
    return s[:80].rstrip("-")


def build_context(nid, detail, lookups):
    """Připraví dict pro jinja2 render."""
    title = detail.get("title", "")
    popis_block = detail.get("popis") or {}
    popis_text = popis_block.get("text") or popis_block.get("teaser") or ""
    description = (popis_text[:150].rstrip() + "…") if len(popis_text) > 155 \
                  else (popis_text or f"Drobná památka {title} v ČR.")

    druh = (detail.get("druh") or {}).get("name", "")
    misto_chain = []
    for tid in detail.get("misto_termy") or []:
        info = lookups["misto"].get(str(tid))
        if info: misto_chain.append(info["name"])
    misto = " › ".join(misto_chain[:3])

    gps = detail.get("gps") or [0, 0]
    lng, lat = gps[0], gps[1]

    fotky = detail.get("fotky") or []
    hero = hero_abs = None
    if fotky and "/" in fotky[0].get("path", ""):
        avif = fotky[0]["path"].split("/", 1)[1].replace(".jpg", ".avif")
        hero = f"{BASE_PATH}data/thumbs/{avif}"
        hero_abs = f"{SITE_BASE}data/thumbs/{avif}"

    slug = slugify(title)
    canonical = f"{SITE_BASE}pamatka/{nid}-{slug}/"
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


# Worker init — každý proces si jednou nahraje lookups + zkompiluje šablonu
_WORKER_STATE = {}

def _init_worker(lookups_path, template_path):
    _WORKER_STATE["lookups"] = json.loads(Path(lookups_path).read_text(encoding="utf-8"))
    env = Environment(
        loader=FileSystemLoader(str(template_path)),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True, lstrip_blocks=True,
    )
    _WORKER_STATE["tpl"] = env.get_template("page.html.j2")


def _render_one(args):
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
        return (nid, "", "", kraj_tid, f"err: {e}")
```

**Klíčové prvky:**
- `multiprocessing.Pool` s `initializer` → zero overhead per stránka
- `imap_unordered(chunksize=200)` → batchové dispatching jako `build_thumbnails.py`
- Odhadem 200-500 stránek/s × 10 workers ≈ **30-60s pro celý běh**
- Jeden worker padne → status `err` v results, ostatní pokračují
- Stats counter + progress print každých 5000

## Integrace do sync-from-source.sh

Mezi `[2/7] build_search_index.js` a `[3/7] manifest diff` přidat:

```bash
echo "─── [2b/8] build_static_pages.py ───"
(cd scripts/snapshot && uv run python build_static_pages.py)
```

Číslování ostatních kroků se posune na 8 fází.

V copy fázi `[7/8]`:

```bash
cp -R scripts/snapshot/out/pamatka data/
cp scripts/snapshot/out/sitemap.xml scripts/snapshot/out/sitemap-*.xml data/
cp scripts/snapshot/out/robots.txt data/
```

`deploy.sh` už dnes `rsync -a data/ → gh-pages` → kopíruje vše automaticky.

## Bezpečnost

| Vrstva | Co dělá |
|---|---|
| `bleach` (Python, #8) | Sanitizuje `popis.text` při exportu z DB |
| `markupsafe.escape` (Python) | Escape pro `popis_html` před vložením `<br>` |
| Jinja2 `autoescape=True` | Auto-escape všech `{{ var }}` v šabloně |
| `|safe` filter | Jen na 2 polích: `popis_html` (už escapovaný) a `jsonld` (JSON string je sám validní) |

XSS test (manuální): inject `<script>alert(1)</script>` do title v JSON, re-run builder,
ověřit že generovaný HTML obsahuje jen `&lt;script&gt;alert(1)&lt;/script&gt;`.

## Testing

Žádný test framework (per `AGENTS.md`). Pro #5:

1. **`test_build_static_pages.py`** — 5-7 case:
   - `slugify("Socha sv. Iva")` → `"socha-sv-iva"`
   - `slugify("Příliš žluťoučký kůň")` → `"prilis-zlutoucky-kun"`
   - `slugify("")` → `""`
   - `slugify("@#$%^&*()")` → `""`
   - `build_context` s minimálním detail → očekávaný klíče
   - `build_context` s prázdným `popis` → `description` = fallback
   - `build_context` s prázdnými `fotky` → `hero=None`

2. **Pilot smoke test** `--limit 100`:
   ```bash
   cd scripts/snapshot && uv run python build_static_pages.py --limit 100
   ```
   Lokálně otevřít `http://localhost:8000/pamatka/<sample-nid>-<slug>/`.

3. **Schema.org JSON-LD validation** přes [validator.schema.org](https://validator.schema.org/) — manuální, jednorázové.

4. **Sitemap validation:**
   ```bash
   xmllint --noout out/sitemap.xml out/sitemap-*.xml
   ```

5. **GH Pages local emulation:** `python3 -m http.server 8000` v repo root, ověřit:
   - `http://localhost:8000/pamatka/8980-socha-sv-iva/` se otevře
   - `http://localhost:8000/sitemap.xml` se otevře
   - `http://localhost:8000/robots.txt` se otevře

6. **XSS smoke test:** inject `<script>` do title v JSON, re-build, ověřit escape.

## Acceptance criteria

- [ ] `jinja2` přidán do `pyproject.toml` přes `uv add`
- [ ] `templates/`:
  - [ ] `page.html.j2` (slim+ šablona)
  - [ ] `sitemap.xml.j2` (per-kraj urlset)
  - [ ] `sitemap-index.xml.j2` (master index)
  - [ ] `robots.txt.j2`
- [ ] `assets/page.css` (~600 B sdílený stylesheet)
- [ ] `scripts/snapshot/build_static_pages.py`:
  - [ ] `slugify()`, `build_context()`, `_init_worker()`, `_render_one()`, `load_all_inputs()`, `write_sitemaps()`, `main()`
  - [ ] Jinja2 `autoescape=True`
  - [ ] `multiprocessing.Pool` s init pro lookups + template
  - [ ] `--limit N` flag pro pilot
  - [ ] `--workers N` flag (default `os.cpu_count()`)
  - [ ] Progress print každých 5000
- [ ] `scripts/snapshot/test_build_static_pages.py` (5-7 case projdou)
- [ ] `scripts/sync-from-source.sh`:
  - [ ] Nový krok `[2b/8]` build_static_pages
  - [ ] `[7/8]` kopie přidá `out/pamatka/`, `out/sitemap*.xml`, `out/robots.txt`
- [ ] `.gitignore`: `data/pamatka/`, `data/sitemap*.xml`, `data/robots.txt`
- [ ] Pilot `--limit 100` projde bez err, vizuálně ověřeno
- [ ] Lokálně `http://localhost:8000/pamatka/<nid>-<slug>/` vykreslí
- [ ] Sitemap XML validní (xmllint)
- [ ] JSON-LD validní (validator.schema.org)
- [ ] XSS test: payload v JSON neproskočí jako exekuovatelný script
- [ ] Full run bez `--limit`:
  - [ ] 81 988 stránek vygenerováno, 0 err
  - [ ] Velikost `out/pamatka/` cca 120-150 MB
  - [ ] 15 sitemap files + 1 index + 1 robots.txt
  - [ ] Doba běhu < 5 min
- [ ] Po deploy:
  - [ ] `https://kratocz.github.io/drobne-pamatky/pamatka/8980-socha-sv-iva/` se otevře
  - [ ] view-source ukáže reálné meta tagy + JSON-LD
  - [ ] `https://kratocz.github.io/drobne-pamatky/sitemap.xml` se otevře
  - [ ] Submit sitemap do Google Search Console

## Mimo scope

- **Image processor upgrade** — řeší se v issue #11 (GitHub Actions automation)
- **CDN pro thumbs** — fallback pokud překročíme 1 GB limit
- **Per-pamatka HTML redesign / další obsah** — slim+ je výchozí, větší změny vlastní follow-up issue
- **`data/details/*.json` deduplication** — SPA stále načítá z těchto JSON, per-pamatka HTML je samostatná vrstva pro crawlery
- **i18n** — zatím jen čeština
- **Sitemap ping search engines** — Google + Bing API deprekované, stačí robots.txt + Search Console submit
- **Galerie** — slim+ má jen hero foto, plné galerie by zvedly HTML o ~400 B / stránka
- **Twitter Card title/description** — Twitter dědí z OG, stačí jen `twitter:card` typ
- **Breadcrumb JSON-LD** — text drobečková navigace v `<header>` stačí, Google ji čte i bez schema
