---
name: closing-work
description: The /flow engine's DONE stage — report completion on a work item, move it to Done with the agent/completed label, create any follow-up work, run a project pulse check for the next loop action, and clean up the worktree. Use when running /flow:done or advancing an approved work item into the DONE stage.
---

# Closing Work — the DONE stage

> **Flow root.** This skill lives at `<flow-root>/skills/closing-work/SKILL.md`. If you reached it via a symlink (`.claude/skills/flow__*` or `.agents/skills/flow__*`), resolve the real path first (`realpath <path>`): the flow root is two directories above the skill directory. Every `<flow-root>/...` reference below is relative to that root.

> **Stage:** DONE (spec §1). One generic, PM-agnostic stage skill.
> **Absorbs:** the legacy `/linear:done` close flow (retired in spec #257).
> **PM projection (tracker):** Done state + `agent/completed` label.
> **Trigger doors:** the thin `/flow:done` command _or_ a PM transition into the
> DONE stage are two triggers for this one skill.

DONE is an **intentional** act — "I'm satisfied; close the loop." It runs only
**after the human-review gate (REVIEW) has approved** the work (and, in the
autonomous loop, after the auto-merge recovery ladder has merged a green,
cleanly-mergeable diff — spec §6). It reports completion, advances the work item,
seeds the next loop phase, and tears down the workspace.

## The one tracker rule

This is a generic stage skill. **It never touches a tracker API string.** The
completion comment, the Done transition, the `agent/completed` label, follow-up
creation, relation links, and the project pulse-check reads all go through the
**adapter** skill by naming its verbs (`comment`, `transition`,
`createSubIssue`, `link`, `getProjects`, `getEligibleWork`, `getRelations`, and —
only in `auto` mode, and only when the adapter declares it supported — the
optional `completeProject`). No raw tracker tool name, CLI invocation, or slug
lives here. (The
`tracker-confinement` Vitest guard enforces this for the whole flow bundle.)

## Process

### 1. Identify the work item

- Use the explicitly provided identifier (e.g. `PROJ-123`) when present.
- Otherwise infer only from strong local context: the spec's provenance block /
  `linear-issue:` frontmatter, or an item claimed earlier in this session.
- If still ambiguous, ask a short bounded question. Do not close casually.

### 2. Build the completion summary

- **What was done** — a brief summary.
- **Evidence** — proof scaled to the work (the VERIFY bundle): the test command +
  pass summary for server/logic work; a screenshot or annotated GIF for UI work;
  video only for temporal behavior. Paste/attach it on the item.
- **Files changed** (if applicable) and the spec directory link (if routed
  through the spec workflow).
- **Follow-ups** needed; for hypotheses, whether the validation criteria were
  met.

### 3. Comment + advance the item (via the adapter)

- Via the adapter, `comment(item, body)` — post the completion summary (carries
  the agent's `identity.marker`).
- Via the adapter, `transition(item, "done")` — move to a `completed`-category
  state and set `agent/completed`, clearing `agent/claimed`. **Match on state
  category, never on the display name** — the adapter owns that mapping.

### 4. Create follow-up work (when required)

Driven by the item's type and its `## On Completion` routing:

- `type/hypothesis` → via the adapter, create a `type/monitor` item carrying the
  hypothesis's validation criteria (origin labelled as from-agent).
- If this item was blocking others, note that they are now unblocked (read via
  the adapter's `getRelations`); use `link` only for genuinely typed relations.

### 5. Completion routing + project pulse check

- Read the item's `## On Completion` section first — it is the most specific
  signal for what to recommend next; when it is absent, fall back to the
  project pulse-check rules below.
- Run a **project pulse check** (skip if the item has no project): via the
  adapter, read remaining items in the same project, group by type + state
  category, and apply the loop-continuity rules:
  - All research Done, no hypothesis/spec → recommend `/flow:ideate` (complex) or
    creating `type/task` sub-issues (simple).
  - All tasks under a hypothesis Done → recommend closing the parent hypothesis.
  - All monitors cleared → the project itself may be finished; take the close-out
    decision below.
  - Zero remaining active items → gather the facts the close-out decision needs
    (below) rather than deciding here.
- **The close-out decision.** Gather five facts about the project and let the
  oracle decide — do not re-derive the rules here:
  - `gates.projectCompletion` (`"advisory"` or `"auto"`),
  - the project's progress rollup (`done` of `total`),
  - its **open item count, read live** through the adapter (never inferred from
    the rollup — the two disagree exactly when it matters),
  - whether `specs/manifest.json` still holds an active spec for the project, and
  - whether the adapter declares the optional **`completeProject`** verb supported.

  Feed them to `resolveProjectCompletion` in
  `<flow-root>/scripts/gates-policy.ts`, which returns a `disposition` and the
  `reason` that decided it. Act on the disposition:
  - `complete` → close the project via the adapter's **`completeProject`** verb,
    then report that you did it and with which outcome.
  - `advise` → recommend the close-out, offer to run it, and leave the decision
    with the human.
  - `skip` → do **not** close it and do **not** recommend closing it. Report the
    project's status and move on.

  **Always report the `reason` verbatim** alongside what you did. It is the whole
  point of the shape: "I did not close it" is only useful to a person paired with
  which condition stopped it. That oracle is the source of truth if this prose and
  that code ever drift.

  One condition is worth knowing by name even though the oracle enforces it: a
  project with **open items** is never closed, in either mode. A project in a
  terminal state hides its open items from dispatch permanently, so closing one
  early strands that work where nothing will ever surface it again. The adapter's
  verb re-checks this itself and refuses loudly; do not treat its refusal as a
  failure to route around.
- Present the project state, the action taken or the action recommended, and offer
  to run a recommendation. If no transition is detected, report the project status
  briefly.

### 6. Clean up the workspace

If the work ran in a dedicated git worktree (recorded in the spec's
`04-implementation.md`, or detected when `git rev-parse --git-dir
--git-common-dir` prints two different paths), clean it up here.

**Remove it without asking when all three of these hold:**

- its branch is merged,
- its working tree has no uncommitted and no untracked files, and
- it holds no commit that is missing from the remote.

That combination makes removal lossless, and asking costs more than it protects.
If any one of them fails, leave the worktree alone and say which one failed —
never remove a worktree with uncommitted, untracked, or unpushed work.

If the session is currently inside that worktree, **leave it first** (return to
the main checkout, using your harness's worktree-exit tool if it has one) before
removing. Prefer your harness's own worktree cleanup command over bare
`git worktree remove` when it has one, since it may also tear down provisioning
that git does not know about.

**When the branch is not merged yet, do not promise to clean it up "once it
merges."** Nobody will be there. Where merging is automated — an auto-merge
setting, a merge queue, a scheduled merge bot — the merge lands minutes to hours
after this stage runs, and the session that would have done the cleanup is gone
by then. So the reliable habit is a sweep at the START of a session, not a
promise at the end of one: a periodic pass that removes every worktree whose
branch has since merged. Tell the person that, once, instead of leaving a
worktree behind with no owner.

### 7. Report

Report what was closed, any follow-up created, and the project-pulse next-action
recommendation. Name every work item as identifier with title (`PROJ-157 - Title`,
per the adapter's display convention), never the bare key.

## Guardrails

- DONE is intentional and gated — never close an item casually or before REVIEW
  approval.
- Do not skip the project pulse check unless the item has no project context and
  no clear parent flow.
- Prefer the item's explicit `## On Completion` routing over generic defaults.
- Filesystem stays canonical; the tracker holds pointers + state + conversation,
  never a second copy of the prose.
- All tracker I/O through the adapter. No tracker strings in this skill. If
  the tracker is unavailable, explain the limitation clearly rather than guessing.
