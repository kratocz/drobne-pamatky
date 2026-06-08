# Design: Sync skript ze starého webu → Git (issue #1)

**Datum:** 2026-06-08
**Issue:** [#1](https://github.com/kratocz/drobne-pamatky/issues/1)
**Status:** schválený design, čeká na implementační plán

## Cíl

Jeden příkaz, který stáhne aktuální data z původního Drupal 6 webu na `drobnepamatky.cz`,
vygeneruje statické JSON/GeoJSON pro tento repozitář a aktualizuje `data/` lokálně.

**Změna oproti issue #1:** skript NEcommituje. User po `sync-from-source.sh` ručně zkontroluje
diff a sám commitne. To zjednodušuje skript a dává uživateli kontrolu nad commit message i timingem.

## Architektura

Bash wrapper `scripts/sync-from-source.sh` orchestruje existující skripty + nový manifest diff.

```
┌─────────────────────────────────────────────────────────────────────┐
│ scripts/sync-from-source.sh                                         │
├─────────────────────────────────────────────────────────────────────┤
│ 1. načti .env, ověř required vars + tooling                         │
│ 2. otevři SSH tunel (background, trap pro cleanup)                  │
│ 3. uv run python export.py        ──→  out/{pamatky.geojson,         │
│                                            lookups.json,             │
│                                            search-data.json,         │
│                                            details/*.json,           │
│                                            files-manifest.json}      │
│ 4. node build_search_index.js     ──→  out/search-index.json         │
│ 5. uv run python sync_manifest_diff.py                              │
│        --wanted out/files-manifest.json                             │
│        --existing data/thumbs-manifest.json                         │
│        --to-generate tmp/thumbs-to-generate.txt                     │
│        --to-delete tmp/thumbs-to-delete.txt                         │
│        --to-rsync tmp/jpg-to-rsync.txt                              │
│ 6. rsync nové JPG z VPS           ──→  tmp/originals/<filepath>      │
│ 7. uv run python build_thumbnails.py --only tmp/jpg-to-rsync.txt     │
│        JPG_SOURCE_DIR=tmp/originals                                 │
│                                   ──→  data/thumbs/<rok>/*.avif      │
│ 8. smaž obsolete thumbs ze tmp/thumbs-to-delete.txt                  │
│ 9. smaž tmp/originals/ (free disk)                                  │
│ 10. kopie out/{geojson,lookups,search-index,details} do data/        │
│ 11. přepiš data/thumbs-manifest.json novým snapshotem               │
│ 12. SSH tunel cleanup (trap EXIT)                                    │
│ 13. git status data/ (info, žádný commit)                            │
└─────────────────────────────────────────────────────────────────────┘
```

## File structure

| Soubor | Akce | Odpovědnost |
|---|---|---|
| `scripts/sync-from-source.sh` | create | Orchestrace pipeline |
| `scripts/snapshot/export.py` | modify | + `fetch_files_manifest()` → `out/files-manifest.json` |
| `scripts/snapshot/sync_manifest_diff.py` | create | Diff wanted vs. existing, output 3 souborů |
| `scripts/snapshot/test_manifest_diff.py` | create | Lightweight test pro diff (6 case) |
| `scripts/snapshot/build_thumbnails.py` | modify | + `--only <paths.txt>` flag + env `JPG_SOURCE_DIR` |
| `data/thumbs-manifest.json` | NEW (committed) | Snapshot stavu `data/thumbs/` pro budoucí diff |
| `AGENTS.md` | modify | Run/build/test sekce |

## SSH tunel lifecycle

```bash
SSH_PID_FILE=$(mktemp -t dp-sync-ssh-XXXXXX.pid)

cleanup() {
    if [[ -s "$SSH_PID_FILE" ]]; then
        kill "$(cat "$SSH_PID_FILE")" 2>/dev/null || true
        rm -f "$SSH_PID_FILE"
    fi
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ssh -f -N -L 13306:127.0.0.1:3306 \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    root@drobnepamatky.cz \
    && lsof -ti :13306 > "$SSH_PID_FILE"
```

- **`trap EXIT`** cleanup na úspěšném i chybovém exitu (set -e, Ctrl+C, signal)
- **`ssh -f`** forkuje na pozadí → `$!` nedá správný PID → použijeme `lsof -ti :13306`
- **`ExitOnForwardFailure=yes`** — port collision → ssh hned padne místo tichého ignorace
- **`ServerAliveInterval=30`** — drží tunel živý během rsync velkých souborů

## Pre-flight kontroly

```bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

# .env existuje + permissions
[[ -f .env ]] || { echo "ERROR: .env chybí. cp .env.example .env && chmod 600 .env"; exit 1; }
perms=$(stat -f "%Lp" .env 2>/dev/null || stat -c "%a" .env)
[[ "$perms" == "600" ]] || echo "WARNING: .env má perms $perms, doporučeno 600"

# Required env vars
set -a; source .env; set +a
required=(OLD_DB_HOST OLD_DB_PORT OLD_DB_USER OLD_DB_PASSWORD OLD_DB_NAME)
for var in "${required[@]}"; do
    [[ -n "${!var:-}" ]] || { echo "ERROR: $var prázdné v .env"; exit 1; }
done

# Required tooling
for cmd in uv node rsync ssh lsof; do
    command -v "$cmd" >/dev/null || { echo "ERROR: $cmd není v PATH"; exit 1; }
done

# Port volný
lsof -ti :13306 >/dev/null 2>&1 \
    && { echo "ERROR: port 13306 už používá jiný proces"; exit 1; } \
    || true

# Working tree v data/ (volitelné prompt)
if ! git diff --quiet data/ 2>/dev/null; then
    read -rp "WARNING: necommitované změny v data/. Pokračovat? [y/N] " answer
    [[ "$answer" == "y" ]] || exit 0
fi
```

## Manifest diff (klíčová mechanika)

### `out/files-manifest.json` (nový export.py output)

```json
{
  "generated_ts": 1717840800,
  "files": {
    "sites/default/files/img_1234.jpg": {
      "fid": 1234,
      "size": 458720,
      "timestamp": 1547234567
    }
  }
}
```

### SQL v `fetch_files_manifest`

```python
def fetch_files_manifest(cur):
    """Manifest všech JPG linknutých na publikované památky.
    Slouží sync-from-source.sh jako diff base pro thumbs."""
    cur.execute("""
        SELECT DISTINCT
          f.fid, f.filepath, f.filesize, f.timestamp
        FROM files f
        JOIN content_field_obrazek cfo ON cfo.field_obrazek_fid = f.fid
        JOIN node n ON n.nid = cfo.nid AND n.vid = cfo.vid
        WHERE n.type = 'objekt' AND n.status = 1
          AND f.filemime = 'image/jpeg'
    """)
    return {r["filepath"]: {
        "fid": r["fid"],
        "size": r["filesize"],
        "timestamp": r["timestamp"],
    } for r in cur.fetchall()}
```

### Mapování filepath → thumb path

```
files["sites/default/files/img_1234.jpg"]
  → data/thumbs/2019/img_1234.avif      (kde 2019 = year(timestamp))
```

### `data/thumbs-manifest.json` (commited persistentní snapshot)

Stejná struktura jako `files-manifest.json`, klíčem je **thumb path** (`<rok>/<basename>.avif`).
Skript po úspěšném sync přepíše tento soubor odpovídajícím snapshotem podle nového stavu.

### Diff algoritmus (Python helper `sync_manifest_diff.py`)

```python
# Pseudokod
wanted = load_thumb_manifest_from_files_manifest(args.wanted)  # convert filepath → thumb_path
existing = load_json(args.existing)  # data/thumbs-manifest.json

to_generate = []  # thumbs k vygenerování (chybějící NEBO změněné size/timestamp)
to_delete = []    # thumbs ke smazání (obsolete)
to_rsync = []     # JPG filepath k stažení z VPS

wanted_paths = set(wanted.keys())
existing_paths = set(existing.keys())

for path in wanted_paths - existing_paths:
    to_generate.append(path)
    to_rsync.append(wanted[path]["filepath"])

for path in existing_paths - wanted_paths:
    to_delete.append(path)

for path in wanted_paths & existing_paths:
    w, e = wanted[path], existing[path]
    if (w["size"], w["timestamp"]) != (e["size"], e["timestamp"]):
        to_generate.append(path)
        to_rsync.append(w["filepath"])

# Write to output files (one path per line)
write_lines(args.to_generate, to_generate)
write_lines(args.to_delete, to_delete)
write_lines(args.to_rsync, to_rsync)
```

## Per-krok error handling

| Co může selhat | Co se stane | Recovery |
|---|---|---|
| SSH tunel se nesepne | `ExitOnForwardFailure=yes` → ssh fail → `set -e` exit | User vidí ssh error, upraví SSH config / network |
| export.py SQL error | python exit ≠ 0 → set -e exit, trap zavře tunel | User vidí stack trace, opraví |
| rsync fail (sit dropout) | rsync exit ≠ 0 → exit, trap, tunnel close | Re-run skript, manifest diff stáhne jen chybějící |
| build_thumbnails fail na jedné fotce | dnes pokračuje (existing chování), jen warning | Beze změny |
| Ctrl+C uprostřed | SIGINT → trap → tunnel close, tmp cleanup | Repo state nedotčen |

`set -euo pipefail` + `trap EXIT` + log banner per krok (`─── [N/M] popis ───` jako v `deploy.sh`).

## Testing

Žádný framework v projektu (per AGENTS.md). Pro tento skript:

1. **`scripts/snapshot/test_manifest_diff.py`** — lightweight, bez frameworku, 6 case:
   - empty wanted + empty existing → 0/0/0
   - wanted has new entry → `generate`
   - existing has stale entry → `delete`
   - both identical `(size, timestamp)` → no action
   - both differ in `size` → `generate` (refresh)
   - both differ in `timestamp` → `generate` (refresh)

2. **`fetch_files_manifest` manuál:**
   ```bash
   uv run python export.py --limit 50
   jq '.files | length' out/files-manifest.json
   ```

3. **End-to-end:**
   - První běh s prázdným `thumbs-manifest.json`: vygeneruje thumbs pro pilot subset
   - Druhý běh: diff 0/0/0, žádný rsync
   - Třetí běh po ručním smazání 1 thumbu z `data/thumbs/` + smazání z `thumbs-manifest.json`: diff zachytí 1 generate

4. **`--limit N`** propagace do `export.py` pro pilot bez full DB scan.

## Acceptance criteria

- [ ] `scripts/sync-from-source.sh` existuje, exec bit, shebang `#!/usr/bin/env bash`
- [ ] Pre-flight ověřuje `.env`, env vars, tooling, port 13306 volný
- [ ] SSH tunel: `ssh -f -N -L` s `ExitOnForwardFailure=yes`, PID capture, `trap EXIT` cleanup
- [ ] Pipeline kroky 1-13 (load env, tunnel, export, search-index, manifest diff, rsync, thumbnails, copy, manifest update, cleanup)
- [ ] `--limit N` flag propaguje do `export.py`
- [ ] **Žádný `git commit`** — jen `git status data/` info
- [ ] Při chybě: tunel cleanup, tmp dir smazán (idempotent restart)
- [ ] Idempotence: druhý běh bez změn → 0/0/0, žádné transfery
- [ ] `scripts/snapshot/export.py`:
  - [ ] `fetch_files_manifest(cur)` → `out/files-manifest.json`
  - [ ] Manifest `{filepath: {fid, size, timestamp}}` pro publikované JPG
- [ ] `scripts/snapshot/sync_manifest_diff.py`:
  - [ ] CLI `--wanted`, `--existing`, `--to-generate`, `--to-delete`, `--to-rsync`
  - [ ] Refresh trigger na rozdíl `(size, timestamp)`
- [ ] `scripts/snapshot/test_manifest_diff.py` — 6 case projdou
- [ ] `scripts/snapshot/build_thumbnails.py`:
  - [ ] `--only <paths.txt>` flag (bez DB, jen soubor)
  - [ ] Env var `JPG_SOURCE_DIR` přebije `MIRROR_ROOT` default
- [ ] `data/thumbs-manifest.json` — committed, struktura `{thumb_path: {fid, size, timestamp}}`
- [ ] `AGENTS.md` — sekce "Run / build / test" doplněna

## Mimo scope

- **GitHub Actions automation** — bonus z issue #1. Po dokončení #1 založím follow-up issue.
  Důsledky pro current design: žádné (sync skript je přesně to, co Action zavolá).
  Pre-req pro CI: cross-platform image processor (`sips` macOS-only), low-privilege SSH user na VPS,
  branch strategy pro CI commits.
- **Cross-platform image processor** (`sips` → `vips`/`ImageMagick`) — pre-req pro CI, lokální macOS dnes OK.
- **Notification po sync** (Slack/email) — ne dnes.
- **Lock file** (`flock`) na concurrent runs — pro CI cron užitečný, lokálně rare collision.
- **Push do gh-pages** — separátní `deploy.sh` (už existuje, beze změny).
- **Re-sync všech existujících thumbs** — `data/thumbs-manifest.json` bude prázdný na start, takže
  první běh skriptu vygeneruje všechny thumbs znovu. Alternativa: jednorázový `init-thumbs-manifest.py`
  helper, který vygeneruje manifest z existujících souborů (mtime + size). Necháno jako follow-up
  pokud bude první sync příliš dlouhý.
