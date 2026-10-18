#!/usr/bin/env bash
# Fixture suite for scripts/worktree-git.sh, the wrapper the /worktree:*
# commands allow instead of prefix rules on git.
#
# The failure that matters is silent: a check that stops refusing lets an
# option through, and an option is how a git allow rule becomes a shell
# (`--output=<file>`, `--upload-pack=<cmd>`, `-c core.pager=<cmd>`). So most
# cases below are refusals, and each one also proves git never ran: the file
# the injected option would have written does not exist afterwards.
#
# Every case runs the real script against a scratch repo with a bare origin,
# a second worktree and a merged branch.
#
#   bash scripts/test-worktree-git.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script=$repo_root/scripts/worktree-git.sh

tmp=$(mktemp -d -t worktree-git.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
tmp=$(cd "$tmp" && pwd -P)

pass=0
fail=0
check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' \
      "$name" "$expected" "$actual" >&2
  fi
}

# --- fixtures

g() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }
g init -q --bare "$tmp/origin.git"
g init -q "$tmp/repo"
cd "$tmp/repo"
g commit -q --allow-empty -m one
g remote add origin "$tmp/origin.git"
g push -q origin main
g fetch -q origin
g branch done-work
g push -q origin done-work
g worktree add -q "$tmp/wt" -b in-flight
touch "$tmp/wt/dirty.txt"
tip=$(git rev-parse HEAD)

run() { "$script" "$@" >"$tmp/out" 2>"$tmp/err"; echo $?; }
pwned=$tmp/pwned

# --- refusals: exit 2, and nothing ran

refused() {
  local name=$1; shift
  check "$name: refused" 2 "$(run "$@")"
  check "$name: git never ran" no "$([ -e "$pwned" ] && echo yes || echo no)"
  rm -f "$pwned"
}

refused "no verb"
refused "unknown verb" log --output="$pwned"
refused "option as branch (tip)" tip --output="$pwned"
refused "option as branch (unmerged)" unmerged "--output=$pwned"
refused "option as branch (on-origin)" on-origin "--upload-pack=touch $pwned"
refused "option as branch (delete)" delete-branch -D
refused "invalid branch name" tip 'a..b'
refused "branch with a space" tip 'a b'
refused "too many arguments" tip main extra
refused "option as worktree" status "-c"
refused "path that is not a worktree" status "$tmp"
refused "relative spelling of a worktree" status "../wt"
refused "option as commit" remote-contains "--output=$pwned"
refused "short commit" remote-contains abc
refused "folder with a slash" add ../escape new-branch origin/main
refused "folder starting with a dot" add .hidden new-branch origin/main
refused "base other than origin/main or HEAD" add ok new-branch "--output=$pwned"
refused "remove the main checkout" remove "$tmp/repo"
refused "delete main" delete-branch main
refused "delete main as @{-1}" delete-branch '@{-1}'
refused "upstream shorthand as branch" tip '@{u}'
refused "worktree path with a newline" status "$tmp/wt"$'\n'"x"

# A GIT_* variable the caller sets must not reach git.
check "GIT_DIR from the caller is ignored" 0 "$(GIT_DIR=/nonexistent run tip main)"

# Every git call carries config that cannot name a program. A stand-in git on
# PATH logs its arguments, then runs the real one.
real_git=$(command -v git)
mkdir -p "$tmp/bin"
printf '#!/bin/sh\necho "$*" >> "%s"\nexec "%s" "$@"\n' "$tmp/git-calls.log" "$real_git" >"$tmp/bin/git"
chmod +x "$tmp/bin/git"
PATH="$tmp/bin:$PATH" "$script" status "$tmp/wt" >/dev/null 2>&1
check "git calls were logged" yes "$([ -s "$tmp/git-calls.log" ] && echo yes || echo no)"
check "every git call disables fsmonitor, signature display and gpg" "" \
  "$(grep -v '^-c core.fsmonitor=false -c log.showSignature=false -c gpg.program=false ' "$tmp/git-calls.log")"

# --- what the verbs do

check "status shows the dirty worktree" 0 "$(run status "$tmp/wt")"
check "status output" "?? dirty.txt" "$(cat "$tmp/out")"
check "status-ignored runs" 0 "$(run status-ignored "$tmp/wt")"
check "describe prints the branch first" 0 "$(run describe "$tmp/wt")"
check "describe output" "in-flight" "$(head -1 "$tmp/out")"
check "branch-exists finds a branch" 0 "$(run branch-exists done-work)"
check "branch-exists output" "done-work" "$(tr -d ' *' <"$tmp/out")"
check "tip" 0 "$(run tip done-work)"
check "tip output" "$tip" "$(cat "$tmp/out")"
check "on-origin" 0 "$(run on-origin done-work)"
check "on-origin output" "$tip	refs/heads/done-work" "$(cat "$tmp/out")"
check "unmerged is empty for merged work" 0 "$(run unmerged done-work)"
check "unmerged output" "" "$(cat "$tmp/out")"
check "remote-contains" 0 "$(run remote-contains "$tip")"
check "add from HEAD" 0 "$(run add new-one new-one HEAD)"
check "add made the worktree" yes "$([ -d .worktrees/new-one ] && echo yes || echo no)"
check "remove a clean worktree" 0 "$(run remove "$tmp/repo/.worktrees/new-one")"
check "remove refuses a dirty worktree (git's own refusal)" 128 "$(run remove "$tmp/wt")"
check "delete-merged-branch" 0 "$(run delete-merged-branch new-one)"
check "add-existing" 0 "$(run add-existing back done-work)"
check "remove it again" 0 "$(run remove "$tmp/repo/.worktrees/back")"
check "delete-branch" 0 "$(run delete-branch done-work)"
check "the branch is gone" 1 "$(run tip done-work)"

printf 'worktree-git fixtures: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
