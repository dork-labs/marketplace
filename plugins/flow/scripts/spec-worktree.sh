#!/usr/bin/env bash
# Create the worktree /flow:execute works in: ../spec-<slug> on a new branch
# spec-<slug>, cut from HEAD.
#
# Why this exists: /flow:execute used to allow `Bash(git worktree add:*)`, which
# checks a branch out into any new folder. Pointed at ~/.config/git, a branch
# carrying a `config` file becomes global git config, and its core.pager or
# core.fsmonitor runs a command on the next git call. So the command allows this
# script instead. The caller picks only the slug; the script picks the folder
# (beside the checkout root, as the stage always has) and the branch name, and
# checks the slug before git runs. A bad slug exits 2 and git never runs.
#
# Usage: spec-worktree.sh <slug>
#   <slug>: lowercase letters and digits, joined by single hyphens or dots,
#   1-64 characters (`flow-dashboard`, `dor-2691`, `sdk-upgrade-0.2.112`).
#   So never `/`, `..`, or a leading or trailing `.` or `-`.
# Prints the new worktree's absolute path on success.

set -euo pipefail

while IFS='=' read -r name _; do
  case $name in GIT_*) unset "$name" ;; esac
done < <(env)

# Repo-local config and hooks must not name a program for these calls to run.
# Hooks matter most: a checkout fires post-checkout, and a hook manager such as
# husky keeps hooks in tracked files the agent may edit.
g() {
  git -c core.fsmonitor=false -c log.showSignature=false -c gpg.program=false \
    -c core.hooksPath=/dev/null "$@"
}

refuse() {
  echo "spec-worktree: $*" >&2
  exit 2
}

[ $# -eq 1 ] || refuse "takes one argument, the spec slug"
slug=$1
[[ $slug =~ ^[a-z0-9]+([.-][a-z0-9]+)*$ ]] && [ ${#slug} -le 64 ] ||
  refuse "not a slug: '$slug' (lowercase letters and digits joined by single - or ., at most 64)"

root=$(g rev-parse --show-toplevel) || refuse "not inside a git checkout"
parent=$(cd "$(dirname "$root")" && pwd -P) || refuse "cannot resolve the folder above $root"
dest="$parent/spec-$slug"
# True as written; it guards a later edit that builds dest some other way.
[ "$dest" = "$parent/spec-$slug" ] && [ "$(dirname "$dest")" = "$parent" ] ||
  refuse "destination left the folder above the checkout: $dest"
# -e alone passes a dangling symlink, which git would follow. Nothing the
# command allows can make a symlink between this check and git's own.
[ ! -e "$dest" ] && [ ! -L "$dest" ] || refuse "already exists: $dest"

g worktree add --quiet "$dest" -b "spec-$slug"
echo "$dest"
