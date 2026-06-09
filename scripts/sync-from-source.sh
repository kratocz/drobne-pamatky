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
