#!/bin/zsh
# usage: watch.sh repo:pr [repo:pr ...]  — exits when any PR merges, closes, or has a failing check / is no longer armed
while true; do
  for spec in "$@"; do
    repo=${spec%%:*}; pr=${spec##*:}
    j=$(gh pr view $pr -R $repo --json state,autoMergeRequest,statusCheckRollup 2>/dev/null) || continue
    st=$(echo $j | jq -r .state)
    fail=$(echo $j | jq -r '[.statusCheckRollup[]? | select((.conclusion//"")|test("FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED"))|.name]|join(",")')
    armed=$(echo $j | jq -r '.autoMergeRequest != null')
    if [[ $st != OPEN ]]; then echo "$spec $st"; exit 0; fi
    if [[ -n $fail ]]; then echo "$spec FAILING: $fail"; exit 0; fi
    if [[ $armed == false ]]; then
      q=$(gh api graphql -f query="query{repository(owner:\"${repo%%/*}\",name:\"${repo##*/}\"){pullRequest(number:$pr){isInMergeQueue}}}" --jq .data.repository.pullRequest.isInMergeQueue 2>/dev/null)
      [[ $q != true ]] && { echo "$spec NOT-ARMED-NOT-QUEUED"; exit 0; }
    fi
  done
  sleep 90
done
