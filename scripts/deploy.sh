#!/usr/bin/env bash
# Deploy archivu do gh-pages branche (orphan, force push).
#
# Předpoklady:
#   - data/ obsahuje aktuální vygenerované soubory:
#       (cd scripts/snapshot && uv run python export.py)
#       (cd scripts/snapshot && node build_search_index.js)
#       (cd scripts/snapshot && uv run python build_thumbnails.py)
#       cp -R scripts/snapshot/out/{pamatky.geojson,lookups.json,search-index.json,details} data/
#   - main branch je čistý (žádné uncommitted změny)
#   - gh-pages branch může i nemusí existovat (force push ji přepíše)
#
# Použití:
#   bash scripts/deploy.sh             # deploy z aktuálního stavu data/
#   bash scripts/deploy.sh --dry-run   # ukáže co by se dělalo bez pushe

set -euo pipefail

DRY_RUN=0
if [[ ${1:-} == "--dry-run" ]]; then
    DRY_RUN=1
fi

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

# ── 1. Pre-flight ─────────────────────────────────────────────────────
echo "─── pre-flight kontroly ───"

NEEDED_FILES=(
    "index.html"
    "404.html"
    "src/app.js"
    "assets/style.css"
    "data/pamatky.geojson"
    "data/lookups.json"
    "data/search-index.json"
)
NEEDED_DIRS=(
    "data/details"
    "data/thumbs"
)

missing=0
for f in "${NEEDED_FILES[@]}"; do
    if [[ ! -f $f ]]; then
        echo "  ✗ chybí: $f"
        missing=1
    fi
done
for d in "${NEEDED_DIRS[@]}"; do
    if [[ ! -d $d ]] || [[ -z $(ls -A "$d" 2>/dev/null) ]]; then
        echo "  ✗ chybí/prázdné: $d/"
        missing=1
    fi
done

if [[ $missing -ne 0 ]]; then
    echo
    echo "ERROR: nemáš všechny soubory pro deploy. Spusť snapshot pipeline:"
    echo "  (cd scripts/snapshot && uv run python export.py)"
    echo "  (cd scripts/snapshot && node build_search_index.js)"
    echo "  (cd scripts/snapshot && uv run python build_thumbnails.py)"
    echo "  cp -R scripts/snapshot/out/{pamatky.geojson,lookups.json,search-index.json,details} data/"
    exit 1
fi

if ! git diff --quiet HEAD; then
    echo "ERROR: máš uncommitted změny v main. Commit nebo stash je první."
    git status --short
    exit 1
fi

main_sha=$(git rev-parse --short HEAD)
total_size=$(du -sk index.html src assets data 2>/dev/null | awk '{s+=$1} END {print s}')
total_files=$(find index.html src assets data -type f 2>/dev/null | wc -l | tr -d ' ')

echo "  ✓ všechny vyžadované soubory existují"
echo "  ✓ working tree čistý (main: $main_sha)"
echo "  ✓ k deployi: $total_files souborů, $((total_size / 1024)) MB raw"

if [[ $DRY_RUN -eq 1 ]]; then
    echo
    echo "(dry-run, končím – žádný push)"
    exit 0
fi

# ── 2. Worktree ───────────────────────────────────────────────────────
WORKTREE=$(mktemp -d -t dp-deploy-XXXXXX)
echo
echo "─── příprava worktree: $WORKTREE ───"

cleanup() {
    cd "$REPO_ROOT"
    git worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"
}
trap cleanup EXIT

git worktree add --detach "$WORKTREE"
cd "$WORKTREE"

# Switch na orphan branch (žádná historie = repo size stabilní).
# Random suffix, aby nedošlo ke kolizi pokud branch zbyl z předchozího (failed) běhu.
ORPHAN_BRANCH="gh-pages-deploy-$(date +%s)"
git checkout --orphan "$ORPHAN_BRANCH"
# Smazat všechno (kromě .git) – po `git checkout --orphan` je index čistý,
# ale working tree obsahuje stále soubory z původního commitu.
find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
git rm --cached -r . >/dev/null 2>&1 || true

# ── 3. Kopie souborů ──────────────────────────────────────────────────
echo "─── kopie souborů ───"
mkdir -p src assets data
rsync -a "$REPO_ROOT/src/" src/
rsync -a "$REPO_ROOT/assets/" assets/
rsync -a "$REPO_ROOT/data/" data/
# Per-pamatka HTML + sitemap + robots (issue #5) — pokud existují
[ -d "$REPO_ROOT/pamatka" ] && rsync -a "$REPO_ROOT/pamatka/" pamatka/
[ -f "$REPO_ROOT/sitemap.xml" ] && cp "$REPO_ROOT/sitemap.xml" .
ls "$REPO_ROOT"/sitemap-*.xml 2>/dev/null | xargs -I {} cp {} . 2>/dev/null
[ -f "$REPO_ROOT/robots.txt" ] && cp "$REPO_ROOT/robots.txt" .
cp "$REPO_ROOT/index.html" .
cp "$REPO_ROOT/404.html" .
cp "$REPO_ROOT/LICENSE" .

# Deploy-specific .gitignore (jen macOS junk – data jsou jasně chtěná)
cat > .gitignore <<'EOF'
.DS_Store
._*
EOF

echo "  ✓ zkopírováno"
ls -lh | head -10

# ── 4. Commit & push ──────────────────────────────────────────────────
echo
echo "─── commit & push ───"
git add -A
git commit -q -m "Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                -m "Source: main $main_sha"

git push -f origin "HEAD:gh-pages"

# Smazat lokální orphan branch (worktree cleanup ho jinak nesmaže)
cd "$REPO_ROOT"
git branch -D "$ORPHAN_BRANCH" >/dev/null 2>&1 || true

# ── 5. Hotovo ─────────────────────────────────────────────────────────
echo
echo "✓ Deploy hotov."
echo "  Pages URL (po aktivaci): https://kratocz.github.io/drobne-pamatky/"
echo "  Nastavení Pages source: github.com/kratocz/drobne-pamatky/settings/pages"
echo "    → Branch: gh-pages, Folder: / (root)"
