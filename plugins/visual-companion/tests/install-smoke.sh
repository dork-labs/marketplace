#!/usr/bin/env bash
# Install smoke test for the visual-companion package (DOR-3121).
#
# Copies the package the way an install does (no node_modules, no git, no DorkOS
# checkout anywhere near it), then runs the skill end to end with Node alone:
# start the server, show a screen, fetch it over HTTP, and stop. It proves the
# shipped assets stand in for a DorkOS checkout and nothing needs installing.
# Screenshots are off (they need playwright-core, which an install does not have).
#
#   bash plugins/visual-companion/tests/install-smoke.sh

set -uo pipefail

pkg=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d -t vc-install.XXXXXX)
trap 'cd /; [ -x "$tmp/install/skills/visual-companion/scripts/vc" ] && "$tmp/install/skills/visual-companion/scripts/vc" stop --project-dir "$tmp/project" >/dev/null 2>&1; rm -rf "$tmp"' EXIT

pass=0
fail=0
check() {
  local name=$1 ok=$2 detail=${3:-}
  if [ "$ok" = yes ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        %s\n' "$name" "$detail" >&2
  fi
}

# Copy as an install would: the package files, without dependencies or git.
mkdir -p "$tmp/install" "$tmp/project"
(cd "$pkg" && tar --exclude node_modules --exclude .git -cf - .) | (cd "$tmp/install" && tar -xf -)
vc="$tmp/install/skills/visual-companion/scripts/vc"
# No real chat to wake, no DorkOS checkout, no screenshots.
export VC_DORKOS_REPO= VC_PLAYWRIGHT= BRAINSTORM_SHOTS=0 DORKOS_SESSION_ID= CLAUDE_CODE_SESSION_ID=
cd "$tmp/project"

check "the built palette ships with the package" \
  "$([ -s "$tmp/install/skills/visual-companion/scripts/assets/tokens.css" ] && echo yes || echo no)"
check "the built app stylesheet ships with the package" \
  "$([ -s "$tmp/install/skills/visual-companion/scripts/assets/app.css" ] && echo yes || echo no)"

start=$("$vc" start --new --project-dir "$tmp/project" 2>&1)
check "vc start works without a DorkOS checkout" \
  "$(grep -q '"url"' <<<"$start" && echo yes || echo no)" "$start"

printf '<h2>Smoke screen</h2><p class="subtitle">installed copy</p>\n' > "$tmp/screen.html"
show=$("$vc" show "$tmp/screen.html" --name smoke --no-wait --project-dir "$tmp/project" 2>&1)
check "vc show works without a DorkOS checkout" \
  "$(grep -q '"url"' <<<"$show" && echo yes || echo no)" "$show"
check "showing needed no asset build" \
  "$(grep -q 'assets_error' <<<"$show" && echo no || echo yes)" "$show"

url=$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).screen_url||"")}catch{}' "$show")
page=$(curl -fsS --max-time 10 "$url" 2>&1)
check "the screen is served" "$(grep -q 'Smoke screen' <<<"$page" && echo yes || echo no)" "$url"
check "the screen carries the DorkOS palette" \
  "$(grep -q -- '--background' <<<"$page" && echo yes || echo no)" "$url"

stop=$("$vc" stop --project-dir "$tmp/project" 2>&1)
check "vc stop stops it" "$(grep -qi 'stopped\|"ok":true\|not running' <<<"$stop" && echo yes || echo no)" "$stop"

printf 'visual-companion install smoke: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
