---
description: Validate and push commits, running the gates that match what the pushed commits touch
argument-hint: '(no arguments)'
allowed-tools: Bash, Read, Grep
category: git
---

# Git Push

Push commits to remote after running the checks that match what those commits touch. CI runs the same gates on every PR (`flow plugin`, required on `main`; `skills and manifests`), so this is the cheap local copy of them.

## Task

### Step 1: Check Current State

Verify there are commits to push:

```bash
git status
git log @{u}..HEAD --oneline 2>/dev/null || git log --oneline -5
```

If there are no commits to push, report this and stop.

### Step 2: Decide Which Gates Apply

List the files the unpushed commits touch. Pin the base once so another session's `git fetch` cannot move it between commands:

```bash
BASE=$(git rev-parse @{u} 2>/dev/null || git merge-base origin/main HEAD)
git diff --name-only "$BASE"..HEAD
```

| Pushed paths touch                                                   | Run                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `plugins/flow/**`                                                    | In `plugins/flow`: `npm test`, `npm run typecheck`, `npm run format:check`, and the schema drift check below    |
| `.claude-plugin/**`, any `plugins/*/.claude-plugin/**`, or `SKILL.md` | From the repo root: `claude plugin validate .`, plus `claude plugin validate ./plugins/<name>` per touched plugin |
| `tools/schema-check/**`, any `SKILL.md`, or any manifest             | In `tools/schema-check`: `npm run check`                                                                         |
| Nothing above                                                        | No code gate                                                                                                    |

### Step 3: Run Validation Checks

All applicable checks must pass before pushing. Install first with `npm ci` if `node_modules` is missing.

```bash
cd plugins/flow && npm test
cd plugins/flow && npm run typecheck
cd plugins/flow && npm run format:check
```

**Schema drift** (flow only), the same check CI runs:

```bash
cd plugins/flow && npm run generate:schema && git diff --exit-code -- config/config.schema.json
```

A non-empty diff means the committed schema is stale. Commit the regenerated file before pushing.

**If any check fails**: Stop and report the errors. Do not push.

### Step 3.5: Verification Gate

After all checks pass, verify with fresh evidence:

1. Re-read the output of each check you ran
2. Confirm zero failures in each
3. Do not push based on a previous run — the checks in Step 3 ARE the fresh evidence

Refer to the `verification-before-completion` skill.

### Step 4: Review What Will Be Pushed

```bash
git log @{u}..HEAD --oneline 2>/dev/null || echo "No upstream branch set"
git branch --show-current
```

If the current branch is `main`, stop and ask. `main` is protected (required `flow plugin` check, no force push); work lands through a PR.

### Step 5: Push to Remote

```bash
git push
```

If no upstream is set, push with `-u` flag:

```bash
git push -u origin $(git branch --show-current)
```

### Step 6: Verify

A compound command can exit 0 whatever the push did, so confirm against the remote:

```bash
git ls-remote origin $(git branch --show-current)
git status
```

The SHA from `ls-remote` must match `git rev-parse HEAD`.

## Output Format

```
Git Push

Validation:
  [x] flow: tests passed
  [x] flow: typecheck passed
  [x] flow: format check passed
  [x] flow: config schema in sync
  [-] manifests: not touched

Pushed:
  Branch: [branch-name]
  Commits: X commit(s)
  - [hash] [message]

Status: Successfully pushed to origin
```

## Edge Cases

- **A gate fails**: Report errors with file locations, suggest fixes, do not push
- **Schema drift**: Regenerate, commit, then push
- **No upstream**: Set upstream with `-u origin <branch>`
- **Remote rejected**: Report rejection reason (likely needs a rebase onto `origin/main`)
- **No commits to push**: Report "Already up to date with remote"
- **Uncommitted changes**: Warn user about uncommitted changes (but still push existing commits)
