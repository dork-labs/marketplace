---
name: grooming-backlog
description: The /flow engine's backlog GROOM — a whole-tracker corrective sweep that makes the backlog honestly dispatchable. Audits every open item against the fourteen groom invariants, closes shipped/duplicate/junk work with cited evidence, reconciles projects with the repo's real programme structure, classifies and gates every survivor, then verifies the result with the audit-backlog and dispatch oracles. Use when the dispatch queue starves, after a large programme lands, before enabling autonomous mode, or whenever the tracker has drifted from reality. `check` mode is the read-only audit half. PM-agnostic; all tracker I/O routes through the adapter skill.
---

# Grooming the Backlog — the whole-tracker sweep

> **Flow root.** This skill lives at `<flow-root>/skills/grooming-backlog/SKILL.md`. If you reached it via a symlink (`.claude/skills/flow__*` or `.agents/skills/flow__*`), resolve the real path first (`realpath <path>`): the flow root is two directories above the skill directory. Every `<flow-root>/...` reference below is relative to that root.

> **What this is.** The periodic corrective sweep over the WHOLE backlog — the
> workspace-health audit that TRIAGE's scope note reserves for "a separate audit
> skill." Where TRIAGE shapes one item and the hygiene loop only _detects_
> starvation, a groom fixes the tracker itself: it closes work that is already
> done, merges duplicates, retires dead projects, routes everything un-triaged,
> and applies the readiness gate honestly — then **proves** the result with the
> `audit-backlog` oracle and a before/after run of the dispatch oracle.
>
> **Why it exists.** The dispatch gate is the literal `agent/ready` label; an
> item without it is invisible to the engine forever, and an item WITH it that
> is badly shaped burns an agent session and stalls. Backlogs decay toward both
> failure modes. The first groom of the DorkOS tracker (2026-08-03) found that
> only 21 of 276 open items passed eligibility — and of those 21, at least four
> were undoable or already shipped, including the queue's single top-ranked
> pick. A ready label nobody audits decays into noise.
>
> **This is a prose contract, not code.** The agent reads this skill and follows
> it. A thin `/flow:groom` command triggers it; the fourteen invariants live as
> the typed oracle `<flow-root>/scripts/audit-backlog.ts`.

## The one rule: never touch the tracker directly

This skill is **PM-agnostic**. It never names a tracker API, a tool string, or a
tracker-specific field. **Every tracker read or write goes through the adapter
skill** (the v1 `PMClient`, spec §3) by naming one of its capability verbs —
the groom leans on `getBacklogSnapshot()`, `getCurrentUser()`, `transition`,
`comment`, `link`, `needsInput`, and the adapter's bulk-update guidance. The
adapter also owns the **snapshot-time obligations**: tracker-specific states the
generic model cannot represent (an un-triaged holding state, an unmappable
duplicate state) are the adapter's job to surface, and this skill's job to route
out of existence during phase 3.

Read the adapter skill's contract before acting.

## Modes

| Trigger       | Mode                                                                           |
| ------------- | ------------------------------------------------------------------------------ |
| `groom check` | **Check** — phases 1 and 7 only: snapshot → oracles → report. **Zero writes.** |
| `groom`       | **Full** — all seven phases, with the human gate at phase 5.                   |

## Involvement

A full groom closes work items and restructures projects. Per the calibration
floor, two things ALWAYS go to the operator before writing, presented together
at the phase-5 gate: the **closure list** (with per-item evidence) and the
**project restructuring** (creations, renames, close-outs). Everything else
(labels, priorities, estimates, states, relations, description sections)
proceeds under the operator's plan approval of the groom itself.

## The fourteen invariants (what "groomed" means)

The oracle is the definition — run it, do not re-derive it:

```bash
node --experimental-strip-types "<flow-root>/scripts/audit-backlog.ts" --fixture <snapshot.json>
node --experimental-strip-types "<flow-root>/scripts/audit-backlog.ts" --help   # the full list
```

In one line each: every open item has exactly one `type/*` label, a project,
and a real priority (GRM-1..3); every READY item has a size, both engine-read
description sections (`## Validation criteria`, `## On Completion`), no open
blocker, no foreign assignee, a live project, and a `stage/*` label
(GRM-4..10); no dead project holds open work (GRM-11); labels are namespaced
(GRM-12); the agent state machine is single-valued (GRM-13); and a live item
never carries an unresolved `duplicateOf` (GRM-14).

## The procedure

### Phase 1 — Snapshot and baseline

1. Via the adapter, `getCurrentUser()` (the identity for GRM-8) and
   `getBacklogSnapshot()`: every open item with relations, labels, and project
   states, plus recently-closed titles for duplicate/shipped matching.
2. Materialize a **ledger** in the session scratchpad: one row per item,
   current values, empty proposal slots. Every later phase reads and writes
   this file, never its memory of it.
3. Run `audit-backlog.ts` and `dispatch.ts` on the snapshot. Record both — this
   is the BEFORE baseline the final report compares against. In **check** mode,
   skip to phase 7's report using these results.

### Phase 2 — Project architecture

Decide the programme set before any item write, because every item needs a
project and a project's state feeds eligibility.

- Reconcile the tracker's projects against the repo's REAL programme structure:
  the spec manifest, the positioning/strategy docs, recent commit themes. Aim
  for programmes a founder would recognize, not a taxonomy (roughly 12-16 for a
  ~250-item backlog).
- Each project body follows `<flow-root>/templates/records/project.md`
  (`## Goal`, `## Scope`, `## Anchor & provenance`, `## Validation criteria`,
  `## On Completion`).
- **The close-out trap:** a `completed`/`canceled` project permanently hides
  every open item under it (eligibility rule 4). A project may only close when
  it holds ZERO open items after reassignment — verify against live data,
  never a progress field. A tracker progress of 100% often means "the
  decomposition tickets closed," not "the programme shipped"; check the spec's
  own status before believing it.

### Phase 3 — Closures, evidence first

Run these before the field sweep, so no effort is spent organizing work that
should not exist. Fan out subagents by kind:

- **Shipped verification.** The bar for closing: a commit SHA or PR number AND
  a read of the code or test proving the behavior exists. A ticket (or another
  agent) SAYING it is done is not evidence. Partial ships get a comment plus a
  description rewritten down to the remaining scope — not a close.
- **Duplicate adjudication.** Verify sameness from the bodies and, where
  claims conflict, from ground truth (CI history beats ticket prose). Keep the
  best-written survivor, merge unique detail INTO it first, then close each
  duplicate with a comment naming the survivor plus a real `duplicate` relation
  via the adapter's `link` verb. Never park anything in a tracker's own
  duplicate state — cancel it. Same-defect-class families are NOT duplicates:
  link them `related` and keep each open.
- **Junk and limbo.** Test tickets cancel. Items stranded in adapter-flagged
  unmappable states get routed to a real state. If verification shows a
  "duplicate" is actually live unfinished work, REOPEN it — losing real work
  is worse than a stale ticket.

Every closure carries a comment with its evidence. Closing is heavier than
commenting: ambiguity stays open and gets flagged to the operator.

### Phase 4 — Fan-out triage sweep

One subagent per phase-2 project. Each reads every one of its items — the full
body, not the title — and writes a **proposal file** (JSON, fixed schema) to the
session scratchpad. **Triage agents make no tracker writes.** Per item they
propose:

1. Exactly one `type/*` (the TRIAGE rubric: bug/regression → `signal`;
   "investigate/decide" → `research`; feature wish → `idea`; scoped executable
   work → `task`; programme tracker/ledger → `meta`, never ready).
2. A real priority. Calibrate, do not inflate: most work is medium; urgent is
   for a broken mainline, an open hole, or a launch blocker. If a third of the
   backlog is urgent, nothing is.
3. A size estimate (required for anything proposed ready).
4. Simple-vs-complex routing, hence the `stage/*` label: single component, no
   new pattern → `stage/execute`; multi-layer, new pattern, needs an
   architectural decision → `stage/ideate`. When in doubt, complex.
5. **The readiness verdict** — the judgment that matters most. Propose
   `agent/ready` only when ALL SIX hold: (a) concrete problem with a
   recognizable definition of done; (b) executable unsupervised, no operator
   decision embedded; (c) unblocked; (d) not a question, decision, or tracker;
   (e) needs no real-world credentials, live third-party accounts, or a human
   at a keyboard — "verify against a real vendor account" is never ready no
   matter how well written; (f) sized, with both engine-read sections appended
   (written from the item's actual content, not boilerplate — if you cannot
   state a checkable validation criterion, the item is not ready). Real work
   that is too thin gets `needs-input` plus a crisp question comment; marking
   60% of a set ready is a normal outcome, 100% means the bar was not applied.
6. Missing `blockedBy`/`blocks` edges. Decomposed families almost always have
   real ordering nobody recorded — and remember the inverse trap: an item
   whose tracked blockers are all closed may still be gated by something the
   tracker cannot see (an unaccepted decision record). Park those with a
   comment, do not ready them on a technicality.
7. Operator-only work (real accounts, legal review, spend decisions, hardware)
   stays assigned to the operator with NO agent label: honestly parked.
   Everything else agent-executable gets unassigned, because the default
   ownership policy never claims a human-assigned item.

### Phase 5 — Review gate (human)

Merge proposals into the ledger and validate mechanically BEFORE presenting:
every item proposed exactly once; every ready proposal complete (stage, size,
sections) and not droppable-by-the-engine (open blocker, remaining assignee,
dead project); priority distribution sane; boilerplate validation criteria
flagged. Then present to the operator: the closure list with evidence, the
project restructuring, the ready-set size and a spot-checkable sample, and
every flag the sweep raised. **No write happens before this gate clears.**

### Phase 6 — Ordered write pass

Order matters: **projects → closures → per-item fields → relations** (relations
reference items whose state must already be settled). Via the adapter,
respecting its bulk-write guidance:

- Small batches, each re-read after writing — partial application is real.
- Label writes are UNIONS against a fresh read taken immediately before the
  write. Other sessions write concurrently; a union computed from the phase-1
  snapshot silently deletes their labels.
- Anything that fails gets retried through a safer pathway (the adapter
  documents which), then reported — never silently dropped.

### Phase 7 — Verify and report

1. Re-snapshot via the adapter. Run `audit-backlog.ts`: the pass condition is
   every invariant green over the groomed scope. If another session created
   items mid-groom, report their violations as OUT of scope — do not touch
   another session's in-flight work, and do not count it as your failure.
2. Run `dispatch.ts` on the fresh snapshot and compare with the phase-1
   baseline. The groom's real pass condition is qualitative: **the top picks
   are work the operator would genuinely want an agent doing next.** A bigger
   eligible pool with a wrong top pick is a failed groom.
3. Report: before/after oracle numbers, everything closed with its evidence,
   the project map, the ready-set size, every flag and open question routed to
   the operator, and anything discovered that belongs in a follow-up item
   (file those via the adapter, `origin/from-agent`).

## Guardrails

- **Evidence before assertion.** A citation is not a verification; check the
  artifact itself. Expect to disagree with your inputs — in the first groom,
  roughly a fifth of the pre-existing ready queue failed verification, and
  every overturned claim was caught by an agent checking rather than trusting.
- **Prove the check can fail.** The oracle's seeded-violation tests pin this
  permanently; if you add an invariant, add its red-fixture row in the same
  change.
- **Scripts are ephemeral; the oracle is code.** Per-run helpers (snapshot
  pulls, ledger builders, batch appliers) live in the session scratchpad and
  die with the session. Only the invariants deserve to be code, because only
  they must not drift between grooms.
- **Concurrent writers exist.** Re-read before every label write; never
  compute a write from stale state; leave other sessions' mid-flight items
  alone and flag them instead.
- **The engine reads descriptions.** `## Validation criteria` and
  `## On Completion` are load-bearing (DONE routes follow-ups from the
  latter); write them specific to the item or do not mark it ready.
