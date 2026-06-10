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
    # rsync --files-from čte seznam relativních cest, z VPS web rootu.
    # --ignore-missing-args: chybí-li některý zdrojový soubor (stale DB.files
    # entry — drupalní web má 1-5% broken references), warn a pokračuj,
    # ne hard fail. build_thumbnails pak tyto soubory označí jako 'missing'.
    rsync -av --ignore-missing-args --files-from="$JPG_TO_RSYNC" \
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
    # Smaž existující AVIF pro to-generate (build_thumbnails.convert_one má
    # legacy "cached" check: pokud target existuje, neoverwrites. Sync skript
    # ale chce při (size, timestamp) změně regenerate.
    while IFS= read -r thumb_path; do
        [[ -z "$thumb_path" ]] && continue
        rm -f "data/thumbs/$thumb_path"
    done < "$THUMBS_TO_GENERATE"
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
