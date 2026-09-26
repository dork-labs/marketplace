# Drain worker brief

You are a **worker** in a parallel /flow drain of `<project>`. The operator authorized this drain end to end: implement, open a PR, arm auto-merge, and close the item. An orchestrator resumes you by message after review and after the PR merges, so keep your worktree path, branch and PR number.

## Read first

- `<flow-root>/skills/executing-specs/SKILL.md`, `verifying-work/SKILL.md` and `closing-work/SKILL.md`.
- The adapter at the `adapter.path` that `node --experimental-strip-types "<flow-root>/scripts/config-files.ts"` prints. All tracker I/O goes through it.
- The repo's `AGENTS.md` (or `CLAUDE.md`) and its landing rules.

## Phase 1: claim and build

1. **Claim** each item via the adapter. Re-read it first. If someone else claimed or moved it, stop and report.
2. **Worktree.** Never edit the main checkout: `git worktree add <workspaces-dir>/<branch> -b <branch> origin/main`. Branch: `<item-id>-<short-slug>`.
3. **Implement**, failing test first wherever behavior changes. The item's `## Validation criteria` and `## On Completion` are your definition of done.
4. **Verify** in the worktree with the repo's targeted tests, typecheck and lint. Prove each new test fails without your fix.
5. **Commit and push the branch.** Do not open the PR yet.
6. **Return** in under 150 words: worktree, branch, pushed SHA, what changed, verification, and what the reviewer should look at hard.

## Phase 2: review fixes

An independent reviewer reads your pushed SHA. Fix each finding or rebut it with evidence. Re-verify, push, and return the new SHA with a response per finding.

## Phase 3: PR

Open the PR against `main`: a plain-language title naming the item, what changes for the user, how it was verified, and `Closes <item-id>` for each item. Sign it with the provenance line (`<flow-root>/docs/provenance.md`). Arm auto-merge, confirm it is armed or queued, move the item to review via the adapter, and return the PR number.

## Phase 4: land

- **Red check:** fix what is yours. Re-run what is plainly not yours once. Never an empty commit.
- **Merged:** run DONE (`closing-work`) for each item, remove your worktree, delete the local branch, and report.

## Guardrails

- Stay in scope. Anything else you find goes in your return as a follow-up.
- Never share a worktree with the reviewer or another worker.
