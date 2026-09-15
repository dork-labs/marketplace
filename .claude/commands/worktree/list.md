---
description: List all git worktrees with their branch and state
allowed-tools: Bash(git worktree list:*), Bash(git -C:*)
category: git
---

# Worktree List

Show all worktrees of this repo, with branch, HEAD, and whether each has uncommitted work.

## Task

### Step 1: List Worktrees

```bash
git worktree list
```

This gives each worktree's path, HEAD, and checked-out branch (or `detached HEAD`). Worktrees for this repo can live in several places: `.worktrees/` inside the repo (the default for `/worktree:create`), `../marketplace-wt/`, and `~/.dork/workspaces/marketplace/` (created by DorkOS). All of them appear here, because they share one git dir.

### Step 2: Check Each for Uncommitted Work

For each path from Step 1:

```bash
git -C <path> status --porcelain | wc -l
```

A non-zero count means that worktree has uncommitted or untracked files. Report the count; do not read or change them.

## Output Format

```
Worktrees

  marketplace               792e538 (chore/agent-tooling)   [main worktree]
  .worktrees/flow-path-c    c6c31b5 (flow-path-c)           clean
  ../marketplace-wt/rv12    5bb4de8 (detached)              3 uncommitted
```
