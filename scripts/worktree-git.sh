#!/usr/bin/env bash
# The git commands the /worktree:* commands need, behind fixed spellings.
#
# Why this exists: those commands used to allow `Bash(git -C:*)`,
# `Bash(git log:*)`, `Bash(git fetch:*)` and `Bash(git ls-remote:*)`. A prefix
# rule on git allows every option git has, and several of them write or run
# anything: `git log --output=<file>`, `git -C . -c core.pager=<cmd> log`,
# `git ls-remote --upload-pack=<cmd>`. An allow rule that matches them is a
# shell handed out without a prompt.
#
# So the commands allow this script instead, and this script runs one fixed git
# command per verb. Every argument is checked before git sees it: a branch must
# be a valid branch name that does not start with `-`, a worktree path must be
# one `git worktree list` already prints, a commit must be a hex SHA. Anything
# else is refused with exit 2 and git never runs. Inherited GIT_* variables are
# cleared, so the environment cannot point git somewhere else either.
#
# Pinned by scripts/test-worktree-git.sh. Run it from the main checkout.
#
# Usage: scripts/worktree-git.sh <verb> [args]
#
#   status <worktree>               git -C <worktree> status --porcelain
#   status-ignored <worktree>       ... --porcelain --ignored
#   describe <worktree>             the worktree's branch and last commit
#   branch-exists <branch>          git branch --list <branch>
#   tip <branch>                    git rev-parse --verify refs/heads/<branch>
#   on-origin <branch>              git ls-remote origin refs/heads/<branch>
#   unmerged <branch>               git log --oneline origin/main..<branch>
#   remote-contains <sha>           git branch -r --contains <sha>
#   add <folder> <branch> <base>    git worktree add .worktrees/<folder> -b <branch> <base>
#                                   (<base> is origin/main or HEAD)
#   add-existing <folder> <branch>  git worktree add .worktrees/<folder> <branch>
#   remove <worktree>               git worktree remove <worktree> (never --force)
#   delete-merged-branch <branch>   git branch -d <branch>
#   delete-branch <branch>          git branch -D <branch> (never main)

set -euo pipefail

while IFS='=' read -r name _; do
  case $name in GIT_*) unset "$name" ;; esac
done < <(env)

# Repo-local config must not name a program for these calls to run.
g() {
  git -c core.fsmonitor=false -c log.showSignature=false -c gpg.program=false "$@"
}

refuse() {
  echo "worktree-git: $*" >&2
  exit 2
}

need() {
  [ "$1" -eq "$2" ] || refuse "$verb takes $2 argument(s), got $1"
}

# No argument may hold a newline: grep below would read it as a second pattern.
oneline() {
  case $1 in *$'\n'*) refuse "argument holds a newline" ;; esac
}

# A local branch name git accepts, which can never be read as an option. No
# `@`: check-ref-format expands `@{-1}` to another branch (main, say) and
# accepts it, so the name checked would not be the branch git acts on.
branch() {
  oneline "$1"
  case $1 in -*|''|*@*) refuse "not a branch name: '$1'" ;; esac
  [ "$(g check-ref-format --branch "$1" 2>/dev/null)" = "$1" ] || refuse "not a branch name: '$1'"
}

# A worktree `git worktree list` prints, character for character.
worktree() {
  oneline "$1"
  case $1 in -*|'') refuse "not a worktree: '$1'" ;; esac
  g worktree list --porcelain | grep -qxF "worktree $1" || refuse "not a worktree: '$1'"
}

# The first worktree git lists is the main checkout.
main_checkout() {
  g worktree list --porcelain | sed -n '1s/^worktree //p'
}

# One path segment under .worktrees/.
folder() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || refuse "not a folder name: '$1'"
}

verb=${1:-}
[ $# -gt 0 ] && shift

case $verb in
  status)
    need $# 1; worktree "$1"
    g -C "$1" status --porcelain ;;
  status-ignored)
    need $# 1; worktree "$1"
    g -C "$1" status --porcelain --ignored ;;
  describe)
    need $# 1; worktree "$1"
    g -C "$1" branch --show-current
    g -C "$1" log --no-ext-diff --oneline -1 ;;
  branch-exists)
    need $# 1; branch "$1"
    g branch --list "$1" ;;
  tip)
    need $# 1; branch "$1"
    g rev-parse --verify --quiet "refs/heads/$1" ;;
  on-origin)
    need $# 1; branch "$1"
    g ls-remote origin "refs/heads/$1" ;;
  unmerged)
    need $# 1; branch "$1"
    g log --no-ext-diff --oneline "origin/main..refs/heads/$1" ;;
  remote-contains)
    need $# 1
    [[ $1 =~ ^[0-9a-f]{7,40}$ ]] || refuse "not a commit SHA: '$1'"
    g branch -r --contains "$1" ;;
  add)
    need $# 3; folder "$1"; branch "$2"
    case $3 in origin/main|HEAD) ;; *) refuse "base must be origin/main or HEAD, got '$3'" ;; esac
    g worktree add ".worktrees/$1" -b "$2" "$3" ;;
  add-existing)
    need $# 2; folder "$1"; branch "$2"
    g worktree add ".worktrees/$1" "$2" ;;
  remove)
    need $# 1; worktree "$1"
    [ "$1" != "$(main_checkout)" ] || refuse "will not remove the main checkout"
    g worktree remove "$1" ;;
  delete-merged-branch)
    need $# 1; branch "$1"
    g branch -d "$1" ;;
  delete-branch)
    need $# 1; branch "$1"
    [ "$1" != main ] || refuse "will not delete main"
    g branch -D "$1" ;;
  *)
    refuse "unknown verb '$verb' (see the usage at the top of this script)" ;;
esac
