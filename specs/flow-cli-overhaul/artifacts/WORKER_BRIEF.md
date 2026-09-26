# Maintenance drain: worker brief

You are a **worker** in a /flow drain of the DorkOS "Maintenance" project. The operator authorized this drain end to end: implement, open a PR, arm auto-merge, and close the tracker item. An orchestrator coordinates you. It will resume you by message several times (after review, after the PR merges), so keep your context: note your worktree path, branch and PR number.

## Your life cycle (the /flow EXECUTE → VERIFY → DONE stages)

Read these skills before you start, and follow them. They live under `<dorkos-repo>/.dork/plugins/flow/skills/`:

- `executing-specs/SKILL.md` (stage/execute items have no spec; skip the spec parts, but keep its discipline)
- `verifying-work/SKILL.md`
- `closing-work/SKILL.md`
- `linear-adapter/SKILL.md` (all tracker I/O goes through here: `composio execute LINEAR_* --account dorkos`, never `artblocks`)

Also follow the repo's `AGENTS.md`, `.claude/rules/*` for the files you touch, and the skills `working-in-worktrees`, `creating-pull-requests` and `test-driven-development` (in `<dorkos-repo>/.claude/skills/`).

### Phase 1: claim and build (your first run)

1. **Claim** each of your Linear items: add `agent/claimed` (label UNION, computed from a fresh read), set the state to In Progress, and move `stage/execute` to stay. Re-read first. If someone else already claimed it or moved it, STOP and report back.
2. **Worktree.** Never edit the main checkout.
   - dorkos repo: `cd <dorkos-repo> && git gtr new <branch> --from origin/main --yes`, then `W=$(git gtr go <branch> | tail -1)`. Verify it exists (`git worktree list`) and that `git -C "$W" rev-list --count HEAD..origin/main` is 0. gtr provisions `pnpm install`.
   - marketplace repo: the same, run from `<marketplace-repo>` (read its AGENTS.md). If it has no gtr config, use `git worktree add <path> -b <branch> origin/main` under `<workspaces-dir>/marketplace/`, and run `pnpm install` there if it needs one.
   - Branch name: `DOR-<n>-<short-slug>`.
3. **Implement** with a failing test first wherever behavior changes. Each item's description holds `## Validation criteria` and `## On Completion`: those ARE your definition of done. Read the whole issue, including its comments.
4. **Verify** in the worktree: the targeted `pnpm vitest run <paths>` runs, `pnpm --filter <pkg> typecheck` and `lint` for every package you touched, then `pnpm verify`. Run every test that renders a component you changed. Prove each new test fails without your fix, then report that.
5. **Changelog.** A user-facing change needs a fragment in `changelog/unreleased/` (see `changelog/README.md` and the `writing-for-humans` skill). A change that is not user-facing uses a `chore(`/`ci(`/`test(`/`docs(` commit subject and gets the `skip-changelog` label on the PR later. A CI pipeline change (a gate script, a workflow, `turbo.json`, lefthook) needs a `ci/ledger/` entry with a hypothesis, per `.claude/rules/ci-pipeline.md`.
6. **Commit** (end the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), then run prettier on the changed files and **push the branch**. Do NOT open the PR yet.
7. **Return** to the orchestrator in under 150 words: worktree path, branch, pushed head SHA, what changed, verification results, and anything the reviewer should look at hard.

### Phase 2: review fixes (the orchestrator resumes you with findings)

An independent adversarial reviewer reads your pushed SHA against `REVIEW.md`. For each finding: fix it, or rebut it with evidence (see the `receiving-code-review` skill). Never agree performatively. Re-verify, commit, push, and return the new SHA plus a finding-by-finding response.

### Phase 3: PR (the orchestrator tells you the review is clean)

Open the PR from your branch against `main`. Title it in plain language and name the item, for example "Keep schedules running after a full disk (DOR-2131)". The body says what happens for the user, how it was verified, and `Closes DOR-<n>` for each item. Add labels: `skip-changelog` when there is no fragment, and `review:light` for a docs/comment-only change. End the body with:
`🤖 Generated with [Claude Code](https://claude.com/claude-code)` and then
`<!-- agent:provenance {"v":1,"harness":"claude-code","sessionId":"<session-id-8>","account":"claude","surface":"flow-maintenance-drain"} -->`
Then arm auto-merge with `gh pr merge --auto <n>` (bare `--auto`, never `--squash`, never admin), and verify it is armed or queued. Move the Linear item(s) to In Review. Return the PR number.

### Phase 4: land (the orchestrator resumes you if the PR goes red or merges)

- **Red check, or the automated Claude review asks for changes:** follow `creating-pull-requests` and the CI section of AGENTS.md. A first queue ejection on a check that is plainly not yours gets ONE re-arm. A check that is yours gets a fix pushed. Never an empty commit, and never update the branch just to satisfy a gate.
- **Merged:** run the DONE stage for each item. Post a completion comment (signed `— 🤖 /flow` plus the provenance line with the full session id `<session-id>`), move it to Done, swap `agent/claimed` for `agent/completed`, and file any follow-up from `## On Completion` (label `origin/from-agent`, project Maintenance, NOT ready). Then remove your worktree (`git gtr rm <branch> --yes` or `git worktree remove`) and delete the local branch. Report back.

## Guardrails

- `git stash`, `git checkout -- <path>`, pkill/killall and admin merges are all refused. Park files in a scratchpad and restore with `cp`.
- Pin `BASE=$(git rev-parse origin/main)` once per investigation.
- Stay in scope. Something else you find broken becomes a follow-up note in your return, not a drive-by edit.
- Never write "mission control" or "cockpit" in user-facing prose, and put no DorkOS Cloud specifics in this public repo.

## Lesson from review (added mid-drain)

The post-commit hook auto-seeds a changelog fragment (marked `dorkos-changelog:seeded`) from your commit subject. If you also wrote a hand fragment, or your change is not user-facing, the seeded one has to go: move its `covers:` block byte-for-byte into your hand fragment, or delete it when you use skip-changelog. Before you push, run `python3 .claude/scripts/changelog_backfill.py --validate`. It must pass, and it has no skip-changelog bypass.
