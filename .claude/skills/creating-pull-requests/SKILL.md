---
name: creating-pull-requests
description: When and how to open a pull request in the DorkOS marketplace repo (review the pushed branch first, open the PR after it converges), what CI gates it, how a PR title closes a Linear ticket, and how to watch a PR to merge. Use when finishing a branch, opening a PR, or landing one.
---

# Creating Pull Requests

How marketplace PRs are opened, gated, and landed. This repo is worked by several agents at once, so the mechanics below keep PRs clean and the review loop cheap.

## When to use

- You have finished a branch and are deciding when to open the PR.
- You are about to open a PR (from an agent or by hand).
- A PR is open and you are waiting for it to go green or merge.

## How this repo is set up

Ask the repo rather than trusting this list, because settings change:

```bash
gh api repos/{owner}/{repo}/rules/branches/main \
  --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'
gh api repos/{owner}/{repo}/rules/branches/main --jq '[.[].type]'   # merge_queue, deletion, non_fast_forward, ...
gh api repos/{owner}/{repo} --jq '{allow_auto_merge, delete_branch_on_merge, allow_squash_merge}'
```

A repository ruleset protects `main`, so read the rules API. The older
`branches/main/protection` endpoint reads classic branch protection only, which this repo
no longer uses, and it would miss required checks.

As of this writing:

| Setting                 | Value                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Required checks         | `flow plugin` (`flow-tests.yml`), `skills and manifests` (`schema-check.yml`), `script fixtures` (`scripts-test.yml`) |
| Merge queue             | On, squash. It runs the required checks on your PR on top of `main` and everything ahead of it |
| Branch up to date       | Not required: the queue tests the combined tree, so being behind blocks nothing        |
| Force push / delete `main` | Not allowed                                                                         |
| Auto-merge              | On. Arm your own PR; nothing else arms PRs yet (merge-tail: DOR-2270)                  |
| Delete branch on merge  | On. GitHub deletes the head branch when the PR merges                                  |
| Automated Claude review | None configured (DOR-2270). Review is a code-reviewer subagent or a human, before the PR opens |

Every check runs on **every** PR and every merge-queue run (`merge_group`), with no `paths:` filter and no job-level `if:`: a required check that skips a PR, or never reports on the queue's run, leaves that PR waiting forever. Do not add a filter without un-requiring the check first.

## The order: review the branch, then open the PR

The independent review runs **against a pushed branch, before a PR exists**. Opening the PR is the last step, not the first:

1. Build in an isolated worktree and run the local gates.
2. Push the branch. **Open nothing.**
3. A reviewer (the `requesting-code-review` skill, or `/flow:verify`) fetches and checks out that branch. It does not need a PR.
4. Findings, fixes, convergence.
5. Squash or tidy to a clean history.
6. **Then** open the PR, already reviewed.

Why: an open PR is an invitation to act. Another session can merge a PR carrying open blocking findings when every check is green. A branch invites nothing. And a PR held open across review rounds watches `main` move under it.

The one real cost: **CI does not run until the PR opens.** Cover it by running the local gates yourself (below). When you genuinely need the runner's answer, open a **draft** so CI runs without inviting a merge, then mark it ready once review converges.

## Before you open: branch from a worktree

Code PRs come from an isolated worktree, never the shared `main` checkout (see the `working-in-worktrees` skill). Base the worktree on `origin/main`, not local `main`, so the PR diff contains only your changes:

```
/worktree:create <branch>
```

Commit conventions and the pre-push gate live in the `/git:commit` and `/git:push` commands. End commit messages with the `Co-Authored-By` trailer.

## Run the CI gates locally

CI runs these; run the ones your diff touches before you push:

```bash
# flow plugin (required) — from plugins/flow, after npm ci
npm run generate:schema && git diff --exit-code -- config/config.schema.json   # schema drift
npm run typecheck
npm test
npm run format:check

# skills and manifests (required) — from tools/schema-check, after npm ci (needs network)
npm run check
npm run check:bump -- origin/main HEAD      # every package you changed raised its version

# script fixtures (required) — from the repo root; one suite per run, so loop
for t in scripts/test-*.sh .claude/skills/creating-pull-requests/scripts/test-watch-prs.sh; do bash "$t" || echo "FAILED: $t"; done

# Claude Code manifest validity — from the repo root
claude plugin validate .
claude plugin validate ./plugins/<name>
```

**Schema drift is the easy one to miss.** CI regenerates `plugins/flow/config/config.schema.json` from its Zod source and fails if the committed file differs. Never hand-edit it; run `npm run generate:schema` and commit the result.

**A new or renamed package touches three places.** `plugins/<name>/.claude-plugin/plugin.json`, its entry in `.claude-plugin/marketplace.json`, and its entry in `.claude-plugin/dorkos.json`. A PR that updates one without the others is incomplete even when CI is green.

**Never commit local config.** `plugins/flow/config/config.json` and `*.local.json` are gitignored; only the `*.example.json` templates are committed. Check `git diff --name-only origin/main...HEAD` before opening.

## Opening the PR

Open it once the branch has converged:

```bash
gh pr create --title "<type>(<scope>): <summary>" --body "<body>"
```

PR body: lead with what changed and why, link the issue, list the gates you ran, and call out anything reviewers should look at first. This repo is public: nothing from private repos (prices, plan names, hostnames, private paths) goes in a title or body.

Open a **draft** instead when you still need CI to tell you something:

```bash
gh pr create --draft --title "<type>(<scope>): <summary>" --body "<body>"
gh pr ready <number>
```

### A merged PR closes the ticket it names — from the title, the branch, or a magic word

The tracker is Linear team DOR (shared with the DorkOS app). Linear's GitHub integration moves an issue on PR lifecycle: In Progress on open, Done on merge. It never reads the diff to check whether the work is actually finished. There are three ways a PR names a ticket and they do not behave alike:

| Where the identifier appears                                           | On merge               |
| ---------------------------------------------------------------------- | ---------------------- |
| A bare id in the **title** or the **branch name**                      | **Closes** the ticket  |
| A **magic word** anywhere, body included — `Closes`/`Fixes`/`Resolves` | **Closes** the ticket  |
| A **bare id in the body**, or `Refs DOR-634`                           | Links only, stays open |

So **match what you write to the truth — say "closes" only when the PR completes the ticket.** A PR that advances a ticket without finishing it keeps the identifier out of the title _and_ the branch name, and refers to it from the body in a form that does not close: a bare id, or `Refs DOR-634`.

**The body is not automatically safe.** Moving the id out of the title and then writing `Closes DOR-123.` in the body, because that is the habit, reproduces the exact failure. In the DorkOS app repo two tickets were closed this way in one day and had to be reopened by hand: a code ticket closed by a PR that only delivered its specification, and another closed by a PR that delivered only the server half.

The corollary matters as much: when the PR genuinely completes the ticket, the identifier in the title is doing exactly what you want. The rule is about telling the truth, not avoiding identifiers.

Branch names carry the same force, so the choice is made before the PR exists — see `working-in-worktrees` → **Create the worktree**.

## Rebase before you expect CI

**A pull request with merge conflicts gets no CI at all — and no red check to tell you so.** GitHub builds a PR's test-merge commit before it starts any `pull_request` workflow. When the branch conflicts with `main`, that commit cannot be built, so GitHub starts nothing. The PR looks quiet and clean because nothing ever looked at it, and the required `flow plugin` check just never appears.

So: **rebase onto `origin/main` and push before you open the PR.** If GitHub's PR page says the branch has conflicts, treat every green space on that page as meaningless.

## Merging

Once review has converged and the PR is open, arm it and let it land itself:

```bash
gh pr merge --auto --squash <number>
```

It joins the merge queue and merges as soon as the required checks pass there. The queue tests your PR on top of `main` and everything ahead of it, so being behind blocks nothing: **never update a branch to satisfy a gate** (no `gh pr update-branch`, no merging `main` in). The queue owns the merge method, so gh may print `! The merge strategy for main is set by the merge queue`; that is not a refusal. Confirm with `gh pr view <number>`.

**A new commit disarms auto-merge.** GitHub drops the armed state on every push to the PR branch, silently. Re-arm once the new commit's checks are green.

**Never an admin merge.** `gh pr merge` with the admin flag, a REST `PUT .../pulls/<n>/merge` and the `mergePullRequest` mutation each land a change without the queue's checks, and every agent on this machine runs as an admin. In Claude Code the PreToolUse guard `.claude/hooks/merge-guard.mjs` refuses them; other harnesses may not run it, so there treat this sentence as the whole rule. If the queue itself is broken, say so and leave the PR alone.

Arm only when every signal is good; `scripts/should-arm-automerge.sh` (pinned by `scripts/test-should-arm-automerge.sh`) is the rule, so never a draft, a conflicting PR, a PR with changes requested or an unresolved thread, or one with a check failing, cancelled or still running. **A PR labelled `hold`, `do-not-merge`, `wip` or `blocked` is not armed**; the labels mean the same in dork-labs/dorkos. Nothing arms PRs automatically yet: a scheduled `merge-tail` workflow that runs that rule over every open PR arrives once the `dorkos-merge-tail` GitHub App is set up here (DOR-2270). A label does not disarm a PR that is already armed: `gh pr merge --disable-auto <number>` does.

GitHub deletes the head branch when the PR merges. Remove your worktree afterwards:

```bash
/worktree:remove <branch> --delete-branch
```

If the merge happens after your session ends, sweep at the start of the next one with `/worktree:prune`.

### Watching a PR: watch the checks, not the merge state

The obvious poll — "has it merged yet?" — is blind to the one outcome you most need to catch:

```bash
gh pr view <number> --json state --jq .state   # OPEN until MERGED/CLOSED — says NOTHING about a failed check
```

A required check that **fails** leaves the PR `OPEN`, indistinguishable from a PR whose checks are still running. Watch the check **conclusions** instead:

```bash
gh pr checks <number>                                   # one bucket per check: pass | fail | pending | skipping
gh pr view <number> --json statusCheckRollup --jq \
  '[.statusCheckRollup[] | select(.conclusion=="FAILURE") | .name]'   # the failures, by name
```

**Do not write the watch loop from memory — run the tested one:**

```bash
.claude/skills/creating-pull-requests/scripts/watch-prs.sh --interval 60 --max-cycles 60 <number> [<number>...]
# pipe it into the Monitor tool for hands-free notification; --once for a single cycle
```

It reports state **transitions**, and its event vocabulary is pinned by `scripts/test-watch-prs.sh` (run it after touching the script). The events that matter in this repo are `MERGED`, `CLOSED`, `CONFLICTING`, `FAILING(names)`, `UNRESOLVED_THREADS(n)`, and `UNARMED_CLEAN` (green and mergeable but nobody armed it: arm it). The merge-queue events are live too: `QUEUED(pos)` is informational; `EJECTED(reason)` means the queue dropped the PR, which nothing else reports (read the failing job; if it is plainly not yours, re-arm once with `gh pr merge --auto --squash <number>`); `STUCK_UNMERGEABLE` is a dead entry that keeps its place (dequeue it with the `dequeuePullRequest` GraphQL mutation, then re-arm); `STALLED_IN_QUEUE` means no checks reported on the queue's run, usually a required check missing its `merge_group` trigger. It also knows that `mergeStateStatus: UNKNOWN` is retry-not-terminal. A red check that is not yours gets one rerun (`gh run rerun <run-id> --failed`), never an empty commit.

Three rules for any PR watcher:

- **A failed check conclusion must be a terminal condition.** A watcher without one cannot see the most common stall.
- **Zero unresolved threads proves nothing about checks.**
- **A watcher that dies must say so.** `--max-cycles N` announces its own expiry (exit 3); answer it with a direct `gh pr checks` look.

## Stacked branches and squash merges

Two recurring conflict shapes when several branches share files and `main` merges by squash:

- **Your own squashed base conflicts with you.** A branch stacked on another branch (or on its own earlier PR) hits "changed in both" conflicts against the squash commit, with byte-identical content on both sides. Pin the base first — `BASE=$(git rev-parse origin/main)` — then verify each conflicted file is identical between the merge base and `$BASE` (`git diff <base>:<file> "$BASE":<file>` — empty means the conflict is pure squash noise), then keep the branch side wholesale. Write files out with `git show HEAD:<file> > <file>` — `git checkout -- <path>` is blocked by the git-guard hook. Confirm with a three-dot diff against `$BASE` showing only the branch's own work. **Reuse `$BASE`; never name `origin/main` twice in one comparison** — see `working-in-worktrees` → _Two readers, one ref namespace_.
- **A textually clean merge is not a semantically clean one.** When sibling branches landed on one seam, `git merge origin/main` can resolve cleanly while leaving a call to a renamed helper, a test asserting behaviour another PR changed, or a stale generated schema. After merging `main` into any branch whose neighbours touched the same area: run the typecheck and tests, and regenerate `config/config.schema.json`, before pushing.

**A push is not landed until the remote says so.** A compound command ending in `; echo ...` exits 0 whatever the push did. Confirm with `git ls-remote origin <branch>` showing the SHA.

## Gotchas

- **A fresh worktree has no `node_modules`.** The gates above fail with missing-module errors until you run `npm ci` in `plugins/flow` (and `tools/schema-check` if you need it). That is setup, not a real failure. Prettier drift you never saw locally then shows up as a red `format:check` step inside the `flow plugin` check.
- **A red `flow plugin` check is not always the tests.** It runs schema drift, typecheck, tests, and format check in that order; read which step failed before debugging.
- **`skills and manifests` needs network.** It fetches the pinned upstream DorkOS schemas; an offline local run fails before checking anything.
- **A new Linear issue lands in Triage, not the backlog.** Creating an issue without an explicit state leaves it in the team's triage queue, where it is easy to miss. Tracker I/O normally routes through the `/flow` `linear-adapter` skill, which sets state for you.
- **A stalled check may be GitHub, not you.** Before debugging why a run sits queued for a long time, check githubstatus.com.
