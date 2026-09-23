---
name: working-in-worktrees
description: Decides when agent work needs an isolated git worktree and how to create, enter, and clean one up safely. Use when starting code changes in a checkout that may be shared with another agent, dispatching a Linear task, executing a spec, or running any parallel work that mutates tracked files.
---

# Working in Worktrees

## Overview

This skill governs **workspace isolation** in the DorkOS marketplace repo, which is routinely worked by several agents and sessions at once. It teaches the one decision rule (_one checkout, one writer_), the failure modes that make isolation non-optional, the exact mechanics for creating, entering, and cleaning up a worktree without losing anyone's work — and the half that isolation does **not** buy you, because worktrees separate working trees but share every ref.

## When to Use

- You are about to make a change and the checkout **may be shared** with another agent or session.
- You are running the `/flow:execute` stage (the workspace-choice phase of the flow plugin's `executing-specs` skill).
- You are running parallel work that mutates tracked files.
- You are comparing your branch against `main` across **more than one command** — a conflict investigation, a "what did `main` change" question.
- You need to create, enter, exit, or remove a worktree and want the safe procedure.
- You are _unsure_ whether to isolate — the default answer for code work in this repo is **yes**.

## Key Concepts

### The rule: one checkout, one writer

`main` is the **clean integration tree**, not a shared scratchpad. Changes default to an **isolated worktree**; `main` stays clean and is where branches merge back through PRs.

**Default to a worktree for any code change.** Stay in the main checkout only when _all three_ hold:

1. You are **certainly the sole writer** in this checkout, **and**
2. The work is **non-code** (a README, a package description, tracker work) **or** a single commit you land immediately, **and**
3. **No long-running process** in this checkout (a test watcher, a `flow` script run) needs to stay undisturbed.

Create a worktree when **any** trigger fires:

- 🔴 **Another agent/session may be active here** — you usually cannot prove you are alone, so assume you are not.
- 🔴 **Multi-commit / long-lived work** — a flow feature, a refactor, a new package.
- 🟡 The checkout is already **dirty or on an unrelated topic** branch.
- 🟡 A **test run or script** must run undisturbed.

### Why this is non-negotiable: two writers, one index

Two agents in one checkout share one index and one working tree. One agent's `git add -A` sweeps up the other's half-finished files into its commit; one agent's branch switch yanks the tree out from under the other mid-edit; a formatter or `npm run generate:schema` run by one rewrites files the other is reasoning about. None of it errors. The damage surfaces later as a commit containing someone else's work, or an edit that silently vanished.

The industry has shipped this failure repeatedly: Cursor "silently ran `git stash` + `git reset HEAD` mid-session"; Claude Code auto-cleanup deleted 10 days of uncommitted work (#46444). A worktree gives each agent its own tree and index, so this race cannot happen.

The `git stash` stack is the exception: it lives in the common git dir and is shared by **every** worktree. That is why the `git-guard` hook blocks `git stash` (except `list` and `show`) and `git checkout -- <path>` / `git restore <path>`. Park changes by copying files to a scratch location instead.

### Two readers, one ref namespace

The hazard above is about two **writers** sharing one working tree. There is a second, quieter one: two **readers** sharing one set of refs. A worktree isolates the working tree. It does **not** isolate the refs or the object store — those live in the common git dir, shared by every worktree of this repo:

```bash
git rev-parse --git-dir --git-common-dir              # differ ⇒ you are in a secondary worktree
git rev-parse --git-path refs/remotes/origin/main     # …yet this resolves under the COMMON dir
```

So you can hold a perfectly isolated tree and still share one `origin/main` with every other session on the machine. When any of them runs `git fetch`, that ref moves **for you too** — including between two commands of your own investigation.

**Nothing errors.** Every command exits `0`. Two `git` invocations seconds apart simply answer against different trees, and the inconsistency surfaces only as a conclusion that does not match the code. In the DorkOS app repo, an agent resolving a merge conflict listed the files `main` had touched and concluded `main` had modified files it had never touched — a concurrent session had fetched mid-investigation. A wrong answer that looks reasonable does not get caught.

**The rule: pin the base once, then never name the moving ref again.**

```bash
BASE=$(git rev-parse origin/main)          # once, at the start of the comparison
git diff --name-only "$BASE"...HEAD
git log --oneline "$(git merge-base "$BASE" HEAD)"..HEAD
```

- Use `$BASE` for every step of a multi-step comparison — **never write `origin/main` twice** in one line of reasoning.
- Prefer `git merge-base "$BASE" HEAD` over re-reading the branch name. A merge base recomputed against a ref that moved is a _different_ merge base, silently.
- **Treat a surprising file list as evidence the ref moved, not as data.** Re-derive it against a pinned SHA before you reason one step further.
- **Hand people SHAs, not ref names.** "`main` touched 8 files" is unfalsifiable an hour later; "`2a8fb9c` touched 8 files" is checkable forever.

### Where this repo's worktrees live

There is no `.gtrconfig` and no post-create hook here. Worktrees are plain `git worktree` checkouts, and they show up in several places because different tools made them:

| Location                            | Made by                                    |
| ----------------------------------- | ------------------------------------------ |
| `.worktrees/<branch>` (gitignored)  | `/worktree:create` — the default           |
| `../marketplace-wt/<name>`          | earlier manual sessions                    |
| `~/.dork/workspaces/marketplace/…`  | DorkOS agent sessions — may be in use      |

`git worktree list` shows all of them. Never remove one under `~/.dork/workspaces/` without checking that no session is using it.

### Non-code phases stay in the main checkout

The `/flow` intent stages — `/flow:ideate`, `/flow:specify`, `/flow:decompose` — write spec markdown and tracker breadcrumbs only. They do not mutate code, so they can run without a worktree. Isolation begins at **execution** — the `/flow:execute` stage.

## Step-by-Step Approach

1. **Detect whether you are already in a worktree.**

   ```bash
   git rev-parse --git-dir --git-common-dir
   ```

   The two paths are **equal only in the main worktree**. If they differ, you are already in a secondary worktree — **work here, do not nest**. Never create a worktree from inside one.

2. **Judge "am I alone?"** You usually can't prove it. Heuristics, weakest to strongest:
   - Did _you_ start this checkout, or were you handed it mid-state? Handed-in ⇒ assume shared.
   - `git status` shows changes you did not make ⇒ another writer is here.
   - `git worktree list` shows siblings ⇒ multi-worktree work is already underway.
   - **Default for this repo: assume shared.** When in doubt, isolate.

3. **Create the worktree** (keyed by unit of work — a descriptive slug, or `dor-123` when it completes that ticket):

   ```
   /worktree:create <branch-name>            # from origin/main (default)
   /worktree:create <branch-name> --from-current
   ```

   By hand, the equivalent is:

   ```bash
   git fetch origin
   git worktree add .worktrees/<folder> -b <branch-name> origin/main
   ```

   **Do not key the branch by ticket id unless the branch will _complete_ that ticket.** Linear closes an issue whose identifier appears in the merged PR's branch name, so `dor-123` on a branch that only partly delivers DOR-123 closes it anyway. Use a descriptive slug for partial work; see `creating-pull-requests` → **A merged PR closes the ticket it names**.

   **Always base on `origin/main`.** Local `main` drifts behind origin, and a worktree started there carries a stale base into its PR diff.

   **Install dependencies only where the work needs them.** A new worktree has no `node_modules`:

   ```bash
   npm ci --prefix .worktrees/<folder>/plugins/flow          # flow tests, typecheck, format, schema generation
   npm ci --prefix .worktrees/<folder>/tools/schema-check    # the skills-and-manifests gate
   ```

   Manifest-only or prose-only work needs neither.

   **Local flow config stays in the main checkout.** flow reads its settings from the project's `.agents/flow/`, and from a linked worktree it finds the main checkout's copy, so nothing needs copying in. Never commit `.agents/flow/config.local.json`, or a legacy `plugins/flow/config/config.json` left by flow before 0.8.0.

4. **Verify it exists before you rely on it.**

   ```bash
   W="$(git rev-parse --show-toplevel)/.worktrees/<folder>"
   if [ -d "$W" ]; then
     git -C "$W" log --oneline -1
     git -C "$W" rev-list --count HEAD..origin/main   # 0 == based on origin's tip
   else
     echo "MISSING — recreate it"
   fi
   ```

   **Every line that touches `$W` must sit inside the guard.** `git -C ""` falls back to the _current_ directory — so a `git -C "$W" …` left outside the `if` reports on wherever you happen to be standing, exits `0`, and manufactures the success you were trying to disprove. A check that cannot fail is worse than no check.

   **If you were handed a path, verify it before you start and say so if it is wrong.** Silently recreating or relocating a path you were briefed with costs the orchestrator more than failing loudly.

5. **Enter without restarting** — move the running session in with the **EnterWorktree** tool, passing `path` = the worktree's absolute location. It works for any path that appears in `git worktree list`. The session cwd switches with no CLI restart. (`claude -w <name>` instead starts a _fresh_ session already inside one.)

6. **Do the work**, commit (`/git:commit`), push (`/git:push`), open the PR from the worktree branch.

7. **Exit** with **ExitWorktree** (`keep` to leave it on disk, `remove` to delete) before cleanup, or `cd` back to the main checkout.

8. **Clean up after merge** — for the one worktree you know about, `/worktree:remove <branch> --delete-branch`. But the merge usually lands after your session is over, so the more reliable habit is to sweep at the **start** of a session:

   ```
   /worktree:prune          # what would go, and why
   /worktree:prune --fix    # remove it
   ```

   That collects everything that merged while you were away. It refuses anything it cannot prove is safe — uncommitted, unpushed, still open, or unaskable — and names the reason for each. This repo does not delete merged head branches on origin automatically, so delete the remote branch when you merge (`git push origin --delete <branch>`).

   **Do not skip this because the worktree is "just" a review checkout.** Review checkouts pile up fastest, because a review leaves no PR or ticket behind to remind anyone.

## Landing Work from a Shared or Diverged Checkout

When you've already committed on a shared `main` that has diverged from `origin/main` (another PR merged upstream while you worked), **do not rebase the shared checkout** — that churns the working tree and can yank the branch out from under a co-tenant agent. `main` is protected anyway, so the commit has to land through a PR. Move it into an isolated worktree:

1. `git fetch origin` — refs only; never touches the working tree.
2. `git worktree add .worktrees/<folder> -b <branch> origin/main` — a fresh worktree at origin's tip.
3. `git -C .worktrees/<folder> cherry-pick <your-sha>` — re-apply just your commit.
4. `npm ci` in the packages you touched, run the gates, then `git -C .worktrees/<folder> push -u origin <branch>`.
5. Open the PR, merge, then `/worktree:remove <branch> --delete-branch` and delete the remote branch.
6. **Reconcile the shared checkout** once its working tree is clean and you are sure no one else is using it: `git fetch && git reset --hard origin/main` drops the now-redundant local commit (recoverable via reflog). Re-check `git status` is clean immediately before resetting.

Better still: start the work in a worktree from the outset so the divergence never happens.

## Best Practices

- **Key by unit of work, not session.** A workspace outlives any one session and can be reattached. Use a ticket id in the branch only when the branch will **complete** that ticket (step 3).
- **`main` is the merge target, not the workbench.** Land branches into it through PRs; don't accumulate ad-hoc edits there.
- **Install per package.** There is no root `package.json`; `npm ci` only in `plugins/flow` or `tools/schema-check` when you need their gates.
- **Record the worktree** in the spec's implementation notes when running `/flow:execute`, so the `/flow:done` stage can offer cleanup.

## Common Pitfalls

- ❌ Starting code work in a shared checkout "because it's a small change" — a shared index does not care how small your change is.
- ❌ Creating a worktree from inside a worktree (always run the two-path `rev-parse` detection first).
- ❌ Reporting a worktree path without checking it exists.
- ❌ Silently recreating or relocating a worktree path you were handed.
- ❌ Auto-removing a worktree with **uncommitted, untracked, or unpushed** work — refuse and confirm first. This is where Claude Code and Cursor both shipped data-loss bugs.
- ❌ Removing a worktree under `~/.dork/workspaces/marketplace/` that a DorkOS session may still be using.
- ❌ Committing a copied-in `plugins/flow/config/config.json` or `*.local.json`.
- ❌ Naming `origin/main` twice in one investigation. Pin it once (`BASE=$(git rev-parse origin/main)`) and compare against `$BASE`.
- ❌ Believing a file list that surprised you. In a shared checkout that is first evidence the ref moved, not a finding to reason from.

## References

- Repo conventions: `CLAUDE.md`
- Commands: `/worktree:create`, `/worktree:list`, `/worktree:remove`, `/worktree:prune`
- Execution gate: the `/flow:execute` stage, the workspace-choice phase of the flow plugin's `executing-specs` skill
- Cleanup: the `/flow:done` stage (`closing-work` skill)
- PRs and ticket-closing rules: `creating-pull-requests`
