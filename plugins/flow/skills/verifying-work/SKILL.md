---
name: verifying-work
description: The /flow engine's VERIFY stage — trace recent work for correctness, run the verification gate, put the branch through an independent adversarial review before any PR opens, gather proof-of-completion scaled to the change, attach it to the work item under a deliberately chosen closing or non-closing reference, and hand off to the human-review gate. Use when running /flow:verify or advancing a work item into the VERIFY stage.
---

# Verifying Work — the VERIFY stage

> **Flow root.** This skill lives at `<flow-root>/skills/verifying-work/SKILL.md`. If you reached it via a symlink (`.claude/skills/flow__*` or `.agents/skills/flow__*`), resolve the real path first (`realpath <path>`): the flow root is two directories above the skill directory. Every `<flow-root>/...` reference below is relative to that root.

> **Stage:** VERIFY (spec §1). One generic, PM-agnostic stage skill.
> **Absorbs:** today's `/review-recent-work`, browser proof-of-completion, and
> code review (the `browser-testing`, `requesting-code-review`, and
> `verification-before-completion` skills).
> **PM projection (tracker):** evidence attached to the work item / PR.
> **Trigger doors:** the thin `/flow:verify` command _or_ a PM transition into
> the VERIFY stage are two triggers for this one skill.

VERIFY is the proof stage. It answers one question with evidence, never
assertion: _does the implementation actually do what the spec asked, and is it
ready for a human to approve?_ It ends by parking at the **human-review gate**
(REVIEW) — VERIFY never declares the work done itself (that is DONE, after a
human approves).

## The one tracker rule

This is a generic stage skill. **It never touches a tracker API string.**
Attaching evidence, assigning the reviewer, and any breadcrumb go through the
**adapter** skill by naming its verbs (`attachEvidence`,
`assignToHuman`, `comment`, `transition`). No raw tracker tool name, CLI
invocation, or slug lives here. (The `tracker-confinement` Vitest guard enforces
this for the whole flow bundle.)

## Process

### 1. Correctness trace (absorbs `/review-recent-work`)

Trace the recently-changed files and functions to verify the implementation is
**correct and complete**, fixing issues found in place:

- Identify the files/functions modified since the change's base (e.g. the spec's
  base SHA, or `git diff` against the merge base).
- For each function: state what it does, its callers, its callees, then trace the
  logic for correctness.
- Correct any issue found during the trace.

This is the quick inline self-review, and it is the only review you perform on
your own work. Everything that follows is read by someone else: the independent
gate in step 4 when it is configured on, the lighter conformance pass in step 3
when it is not.

### 2. The verification gate (absorbs `verification-before-completion`)

**The Iron Law: no completion claim without fresh verification evidence.** Before
asserting any status, run the proving command _in this pass_ and read its full
output — confidence is not evidence. Scale the commands to the change:

| Claim          | Command                                  |
| -------------- | ---------------------------------------- |
| Tests pass     | `pnpm vitest run [path]` → 0 failures    |
| Linter clean   | `pnpm lint` → 0 errors/warnings          |
| Types check    | `pnpm typecheck` → 0 errors              |
| Build succeeds | `pnpm build` → exit 0                    |
| Bug fixed      | original symptom test passes (red→green) |

Prefer package-filtered commands when scoped (`pnpm vitest run <file>`,
`dotenv -- turbo typecheck --filter=@dorkos/<pkg>`). Trust no agent's "success"
report without checking the VCS diff. The full `verification-before-completion`
skill carries the rationalization-prevention table — read it when tempted to
skip.

### 3. Structured code review — only when the gate in step 4 is off

Run this step **only when `review.adversarial` is false**. With the gate on, step
4 reads the same diff against the same spec and more besides, so running both
spends two full reads to answer one question.

For non-trivial changes, dispatch a fresh reviewing subagent (or your harness's
code-review skill or agent if it has one) rather than self-reviewing. Obtain the
base/head SHAs, assemble the review context (what was implemented · the task spec
from `03-tasks.json` · base/head SHAs · a summary), dispatch the subagent, and act
on its feedback. The reviewer reads actual code against the spec and the project's
standards (architecture boundaries, layering, import rules, test coverage) — it
never trusts the implementer's narrative.

This pass is **advisory**: it is scoped by size, it carries no rubric, and it does
not block the PR. You may open the PR with a finding outstanding, provided you say
so in the PR body. Step 4 is the opposite on all three counts.

### 4. Adversarial review — before the PR exists

When `review.adversarial` is true (the default), the branch **must face an
independent adversarial review before a PR exists**, and that review **blocks**:
the PR does not open until it converges. Run it here, ahead of the evidence
bundle, because a review that converges changes the diff and proof captured
against a superseded diff is not proof.

- **Dispatch `review.reviewers` separate reviewer agents** (default one). Each is
  a fresh agent with its own context — **never the agent that implemented the
  change, reviewing from the context it implemented in**. That agent reviews the
  change it remembers intending rather than the diff it produced; that is the
  exact failure this step exists to prevent.
- **Name each reviewer's model explicitly.** Reviewers are the `review` work
  class: resolve `models.tiers.review` (default `workhorse`) through
  `models.bindings` and pass the result. Never dispatch with the model omitted —
  on a harness that inherits the parent's model on omission, an orchestrator
  sitting at the frontier tier silently runs every reviewer at frontier cost. An
  unbound tier falls back to the harness default **with a note in the run**, and a
  model that errors falls sideways or down, never up to the orchestrator's model.
  The full policy, including the work-class table, lives in the EXECUTE stage
  skill; this is the reviewer's half of it.
- **Give each reviewer three things: the diff, the rubric, and the intent.** The
  diff and the files it touches (via the base/head SHAs); the rubric named by
  `review.rubric`, resolved from the repo root (default `REVIEW.md`), which
  carries the severity calibration, the repo's hard rules, and the do-not-report
  list; and the work item's description or its `03-tasks.json` task, so the
  reviewer can judge conformance — did this do what was asked — as well as
  soundness. What you do **not** hand over is your account of what you did: that
  is the story the review exists to check, not an input to it.
- **Reconcile more than one reviewer by union, not by vote.** Findings from all
  `review.reviewers` reviewers are pooled, and **any blocking finding blocks
  unless it is rebutted** — a second reviewer failing to notice a real defect is
  not evidence against the reviewer who did.
- **Converge.** Fix what the findings justify, rebut in writing what they get
  wrong, then re-review the updated diff. Repeat until a pass returns nothing
  blocking.
- **Re-verify if convergence touched code.** Any fix made during this step
  invalidates the step-2 run, so re-run the verification gate before step 5. The
  proof you attach must describe the diff you are actually shipping.

**Degradation.** The absolute rule is narrower than "always use another agent":
**never review your own branch from your own working context.** Everything below
is a documented floor beneath the full gate, and every one of them is disclosed
in the run report and in the PR's review-status line — a degraded review that
reads as a clean one is worse than none.

- **The rubric file is missing** → the reviewer proceeds on general review
  discipline (correctness, blast radius, data loss, secrets, test coverage) and
  the run says so. Mention that `/flow:init` scaffolds a rubric at the configured
  path, so the next review is calibrated rather than generic.
- **`review.adversarial` is false** → skip this step entirely and say that you
  skipped it. The tradeoff is deliberate and belongs in the report, not hidden:
  the loop is cheaper in tokens and time, and the first eye on the diff is the
  human's.
- **No second agent is available** in your harness → run the review in a **fresh
  context handed only the diff, the rubric, and the intent**, with none of the
  implementation conversation carried in. This is the degraded floor, not an
  equivalent: a fresh context cannot forget what it was never told, but it also
  cannot bring a second reviewer's independent priors. Record that the review ran
  degraded.

### 5. Proof-of-completion bundle (browser proof)

Gather proof **scaled to the surface touched** (spec §13), following the
`browser-testing` skill for the methodology. The format and attach target are
**config-driven from the `evidence` block** of `<flow-root>/config/config.json` — never
hand-picked. The pinned oracle for that decision is the flow engine's
`selectEvidence`: given the change `kind`, the
run's trigger (`liveSession`), and the resolved `evidence` config, it returns an
`EvidencePlan` — the capture format, the tool that produces it, and where the
bundle attaches. Follow its result; do not re-derive the choice by hand.

**Resolve the capture per class** (what `selectEvidence` returns):

- **UI change** (`kind: "ui"`) → run Playwright (`apps/e2e`) for the touched
  surface. `evidence.ui` picks the format; `"auto"` (default) resolves on the
  trigger:
  - **interactive** run (a live CLI/session) → an **annotated GIF** via
    claude-in-chrome's `gif_creator` (per-action keyframes with click/label
    overlays).
  - **unattended** run (no live session) → a **WebM** via Playwright's
    `recordVideo` — the path already wired in `apps/e2e`
    (`video: 'retain-on-failure'` in `playwright.config.ts`).
  - `evidence.ui: "screenshot"` pins a still; `"off"` skips UI capture.
- **Temporal behavior** (`kind: "temporal"`) → a moving recording regardless of
  trigger: `evidence.temporal` is `"video"` (WebM) by default, `"gif"` forces the
  annotated GIF, `"off"` skips it.
- **Server / logic** (`kind: "logic"`) → the verification-gate summary from step 2:
  `evidence.logic` is `"test-summary"` by default, `"full-output"` attaches the raw
  command output, `"off"` skips it.

The capture _format_ keys off whether a live interactive session is attached right
now (the same `liveSession` signal the comms router uses), never off the autonomy
of the run: `/flow auto` is autonomous yet interactive (annotated GIF reachable);
a Pulse tick is autonomous and unattended (WebM `recordVideo`).

> ### Scope boundary — v1 (this skill) vs the P5 server extension
>
> **v1 (here, interactive/CLI) attaches what an interactive or CLI run can already
> produce:** the `apps/e2e` **WebM** (`recordVideo`, headless), any `gif_creator`
> capture from a live interactive session, and the verification-command summaries.
> The selector (`selectEvidence`) and the attach step below are the full v1
> pipeline; nothing here is a placeholder.
>
> **Deferred to the P5 server extension, NOT built here:** the
> fully **unattended/server variant** — headless `recordVideo` driven by the
> server-side VERIFY runner, then **automated** tracker `fileUpload` /
> `attachmentCreate` of the artifact (binary upload) with no human in the loop. v1
> attaches _links/URLs_ to the produced artifacts via the adapter (step 6); P5
> promotes that to server-driven binary upload + the headless capture loop. When P5
> lands, `selectEvidence`'s output is unchanged — only the executor moves
> server-side. Until then, if a capture cannot be produced (e.g. no live session
> _and_ no `apps/e2e` run for the surface), VERIFY **documents the gap rather than
> faking proof**.

### 6. Attach evidence + open the review (via the adapter)

Project the proof onto the work item — the single audit surface. The plan's
`attachTo` (from `selectEvidence`, echoing `evidence.attachTo`, default
`["pr", "tracker"]`) decides which of these fire:

- **`"pr"`** → assemble the **ProofShot-style bundle** into the PR comment: the
  test/validation summary, the recording link(s) (the `apps/e2e` WebM and/or the
  `gif_creator` GIF), and the linked work item. Open / update the PR with the
  `templates/pr.md` scaffold, including its review-status line (whether the step-4
  gate ran, was skipped by config, or ran degraded, and against which rubric).
- **`"tracker"`** → via the adapter, `attachEvidence(item, evidence)` — the same
  bundle attached onto the work item's `externalUrls` (a link to each artifact + a
  link to the PR). Route this through the **adapter** verb; never touch a
  tracker string here.

If a class resolved to a `"none"` capture, its `attachTo` is empty — there is no
bundle to attach, and VERIFY says so rather than inventing one.

#### Stamp the run's provenance

A reviewer or a follow-up session should not have to guess where this change came
from. Carry the run's `provenance` block (written at EXECUTE Phase 0.5, in
`.dork/flow/flow-state.json`) onto both surfaces:

- **On the PR** — append one hidden, machine-readable line to the body:

  ```
  <!-- flow:provenance {"harness":"…","sessionId":"…","agentId":"…","host":"…","worktree":"…","branch":"…"} -->
  ```

  It is a comment, so a human reading the PR never sees it, and a later session
  can read it back without parsing prose. `templates/pr.md` carries the same marker.

  **This is the one artifact a machine parses, so it has to be valid JSON.**
  JSON-escape every value — quotes, backslashes, newlines, control characters —
  and drop any field whose value you cannot escape safely. A missing field
  degrades one lookup; an unescaped quote invalidates the whole blob, and a
  parser that silently gets nothing back is exactly the failure this line exists
  to prevent. If nothing survives escaping, write no line at all and say so.

- **On the work item** — via the adapter, and **only with verbs that already
  exist**:
  - `comment(item, body)` carrying the same block plus the identity `marker`, or
  - `attachEvidence(item, evidence)` with a link, **when — and only when — the
    provenance includes a resumable session URL** a person or a later tick can
    actually open. A link that resolves to nothing is worse than no link.

**Emit only the fields the run actually has.** Omitted is a fact; invented is a
lie a later session will act on. If provenance is empty because the harness could
determine nothing, skip both stamps and say so in the run report rather than
writing an empty block that looks like a stamp.

**If EXECUTE never ran** — you were triggered straight into VERIFY, so
`flow-state.json` holds no provenance for this item — stamp what _this_ session
can determine about itself (its own harness, session, host, worktree, branch) and
omit the rest. Partial provenance from the verifying session is still a real
trail; inventing an execution session that never happened is not.

#### Decide the closing form deliberately

Before composing the title and body, answer one question: **does this PR complete
the work item?** The rationale for caring is one line: **merge automation is
diff-blind.** It cannot tell a half-finished feature from a finished one, so the
references you write are the only truth it reads. A closing reference on a partial
PR silently closes live work, and the next dispatch pass will never see it again.

- **It completes the item** → reference the item in the **body** with the
  tracker's **closing** form (conventionally `Closes <identifier>`). The tracker's
  merge automation then moves the item to its terminal state on merge, which is
  what you want.
- **It does not complete the item** (a partial delivery, one PR of several) →
  reference it with an explicitly **non-closing** form (conventionally
  `Refs <identifier>`) and keep the identifier out of every position the tracker
  treats as closing, starting with the **title**.

**The branch name is a third closing vector, and you do not control it here.**
Many trackers close an item when a branch carrying its identifier merges,
independently of the title and body — and flow's own convention makes the
identifier the branch key on _every_ branch, so a partial PR is exposed to this by
default. Two things follow, and a partial PR needs both:

- **Check after the merge, not before.** Read the item's state once the PR lands;
  if branch automation closed it while work remains, reopen it via the adapter's
  `transition` — back to the stage projection the remaining work actually sits at,
  not merely out of the terminal state — and say that automation, not a human,
  closed it.
- **Tell the adopter about the durable fix.** The reliable cure is a setting, not
  a habit: most trackers let you disable branch-name-based auto-close in their
  git-integration settings, leaving the body reference as the only closing signal.
  Recommend it once, rather than paying the check on every partial PR.

Use the tracker's generic closing keywords — not a memorized per-tracker list.
When you are unsure which forms the configured tracker honors, or whether its
branch automation is on, read the adapter skill: it is the one component that
documents the tracker's behavior.

### 7. Hand off to the human-review gate (REVIEW)

The **human-review gate is always on** (spec §5). VERIFY does not advance to
DONE. Instead, via the adapter:

- `transition` the work item into the review state (e.g. In Review).
- `assignToHuman(item)` — assign the reviewer, which fires their notification.
- **Stop.** The engine **parks** at REVIEW. REVIEW is a human gate with **no
  skill** — there is no `reviewing-work`. The loop resumes (in P2) only on the
  human's approval, after which DONE (`closing-work`) and the auto-merge recovery
  ladder run. **In v1 there is no approval detection:** after you approve and merge
  the PR, run `/flow:done <issue>` to move the item to Done and tear down the
  worktree — the unattended approval→merge resume is the P2 server Extension.

When you report the handoff to the operator, name the work item as identifier with
title (`PROJ-157 - Title`, per the adapter's display convention), never the
bare key.

If no work item is linked or the tracker is unavailable, skip the tracker steps
silently and report the evidence inline — tracker integration is always optional.

## Calibration (spec §5)

VERIFY is an **execution stage**: in the ambiguous middle (reversible +
not-confident) it **proceeds on the best default and logs the assumption** rather
than stopping. The floor (row 0) still stops and asks via the adapter's
`needsInput`. But VERIFY's _output_ is itself the human gate — every assumption
logged during EXECUTE/VERIFY surfaces here for the human to approve.

## Guardrails

- Evidence before claims, always (the Iron Law). No "should"/"probably"/"seems".
- VERIFY never closes the loop — it parks at REVIEW. DONE is a separate stage.
- REVIEW has no skill; do not invent a reviewing skill or auto-approve.
- Never review your own branch from your own working context, and never let a
  skipped, degraded, or unconverged review pass silently — say which happened, in
  the report and on the PR.
- A PR that does not complete its work item never carries a closing reference —
  and its item's state is checked again after the merge, because the branch name
  can close it without one.
- Provenance is stamped from what the run actually knows. An omitted field is
  honest; a fabricated one sends the next session after a worker that never
  existed.
- Every reviewer is dispatched with its model named. An omitted model is not a
  neutral default — it is the orchestrator's model, at the orchestrator's price.
- All tracker I/O through the adapter. No tracker strings in this skill.
