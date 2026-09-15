---
description: Remove a git worktree safely
argument-hint: '<branch-name> [--delete-branch]'
allowed-tools: Bash(git worktree list:*), Bash(git worktree remove:*), Bash(git worktree prune:*), Bash(git -C:*), Bash(git branch -d:*), Bash(git rev-parse:*)
category: git
---

# Worktree Remove

Remove a git worktree after checking for uncommitted changes.

## Arguments

Parse `$ARGUMENTS` for:

| Argument          | Effect                                              |
| ----------------- | --------------------------------------------------- |
| `<branch-name>`   | **Required.** Branch name of the worktree to remove |
| `--delete-branch` | Also delete the branch after removing the worktree  |

**Examples:**

- `/worktree:remove fix-flow-slug` — Remove worktree, keep branch
- `/worktree:remove fix-flow-slug --delete-branch` — Remove worktree and branch

## Task

### Step 0: Parse Arguments

Extract the branch name and `--delete-branch` flag from `$ARGUMENTS`. If no branch name is provided, report the error and stop.

### Step 1: Safety Checks

**Refuse to remove main/master:**

If branch name is `main` or `master`, report "Cannot remove the main worktree" and stop.

**Find the worktree and refuse if it's the main one:**

```bash
git worktree list
```

Scan the output for `[<branch-name>]`. If no worktree matches, report and stop. The first line is always the main worktree — if that's the line matching `<branch-name>` (i.e. the main worktree happens to have that branch checked out), report "That branch is checked out in the main worktree, which cannot be removed" and stop. The branch name alone is not a reliable guard; the path is.

**Check for uncommitted changes:**

```bash
git -C <worktree-path> status --porcelain
```

If there are uncommitted changes, warn the user and ask for confirmation before proceeding.

### Step 2: Remove Worktree

Record the branch tip first, so the report carries a recovery handle:

```bash
git rev-parse <branch-name>
git worktree remove <worktree-path>
git worktree prune
```

`git worktree remove` refuses a worktree with modified or untracked files. If the user confirmed in Step 1 that those changes can go, say so explicitly before retrying with `--force`; never add `--force` on your own.

If `--delete-branch` was specified:

```bash
git branch -d <branch-name>
```

If the branch hasn't been merged, `git branch -d` will fail safely. Because `main` merges by squash, a merged PR's branch also fails `-d`. Report this and suggest `git branch -D` only after confirming the PR merged (`gh pr view <branch-name> --json state`).

### Step 3: Verify

```bash
git worktree list
```

## Output Format

```
Worktree Removed

Removed: <worktree-path>
Branch:  <branch-name> [deleted | kept] (tip <sha>)

Remaining worktrees:
  <worktree list>
```

## Edge Cases

- **main/master**: Refuse unconditionally
- **Branch checked out in the main worktree**: Refuse — the main worktree is never removed
- **Uncommitted changes**: Warn and ask for confirmation
- **Worktree not found**: Report "No worktree found for branch '<name>'"
- **Unmerged branch with --delete-branch**: Report that `-d` failed, suggest `-D` if intentional
- **Currently inside the worktree**: Warn that removal may fail — switch to main worktree first
- **Worktree under `~/.dork/workspaces/`**: It may belong to a live DorkOS agent session; confirm with the user first
