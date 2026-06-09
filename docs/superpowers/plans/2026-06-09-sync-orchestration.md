# Sync orchestration (#1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jeden bash skript `scripts/sync-from-source.sh`, který stáhne aktuální data z Drupal 6 produkce, spustí export + thumbs pipeline a aktualizuje lokální `data/` (bez auto-commitu).

**Architecture:** Bash wrapper orchestruje existující skripty (`export.py`, `build_search_index.js`, `build_thumbnails.py`) + nový Python helper (`sync_manifest_diff.py`) pro diff JPG manifestu. `data/thumbs-manifest.json` jako persistent snapshot stavu pro idempotentní sync (rsync stahuje jen nové/změněné JPG z VPS).

**Tech Stack:** bash + uv-managed Python (PyMySQL) + Node (existing build_search_index.js) + rsync/ssh + macOS sips/avifenc.

**Spec:** `docs/superpowers/specs/2026-06-08-sync-orchestration-design.md`

---

## File Structure

| Soubor | Akce | Odpovědnost |
|---|---|---|
| `scripts/sync-from-source.sh` | create | Orchestrace pipeline (pre-flight → tunnel → export → diff → rsync → thumbs → copy → cleanup) |
| `scripts/snapshot/export.py` | modify | + `fetch_files_manifest()` → `out/files-manifest.json` |
| `scripts/snapshot/sync_manifest_diff.py` | create | Diff wanted vs. existing → 3 výstupní soubory (to-generate, to-delete, to-rsync) + nový thumbs-manifest |
| `scripts/snapshot/test_manifest_diff.py` | create | 6 lightweight test cases |
| `scripts/snapshot/build_thumbnails.py` | modify | + `--only <paths.txt>` flag + env `JPG_SOURCE_DIR` |
| `data/thumbs-manifest.json` | NEW (initial empty `{}`) | Persistent snapshot stavu `data/thumbs/` |
| `AGENTS.md` | modify | + sekce "Sync ze zdroje" v Run/build/test |

---

## Task 1: `fetch_files_manifest` v export.py

**Files:**
- Modify: `scripts/snapshot/export.py` (přidat novou fetch funkci + write do main)

- [ ] **Step 1: Přidat `fetch_files_manifest` funkci**

V `scripts/snapshot/export.py` najít blok ostatních `fetch_*` funkcí (mezi `fetch_photos_per_nid` a `resolve_kraj_tid`, kolem řádku 215). Přidat za `fetch_photos_per_nid`:

```python
def fetch_files_manifest(cur):
    """Manifest všech JPG linknutých na publikované památky.
    Slouží sync-from-source.sh jako diff base pro thumbs (issue #1).
    
    Vrací dict {filepath: {fid, size, timestamp}}.
    """
    cur.execute(
        """
        SELECT DISTINCT
          f.fid, f.filepath, f.filesize, f.timestamp
        FROM files f
        JOIN content_field_obrazek cfo ON cfo.field_obrazek_fid = f.fid
        JOIN node n ON n.nid = cfo.nid AND n.vid = cfo.vid
        WHERE n.type = 'objekt' AND n.status = 1
          AND f.filemime = 'image/jpeg'
        """
    )
    return {r["filepath"]: {
        "fid": r["fid"],
        "size": r["filesize"],
        "timestamp": r["timestamp"],
    } for r in cur.fetchall()}
```

- [ ] **Step 2: Zavolat fetch + zapsat manifest v `main()`**

V `main()` najít sekci `[3/6] fetch druh + místo + hierarchie + autoři …` (kolem řádku 298). Hned **po** řádku s `users = fetch_users(cur)` a jeho print, přidat:

```python
            print("[3b/6] fetch files manifest (JPG → fid/size/timestamp) …", flush=True)
            files_manifest = fetch_files_manifest(cur)
            print(f"      → {len(files_manifest)} JPG souborů", flush=True)
```

Pak najít sekci `[5/7] build & zapsat master GeoJSON + lookups + search-data …`. Hned **po** `search_data = build_search_data(...)` (a před `with open(...) as f: json.dump(geojson, ...)`), přidat zápis manifestu:

```python
            with open(os.path.join(OUT_DIR, "files-manifest.json"), "w", encoding="utf-8") as f:
                json.dump(
                    {"generated_ts": int(time.time()), "files": files_manifest},
                    f, ensure_ascii=False, separators=(",", ":"), default=str
                )
```

- [ ] **Step 3: Pilot run + verifikace**

SSH tunel musí být UP na portu 13306. Pokud není, sync skript ho otevře, ale tady poběží `export.py` samostatně, takže ho musíš pustit ručně:

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
set -a; source .env; set +a
ssh -f -N -L 13306:127.0.0.1:3306 -o ExitOnForwardFailure=yes root@drobnepamatky.cz 2>/dev/null || echo "(tunnel may already be running)"
```

Pak:

```bash
cd scripts/snapshot && uv run python export.py --limit 50 2>&1 | tail -10
```

Expected output obsahuje `[3b/6] fetch files manifest …` line, žádné chyby.

Pak ověřit manifest:

```bash
jq '.files | length, (.files | to_entries[0])' out/files-manifest.json
```

Expected: nenulové číslo (kolem 50-100, podle počtu fotek per památka) + jeden záznam typu `{"files/<rok>/<basename>.jpg": {"fid": N, "size": N, "timestamp": N}}`.

- [ ] **Step 4: Commit**

```bash
git add scripts/snapshot/export.py
git commit -m "feat(snapshot): fetch_files_manifest → out/files-manifest.json (refs #1)"
```

---

## Task 2: Lightweight test pro `sync_manifest_diff`

TDD: test je první, poběží červeně (modul ještě neexistuje).

**Files:**
- Create: `scripts/snapshot/test_manifest_diff.py`

- [ ] **Step 1: Vytvořit test skript**

Create `scripts/snapshot/test_manifest_diff.py`:

```python
#!/usr/bin/env python3
"""
Lightweight test pro sync_manifest_diff.compute_diff.
Bez frameworku - spustit přes:
  cd scripts/snapshot && uv run python test_manifest_diff.py
Exit code 0 = pass, 1 = aspoň jeden FAIL.
"""

import sys
from sync_manifest_diff import compute_diff


# (wanted, existing, expected_generate, expected_delete, expected_rsync, description)
CASES = [
    (
        {},
        {},
        [], [], [],
        "empty wanted + empty existing → no action",
    ),
    (
        # wanted has new entry → generate + rsync
        {"2020/img_1.avif": {"filepath": "files/2020/img_1.jpg", "fid": 1, "size": 100, "timestamp": 1577836800}},
        {},
        ["2020/img_1.avif"], [], ["files/2020/img_1.jpg"],
        "new entry → generate + rsync",
    ),
    (
        # existing has stale entry → delete
        {},
        {"2020/img_1.avif": {"fid": 1, "size": 100, "timestamp": 1577836800}},
        [], ["2020/img_1.avif"], [],
        "stale entry → delete",
    ),
    (
        # both identical → no action
        {"2020/img_1.avif": {"filepath": "files/2020/img_1.jpg", "fid": 1, "size": 100, "timestamp": 1577836800}},
        {"2020/img_1.avif": {"fid": 1, "size": 100, "timestamp": 1577836800}},
        [], [], [],
        "identical → no action",
    ),
    (
        # differ in size → regenerate
        {"2020/img_1.avif": {"filepath": "files/2020/img_1.jpg", "fid": 1, "size": 200, "timestamp": 1577836800}},
        {"2020/img_1.avif": {"fid": 1, "size": 100, "timestamp": 1577836800}},
        ["2020/img_1.avif"], [], ["files/2020/img_1.jpg"],
        "size differs → regenerate",
    ),
    (
        # differ in timestamp → regenerate
        {"2020/img_1.avif": {"filepath": "files/2020/img_1.jpg", "fid": 1, "size": 100, "timestamp": 1609459200}},
        {"2020/img_1.avif": {"fid": 1, "size": 100, "timestamp": 1577836800}},
        ["2020/img_1.avif"], [], ["files/2020/img_1.jpg"],
        "timestamp differs → regenerate",
    ),
]


def main():
    failed = 0
    for i, (wanted, existing, exp_gen, exp_del, exp_rsync, desc) in enumerate(CASES, 1):
        gen, deleted, rsync = compute_diff(wanted, existing)
        ok = (sorted(gen) == sorted(exp_gen)
              and sorted(deleted) == sorted(exp_del)
              and sorted(rsync) == sorted(exp_rsync))
        status = 'OK  ' if ok else 'FAIL'
        print(f"  {status}  case {i}: {desc}")
        if not ok:
            print(f"        expected: gen={exp_gen}, del={exp_del}, rsync={exp_rsync}")
            print(f"        got:      gen={gen}, del={deleted}, rsync={rsync}")
            failed += 1
    print()
    print(f"{len(CASES) - failed}/{len(CASES)} passed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Spustit a ověřit FAIL (modul neexistuje)**

```bash
cd scripts/snapshot && uv run python test_manifest_diff.py
```

Expected: `ImportError` nebo `ModuleNotFoundError` na řádku `from sync_manifest_diff import compute_diff`.

- [ ] **Step 3: Commit failing test**

```bash
git add scripts/snapshot/test_manifest_diff.py
git commit -m "test(snapshot): 6 case pro sync_manifest_diff.compute_diff (refs #1)"
```

---

## Task 3: Implementace `sync_manifest_diff.py`

**Files:**
- Create: `scripts/snapshot/sync_manifest_diff.py`

- [ ] **Step 1: Vytvořit modul s `compute_diff` + CLI**

Create `scripts/snapshot/sync_manifest_diff.py`:

```python
#!/usr/bin/env python3
"""
Diff "wanted" (z files-manifest.json přes export.py) vs. "existing" (z
data/thumbs-manifest.json) pro orchestraci thumbs sync (issue #1).

CLI:
  uv run python sync_manifest_diff.py \\
      --wanted out/files-manifest.json \\
      --existing ../../data/thumbs-manifest.json \\
      --to-generate /tmp/thumbs-to-generate.txt \\
      --to-delete /tmp/thumbs-to-delete.txt \\
      --to-rsync /tmp/jpg-to-rsync.txt \\
      --new-manifest /tmp/thumbs-manifest-new.json

Filepath → thumb_path mapping (musí ladit s build_thumbnails.convert_one):
  files/2022/img_1.jpg → 2022/img_1.avif
  Konkrétně: parts = filepath.split("/")
             parts[0] musí být "files", parts[1] = rok
             basename = Path(parts[-1]).stem + ".avif"
             thumb_path = f"{parts[1]}/{basename}"
"""

import argparse
import json
import sys
from pathlib import Path


def filepath_to_thumb_path(filepath):
    """files/2022/img_1.jpg → 2022/img_1.avif.
    Vrací None pro neočekávaný tvar (musí ladit s build_thumbnails.convert_one).
    
    Pozn.: Drupal 6 v gk66 ukládá filepath relativně k web rootu jako
    "files/<rok>/<basename>.jpg" (NE "sites/default/files/..."). VPS web root
    je /www/drobnepamatky.cz/www/, takže rsync --files-from přijímá tyto cesty
    přímo (źdrojový root v rsync je /www/drobnepamatky.cz/www/).
    """
    parts = filepath.split("/")
    if len(parts) < 3 or parts[0] != "files":
        return None
    rok = parts[1]
    basename = Path(parts[-1]).stem + ".avif"
    return f"{rok}/{basename}"


def build_wanted_index(files_manifest):
    """{filepath: {fid, size, timestamp}} → {thumb_path: {filepath, fid, size, timestamp}}."""
    wanted = {}
    for filepath, meta in files_manifest.items():
        thumb_path = filepath_to_thumb_path(filepath)
        if thumb_path is None:
            continue
        wanted[thumb_path] = {
            "filepath": filepath,
            "fid": meta["fid"],
            "size": meta["size"],
            "timestamp": meta["timestamp"],
        }
    return wanted


def compute_diff(wanted, existing):
    """Vrací (to_generate, to_delete, to_rsync) — všechny seznamy stringů.
    
    to_generate: thumb_paths kterým chybí nebo se změnil obsah (size/timestamp)
    to_delete:   thumb_paths které jsou v existing ale ne ve wanted
    to_rsync:    filepaths JPG ke stažení (1:1 s to_generate, ale jen filepath)
    """
    to_generate = []
    to_delete = []
    to_rsync = []

    wanted_paths = set(wanted.keys())
    existing_paths = set(existing.keys())

    for tp in wanted_paths - existing_paths:
        to_generate.append(tp)
        to_rsync.append(wanted[tp]["filepath"])

    for tp in existing_paths - wanted_paths:
        to_delete.append(tp)

    for tp in wanted_paths & existing_paths:
        w, e = wanted[tp], existing[tp]
        if (w["size"], w["timestamp"]) != (e["size"], e["timestamp"]):
            to_generate.append(tp)
            to_rsync.append(w["filepath"])

    return to_generate, to_delete, to_rsync


def build_new_existing_manifest(wanted):
    """Konvertuje wanted index zpět na tvar, který se ukládá do data/thumbs-manifest.json
    (bez `filepath`, jen fid/size/timestamp)."""
    return {tp: {"fid": w["fid"], "size": w["size"], "timestamp": w["timestamp"]}
            for tp, w in wanted.items()}


def write_lines(path, lines):
    """Zapíše seznam stringů, jeden per řádek."""
    Path(path).write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--wanted", required=True, help="Cesta k out/files-manifest.json")
    p.add_argument("--existing", required=True, help="Cesta k data/thumbs-manifest.json (může neexistovat = empty)")
    p.add_argument("--to-generate", required=True, help="Výstup: thumb_paths k vygenerování (per řádek)")
    p.add_argument("--to-delete", required=True, help="Výstup: thumb_paths ke smazání (per řádek)")
    p.add_argument("--to-rsync", required=True, help="Výstup: JPG filepath ke stažení (per řádek)")
    p.add_argument("--new-manifest", required=True, help="Výstup: nový thumbs-manifest.json (po úspěšném sync se přepíše existing)")
    args = p.parse_args()

    files_manifest = json.loads(Path(args.wanted).read_text(encoding="utf-8"))
    wanted = build_wanted_index(files_manifest["files"])

    if Path(args.existing).exists():
        existing = json.loads(Path(args.existing).read_text(encoding="utf-8"))
    else:
        existing = {}

    to_generate, to_delete, to_rsync = compute_diff(wanted, existing)

    write_lines(args.to_generate, to_generate)
    write_lines(args.to_delete, to_delete)
    write_lines(args.to_rsync, to_rsync)

    new_manifest = build_new_existing_manifest(wanted)
    Path(args.new_manifest).write_text(
        json.dumps(new_manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    print(f"diff: {len(to_generate)} k vygenerování, "
          f"{len(to_delete)} ke smazání, "
          f"{len(to_rsync)} JPG ke stažení", file=sys.stderr)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Spustit test, ověřit 6/6 pass**

```bash
cd scripts/snapshot && uv run python test_manifest_diff.py
```

Expected: `6/6 passed`, exit 0.

Pokud nějaký case selže, oprav `compute_diff` (ne test), znovu spusť.

- [ ] **Step 3: CLI smoke test**

Vyrobit minimální fixture a spustit CLI:

```bash
cd scripts/snapshot
mkdir -p /tmp/dp-test
cat > /tmp/dp-test/wanted.json <<'EOF'
{"generated_ts": 0, "files": {"files/2020/img_1.jpg": {"fid": 1, "size": 100, "timestamp": 1577836800}}}
EOF
echo '{}' > /tmp/dp-test/existing.json

uv run python sync_manifest_diff.py \
    --wanted /tmp/dp-test/wanted.json \
    --existing /tmp/dp-test/existing.json \
    --to-generate /tmp/dp-test/gen.txt \
    --to-delete /tmp/dp-test/del.txt \
    --to-rsync /tmp/dp-test/rsync.txt \
    --new-manifest /tmp/dp-test/new-manifest.json

cat /tmp/dp-test/gen.txt /tmp/dp-test/rsync.txt
cat /tmp/dp-test/new-manifest.json
```

Expected: `gen.txt` obsahuje `2020/img_1.avif`, `rsync.txt` obsahuje `files/2020/img_1.jpg`, `new-manifest.json` má jeden záznam s `{fid, size, timestamp}`.

Vyčistit: `rm -rf /tmp/dp-test`.

- [ ] **Step 4: Commit**

```bash
git add scripts/snapshot/sync_manifest_diff.py
git commit -m "feat(snapshot): sync_manifest_diff.py – diff wanted vs existing thumb manifest (refs #1)"
```

---

## Task 4: Rozšíření `build_thumbnails.py` o `--only` a `JPG_SOURCE_DIR`

**Files:**
- Modify: `scripts/snapshot/build_thumbnails.py:32` (env var pro MIRROR_ROOT) + `main()` (nový flag)

- [ ] **Step 1: MIRROR_ROOT z env var s fallbackem**

Najít v `scripts/snapshot/build_thumbnails.py` (řádek 32):

```python
MIRROR_ROOT = Path.home() / "IdeaProjects/github.com/kratocz/drobnepamatky.cz"
```

Nahradit za:

```python
MIRROR_ROOT = Path(os.environ.get(
    "JPG_SOURCE_DIR",
    str(Path.home() / "IdeaProjects/github.com/kratocz/drobnepamatky.cz"),
))
```

(`os` je už importované na řádku 22, není potřeba přidávat import.)

- [ ] **Step 2: Přidat `--only` flag do main()**

Najít `main()` (kolem řádku 95). Najít parser sekci s `parser.add_argument("--limit", ...)` a přidat za ni:

```python
    parser.add_argument("--only", type=str, default=None,
                        help="Místo DB query číst seznam filepath z textového souboru "
                             "(jeden per řádek). Pro sync-from-source.sh.")
```

Pak najít volání `paths = fetch_jpg_paths(limit=args.limit)` (kolem řádku 107). Nahradit za:

```python
    if args.only:
        with open(args.only, encoding="utf-8") as f:
            paths = [line.strip() for line in f if line.strip()]
        print(f"Source: {len(paths)} JPG ze souboru {args.only}")
    else:
        paths = fetch_jpg_paths(limit=args.limit)
        print(f"Source: {len(paths)} JPG souborů z DB files tabulky")
```

A smazat původní řádek `print(f"Source: {len(paths)} JPG souborů z DB files tabulky")` který tam byl samostatně — výpis je teď uvnitř if/else.

- [ ] **Step 3: Aktualizovat docstring**

Najít docstring na začátku souboru (řádky 2-19). Nahradit blok "Spuštění" za:

```python
Spuštění:
  cd scripts/snapshot
  uv run python build_thumbnails.py                  # full ~125 k souborů (DB query)
  uv run python build_thumbnails.py --limit 100      # pilot (DB query)
  uv run python build_thumbnails.py --workers 4      # méně paralelismu
  uv run python build_thumbnails.py --only paths.txt # ze souboru (sync-from-source.sh)

Pro sync-from-source.sh (issue #1):
  - JPG_SOURCE_DIR env var přebije MIRROR_ROOT default
  - --only <paths.txt> přebije DB query
```

- [ ] **Step 4: Smoke test`--only`**

```bash
cd scripts/snapshot
mkdir -p /tmp/dp-bt-test
cat > /tmp/dp-bt-test/paths.txt <<'EOF'
nonexistent/file.jpg
EOF

JPG_SOURCE_DIR=/tmp/dp-bt-test uv run python build_thumbnails.py --only /tmp/dp-bt-test/paths.txt 2>&1 | tail -5
```

Expected output: `Source: 1 JPG ze souboru ...`, výsledek `{'ok': 0, 'cached': 0, 'missing': 1, ...}` (file nonexists → status missing).

Vyčistit: `rm -rf /tmp/dp-bt-test data/thumbs/nonexistent`.

- [ ] **Step 5: Smoke test backward compat (default DB query)**

Ověřit, že existující workflow funguje:

```bash
cd scripts/snapshot && uv run python build_thumbnails.py --help 2>&1 | tail -15
```

Expected: help obsahuje `--limit`, `--workers`, **`--only`** v sekci optional arguments.

(Žádný full run – jen ověření že parsing args + import funguje.)

- [ ] **Step 6: Commit**

```bash
git add scripts/snapshot/build_thumbnails.py
git commit -m "feat(snapshot): --only flag + JPG_SOURCE_DIR env pro sync orchestraci (refs #1)"
```

---

## Task 5: Initial empty `data/thumbs-manifest.json`

**Files:**
- Create: `data/thumbs-manifest.json`

- [ ] **Step 1: Vytvořit prázdný manifest**

```bash
cd /Users/krato/IdeaProjects/github.com/kratocz/drobne-pamatky
echo '{}' > data/thumbs-manifest.json
```

První běh `sync-from-source.sh` ho přepíše plným manifestem podle exportu — to způsobí, že **všechny** existující thumbs vypadají jako "missing" a budou se znovu generovat. To je velký první-běh hit, ale následující inkrementální syncs jsou rychlé.

(Alternativně bychom mohli udělat init helper z existujících souborů, ale tohle je v spec "Mimo scope" jako follow-up.)

- [ ] **Step 2: Ověřit `.gitignore` ho NEignoruje**

```bash
git check-ignore data/thumbs-manifest.json && echo "IGNORED (bad)" || echo "tracked OK"
```

Expected: `tracked OK`. `data/` je sice gitignore-ovaný hierarchicky? Ověř:

```bash
grep -n "^data" .gitignore
```

Pokud `data/` nebo `data/*` chybí v `.gitignore`, je všechno OK. Pokud `data/` je v `.gitignore`, musíme `data/thumbs-manifest.json` exception:

```bash
# Pokud nutné (jen pokud check-ignore nahoře hlásil IGNORED):
cat >> .gitignore <<'EOF'

# Exception: thumbs-manifest patří do gitu (drží stav pro sync-from-source.sh)
!data/thumbs-manifest.json
EOF
```

- [ ] **Step 3: Commit**

```bash
git add data/thumbs-manifest.json
# Pokud jsi musel měnit .gitignore:
# git add .gitignore
git commit -m "chore(data): initial empty thumbs-manifest.json pro sync orchestraci (refs #1)"
```

---

## Task 6: `scripts/sync-from-source.sh` — pre-flight + tunel

**Files:**
- Create: `scripts/sync-from-source.sh`

Plnu pipeline rozdělíme do dvou tasků (Task 6 = setup, Task 7 = pipeline kroky). Důvod: skript bude 150+ řádků a jednorázový commit je snazší review.

- [ ] **Step 1: Vytvořit skript s pre-flight + tunelem (zatím bez vlastní pipeline)**

Create `scripts/sync-from-source.sh`:

```bash
#!/usr/bin/env bash
# Sync skript ze starého Drupal 6 webu → aktualizace data/ v tomto repu (issue #1).
#
# Co dělá:
#   1. Pre-flight (env vars, tooling, port volný)
#   2. SSH tunel na drobnepamatky.cz:3306 → localhost:13306
#   3. Spustí export.py + build_search_index.js
#   4. Diff JPG manifestu (jen změněné/nové)
#   5. Rsync JPG z VPS do tmp/
#   6. build_thumbnails.py --only
#   7. Cleanup obsolete thumbs
#   8. Kopie out/ + nový manifest do data/
#   9. SSH tunel cleanup (trap EXIT)
#
# Neprovádí git commit — user si zkontroluje data/ a commitne ručně.
#
# Použití:
#   bash scripts/sync-from-source.sh            # full sync
#   bash scripts/sync-from-source.sh --limit 50 # pilot mode (jen 50 záznamů z DB)

set -euo pipefail

# ── 0. Args parsing ───────────────────────────────────────────────────
LIMIT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --limit) LIMIT="$2"; shift 2 ;;
        *) echo "ERROR: neznámý argument $1"; exit 1 ;;
    esac
done

# ── 1. Pre-flight ─────────────────────────────────────────────────────
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

echo "─── pre-flight kontroly ───"

# .env existuje
if [[ ! -f .env ]]; then
    echo "ERROR: .env chybí. Spusť: cp .env.example .env && chmod 600 .env"
    exit 1
fi

# .env permissions
perms=$(stat -f "%Lp" .env 2>/dev/null || stat -c "%a" .env)
if [[ "$perms" != "600" ]]; then
    echo "WARNING: .env má perms $perms, doporučeno 600 (chmod 600 .env)"
fi

# Načti .env
set -a; source .env; set +a

# Required env vars
required_vars=(OLD_DB_HOST OLD_DB_PORT OLD_DB_USER OLD_DB_PASSWORD OLD_DB_NAME)
for var in "${required_vars[@]}"; do
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var je prázdné v .env"
        exit 1
    fi
done

# Required tooling
for cmd in uv node rsync ssh lsof; do
    if ! command -v "$cmd" >/dev/null; then
        echo "ERROR: $cmd není v PATH"
        exit 1
    fi
done

# Port volný (sync skript používá 13306, ne $OLD_DB_PORT z .env, protože
# DB_CFG v export.py / build_thumbnails.py je hardcoded na 13306)
if lsof -ti :13306 >/dev/null 2>&1; then
    echo "ERROR: port 13306 už používá jiný proces"
    echo "       Zavři ho: pkill -f 'ssh.*-L 13306' nebo lsof -ti :13306 | xargs kill"
    exit 1
fi

# Working tree v data/ čistý (warn, ne block)
if ! git diff --quiet data/ 2>/dev/null; then
    read -rp "WARNING: máš necommitované změny v data/. Pokračovat? [y/N] " answer
    if [[ "$answer" != "y" ]]; then
        echo "Skončil jsem."
        exit 0
    fi
fi

echo "  ✓ .env, tooling, port 13306 volný"

# ── 2. Trap + tmp dir ─────────────────────────────────────────────────
TMP_DIR=$(mktemp -d -t dp-sync-XXXXXX)
SSH_PID_FILE="$TMP_DIR/ssh.pid"

cleanup() {
    local exit_code=$?
    if [[ -s "$SSH_PID_FILE" ]]; then
        local pid
        pid=$(cat "$SSH_PID_FILE")
        kill "$pid" 2>/dev/null || true
    fi
    rm -rf "$TMP_DIR"
    if [[ $exit_code -ne 0 ]]; then
        echo "✗ Sync selhal (exit $exit_code). Tunel uklizen, tmp smazáno."
    fi
}
trap cleanup EXIT

# ── 3. SSH tunel ──────────────────────────────────────────────────────
echo
echo "─── SSH tunel root@drobnepamatky.cz → localhost:13306 ───"

ssh -f -N -L 13306:127.0.0.1:3306 \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    root@drobnepamatky.cz

# ssh -f forkuje, takže $! nedá správný PID. Po úspěšném tunelu zachytíme přes lsof.
sleep 1
lsof -ti :13306 > "$SSH_PID_FILE"

if [[ ! -s "$SSH_PID_FILE" ]]; then
    echo "ERROR: SSH tunel se neotevřel"
    exit 1
fi

echo "  ✓ tunel živý (PID $(cat "$SSH_PID_FILE"))"

# ── Zbytek pipeline (export, diff, rsync, thumbs, copy) přijde v Task 7 ─

echo
echo "(Pipeline placeholder — implementace v Task 7)"
```

- [ ] **Step 2: chmod +x**

```bash
chmod +x scripts/sync-from-source.sh
```

- [ ] **Step 3: Smoke test (pre-flight + tunel)**

Pozor: tento test otevře SSH tunel a hned ho uklidí (trap). Pokud tunel už běží z předchozí práce, smaž ho:

```bash
pkill -f 'ssh.*-L 13306' 2>/dev/null; sleep 1
bash scripts/sync-from-source.sh 2>&1 | tail -15
```

Expected output:
```
─── pre-flight kontroly ───
  ✓ .env, tooling, port 13306 volný

─── SSH tunel root@drobnepamatky.cz → localhost:13306 ───
  ✓ tunel živý (PID XXXXX)

(Pipeline placeholder — implementace v Task 7)
```

Po skončení skriptu trap zavře tunel. Ověř:

```bash
lsof -ti :13306 >/dev/null && echo "tunnel still UP (bad)" || echo "tunnel cleaned (good)"
```

Expected: `tunnel cleaned (good)`.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-from-source.sh
git commit -m "feat(sync): sync-from-source.sh – pre-flight + SSH tunel (refs #1)"
```

---

## Task 7: Pipeline kroky v `sync-from-source.sh`

**Files:**
- Modify: `scripts/sync-from-source.sh`

- [ ] **Step 1: Najít placeholder a nahradit pipeline kroky**

V `scripts/sync-from-source.sh` najít blok:

```bash
# ── Zbytek pipeline (export, diff, rsync, thumbs, copy) přijde v Task 7 ─

echo
echo "(Pipeline placeholder — implementace v Task 7)"
```

Nahradit za:

```bash
# ── 4. export.py ──────────────────────────────────────────────────────
echo
echo "─── [1/7] export.py (data + manifest) ───"
EXPORT_ARGS=()
if [[ -n "$LIMIT" ]]; then
    EXPORT_ARGS+=(--limit "$LIMIT")
fi
(cd scripts/snapshot && uv run python export.py "${EXPORT_ARGS[@]}")

# ── 5. build_search_index.js ──────────────────────────────────────────
echo
echo "─── [2/7] build_search_index.js ───"
(cd scripts/snapshot && node build_search_index.js)

# ── 6. Manifest diff ──────────────────────────────────────────────────
echo
echo "─── [3/7] manifest diff (existing thumbs vs. wanted JPG) ───"
THUMBS_TO_GENERATE="$TMP_DIR/thumbs-to-generate.txt"
THUMBS_TO_DELETE="$TMP_DIR/thumbs-to-delete.txt"
JPG_TO_RSYNC="$TMP_DIR/jpg-to-rsync.txt"
NEW_MANIFEST="$TMP_DIR/thumbs-manifest-new.json"

(cd scripts/snapshot && uv run python sync_manifest_diff.py \
    --wanted out/files-manifest.json \
    --existing "$REPO_ROOT/data/thumbs-manifest.json" \
    --to-generate "$THUMBS_TO_GENERATE" \
    --to-delete "$THUMBS_TO_DELETE" \
    --to-rsync "$JPG_TO_RSYNC" \
    --new-manifest "$NEW_MANIFEST")

GEN_COUNT=$(wc -l < "$THUMBS_TO_GENERATE" | tr -d ' ')
DEL_COUNT=$(wc -l < "$THUMBS_TO_DELETE" | tr -d ' ')
RSYNC_COUNT=$(wc -l < "$JPG_TO_RSYNC" | tr -d ' ')
# wc -l u prázdného souboru vrátí 0 — výborně.

echo "  → $GEN_COUNT k vygenerování, $DEL_COUNT ke smazání, $RSYNC_COUNT JPG ke stažení"

# ── 7. Rsync JPG z VPS ────────────────────────────────────────────────
JPG_DOWNLOAD_DIR="$TMP_DIR/originals"
if [[ "$RSYNC_COUNT" -gt 0 ]]; then
    echo
    echo "─── [4/7] rsync $RSYNC_COUNT JPG z VPS → $JPG_DOWNLOAD_DIR ───"
    mkdir -p "$JPG_DOWNLOAD_DIR"
    # rsync --files-from čte seznam relativních cest, z VPS web rootu
    rsync -av --files-from="$JPG_TO_RSYNC" \
        root@drobnepamatky.cz:/www/drobnepamatky.cz/www/ \
        "$JPG_DOWNLOAD_DIR/" \
        | tail -5
else
    echo
    echo "─── [4/7] rsync skip (0 JPG ke stažení) ───"
fi

# ── 8. build_thumbnails.py --only ─────────────────────────────────────
if [[ "$GEN_COUNT" -gt 0 ]]; then
    echo
    echo "─── [5/7] build_thumbnails.py --only ($GEN_COUNT thumbs) ───"
    (cd scripts/snapshot && \
        JPG_SOURCE_DIR="$JPG_DOWNLOAD_DIR" \
        uv run python build_thumbnails.py --only "$JPG_TO_RSYNC")
else
    echo
    echo "─── [5/7] build_thumbnails skip (0 ke generování) ───"
fi

# ── 9. Cleanup obsolete thumbs ────────────────────────────────────────
if [[ "$DEL_COUNT" -gt 0 ]]; then
    echo
    echo "─── [6/7] mazání $DEL_COUNT obsolete thumbs ───"
    while IFS= read -r thumb_path; do
        [[ -z "$thumb_path" ]] && continue
        rm -f "data/thumbs/$thumb_path"
    done < "$THUMBS_TO_DELETE"
    # Smaž prázdné adresáře po roku
    find data/thumbs -type d -empty -delete 2>/dev/null || true
else
    echo
    echo "─── [6/7] cleanup skip (0 obsolete) ───"
fi

# ── 10. Kopie out/* do data/ + nový manifest ──────────────────────────
echo
echo "─── [7/7] kopie out/ → data/ + thumbs-manifest update ───"
cp scripts/snapshot/out/pamatky.geojson data/
cp scripts/snapshot/out/lookups.json data/
cp scripts/snapshot/out/search-index.json data/
# details/ je adresář bucketů — kopírujeme celý
rm -rf data/details
cp -R scripts/snapshot/out/details data/
# Nový thumbs-manifest (z Tasku 3 helperu)
cp "$NEW_MANIFEST" data/thumbs-manifest.json

echo "  ✓ data/ aktualizováno"

# ── 11. Status ────────────────────────────────────────────────────────
echo
echo "─── git status data/ ───"
git status --short data/ | head -30
echo
echo "Hotovo. Zkontroluj diff (git diff data/) a commitni ručně."
```

- [ ] **Step 2: Smoke test s `--limit 5`**

Pokud port 13306 ještě obsazen (z předchozího testu), uklidit:

```bash
pkill -f 'ssh.*-L 13306' 2>/dev/null; sleep 1
```

Pak:

```bash
bash scripts/sync-from-source.sh --limit 5 2>&1 | tail -50
```

Expected output: všechny kroky `[1/7]` až `[7/7]` proběhnou, na konci:
- `git status data/` ukáže modified `data/thumbs-manifest.json`, případně modified `data/pamatky.geojson` atd.
- `(unknown)` bucket bude redukován na 5 záznamů, ostatní zmizí
- Žádný error

**Důležité:** `--limit 5` výrazně zúží data v `data/`. **Po smoke testu reverni `data/`:**

```bash
git checkout data/
```

(Vrátí poslední committed stav. `data/thumbs-manifest.json` resetne na `{}`, geojson/lookups/details vrátí stav před limitem.)

- [ ] **Step 3: Verifikovat idempotenci**

Druhý běh skriptu bez DB změn by měl vykázat 0/0/0 v diff fázi. Tunel ještě potřebujeme:

```bash
pkill -f 'ssh.*-L 13306' 2>/dev/null; sleep 1

# První běh
bash scripts/sync-from-source.sh --limit 5 2>&1 | grep "k vygenerování"
# Reset diff base na full export aby další běh nebyl zase --limit 5
# (skip — pojďme rovnou ověřit idempotenci na --limit 5 stejných záznamů)

# Druhý běh (bez resetu data/, jen znovu --limit 5)
bash scripts/sync-from-source.sh --limit 5 2>&1 | grep "k vygenerování"
```

Expected: druhý běh `→ 0 k vygenerování, 0 ke smazání, 0 JPG ke stažení` (nebo malý nenulový počet pokud `--limit` rotuje různé záznamy podle ORDER BY nid DESC; v takovém případě je idempotence dokázána jiným způsobem — diff není explosivní).

Reset:

```bash
git checkout data/
pkill -f 'ssh.*-L 13306' 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-from-source.sh
git commit -m "feat(sync): pipeline kroky v sync-from-source.sh (refs #1)"
```

---

## Task 8: Dokumentace v AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Najít sekci "Run / build / test"**

V `AGENTS.md` najít sekci `## Run / build / test`. Aktuálně obsahuje:

```markdown
## Run / build / test

- **Run lokálně:** `python3 -m http.server 8000` nebo `npx serve .`, pak otevřít `http://localhost:8000`
- **Build:** žádný (čistě statické soubory)
- **Test:** zatím žádné
```

- [ ] **Step 2: Přidat sekci "Sync ze zdroje" za "Run / build / test"**

Nahradit sekci "Run / build / test" za:

```markdown
## Run / build / test

- **Run lokálně:** `python3 -m http.server 8000` nebo `npx serve .`, pak otevřít `http://localhost:8000`
- **Build:** žádný (čistě statické soubory)
- **Test:** lightweight Python skripty v `scripts/snapshot/` — `uv run python test_sanitize.py` a `uv run python test_manifest_diff.py`.

## Sync ze zdroje (Drupal 6 → data/)

Aktualizace `data/` z produkční DB + filesystému na `drobnepamatky.cz`:

```bash
bash scripts/sync-from-source.sh            # full sync
bash scripts/sync-from-source.sh --limit 50 # pilot (50 záznamů, rychlý test)
```

Co skript dělá:
1. Pre-flight (env vars, tooling, port 13306 volný)
2. SSH tunel `root@drobnepamatky.cz:3306 → localhost:13306` (auto-cleanup)
3. `export.py` → JSON/GeoJSON do `scripts/snapshot/out/` + `files-manifest.json`
4. `build_search_index.js` → search index
5. `sync_manifest_diff.py` porovná `out/files-manifest.json` s `data/thumbs-manifest.json`
6. `rsync` jen chybějících/změněných JPG z VPS do tmp/
7. `build_thumbnails.py --only` vygeneruje nové thumbs
8. Smaže obsolete thumbs ze `data/thumbs/`
9. Zkopíruje `out/*` + nový thumbs-manifest do `data/`

**Skript NEcommituje** — po doběhnutí zkontroluj `git diff data/` a commitni ručně.

Idempotentní: druhý běh bez změn v DB ↔ 0 thumbs k vygenerování, 0 rsync transferů.

Pro nasazení změn do `gh-pages`: po commitu spusť `bash scripts/deploy.sh`.
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): sekce o sync-from-source.sh (refs #1)"
```

---

## Task 9: gh issue komentář + closing

**Files:** žádný kód

- [ ] **Step 1: Komentář na issue #1 o změně scope**

Jak jsme se domluvili při brainstormingu, skript se neliší od původního zadání v jednom bodu (nepouští `git commit`). Komentář na issue ať budoucí čtenář ví:

```bash
gh issue comment 1 --body "$(cat <<'EOF'
Po brainstormingu jsem upravil scope: skript NEcommituje (původní AC říkalo "vytvoří commit"). Důvod: user má kontrolu nad commit message + timingem, skript je čistě data pipeline.

Spec: docs/superpowers/specs/2026-06-08-sync-orchestration-design.md
Plán: docs/superpowers/plans/2026-06-09-sync-orchestration.md

Bonus z issue (GitHub Actions automation) bude follow-up issue po dokončení tohoto.
EOF
)"
```

- [ ] **Step 2: Acceptance criteria průchod**

Otevři `docs/superpowers/specs/2026-06-08-sync-orchestration-design.md` sekce "Acceptance criteria". Ručně odškrtni hotové. Pokud něco zbývá nebo bylo upraveno za běhu, dokončit nebo aktualizovat spec poznámkou.

- [ ] **Step 3: Close issue (volitelné — po manuálním ověření)**

Pokud po sync skriptu vše funguje:

```bash
gh issue close 1 --comment "Implementováno, ověřeno. Spec + plán v docs/superpowers/."
```

(Bonus issue na GitHub Actions automation otevři samostatně.)

---

## Spec coverage check

| Spec sekce | Pokrytí v plánu |
|---|---|
| `scripts/sync-from-source.sh` (orchestrace) | Task 6 + 7 |
| `fetch_files_manifest()` v export.py | Task 1 |
| `sync_manifest_diff.py` (helper) | Task 3 |
| `test_manifest_diff.py` (6 case) | Task 2 |
| `build_thumbnails.py` `--only` + `JPG_SOURCE_DIR` | Task 4 |
| `data/thumbs-manifest.json` initial | Task 5 |
| SSH tunel s trap cleanup | Task 6 |
| Pre-flight (env, tooling, port) | Task 6 |
| `--limit N` propagation | Task 7 step 1 (`EXPORT_ARGS`) |
| Pipeline kroky 1-13 | Task 7 |
| Idempotence ověření | Task 7 step 3 |
| AGENTS.md dokumentace | Task 8 |

Vše pokryto.

## Type consistency check

- `compute_diff` signature: `(wanted, existing) → (to_generate, to_delete, to_rsync)`. Task 2 (test) a Task 3 (impl) match.
- `filepath_to_thumb_path` produkuje `<rok>/<basename>.avif`. Task 3 + diff algoritmus + cleanup loop v Task 7 step 1 (`rm -f data/thumbs/$thumb_path`) match.
- `fetch_files_manifest` vrací `{filepath: {fid, size, timestamp}}`. Task 1 a Task 3 (`build_wanted_index`) match.
- `JPG_SOURCE_DIR` env var: Task 4 step 1 (build_thumbnails.py modifikace) a Task 7 step 1 (sync skript export `JPG_SOURCE_DIR="$JPG_DOWNLOAD_DIR"`) match.
- `--only` flag: Task 4 step 2 (build_thumbnails.py parser) a Task 7 step 1 (`build_thumbnails.py --only "$JPG_TO_RSYNC"`) match.
