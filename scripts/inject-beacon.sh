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
