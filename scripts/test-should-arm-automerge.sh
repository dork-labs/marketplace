#!/usr/bin/env bash
# Fixture suite for scripts/should-arm-automerge.sh, the gate that decides
# whether a pull request may have auto-merge armed on it.
#
# It exists because the failure this gate can produce is silent. A crash is
# obvious and harmless: nothing gets armed. The dangerous bug is a SKIP branch
# that quietly stops matching — a renamed field, a `bucket` value nobody
# anticipated, a `labels` payload shaped as strings instead of objects — because
# then the gate keeps returning ARM and the first symptom is unreviewed code on
# `main`. Nothing about the source makes that visible, so every refusal is pinned
# here by shape.
#
# Ported from dork-labs/dorkos (scripts/test-should-arm-automerge.sh) with the
# gate it tests. Keep the two gates' rules in step; the check names in the green
# fixture (scripts/fixtures/arm-decisions.json) are this repo's own.
#
#   bash scripts/test-should-arm-automerge.sh
#   GATE=/path/to/other.sh bash scripts/test-should-arm-automerge.sh
#
# GATE exists so a candidate rewrite can be run against the same fixtures.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gate=${GATE:-$repo_root/scripts/should-arm-automerge.sh}

if ! command -v jq >/dev/null 2>&1; then
  echo "should-arm-automerge fixtures: needs jq on PATH" >&2
  exit 2
fi

fixtures=$repo_root/scripts/fixtures/arm-decisions.json

pass=0
fail=0

# The cases live in scripts/fixtures/arm-decisions.json, shared with flow's arm
# guard (plugins/flow/engine-tests/land/arm-decision.test.ts), so the two cannot
# drift: every row says what this gate answers (`gate`) and what the guard
# answers (`guard`), and each suite checks its own column. The file's `about`
# and each row's `why` say why a case exists. A case is the `green` payload
# there (open, undrafted, unarmed, unlabelled, cleanly mergeable, reviewed,
# every check settled green) with exactly one field bent by a jq `mutation`, so
# a failure names the field.
if ! jq -e '.green and (.cases | length > 0)' "$fixtures" >/dev/null 2>&1; then
  echo "should-arm-automerge fixtures: cannot read $fixtures" >&2
  exit 2
fi

# A row without both answers would let one rule change unseen by the other.
missing_answers=$(jq -r '.cases[] | select((.gate | type) != "string" or (.guard | type) != "string") | .name' "$fixtures")
if [[ -n "$missing_answers" ]]; then
  while IFS= read -r name; do
    fail=$(( fail + 1 ))
    printf 'FAIL  %-34s needs both a gate and a guard answer\n' "$name"
  done <<<"$missing_answers"
fi

# check <name> <expected-verdict> <jq-mutation-of-the-green-fixture>
check() {
  local name=$1 expected=$2 mutation=$3 got
  got=$(jq '.green' "$fixtures" | jq "$mutation" | "$gate" - 2>/dev/null)
  if [[ "$got" == "$expected" ]]; then
    pass=$(( pass + 1 ))
  else
    fail=$(( fail + 1 ))
    printf 'FAIL  %-34s expected %-26s got %s\n' "$name" "$expected" "${got:-<empty>}"
  fi
}

while IFS=$'\t' read -r name expected mutation; do
  check "$name" "$expected" "$mutation"
done < <(jq -r '.cases[] | select((.gate | type) == "string") | [.name, .gate, .mutation] | @tsv' "$fixtures")

# Missing fields must never read as permission. An empty object has no state, so
# it is not open.
missing=$(echo '{}' | "$gate" - 2>/dev/null)
if [[ "$missing" == "SKIP not-open" ]]; then pass=$(( pass + 1 )); else
  fail=$(( fail + 1 )); printf 'FAIL  %-34s expected %-26s got %s\n' "empty object" "SKIP not-open" "${missing:-<empty>}"
fi

# Malformed input must refuse loudly (exit 2), never fall through to ARM.
garbage=$(echo 'not json at all' | "$gate" - 2>/dev/null); garbage_rc=$?
if [[ "$garbage" == "SKIP unreadable-payload" && $garbage_rc -eq 2 ]]; then pass=$(( pass + 1 )); else
  fail=$(( fail + 1 )); printf 'FAIL  %-34s expected %-26s got %s (rc=%d)\n' "garbage input" "SKIP unreadable-payload" "${garbage:-<empty>}" "$garbage_rc"
fi

echo
echo "should-arm-automerge fixtures: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
