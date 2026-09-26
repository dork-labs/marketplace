#!/bin/bash
# flow usage recorder. A status-line script runs this in the background.
# It prints nothing and always exits 0. See docs/account-usage.mdx.
IFS= read -r -d '' input || true
case $input in *'"rate_limits"'*) ;; *) exit 0 ;; esac
fp=${input#*'"rate_limits"'}; fp=${fp%%'}}'*}
dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
stamp=${DORK_HOME:-$HOME/.dork}/usage/.statusline-${dir//[^A-Za-z0-9]/_}
last=; [ -r "$stamp" ] && IFS= read -r last < "$stamp"
[ "$fp" = "$last" ] && exit 0
here=${BASH_SOURCE[0]%/*}
printf '%s' "$input" | FLOW_USAGE_FP="$fp" FLOW_USAGE_STAMP="$stamp" \
  "${FLOW_NODE:-node}" --experimental-strip-types "$here/../flow.ts" usage record >/dev/null 2>&1
exit 0
