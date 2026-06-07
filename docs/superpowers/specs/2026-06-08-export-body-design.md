# Design: Rozšířit export o `node_revisions.body` (issue #8)

**Datum:** 2026-06-08
**Issue:** [#8](https://github.com/kratocz/drobne-pamatky/issues/8)
**Status:** schválený design, čeká na implementační plán

## Cíl

V produkční Drupal 6 DB existují bohaté popisové texty (`node_revisions.body`, `teaser`)
pro ~11 022 z 81 988 publikovaných památek (13.4 %), které aktuální `export.py` ignoruje.
Spec popisuje, jak je sanitizovaně dotáhnout do statického JSON a vykreslit v detail panelu.

## Architektura

Tok dat zůstává `DB → export.py → details/<kraj>.json → app.js → DOM`,
přidává se sanitizace na dvou místech (Python `bleach`, JS `DOMPurify`).

```
node_revisions.body (Drupal 6, 99.95% format=1 Filtered HTML, max 7937 znaků)
        │
        ▼
[export.py] fetch_objects: JOIN node_revisions nr ON nr.vid = n.vid
        │   SELECT nr.body AS popis_body, nr.teaser AS popis_teaser, nr.format AS popis_format
        ▼
[export.py] sanitize_body(text, format):
              ├─ format=1: bleach.clean(tags=[a,br,em,strong], protocols=[http,https,mailto])
              ├─ format!=1 (5 záznamů): strip vše do plaintextu
              └─ looks_like_navigation_dump() → None
        ▼
[export.py] build_detail: popis = { text, teaser, sidlo, zvlastnost, oborano, wiki, cesta }
        ▼
details/<kraj_tid>.json (statické soubory v repu, deploy na gh-pages)
        ▼
[app.js] buildDetailHtml: popis.text || popis.teaser
        │   → DOMPurify.sanitize(text, {ALLOWED_TAGS: [a,br,em,strong], ALLOWED_ATTR: [href, rel]})
        ▼
<div class="detail-popis-body">…</div> v sidebar panelu
```

## Komponenty, které se mění

1. `scripts/snapshot/export.py` — rozšířený SQL JOIN, nové funkce `sanitize_body`,
   `looks_like_navigation_dump`
2. `scripts/snapshot/pyproject.toml` — `uv add bleach`
3. `scripts/snapshot/test_sanitize.py` — nový (lightweight, bez frameworku)
4. `index.html` — `<script src=".../dompurify.min.js" integrity="…">` v `<head>`
5. `src/app.js` — render `detail.popis.text` přes DOMPurify v `buildDetailHtml`
6. `assets/style.css` — nová class `.detail-popis-body`

## SQL změny v `fetch_objects`

```sql
SELECT
  n.nid, n.title, n.uid AS author_uid, n.created, n.changed,
  l.latitude, l.longitude,
  cto.field_pridano_value AS pridano_text,
  cto.field_nkpid_value AS nkpid,
  cto.field_licence_value AS licence,
  cto.field_wd_value AS wikidata_qid,
  cto.field_zvlastnost_value AS popis_zvlastnost,
  cto.field_oborano_value AS popis_oborano,
  cto.field_wiki_value AS wiki_popis,
  cto.field_cesta_value AS cesta_popis,
  cto.field_sidlo_value AS sidlo,
  nr.body AS popis_body,          -- NEW
  nr.teaser AS popis_teaser,      -- NEW
  nr.format AS popis_format       -- NEW
FROM node n
JOIN content_type_objekt cto ON cto.nid = n.nid AND cto.vid = n.vid
JOIN node_revisions nr ON nr.vid = n.vid     -- NEW JOIN
JOIN location l ON l.lid = cto.field_pozice_lid
WHERE n.type = 'objekt' AND n.status = 1
  AND l.latitude != 0 AND l.longitude != 0
```

JOIN přes `nr.vid = n.vid` je INNER — každý publikovaný node má živou revizi,
žádné nidy se neztratí.

## JSON tvar (rozšířený `popis` blok)

```json
{
  "nid": 20094,
  "title": "…",
  "druh": {…},
  "misto_termy": […],
  "gps": [lng, lat],
  "metadata": {…},
  "popis": {
    "text": "Drobná kaple z roku 1885…<a href=\"…\">odkaz</a>",
    "teaser": "Drobná kaple z roku 1885…",
    "sidlo": "Praha",
    "zvlastnost": "Vojenská technika",
    "oborano": "ano",
    "wiki": "Q12345",
    "cesta": "ano"
  },
  "fotky": […]
}
```

`text`/`teaser` jsou součástí `popis` bloku (per issue #8). `_strip_empty()` zajistí,
že u 87 % záznamů (bez body) klíče vůbec nebudou v JSON.

**Velikost JSON:** dnes ~30 MB pro všechny details bucket. Body přidá max
+13 % × ~7937 B ≈ 11 MB raw. Po gzip (gh-pages servíruje gzipped) +pár MB.
Akceptovatelné.

## Sanitizace v Pythonu

```python
import bleach

ALLOWED_TAGS = ['a', 'br', 'em', 'strong']
ALLOWED_ATTRS = {'a': ['href', 'rel']}
ALLOWED_PROTOCOLS = ['http', 'https', 'mailto']

def sanitize_body(text, fmt):
    if not text:
        return None
    if fmt == 1:
        clean = bleach.clean(
            text,
            tags=ALLOWED_TAGS,
            attributes=ALLOWED_ATTRS,
            protocols=ALLOWED_PROTOCOLS,
            strip=True,
        )
    else:
        clean = bleach.clean(text, tags=[], strip=True)
    clean = clean.strip()
    if not clean or looks_like_navigation_dump(clean):
        return None
    return clean
```

### Garbage detekce (heuristika)

```python
def looks_like_navigation_dump(text):
    # Pipe-separated menu (např. "Menu | Úvod | Spolek | Kontakt | Mapa")
    for line in text.splitlines():
        line_s = line.strip()
        if 0 < len(line_s) < 200 and line_s.count('|') >= 3:
            return True
    # Short-line-ratio: > 60 % řádků kratších než 30 znaků bez interpunkce
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if len(lines) < 3:
        return False
    short_lines = sum(1 for l in lines
                      if len(l) < 30 and not l.endswith(('.', '!', '?', ':')))
    if short_lines / len(lines) > 0.6:
        return True
    return False
```

Při false-positive lze v budoucnu přidat per-nid allowlist; pro V1 stačí
čistá heuristika.

### Použití v `build_detail`

```python
"popis": _strip_empty({
    "text": sanitize_body(obj["popis_body"], obj["popis_format"]),
    "teaser": sanitize_body(obj["popis_teaser"], obj["popis_format"]),
    "zvlastnost": obj["popis_zvlastnost"],
    "oborano": obj["popis_oborano"],
    "wiki": obj["wiki_popis"],
    "cesta": obj["cesta_popis"],
    "sidlo": obj["sidlo"],
}),
```

### Logování při exportu

Doplnit počítadla do `[6/7]` fáze: `body_total`, `body_kept`, `body_dropped_garbage`.
Tisknout shrnutí na konci.

## UI — DOMPurify + render

### Načtení v `index.html`

```html
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js"
        integrity="sha384-<vygenerovat z curl + openssl při implementaci>"
        crossorigin="anonymous"></script>
```

Hash spočítat: `curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`.

### Render v `buildDetailHtml` (mezi `tagsHtml` a `galleryHtml`)

```js
const popisText = popis.text || popis.teaser;
const popisHtml = (popisText && typeof DOMPurify !== 'undefined')
    ? `<div class="detail-popis-body">${DOMPurify.sanitize(popisText, {
          ALLOWED_TAGS: ['a', 'br', 'em', 'strong'],
          ALLOWED_ATTR: ['href', 'rel'],
      })}</div>`
    : '';
```

Whitelist přesně mirror s `bleach` na serveru (4 tagy, 2 atributy).
Fallback `typeof DOMPurify === 'undefined'` → žádný popis (raději nic než XSS).

### Post-process external links

```js
panelContentEl.querySelectorAll('.detail-popis-body a').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
});
```

DOMPurify whitelistuje atributy, ale nepřidává — tohle je post-process.

### CSS

```css
.detail-popis-body {
    margin: 0.75rem 0;
    line-height: 1.55;
    color: #2a2a2a;
    white-space: pre-wrap;     /* zachovat odřádkování z Drupalu */
    word-wrap: break-word;
}
.detail-popis-body a {
    color: var(--link-color, #1a5490);
    text-decoration: underline;
}
.detail-popis-body em { font-style: italic; }
.detail-popis-body strong { font-weight: 600; }
```

## Bezpečnost (defense in depth)

| Vrstva | Co dělá | Co blokuje |
|---|---|---|
| Drupal admin | Filtered HTML format | `<script>`, většinu nebezpečných tagů |
| `bleach` (Python) | Whitelist tagů + atributů + protokolů | `<script>`, `onclick`, `javascript:`, `<iframe>`, vše mimo `<a><br><em><strong>` |
| `DOMPurify` (JS) | Stejný whitelist v prohlížeči | Cokoli, co by uniklo `bleach` nebo bylo dodatečně injektnuto do JSON |
| CSP headers | (Pages default, žádné inline JS od nás) | Většinu DOM-based XSS vektorů |

Data jsou user-generated z komunitního webu — nesmí se předpokládat, že jsou bezpečná
ani po Drupal filtru.

## Testing

Žádný test framework v projektu zatím není (per `AGENTS.md`). Pro tuto změnu:

1. **Pilot mode:** `uv run python export.py --limit 100` → vizuální kontrola
   `out/details/<kraj>.json`
2. **Targeted DB lookup:** ad-hoc úprava `fetch_nids` na známé nidy
   (`20094, 25608, 8893, 9217, 72018`) → ověřit kvalitní texty + nav-dump filter
3. **`scripts/snapshot/test_sanitize.py`:** lightweight skript bez pytestu, testuje
   `sanitize_body` na ~8 případech (empty, script tag, javascript: protokol,
   onclick atribut, pipe nav, real text, format!=1)
4. **UI smoke test (Playwright MCP):**
   - `?p=/pamatka/20094` → `.detail-popis-body` exists
   - `?p=/pamatka/72018` → `.detail-popis-body` neexists (nav filtered)
5. **XSS test (ručně, jednorázový):** Dočasně inject `<img src=x onerror=alert(1)>`
   do JSON, ověřit že `alert` neproskočí.

## Acceptance criteria

- [ ] `bleach` přidán do `pyproject.toml` přes `uv add bleach`
- [ ] `export.py`:
  - [ ] SQL: nový JOIN `node_revisions nr ON nr.vid = n.vid` + 3 nové sloupce
  - [ ] `sanitize_body(text, fmt)` helper s bleach whitelist `<a><br><em><strong>`
  - [ ] `looks_like_navigation_dump(text)` heuristika
  - [ ] `build_detail` plní `popis.text`, `popis.teaser`
  - [ ] Export logguje počty: total / kept / dropped_garbage
- [ ] `test_sanitize.py` ručně spuštěn, všechny case pass
- [ ] Full export běží bez chyb (~82 k záznamů, ~13 % obsahuje `popis.text`)
- [ ] `index.html` načítá DOMPurify 3.2.x z CDN s `integrity` + `crossorigin`
- [ ] `app.js`:
  - [ ] `buildDetailHtml` renderuje `popis.text || popis.teaser` přes DOMPurify
  - [ ] Fallback `typeof DOMPurify === 'undefined'` → žádný popis
  - [ ] Post-process `target="_blank"` + `rel="noopener noreferrer"` na `<a>`
- [ ] `style.css`: `.detail-popis-body` typografie
- [ ] Vizuálně ověřeno na 3 vzorcích (krátký, dlouhý, s HTML linky)
- [ ] XSS test prošel (alert neproskočí)

## Mimo scope

- **Migrace na `uv`** — udělána samostatným commitem (`3692495b9`) před tímto issue
- **CI pipeline** — žádný projekt zatím nemá; nezavádět kvůli jednomu issue
- **Pytest framework** — overkill pro jeden helper, lightweight skript stačí
- **Per-nid allowlist garbage filteru** — V2, pokud heuristika dá false positives
- **Migrace ostatních polí (Wikidata Q-link, fotka credits)** — vlastní issues
