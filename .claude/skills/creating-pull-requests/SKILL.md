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
gh api repos/{owner}/{repo}/branches/main/protection --jq '.required_status_checks'
gh api repos/{owner}/{repo} --jq '{allow_auto_merge, delete_branch_on_merge, allow_squash_merge}'
```

As of this writing:

| Setting                 | Value                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Required check          | `flow plugin` (`.github/workflows/flow-tests.yml`)                                         |
| Other CI                | `skills and manifests` (`.github/workflows/schema-check.yml`), not required but must pass  |
| Branch up to date       | Not required (`strict: false`), so a PR behind `main` can still merge                      |
| Force push to `main`    | Not allowed                                                                                |
| Merge style             | Squash via PR                                                                              |
| Auto-merge / merge queue | Off. Someone merges by hand                                                               |
| Delete branch on merge  | Off. Delete the head branch yourself after merging                                         |
| Automated Claude review | None configured. Review is a code-reviewer subagent or a human, before the PR opens       |

Both workflows deliberately run on **every** PR with no `paths:` filter: a required check with a path filter never reports on PRs outside those paths, and those PRs wait forever. Do not add one without un-requiring the check first.

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
# flow plugin (the required check) — from plugins/flow, after npm ci
npm run generate:schema && git diff --exit-code -- config/config.schema.json   # schema drift
npm run typecheck
npm test
npm run format:check

# skills and manifests — from tools/schema-check, after npm ci (needs network)
npm run check

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

Auto-merge and the merge queue are off here, so a green PR sits until someone merges it. Only merge after review has converged and the required check is green:

```bash
gh pr checks <number>
gh pr merge --squash <number>
```

Then clean up, because the repo does not delete head branches for you:

```bash
git push origin --delete <branch>     # the remote branch
/worktree:remove <branch> --delete-branch
```

If the merge happens after your session ends, sweep at the start of the next one with `/worktree:prune`.

**Opening a PR is not landing it.** In the autonomous loop the flow plugin owns landing; flow is used manually in this repo, so nobody merges a PR unless someone chooses to.

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

It reports state **transitions**, and its event vocabulary is pinned by `scripts/test-watch-prs.sh` (run it after touching the script). The events that matter in this repo are `MERGED`, `CLOSED`, `CONFLICTING`, `FAILING(names)`, `UNRESOLVED_THREADS(n)`, and `UNARMED_CLEAN` (green and mergeable, and with auto-merge off, this is the normal "ready for a human to merge" state). The merge-queue events (`QUEUED`, `EJECTED`, `STUCK_UNMERGEABLE`, `STALLED_IN_QUEUE`) cannot fire while the queue is off. It also knows that `mergeStateStatus: UNKNOWN` is retry-not-terminal, and that a rerun of a failed `pull_request` job reuses the original merge snapshot, so when `main` has moved the fix is an empty commit, not another rerun.

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
