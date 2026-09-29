---
name: closing-work
description: The /flow engine's DONE stage — report completion on a work item, move it to Done with the agent/completed label, create any follow-up work, run a project pulse check for the next loop action, and clean up the worktree. Use when running /flow:done or advancing an approved work item into the DONE stage.
---

# Closing Work — the DONE stage

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

DONE runs only **after the review gate approved** the work (a person or the reviewer
agent; unattended, after the merge). It closes the item, files follow-ups, checks the
project, cleans up.
Links and project reads go through the adapter at `adapter.path` (`link`, `getProjects`,
`getEligibleWork`, `getRelations`, and `completeProject` only when supported).

### 1. Identify the item

The given identifier; else strong local context (the spec's provenance block, an item
claimed this session); else ask.

### 2. Write the summary

What was done; evidence scaled to the work (the VERIFY bundle); files changed and the
spec link; follow-ups; for a hypothesis, whether its criteria were met.

### 3. Close it

`flow done <id> --summary-file <file> [--pr <url>] --json` posts the summary once, signed,
sets `completed` with `agent/completed` (even after a merge closed it), and completes the
run. Exit 4: run it again.

### 4. File follow-up work

The item's type and `## On Completion` say what follows (a `type/hypothesis` gets a
`type/monitor` holding its criteria). File each with:

```bash
flow create --title '<title>' --description-file .dork/flow/tmp/<key>.md \
  --label type/<type> --label origin/from-agent --priority <1-4> \
  --for-project '<project>' --key <id>-followup-<slug> --json
```

Always a type, a priority and a project (this item's); never an `agent/*` label. The
`--key` makes a retry return the first item. Write titles and descriptions as
`<flow-root>/skills/capturing-work/SKILL.md` step 3 says.

Then triage it right away (`<flow-root>/skills/triaging-work/SKILL.md`, Path B): ready
only if it passes the six readiness rules (`<flow-root>/skills/grooming-backlog/SKILL.md`,
phase 4 step 5), otherwise park it with one question. Note any items this one was
blocking as unblocked (`getRelations`); `link` only real typed relations.

### 5. Project pulse check

Skip when the item has no project. `## On Completion` routing beats the defaults. Read
the project's remaining items by type and state:

- all research done, no hypothesis or spec → recommend `/flow:ideate`, or `type/task`
  sub-issues when simple;
- all tasks under a hypothesis done → recommend closing the hypothesis;
- all monitors cleared or nothing active → the close-out decision.

**Close-out:** give `resolveProjectCompletion` (`<flow-root>/scripts/gates-policy.ts`)
the five facts: `gates.projectCompletion`, the progress rollup, the open item count
**read live** (never from the rollup), whether `specs/manifest.json` holds an active spec
for it, and whether `completeProject` is supported. Act on its `disposition`: `complete`
→ `completeProject` and report it; `advise` → recommend and leave it to the person;
`skip` → neither close nor recommend. **Always report its `reason` verbatim.** A project
with open items never closes; if the adapter refuses, do not route around it.

### 6. Clean up the worktree

For a dedicated worktree (in `04-implementation.md`, or `git rev-parse --git-dir
--git-common-dir` differ): remove it without asking only when its branch is merged, it
has no uncommitted or untracked files, and no commit is missing from the remote.
Otherwise leave it and say which condition failed. Leave the worktree before removing
it; prefer the harness's cleanup command. Unmerged: never promise to clean it "once it
merges"; say once that a start-of-session sweep removes merged worktrees.

### 7. Report

What closed, the follow-ups, and the pulse recommendation, items by the adapter's display
convention. The repo holds the prose; the tracker holds pointers, state and conversation.
