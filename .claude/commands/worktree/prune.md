---
description: Find worktrees and local branches whose work has landed, and remove them when asked
argument-hint: '[--fix]'
allowed-tools: Bash(git worktree:*), Bash(git -C:*), Bash(git fetch:*), Bash(git branch:*), Bash(git log:*), Bash(git rev-parse:*), Bash(git ls-remote:*), Bash(gh pr list:*), Bash(gh pr view:*)
category: git
---

# Worktree Prune

Delete the worktrees and local branches that finished work left behind. Reports by default and writes only when asked.

This repo has no janitor script, so this command is a procedure: gather the facts per worktree, classify each one with the table below, and remove only what is provably safe. When in doubt, it is `KEEP`.

## Arguments

| Argument | Effect                                              |
| -------- | --------------------------------------------------- |
| _(none)_ | Show what would be removed and why. Writes nothing. |
| `--fix`  | Remove the ones marked `REAP`.                      |

## Task

### Step 1: Gather

```bash
git fetch origin --prune
git worktree list --porcelain
gh pr list --state all --limit 200 --json number,state,headRefName,headRefOid,mergedAt
```

If `gh` fails, or the listing returns exactly the limit (it may be truncated), every branch is `pr-state-unknown` and nothing is reaped.

For each secondary worktree (skip the first entry, the main checkout) and each local branch without a worktree, collect:

```bash
git -C <path> status --porcelain --ignored   # uncommitted, untracked, and ignored files
git rev-parse <branch>                        # local tip
git ls-remote origin refs/heads/<branch>      # still on origin?
git log --oneline origin/main..<branch>       # commits main has not seen by ancestry
```

`main` merges by squash, so `origin/main..<branch>` is usually non-empty even for merged work. Merged state comes from the PR, not from ancestry.

### Step 2: Classify

`REAP` only when **all** hold: not protected, not the current worktree, no uncommitted or untracked files, and either
- its PR is `MERGED` and the local tip equals the PR's `headRefOid` (nothing pushed after the merge), or
- the branch is gone from origin **and** every local commit is reachable from some remote ref (`git branch -r --contains <tip>`), and no open PR exists.

Everything else is `KEEP <slug>`:

| Slug                  | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `protected-branch`    | `main`, or the primary checkout.                                                                             |
| `current-worktree`    | The one this session is standing in.                                                                         |
| `uncommitted-changes` | Tracked or untracked work exists only in that working tree.                                                  |
| `ignored-content`     | Ignored files that are not regenerable, e.g. a `.temp/` handoff or a local `plugins/flow/config/config.json`. `node_modules/` does not count. |
| `pr-open`             | Someone is still reviewing it.                                                                               |
| `pr-closed-unmerged`  | A human stopped this work; the branch is its only record.                                                    |
| `commits-after-merge` | Pushed after the merge, so main has never seen those commits.                                                |
| `pushed-no-pr`        | On origin but never proposed — work in flight.                                                               |
| `unpushed-commits`    | Commits that exist nowhere else.                                                                             |
| `pr-state-unknown`    | GitHub could not be asked, or the PR listing may have been truncated. Not the same as "no PR".               |

Present the plan as one line per worktree or branch: `REAP <path|branch>` or `KEEP <slug> <path|branch>`.

### Step 3: Remove, if asked

Only when `$ARGUMENTS` contains `--fix`, and only for `REAP` lines. Record each tip SHA first, because `git branch -D` deletes the branch's reflog too:

```bash
git rev-parse <branch>            # write this down in your report
git worktree remove <path>        # no --force: let git refuse anything that changed since Step 1
git branch -D <branch>            # squash-merged branches fail `-d`; -D is safe here only because Step 2 proved the PR merged
git worktree prune
```

Report what was removed (with SHAs) and what failed. If anything failed, say so plainly and name it. A removed branch can be restored with `git branch <name> <sha>`.

## Notes

- **Branches on origin are not this command's job.** This repo does not auto-delete head branches on merge, so merged branches can remain on origin; deleting them is a separate, explicit decision.
- Safe to run any time without `--fix`; it fetches, then only reads.
- Run it from the main checkout. A worktree you are standing in is always `current-worktree`.
- Worktrees under `~/.dork/workspaces/marketplace/` may belong to a live DorkOS agent session. Treat any with uncommitted changes as `KEEP`, and do not remove one a session may be using without asking.
