---
description: List all git worktrees with their branch and state
allowed-tools: Bash(git worktree list), Bash(scripts/worktree-git.sh status:*)
category: git
---

# Worktree List

Show all worktrees of this repo, with branch, HEAD, and whether each has uncommitted work.

Git runs through `scripts/worktree-git.sh` (from the repo root) wherever a command takes a branch or a path: it checks each argument, then runs one fixed git command. Pass worktree paths exactly as `git worktree list` prints them. Do not reach for raw `git -C`, `git log` or `git ls-remote` instead: those are the prefix rules this command no longer allows, because their options can write files and run commands.

## Task

### Step 1: List Worktrees

```bash
git worktree list
```

This gives each worktree's path, HEAD, and checked-out branch (or `detached HEAD`). Worktrees for this repo can live in several places: `.worktrees/` inside the repo (the default for `/worktree:create`), `../marketplace-wt/`, and `~/.dork/workspaces/marketplace/` (created by DorkOS). All of them appear here, because they share one git dir.

### Step 2: Check Each for Uncommitted Work

For each path from Step 1:

```bash
scripts/worktree-git.sh status <path>
```

Count the lines it prints. A non-zero count means that worktree has uncommitted or untracked files. Report the count; do not read or change them.

## Output Format

```
Worktrees

  marketplace               792e538 (chore/agent-tooling)   [main worktree]
  .worktrees/flow-path-c    c6c31b5 (flow-path-c)           clean
  ../marketplace-wt/rv12    5bb4de8 (detached)              3 uncommitted
```
