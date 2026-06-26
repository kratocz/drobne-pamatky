#!/usr/bin/env bash
# Lightweight test pro scripts/inject-beacon.sh (bez frameworku).
# Spuštění: bash scripts/snapshot/test_inject_beacon.sh
# Exit 0 = pass, 1 = aspoň jeden FAIL.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$REPO_ROOT/scripts/inject-beacon.sh"
TOKEN="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
failed=0

check() {
    local label="$1" cond="$2"
    if [[ "$cond" == "ok" ]]; then
        echo "  OK    $label"
    else
        echo "  FAIL  $label"
        failed=$((failed + 1))
    fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Case 1: index.html + token → snippet s defer
cat > "$tmp/index.html" <<'EOF'
<head><title>X</title><!-- CF_BEACON --></head>
EOF
bash "$HELPER" "$tmp" "$TOKEN" >/dev/null
grep -qF 'cloudflareinsights.com/beacon.min.js' "$tmp/index.html" && c=ok || c=no
check "index.html: snippet vložen" "$c"
grep -qF '<script defer src=' "$tmp/index.html" && c=ok || c=no
check "index.html: má defer" "$c"
grep -qF "$TOKEN" "$tmp/index.html" && c=ok || c=no
check "index.html: token přítomen" "$c"
grep -qF '<!-- CF_BEACON -->' "$tmp/index.html" && c=no || c=ok
check "index.html: placeholder zmizel" "$c"

# Case 2: 404.html + token → snippet BEZ defer
cat > "$tmp/404.html" <<'EOF'
<head><title>X</title><!-- CF_BEACON --><script>redirect()</script></head>
EOF
bash "$HELPER" "$tmp" "$TOKEN" >/dev/null
grep -qF 'cloudflareinsights.com/beacon.min.js' "$tmp/404.html" && c=ok || c=no
check "404.html: snippet vložen" "$c"
grep -qE '<script src="https://static\.cloudflareinsights' "$tmp/404.html" && c=ok || c=no
check "404.html: BEZ defer" "$c"
grep -qF '<script defer' "$tmp/404.html" && c=no || c=ok
check "404.html: nemá defer" "$c"

# Case 3: prázdný token → placeholder smazán, žádný script
cat > "$tmp/empty.html" <<'EOF'
<head><title>X</title><!-- CF_BEACON --></head>
EOF
bash "$HELPER" "$tmp/empty.html.dir_nonexist" "" >/dev/null 2>&1 || true
# (helper bere dir; vytvoříme podadresář pro izolaci)
mkdir -p "$tmp/e"
cat > "$tmp/e/empty.html" <<'EOF'
<head><title>X</title><!-- CF_BEACON --></head>
EOF
bash "$HELPER" "$tmp/e" "" >/dev/null
grep -qF '<!-- CF_BEACON -->' "$tmp/e/empty.html" && c=no || c=ok
check "prázdný token: placeholder smazán" "$c"
grep -qF 'cloudflareinsights' "$tmp/e/empty.html" && c=no || c=ok
check "prázdný token: žádný script" "$c"

# Case 4: HTML bez placeholderu → beze změny (idempotence)
mkdir -p "$tmp/n"
cat > "$tmp/n/nomark.html" <<'EOF'
<head><title>X</title></head>
EOF
before="$(cat "$tmp/n/nomark.html")"
bash "$HELPER" "$tmp/n" "$TOKEN" >/dev/null
after="$(cat "$tmp/n/nomark.html")"
[[ "$before" == "$after" ]] && c=ok || c=no
check "bez placeholderu: beze změny" "$c"

echo
echo "$([ $failed -eq 0 ] && echo "VŠE OK" || echo "$failed FAIL")"
exit $([ $failed -eq 0 ] && echo 0 || echo 1)
