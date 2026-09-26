#!/usr/bin/env bash
# Watch PRs until one merges, closes, fails a check, or is neither armed nor queued.
# Usage: watch.sh <owner/repo>:<pr> [<owner/repo>:<pr> ...]
# Needs: gh (signed in) and jq.
set -u
while true; do
  for spec in "$@"; do
    repo=${spec%%:*}
    pr=${spec##*:}
    j=$(gh pr view "$pr" -R "$repo" --json state,autoMergeRequest,statusCheckRollup 2>/dev/null) || continue
    state=$(jq -r .state <<<"$j")
    failing=$(jq -r '[.statusCheckRollup[]? | select((.conclusion // "") | test("FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED")) | .name] | join(",")' <<<"$j")
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
