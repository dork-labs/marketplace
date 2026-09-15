---
description: Stage, validate, and commit changes with the gates that match what the diff touches
argument-hint: '[-m "message"] [--amend] [--no-verify] [files...]'
allowed-tools: Bash, Read, Grep
category: git
---

# Git Commit

Stage and commit changes after running the checks that match what the staged diff touches. This repo has no root `package.json` and no lint step: the gates live inside the packages that have code.

## Arguments

Parse `$ARGUMENTS` for these optional flags:

| Argument       | Effect                                                 |
| -------------- | ------------------------------------------------------ |
| `-m "message"` | Use provided commit message instead of auto-generating |
| `--amend`      | Amend the previous commit instead of creating new one  |
| `--no-verify`  | Skip the validation checks                             |
| `<files...>`   | Stage only specified files (default: all changes)      |

**Examples:**

- `/git:commit` — Auto-generate message, stage all, validate
- `/git:commit -m "fix(flow): resolve tracker slug"` — Use provided message
- `/git:commit --amend` — Amend previous commit
- `/git:commit plugins/flow/scripts/dispatch.ts` — Only stage and commit a specific file
- `/git:commit -m "wip" --no-verify` — Quick WIP commit, skip checks

## Task

### Step 0: Parse Arguments

Extract flags from `$ARGUMENTS`:

- Check for `-m "..."` or `-m '...'` — store as `USER_MESSAGE`
- Check for `--amend` flag — store as `AMEND=true`
- Check for `--no-verify` flag — store as `SKIP_VERIFY=true`
- Remaining arguments are file paths — store as `FILES`

### Step 1: Review and Stage Changes

Show the current state of the repository:

```bash
git status
git diff --staged
git diff
```

Stage changes:

**If specific files were provided:**

```bash
git add <files...>
```

**Otherwise, stage all changes:**

```bash
git add -A
```

If there are no changes to commit (or stage), report this and stop.

**Never stage local config.** If `git diff --staged --name-only` lists `plugins/flow/config/config.json`, any `*.local.json`, `.claude/settings.local.json`, or anything that looks like a secret (tokens, API keys, `.env`), unstage it (`git restore --staged <path>`) and warn the user. These are gitignored for a reason; a force-added one is a leak.

### Step 2: Run Validation Checks (unless --no-verify)

**Skip this step if `--no-verify` flag was provided.**

Decide which gates apply from the staged file list:

```bash
git diff --staged --name-only
```

| Staged paths touch                                                  | Run                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `plugins/flow/**`                                                   | In `plugins/flow`: `npm test`, `npm run typecheck`, `npm run format:check`                                    |
| `plugins/flow/scripts/**` (the Zod config schema feeds `scripts/config-schema-builder.ts`) | Also, in `plugins/flow`: `npm run generate:schema`; if `config/config.schema.json` changed, stage it |
| `.claude-plugin/**`, any `plugins/*/.claude-plugin/**`, or `SKILL.md` | From the repo root: `claude plugin validate .`, plus `claude plugin validate ./plugins/<name>` per touched plugin |
| `tools/schema-check/**`, any `SKILL.md`, or any manifest            | In `tools/schema-check`: `npm run check` (the `skills and manifests` CI check)                                 |
| Only `.claude/`, `README.md`, `CLAUDE.md`, or other prose           | No code gate. Re-read the diff instead                                                                        |

Run the flow gates in parallel from `plugins/flow` (install first with `npm ci` if `node_modules` is missing):

```bash
cd plugins/flow && npm test
cd plugins/flow && npm run typecheck
cd plugins/flow && npm run format:check
```

**Schema drift:** CI regenerates `config/config.schema.json` and fails if it differs from the committed file. When the Zod config schema source changed, run `npm run generate:schema` and include the result in this commit. Never hand-edit `config.schema.json`.

**If any check fails**: Stop and report the errors. Do not proceed to commit.

### Step 3: Review Recent Commits

Check recent commit style for consistency (conventional commits, scope is usually the plugin name, e.g. `fix(flow): ...`):

```bash
git log --oneline -5
```

### Step 4: Generate Commit Message (unless -m provided)

**Skip this step if `-m "message"` was provided** — use the user's message directly.

Otherwise, analyze the staged changes and generate an appropriate commit message:

1. Look at `git diff --staged` to understand what changed
2. Summarize the nature of changes (feat, fix, refactor, docs, chore, ci)
3. Write a concise message focusing on "why" not "what"

A Linear id (`DOR-123`) in the subject is fine when this work completes that ticket. See `creating-pull-requests` for why a PR title that names a ticket closes it.

### Step 5: Verification Gate

Before committing, verify all checks pass with FRESH evidence:

1. Confirm Step 2 validation passed (or was skipped with --no-verify)
2. Review the staged diff one more time
3. Ensure no incomplete work is being committed (no TODO markers, no commented-out code, no partial implementations)
4. Ensure nothing from private repos is in the diff (prices, plan names, hostnames, private paths). This repo is public.

Refer to the `verification-before-completion` skill: never claim work is ready to commit without fresh verification evidence.

### Step 6: Create Commit

**If `--amend` flag was provided:**

```bash
git commit --amend -m "$(cat <<'EOF'
<commit message here>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Otherwise, create a new commit:**

```bash
git commit -m "$(cat <<'EOF'
<commit message here>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Note**: When using `-m` with user-provided message, still append the attribution trailer. If the session has been given a specific attribution line, use that one instead.

### Step 7: Verify

Confirm the commit was successful:

```bash
git log -1 --oneline
git status
```

## Output Format

```
Git Commit

Validation:
  [x] flow: tests passed
  [x] flow: typecheck passed
  [x] flow: format check passed
  [-] manifests: not touched

Changes:
  - X files changed
  - [brief summary of changes]

Commit:
  [hash] [commit message first line]

Status: Ready to push
```

## Edge Cases

- **A gate fails**: Report errors with file locations, suggest fixes, do not commit (unless `--no-verify`)
- **`node_modules` missing in `plugins/flow`**: Run `npm ci` there first; report if the install fails
- **Schema drift**: Regenerate with `npm run generate:schema` and stage the result; never hand-edit the JSON
- **No changes**: Report "Nothing to commit, working tree clean"
- **Merge conflict markers**: Warn user about unresolved conflicts
- **Local config or secrets staged**: Unstage and warn (see Step 1)
- **--amend on pushed commit**: Warn user that amending will require a force push, and `main` does not allow one
- **Specified files don't exist**: Report which files weren't found, stage what exists
