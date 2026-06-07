# Export popisových textů (#8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dotáhnout `node_revisions.body` + `teaser` (~11 022 záznamů, 13.4 %) z Drupal 6 DB do statického JSON exportu a vykreslit je sanitizovaně v detail panelu mapy.

**Architecture:** Single-pass JOIN v `export.py` rozšíří `fetch_objects` o body sloupce. Sanitizace ve dvou vrstvách: `bleach` v Pythonu při exportu, `DOMPurify` v JS při renderu (defense in depth). Heuristická detekce web-scrape garbage zahodí navigační dump.

**Tech Stack:** Python 3.12 + `bleach` (přes uv), vanilla JS + DOMPurify 3.2.4 z CDN, Drupal 6 MySQL 5.5 zdroj dat.

**Spec:** `docs/superpowers/specs/2026-06-08-export-body-design.md`

---

## File Structure

| Soubor | Akce | Odpovědnost |
|---|---|---|
| `scripts/snapshot/pyproject.toml` | modify | Přidat `bleach` dependency |
| `scripts/snapshot/export.py` | modify | SQL JOIN + sanitize helpery + body do `build_detail` + logging |
| `scripts/snapshot/test_sanitize.py` | create | Lightweight test skript pro `sanitize_body` (bez frameworku) |
| `index.html` | modify | `<script>` tag pro DOMPurify s `integrity` + `crossorigin` |
| `src/app.js` | modify | Render `popis.text` přes DOMPurify v `buildDetailHtml` + post-process `<a target rel>` |
| `assets/style.css` | modify | `.detail-popis-body` typografie |

---

## Task 1: Přidat bleach dependency

**Files:**
- Modify: `scripts/snapshot/pyproject.toml`
- Modify: `scripts/snapshot/uv.lock` (auto-regenerated)

- [ ] **Step 1: Přidat bleach přes uv**

Run:
```bash
cd scripts/snapshot && uv add bleach
```

Expected output (verze se může drobně lišit, ale instalace musí uspět):
```
Resolved N packages in Xms
Installed N packages in Yms
 + bleach==6.x.x
 + …
```

- [ ] **Step 2: Ověřit, že bleach jde importovat**

Run:
```bash
cd scripts/snapshot && uv run python -c "import bleach; print('bleach', bleach.__version__, 'OK')"
```

Expected output:
```
bleach 6.x.x OK
```

- [ ] **Step 3: Commit**

```bash
git add scripts/snapshot/pyproject.toml scripts/snapshot/uv.lock
git commit -m "chore(snapshot): přidat bleach dependency pro sanitizaci body (refs #8)"
```

---

## Task 2: Napsat test skript pro `sanitize_body`

TDD – nejdřív test pro funkci, kterou ještě nemáme. Test poběží proti `export.py` po implementaci v Task 3.

**Files:**
- Create: `scripts/snapshot/test_sanitize.py`

- [ ] **Step 1: Vytvořit test skript**

Create `scripts/snapshot/test_sanitize.py`:

```python
#!/usr/bin/env python3
"""
Lightweight test skript pro sanitize_body z export.py.
Bez frameworku - spustit přes:
  cd scripts/snapshot && uv run python test_sanitize.py
Exit code 0 = všechny case pass, 1 = aspoň jeden FAIL.
"""

import sys
from export import sanitize_body, looks_like_navigation_dump

# (input, format, expectation, description)
# expectation:
#   None       → očekáváme None (text byl prázdný nebo nav-dump)
#   ('in', s)  → očekáváme, že 's' je substring výsledku
#   ('out', s) → očekáváme, že 's' NENÍ substring výsledku
CASES = [
    ('',                                                  1, None,                      'empty string → None'),
    (None,                                                1, None,                      'None → None'),
    ('   \n\n   ',                                        1, None,                      'whitespace only → None'),
    ('<script>alert(1)</script>Hello',                    1, ('out', '<script>'),       'script tag stripped'),
    ('<script>alert(1)</script>Hello',                    1, ('in', 'Hello'),           'text after script preserved'),
    ('<a href="javascript:alert(1)">x</a>',               1, ('out', 'javascript:'),    'javascript: protocol blocked'),
    ('<a href="https://ok.cz" onclick="bad()">x</a>',     1, ('out', 'onclick'),        'onclick attribute stripped'),
    ('<a href="https://ok.cz" onclick="bad()">x</a>',     1, ('in', 'href="https://ok.cz"'), 'href atribut zachován'),
    ('Menu | Úvod | Spolek | Kontakt | Mapa',             1, None,                      'pipe-separated nav dump → None'),
    ('Kaple sv. Jana.\nPostavena 1885.\nObnova 2010.',    1, ('in', 'Kaple'),           'real text kept'),
    ('<b>bold</b> a <em>italic</em>',                     1, ('out', '<b>'),            '<b> stripped (mimo whitelist)'),
    ('<b>bold</b> a <em>italic</em>',                     1, ('in', '<em>italic</em>'), '<em> zachován'),
    ('<a href="http://x.cz" rel="nofollow">x</a>',        2, ('out', '<a'),             'format=2 strips all tags'),
    ('<a href="http://x.cz" rel="nofollow">x</a>',        2, ('in', 'x'),               'format=2 text zachován'),
    ('Krátké\nslovo\nbez\ntečky\nano\nne\nnic',           1, None,                      'short-line ratio > 60 % → None'),
]


def check(text, fmt, expectation, desc):
    got = sanitize_body(text, fmt)
    if expectation is None:
        return (got is None), got
    kind, needle = expectation
    if got is None:
        return False, got
    if kind == 'in':
        return (needle in got), got
    if kind == 'out':
        return (needle not in got), got
    raise ValueError(f'unknown expectation kind: {kind}')


def main():
    failed = 0
    for text, fmt, expectation, desc in CASES:
        ok, got = check(text, fmt, expectation, desc)
        status = 'OK  ' if ok else 'FAIL'
        print(f'  {status}  {desc:60}  → {got!r}')
        if not ok:
            failed += 1
    print()
    print(f'{len(CASES) - failed}/{len(CASES)} passed')
    sys.exit(0 if failed == 0 else 1)


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Spustit a ověřit, že selže (sanitize_body ještě neexistuje)**

Run:
```bash
cd scripts/snapshot && uv run python test_sanitize.py
```

Expected: FAIL s `ImportError: cannot import name 'sanitize_body' from 'export'` (funkce ještě není implementovaná).

- [ ] **Step 3: Commit testu**

```bash
git add scripts/snapshot/test_sanitize.py
git commit -m "test(snapshot): test cases pro sanitize_body (refs #8)"
```

---

## Task 3: Implementovat `sanitize_body` + `looks_like_navigation_dump`

**Files:**
- Modify: `scripts/snapshot/export.py:22` (po importech, před `DB_CFG`)

- [ ] **Step 1: Přidat import + helpery do export.py**

V `scripts/snapshot/export.py` najít blok importů (řádky 18-22):

```python
import argparse
import json
import os
import time
import pymysql
```

Přidat za něj `import bleach` a sekci s helpery:

```python
import argparse
import json
import os
import time
import bleach
import pymysql

# ── Sanitizace popisových textů (issue #8) ─────────────────────────────
# Drupal 6 "Filtered HTML" formát (format=1, 99.95 % záznamů) povoluje
# inline tagy. Sanitizace zachová <a><br><em><strong> + http/https/mailto.
# Pro format!=1 (5 záznamů) striktně plaintext.

ALLOWED_TAGS = ['a', 'br', 'em', 'strong']
ALLOWED_ATTRS = {'a': ['href', 'rel']}
ALLOWED_PROTOCOLS = ['http', 'https', 'mailto']


def looks_like_navigation_dump(text):
    """
    Heuristika pro web-scrape garbage (např. nid 72018):
      - obsahuje pipe-separated menu (3+ '|' na řádku < 200 znaků), NEBO
      - > 60 % řádků je krátkých (<30 znaků) bez koncové interpunkce.
    """
    for line in text.splitlines():
        line_s = line.strip()
        if 0 < len(line_s) < 200 and line_s.count('|') >= 3:
            return True
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if len(lines) < 3:
        return False
    short_lines = sum(1 for l in lines
                      if len(l) < 30 and not l.endswith(('.', '!', '?', ':')))
    return (short_lines / len(lines)) > 0.6


def sanitize_body(text, fmt):
    """
    Sanitizuj Drupal body/teaser. Vrací None pro prázdný vstup nebo nav-dump.
    """
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

- [ ] **Step 2: Spustit test, ověřit že všechny case projdou**

Run:
```bash
cd scripts/snapshot && uv run python test_sanitize.py
```

Expected output:
```
  OK    empty string → None                                            → None
  OK    None → None                                                    → None
  …
  15/15 passed
```

Exit code 0.

- [ ] **Step 3: Pokud test selže, opravit dokud nepass**

Časté problémy:
- `bleach.clean(strip=True)` ponechává prázdný řetězec `""` → handle před `looks_like_navigation_dump`
- `protocols=` parametr je v `bleach 6.x` jiný než ve starších verzích — pokud `TypeError`, ověřit signaturu `bleach.clean(?)` přes `uv run python -c "import bleach; help(bleach.clean)" | head -20`

Re-run test až do 15/15 passed.

- [ ] **Step 4: Commit**

```bash
git add scripts/snapshot/export.py
git commit -m "feat(snapshot): sanitize_body + looks_like_navigation_dump helpery (refs #8)"
```

---

## Task 4: Rozšířit SQL v `fetch_objects` o body sloupce

**Files:**
- Modify: `scripts/snapshot/export.py:52-80` (funkce `fetch_objects`)

- [ ] **Step 1: Najít stávající `fetch_objects`**

Aktuální SELECT v `scripts/snapshot/export.py` (řádky 54-79):

```python
def fetch_objects(cur):
    """Všechna publikovaná data – jeden řádek per památka. Druh se dotazuje zvlášť."""
    cur.execute(
        """
        SELECT
          n.nid,
          n.title,
          n.uid AS author_uid,
          n.created,
          n.changed,
          l.latitude,
          l.longitude,
          cto.field_pridano_value AS pridano_text,
          cto.field_nkpid_value AS nkpid,
          cto.field_licence_value AS licence,
          cto.field_wd_value AS wikidata_qid,
          cto.field_zvlastnost_value AS popis_zvlastnost,
          cto.field_oborano_value AS popis_oborano,
          cto.field_wiki_value AS wiki_popis,
          cto.field_cesta_value AS cesta_popis,
          cto.field_sidlo_value AS sidlo
        FROM node n
        JOIN content_type_objekt cto ON cto.nid = n.nid AND cto.vid = n.vid
        JOIN location l ON l.lid = cto.field_pozice_lid
        WHERE n.type = 'objekt' AND n.status = 1
          AND l.latitude != 0 AND l.longitude != 0
        """
    )
    return {r["nid"]: r for r in cur.fetchall()}
```

- [ ] **Step 2: Přidat 3 nové sloupce + nový JOIN**

Nahradit celé tělo `fetch_objects` (řádky 52-80) tímto:

```python
def fetch_objects(cur):
    """Všechna publikovaná data – jeden řádek per památka. Druh se dotazuje zvlášť.
    JOIN node_revisions kvůli body/teaser (issue #8)."""
    cur.execute(
        """
        SELECT
          n.nid,
          n.title,
          n.uid AS author_uid,
          n.created,
          n.changed,
          l.latitude,
          l.longitude,
          cto.field_pridano_value AS pridano_text,
          cto.field_nkpid_value AS nkpid,
          cto.field_licence_value AS licence,
          cto.field_wd_value AS wikidata_qid,
          cto.field_zvlastnost_value AS popis_zvlastnost,
          cto.field_oborano_value AS popis_oborano,
          cto.field_wiki_value AS wiki_popis,
          cto.field_cesta_value AS cesta_popis,
          cto.field_sidlo_value AS sidlo,
          nr.body AS popis_body,
          nr.teaser AS popis_teaser,
          nr.format AS popis_format
        FROM node n
        JOIN content_type_objekt cto ON cto.nid = n.nid AND cto.vid = n.vid
        JOIN node_revisions nr ON nr.vid = n.vid
        JOIN location l ON l.lid = cto.field_pozice_lid
        WHERE n.type = 'objekt' AND n.status = 1
          AND l.latitude != 0 AND l.longitude != 0
        """
    )
    return {r["nid"]: r for r in cur.fetchall()}
```

- [ ] **Step 3: Smoke test – ověřit, že SQL se sestaví bez chyby**

Předpoklad: SSH tunel a `.env` jsou připravené (`AGENTS.md` sekce „Starý server"). Pokud tunel není aktivní:

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
set -a; source .env; set +a
ssh -f -N -L "${OLD_DB_PORT}:127.0.0.1:3306" -o ExitOnForwardFailure=yes root@drobnepamatky.cz
```

Pak pilot s `--limit 5`:

```bash
cd scripts/snapshot && uv run python export.py --limit 5
```

Expected output (poslední řádky):
```
[1/6] fetch nids …
      → 5 nidů
[2/6] fetch objects (1 row / nid) …
      → 5 objektů
…
Hotovo za X.Xs. Výstup: …/out
```

Žádná SQL chyba. Pokud chyba `Unknown column 'nr.body'`, ověřit existenci tabulky:
```bash
mysql --skip-ssl -h "$OLD_DB_HOST" -P "$OLD_DB_PORT" -u "$OLD_DB_USER" -p"$OLD_DB_PASSWORD" "$OLD_DB_NAME" -e "DESCRIBE node_revisions" | head -10
```

- [ ] **Step 4: Commit**

```bash
git add scripts/snapshot/export.py
git commit -m "feat(snapshot): SQL JOIN node_revisions + body/teaser/format sloupce (refs #8)"
```

---

## Task 5: Propojit body do `build_detail` + počítadla v `main`

**Files:**
- Modify: `scripts/snapshot/export.py:238-273` (funkce `build_detail`)
- Modify: `scripts/snapshot/export.py:336-361` (sekce `[6/7]` v `main`)

- [ ] **Step 1: Rozšířit `build_detail` o `text` + `teaser`**

Najít sekci `popis` v `build_detail` (řádky 255-261):

```python
        "popis": _strip_empty({
            "zvlastnost": obj["popis_zvlastnost"],
            "oborano": obj["popis_oborano"],
            "wiki": obj["wiki_popis"],
            "cesta": obj["cesta_popis"],
            "sidlo": obj["sidlo"],
        }),
```

Nahradit:

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

- [ ] **Step 2: Přidat počítadla do `main` sekce [6/7]**

Najít sekci `[6/7]` v `main` (kolem řádku 336, hned před `for kraj_tid, bucket in buckets.items()`):

```python
            print("[6/7] zapsat bucketed detail JSONy (per kraj_tid) …", flush=True)
            # Sloučit detaily do bucketů per kraj_tid.
            # Strategie B z plánu: 14 krajů + bucket 0 pro památky bez resolution kraje.
            # Sníží Pages disk usage z ~319 MB (per-file 4 KB block padding)
            # na ~30 MB (14 souborů × ~2 MB).
            buckets = {}
            for nid, obj in objects.items():
                detail = build_detail(
                    obj,
                    druh_per_nid.get(nid),
                    misto_per_nid.get(nid, []),
                    photos_per_nid.get(nid, []),
                )
                kraj_tid = kraj_per_nid[nid]
                buckets.setdefault(kraj_tid, {})[str(nid)] = detail
```

Nahradit za:

```python
            print("[6/7] zapsat bucketed detail JSONy (per kraj_tid) …", flush=True)
            # Sloučit detaily do bucketů per kraj_tid.
            # Strategie B z plánu: 14 krajů + bucket 0 pro památky bez resolution kraje.
            # Sníží Pages disk usage z ~319 MB (per-file 4 KB block padding)
            # na ~30 MB (14 souborů × ~2 MB).
            buckets = {}
            body_stats = {"total_with_body": 0, "kept": 0, "dropped_garbage": 0}
            for nid, obj in objects.items():
                if obj.get("popis_body"):
                    body_stats["total_with_body"] += 1
                detail = build_detail(
                    obj,
                    druh_per_nid.get(nid),
                    misto_per_nid.get(nid, []),
                    photos_per_nid.get(nid, []),
                )
                if obj.get("popis_body"):
                    if detail["popis"].get("text"):
                        body_stats["kept"] += 1
                    else:
                        body_stats["dropped_garbage"] += 1
                kraj_tid = kraj_per_nid[nid]
                buckets.setdefault(kraj_tid, {})[str(nid)] = detail
```

A přidat výpis statistiky před řádek `for kraj_tid, bucket in buckets.items():`:

```python
            print(f"      body stats: {body_stats['total_with_body']} s body, "
                  f"{body_stats['kept']} zachováno, "
                  f"{body_stats['dropped_garbage']} zahozeno (nav-dump)",
                  flush=True)
```

- [ ] **Step 3: Pilot run s `--limit 200`**

```bash
cd scripts/snapshot && uv run python export.py --limit 200
```

Expected: žádné chyby, výstup obsahuje `body stats: N s body, M zachováno, K zahozeno`. Pro 200 záznamů očekáváme cca 26 záznamů s body (13.4 %).

- [ ] **Step 4: Vizuální kontrola JSON**

Najít záznam s `text` v exportu:

```bash
cd scripts/snapshot && uv run python -c "
import json, glob
for path in glob.glob('out/details/*.json'):
    data = json.load(open(path))
    for nid, d in data.items():
        if d.get('popis', {}).get('text'):
            print(f'nid={nid}:')
            print('  text preview:', d['popis']['text'][:200])
            print('  teaser preview:', (d['popis'].get('teaser') or '')[:120])
            break
    else:
        continue
    break
"
```

Expected: smysluplný český text bez `<script>`, bez `javascript:`, bez `onclick`.

- [ ] **Step 5: Commit**

```bash
git add scripts/snapshot/export.py
git commit -m "feat(snapshot): popis.text/teaser v build_detail + body stats v exportu (refs #8)"
```

---

## Task 6: Plný export proti produkční DB

Volitelný checkpoint — full export ~82 k záznamů ověří, že nic nepadá na okrajových případech.

**Files:** žádný kód, jen běh skriptu

- [ ] **Step 1: Plný export**

```bash
cd scripts/snapshot && uv run python export.py
```

Expected output v posledních řádcích:
```
[6/7] zapsat bucketed detail JSONy (per kraj_tid) …
      body stats: ~11022 s body, ~10900-11022 zachováno, ~0-100 zahozeno (nav-dump)
      bucket … = N památek
…
[7/7] hotovo, ~82000 detailů v 15 bucketech zapsáno
Hotovo za X.Xs. Výstup: …/out
```

Doba běhu: pár desítek sekund. Pokud body stats je 0/0/0 → SQL nedotahuje sloupce, ověřit, že `nr.body` opravdu chodí (Task 4 Step 3).

- [ ] **Step 2: Diff velikosti JSON**

```bash
cd scripts/snapshot && du -sh out/details/
```

Předtím cca 30 MB, nyní cca 40-45 MB (růst o ~10 MB raw kvůli body textům).

- [ ] **Step 3: Zkopírovat do data/ pro lokální UI test**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
cp -R scripts/snapshot/out/details data/
```

Žádný commit — `data/` je gitignored (deploy přes orphan branch).

---

## Task 7: Přidat DOMPurify do `index.html`

**Files:**
- Modify: `index.html:60` (poslední `<script>` před `src/app.js`)

- [ ] **Step 1: Spočítat SHA-384 integrity hash**

```bash
curl -sL https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

Expected output: 64-znakový base64 string, např. `xyz123…AbcDef`. Zkopírovat hodnotu.

- [ ] **Step 2: Přidat `<script>` tag do `index.html`**

V `index.html` najít blok `<script>` tagů (řádky 52-61) — přidat DOMPurify jako poslední knihovnu z CDN, **před** `<script src="src/app.js">`:

```html
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
            integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
            crossorigin=""></script>
    <script src="https://unpkg.com/leaflet.glify@3.3.1/dist/glify-browser.js"
            integrity="sha384-WU7o01HFshVQYY8E/NrIBqLa5ypyxjjgAzTuP/l9BUqVSxj2VFLdvQvhItV2aWzY"
            crossorigin=""></script>
    <script src="https://cdn.jsdelivr.net/npm/minisearch@7.2.0/dist/umd/index.min.js"
            integrity="sha384-9Eacb80ywplqCp0P/bR61+zYn5Pg2LmQ7T8rppdoKHcQMmXbRh1wHwRC8avUJvnz"
            crossorigin=""></script>
    <script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js"
            integrity="sha384-<HASH_Z_STEP_1>"
            crossorigin="anonymous"></script>
    <script src="src/app.js"></script>
```

Nahradit `<HASH_Z_STEP_1>` skutečným hashem ze Step 1.

- [ ] **Step 3: Smoke test v prohlížeči**

Spustit lokální server:
```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
python3 -m http.server 8000
```

Otevřít `http://localhost:8000`, v DevTools Console:
```javascript
typeof DOMPurify
DOMPurify.version
```

Expected: `"function"`, `"3.2.4"`. Pokud Console errorem `Failed to find a valid digest …` → hash je špatně, přegenerovat ze Step 1.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(ui): načíst DOMPurify 3.2.4 z CDN s SRI (refs #8)"
```

---

## Task 8: Render `popis.text` v `buildDetailHtml`

**Files:**
- Modify: `src/app.js:326-409` (funkce `buildDetailHtml`)

- [ ] **Step 1: Přidat render bloku popis textu**

Najít v `src/app.js` blok těsně před `const meta = detail.metadata || {};` (kolem řádku 370). Přidat **mezi** `const tagsHtml = …` (řádek 368) a `const meta = detail.metadata || {};` (řádek 370) nový blok:

```js
        // Popis text (issue #8). Sanitizováno už v Pythonu přes bleach,
        // druhá vrstva DOMPurify defense in depth. Fallback: pokud by DOMPurify
        // z nějakého důvodu nebyl načtený, raději nic než nesanitizovaný HTML.
        const popisText = popis.text || popis.teaser;
        const popisHtml = (popisText && typeof DOMPurify !== 'undefined')
            ? `<div class="detail-popis-body">${DOMPurify.sanitize(popisText, {
                  ALLOWED_TAGS: ['a', 'br', 'em', 'strong'],
                  ALLOWED_ATTR: ['href', 'rel'],
              })}</div>`
            : '';
```

- [ ] **Step 2: Vložit `popisHtml` do návratu**

Najít `return` v `buildDetailHtml` (řádky 395-408):

```js
        return `
            <h2>${escapeHtml(title)}</h2>
            <p class="detail-meta">
                ${druh ? `<strong>${escapeHtml(druh)}</strong>` : ''}
                ${druh && misto ? ' · ' : ''}
                ${misto}
            </p>
            ${tagsHtml}
            ${galleryHtml}
            ${metaRows.length ? `<div class="detail-metaextra">${metaRows.join('')}</div>` : ''}
            <div class="detail-links">
                <a href="${ORIG_URL(props.i)}" target="_blank" rel="noopener">Zdroj na drobnepamatky.cz →</a>
            </div>
        `;
```

Nahradit za:

```js
        return `
            <h2>${escapeHtml(title)}</h2>
            <p class="detail-meta">
                ${druh ? `<strong>${escapeHtml(druh)}</strong>` : ''}
                ${druh && misto ? ' · ' : ''}
                ${misto}
            </p>
            ${tagsHtml}
            ${popisHtml}
            ${galleryHtml}
            ${metaRows.length ? `<div class="detail-metaextra">${metaRows.join('')}</div>` : ''}
            <div class="detail-links">
                <a href="${ORIG_URL(props.i)}" target="_blank" rel="noopener">Zdroj na drobnepamatky.cz →</a>
            </div>
        `;
```

- [ ] **Step 3: Přidat post-process pro `<a>` v `attachGalleryHandlers`**

Najít `attachGalleryHandlers` (řádky 411-425):

```js
    const attachGalleryHandlers = (detail) => {
        const hero = panelContentEl.querySelector('#detail-hero-img');
        const thumbs = panelContentEl.querySelectorAll('.gallery-thumbs img');
        if (!hero || !thumbs.length) return;
        thumbs.forEach(t => {
            t.addEventListener('click', () => {
                const idx = Number(t.dataset.fotkaIdx);
                const f = detail.fotky?.[idx];
                if (!f) return;
                hero.src = THUMB_URL(f.path);
                thumbs.forEach(x => x.classList.remove('active'));
                t.classList.add('active');
            });
        });
    };
```

Nahradit za:

```js
    const attachGalleryHandlers = (detail) => {
        const hero = panelContentEl.querySelector('#detail-hero-img');
        const thumbs = panelContentEl.querySelectorAll('.gallery-thumbs img');
        if (hero && thumbs.length) {
            thumbs.forEach(t => {
                t.addEventListener('click', () => {
                    const idx = Number(t.dataset.fotkaIdx);
                    const f = detail.fotky?.[idx];
                    if (!f) return;
                    hero.src = THUMB_URL(f.path);
                    thumbs.forEach(x => x.classList.remove('active'));
                    t.classList.add('active');
                });
            });
        }
        // External links v popisovém textu otevřít v novém tabu (DOMPurify
        // whitelistuje atributy ale nepřidává je).
        panelContentEl.querySelectorAll('.detail-popis-body a').forEach(a => {
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
        });
    };
```

- [ ] **Step 4: Smoke test v prohlížeči**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
python3 -m http.server 8000
```

V prohlížeči `http://localhost:8000`, kliknout na libovolný marker s body textem (typicky starší kvalitní záznam) — v sidebar panelu se musí ukázat blok `<div class="detail-popis-body">`. V DevTools Console:

```javascript
document.querySelector('.detail-popis-body')?.innerHTML.substring(0, 200)
```

Expected: smysluplný text bez `<script>`, `onclick`, `javascript:`. Pokud najdeš odkaz, ověřit:

```javascript
document.querySelector('.detail-popis-body a')?.target
document.querySelector('.detail-popis-body a')?.rel
```

Expected: `"_blank"`, `"noopener noreferrer"`.

- [ ] **Step 5: Commit**

```bash
git add src/app.js
git commit -m "feat(ui): render popis.text v detail panelu přes DOMPurify (refs #8)"
```

---

## Task 9: CSS typografie `.detail-popis-body`

**Files:**
- Modify: `assets/style.css` (na konec nebo k ostatním `.detail-*` selektorům)

- [ ] **Step 1: Najít existující `.detail-*` selektory**

Run:
```bash
grep -n "^\.detail-" /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky/assets/style.css
```

Použít poslední `.detail-*` blok jako kotvu pro insertion.

- [ ] **Step 2: Přidat blok CSS**

Přidat za poslední `.detail-*` selektor v `assets/style.css`:

```css
.detail-popis-body {
    margin: 0.75rem 0;
    line-height: 1.55;
    color: #2a2a2a;
    white-space: pre-wrap;
    word-wrap: break-word;
}
.detail-popis-body a {
    color: #1a5490;
    text-decoration: underline;
}
.detail-popis-body em {
    font-style: italic;
}
.detail-popis-body strong {
    font-weight: 600;
}
```

`white-space: pre-wrap` zachová odřádkování z Drupal body (autorské formátování), `word-wrap: break-word` zalomí dlouhé URL.

- [ ] **Step 3: Smoke test v prohlížeči**

Reload `http://localhost:8000`, otevřít detail památky s body textem. Ověřit:
- Text má rozumný line-height (neslepený)
- Odřádkování z Drupalu se zachová (víc odstavců = víc mezer)
- Linky jsou modré, podtržené
- Tučné / kurzíva fungují, pokud jsou v textu

- [ ] **Step 4: Commit**

```bash
git add assets/style.css
git commit -m "style(ui): .detail-popis-body typografie (refs #8)"
```

---

## Task 10: XSS smoke test

Manuální jednorázový test – ověří, že se attacker payload v JSON nevykreslí jako exekuovaný kód.

**Files:** žádná trvalá změna, dočasná manipulace `data/details/*.json`

- [ ] **Step 1: Najít vhodný cílový nid**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
python3 -c "
import json, glob
for path in glob.glob('data/details/*.json'):
    data = json.load(open(path))
    for nid, d in list(data.items())[:1]:
        print(f'bucket={path}, nid={nid}')
        break
    break
"
```

Zapsat si bucket path + nid (např. `data/details/123.json`, nid `45678`).

- [ ] **Step 2: Inject XSS payload do JSON**

Dočasně přidat `popis.text` s XSS pokusem (manuálně edit JSON, nebo skriptem):

```bash
python3 -c "
import json
path = 'data/details/123.json'   # << nahradit reálnou cestou ze Step 1
nid = '45678'                     # << nahradit reálným nid
data = json.load(open(path))
data[nid].setdefault('popis', {})['text'] = (
    '<img src=x onerror=alert(\"XSS-FAIL\")>'
    '<script>alert(\"XSS-FAIL-SCRIPT\")</script>'
    '<a href=\"javascript:alert(\\'XSS-FAIL-JS\\')\">klik</a>'
    'NORMAL_TEXT_OK'
)
json.dump(data, open(path, 'w'), ensure_ascii=False)
print('XSS payload injected do nid', nid)
"
```

- [ ] **Step 3: Reload a ověřit, že žádný alert neproskočí**

V prohlížeči otevřít `http://localhost:8000/?p=/pamatka/<nid_ze_step_1>` (nebo kliknout na ten marker na mapě).

Expected:
- Žádný `alert()` se nezobrazí
- `.detail-popis-body` obsahuje pouze text `klikNORMAL_TEXT_OK` (link bez `javascript:` href)
- DevTools Console má 0 chyb related k XSS

V DevTools Console ověřit:
```javascript
const html = document.querySelector('.detail-popis-body')?.innerHTML;
console.log('Contains <script>?', html.includes('<script>'));
console.log('Contains onerror?', html.includes('onerror'));
console.log('Contains javascript:?', html.includes('javascript:'));
```

Expected: `false, false, false` na všechna tři.

- [ ] **Step 4: Restore čistý JSON**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
cp -R scripts/snapshot/out/details data/
```

(Přepíše dočasně upravený JSON čerstvým exportem z Task 6.)

- [ ] **Step 5: Žádný commit** — `data/` je gitignored.

---

## Task 11: Aktualizovat issue + závěrečný commit

**Files:** žádný kód

- [ ] **Step 1: Krátký kontrolní průchod acceptance criteria**

Otevřít `docs/superpowers/specs/2026-06-08-export-body-design.md` sekce Acceptance criteria a manuálně odškrtnout, co je hotovo. Pokud něco zbývá, dokončit, než zavřeš issue.

- [ ] **Step 2: Zavřít issue #8 PR-friendly commitem (volitelné)**

Pokud chceš vázat jeden ze závěrečných commitů k automatickému uzavření issue, použij `closes #8` ve zprávě dalšího commitu (např. dokumentace v `AGENTS.md` o novém poli). Bez tohoto kroku zůstane issue otevřené pro manuální zavření po review.

```bash
gh issue comment 8 --body "Implementace hotová, čeká na deploy snapshotu. Spec: docs/superpowers/specs/2026-06-08-export-body-design.md, plán: docs/superpowers/plans/2026-06-08-export-body.md"
```

---

## Spec coverage check

| Spec sekce | Pokrytí v plánu |
|---|---|
| `bleach` dependency | Task 1 |
| SQL JOIN node_revisions + 3 sloupce | Task 4 |
| `sanitize_body` helper | Task 3 |
| `looks_like_navigation_dump` heuristika | Task 3 |
| `build_detail` plní `popis.text`, `popis.teaser` | Task 5 |
| Export logguje total/kept/dropped | Task 5 |
| `test_sanitize.py` skript | Task 2 |
| Full export bez chyb | Task 6 |
| DOMPurify v `index.html` s integrity/crossorigin | Task 7 |
| `buildDetailHtml` render přes DOMPurify | Task 8 |
| Fallback `typeof DOMPurify === 'undefined'` | Task 8 Step 1 |
| Post-process `target/_blank` + `rel` na `<a>` | Task 8 Step 3 |
| CSS `.detail-popis-body` | Task 9 |
| Vizuálně ověřeno na 3 vzorcích | Task 6 Step 4 + Task 8 Step 4 + Task 9 Step 3 |
| XSS test | Task 10 |

Vše pokryto.
