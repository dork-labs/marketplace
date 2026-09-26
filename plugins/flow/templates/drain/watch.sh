#!/usr/bin/env bash
# Watch PRs until one merges, closes, fails a check, or is neither armed nor queued.
# Usage: watch.sh <owner/repo>:<pr> [<owner/repo>:<pr> ...]
# Needs: gh (signed in) and jq. Exits with ERROR after 5 failed reads in a row
# for any one PR (a mistyped repo or an expired login), instead of waiting forever.
set -u
MAX_ERRORS=5
# One counter per PR, by argument position (bash 3.2 has no associative arrays).
errors=()
while true; do
  i=0
  for spec in "$@"; do
    i=$((i + 1))
    repo=${spec%%:*}
    pr=${spec##*:}
    err=$(mktemp)
    j=$(gh pr view "$pr" -R "$repo" --json state,autoMergeRequest,statusCheckRollup 2>"$err")
    ok=$?
    msg=$(cat "$err"); rm -f "$err"
    # A read that failed, or whose JSON has no state, is an error, never "merged".
    state=$( ((ok == 0)) && jq -r '.state // empty' <<<"$j" 2>/dev/null)
    if [[ -z $state ]]; then
      errors[i]=$((${errors[i]:-0} + 1))
      if ((errors[i] >= MAX_ERRORS)); then echo "$spec ERROR: ${msg:-unreadable response}"; exit 1; fi
      continue
    fi
    errors[i]=0
    # Check runs report `.conclusion`; commit statuses (a deploy preview, say) report `.state`.
    failing=$(jq -r '[.statusCheckRollup[]?
      | select(((.conclusion // "") | test("FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED"))
          or ((.state // "") | test("FAILURE|ERROR")))
      | (.name // .context)] | join(",")' <<<"$j")
    armed=$(jq -r '.autoMergeRequest != null' <<<"$j")
    if [[ $state != OPEN ]]; then echo "$spec $state"; exit 0; fi
    if [[ -n $failing ]]; then echo "$spec FAILING: $failing"; exit 0; fi
    if [[ $armed == false ]]; then
      queued=$(gh api graphql -f query="query{repository(owner:\"${repo%%/*}\",name:\"${repo##*/}\"){pullRequest(number:$pr){isInMergeQueue}}}" \
        --jq .data.repository.pullRequest.isInMergeQueue 2>/dev/null)
      if [[ $queued != true ]]; then echo "$spec NOT-ARMED-NOT-QUEUED"; exit 0; fi
    fi
  done
  sleep 90
done
