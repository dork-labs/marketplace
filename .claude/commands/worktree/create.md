---
description: Create an isolated git worktree for parallel work
argument-hint: '<branch-name> [--from-current]'
allowed-tools: Bash(git worktree list), Bash(git rev-parse --git-dir --git-common-dir), Bash(git fetch origin), Bash(scripts/worktree-git.sh branch-exists:*), Bash(scripts/worktree-git.sh add:*), Bash(scripts/worktree-git.sh add-existing:*), Bash(scripts/worktree-git.sh describe:*), Bash(npm ci:*), Read, EnterWorktree, AskUserQuestion
category: git
---

# Worktree Create

Create an isolated git worktree under `.worktrees/` (gitignored). This repo has no `.gtrconfig` and no post-create hook, so the worktree is plain git: install dependencies yourself only if the work needs them.

Git runs through `scripts/worktree-git.sh`, run from the main checkout's root (never a worktree's copy), wherever a command takes a branch or a path: it checks each argument, then runs one fixed git command. Pass worktree paths exactly as `git worktree list` prints them. Do not reach for raw `git -C`, `git log` or `git ls-remote` instead: those are the prefix rules this command no longer allows, because their options can write files and run commands.

## Arguments

Parse `$ARGUMENTS` for:

| Argument         | Effect                                                        |
| ---------------- | ------------------------------------------------------------- |
| `<branch-name>`  | **Required.** Name of the branch/worktree to create           |
| `--from-current` | Base the new branch on the current branch (not `origin/main`) |

**Examples:**

- `/worktree:create fix-flow-slug` — New worktree from `origin/main`
- `/worktree:create fix-flow-slug --from-current` — New worktree from the current branch

## Task

### Step 0: Parse Arguments

Extract the branch name and `--from-current` flag from `$ARGUMENTS`. If no branch name is provided, report the error and stop.

The folder name is the branch name with `/` replaced by `-` (`fix/flow-slug` → `.worktrees/fix-flow-slug`).

### Step 1: Validate Prerequisites

Run these checks. Stop on any failure:

```bash
# Verify we're in the main worktree: the two paths below are equal only
# there — in a secondary worktree --git-dir points into .git/worktrees/
git rev-parse --git-dir --git-common-dir
```

If the two paths differ, the current directory is a secondary worktree — warn the user and stop.

```bash
git worktree list
scripts/worktree-git.sh branch-exists <branch-name>
```

If a worktree already exists for `<branch-name>`, report its location and stop. If the branch exists locally but has no worktree, ask whether to check it out (`scripts/worktree-git.sh add-existing <folder> <branch-name>`) instead of creating a new one.

### Step 2: Create Worktree

```bash
git fetch origin

# From origin/main (default)
scripts/worktree-git.sh add <folder> <branch-name> origin/main

# OR from the current branch (if --from-current)
scripts/worktree-git.sh add <folder> <branch-name> HEAD
```

**Always base on `origin/main`, not local `main`.** Local `main` drifts behind origin, and a worktree started there carries a stale base into its PR diff.

### Step 3: Install Dependencies (only when needed)

A new worktree has no `node_modules`. Install only in the package the work touches:

```bash
# flow plugin work (tests, typecheck, format, schema generation)
npm ci --prefix .worktrees/<folder>/plugins/flow

# schema-check work, or to run the skills-and-manifests gate locally
npm ci --prefix .worktrees/<folder>/tools/schema-check
```

Manifest-only or prose-only work needs neither. If `npm ci` fails, report the error but note the worktree was created.

### Step 4: Verify, Then Report

Confirm the worktree exists before reporting a path to anyone:

```bash
git worktree list
scripts/worktree-git.sh describe <absolute path of .worktrees/<folder>, as the list prints it>
```

`describe` prints the branch, then the last commit. It refuses any path `git worktree list` does not print, so a refusal here means the worktree is missing: recreate it.

### Step 5: Offer to Switch the Session

Offer to move the current session into the new worktree using the EnterWorktree tool, passing `path` = the absolute worktree path from Step 4. If accepted, all subsequent work happens inside the worktree with no CLI restart; ExitWorktree returns later. If declined, the user can `cd` there themselves or start a fresh session in that directory.

## Output Format

```
Worktree Created

Location: <absolute-worktree-path>
Branch:   <branch-name>
Base:     <short-sha> (origin/main | current branch)
Deps:     plugins/flow installed | none needed

Next steps:
  - I can switch this session into it (EnterWorktree), or
  - cd <absolute-worktree-path>
```

## Edge Cases

- **Already in a worktree**: Report "You're already in a worktree. Switch to the main working tree first."
- **Branch already exists as worktree**: Report the existing worktree location
- **Branch name invalid**: Let git report the error naturally
- **npm ci fails**: Report the error but note the worktree was created (user can fix manually)
