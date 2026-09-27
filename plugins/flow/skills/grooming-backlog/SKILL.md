---
name: grooming-backlog
description: The /flow engine's backlog GROOM — a whole-backlog corrective sweep that makes the configured team's backlog honestly dispatchable. Audits every open item against the fifteen groom invariants, closes shipped/duplicate/junk work with cited evidence, reconciles projects with the repo's real programme structure, classifies and gates every survivor, then verifies the result with the audit-backlog and dispatch oracles. Use when the dispatch queue starves, after a large programme lands, before enabling autonomous mode, or whenever the tracker has drifted from reality. `check` mode is the read-only audit half. PM-agnostic; all tracker I/O routes through the adapter skill.
---

# Grooming the Backlog

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

A whole-backlog corrective sweep: close what is done, merge duplicates, retire dead
projects, route the untriaged, apply the readiness gate, then prove it with the oracles.
Tracker reads and writes go through the adapter at `adapter.path` (verbs `transition`,
`comment`, `link`, `needsInput`, and its bulk-write guidance). Items in states the
generic model cannot represent are the adapter's to surface and phase 3's to route out.

**Scope is one team.** Never relabel, close or reassign an item outside it (other teams
may hold live conversations); report it as out of scope. A snapshot carrying more than
one team's identifiers: stop and fix the read first.

| Trigger       | Mode                                               |
| ------------- | -------------------------------------------------- |
| `groom check` | **Check**: phases 1 and 7 only. **Zero writes.**   |
| `groom`       | **Full**: all seven phases, human gate at phase 5. |

**Involvement.** The closure list (with evidence) and the project restructuring always
go to the operator at the phase-5 gate. Labels, priorities, estimates, states,
relations and description sections proceed under the operator's approval of the groom.

**The fifteen invariants** are the oracle, not prose: `flow audit --json` (exit 1 = an
invariant fails); `node --experimental-strip-types "<flow-root>/scripts/audit-backlog.ts" --help`
lists them.

## Procedure

### Phase 1 — Snapshot and baseline

1. `flow snapshot --include-closed --out <scratch>/before.json`.
2. Build a ledger file in the scratchpad (one row per item, current values, empty
   proposal slots). Later phases read and write it, never memory.
3. Record the baseline: `flow audit --snapshot <scratch>/before.json --json` and
   `flow next --snapshot <scratch>/before.json -n 10 --json`. Check mode: go to phase 7's report.

### Phase 2 — Project architecture

Before any item write (every item needs a live project):

- Reconcile projects with the repo's real programmes (spec manifest, strategy docs,
  commit themes): ones a founder would recognize, about 12-16 for ~250 items.
- Each project body follows `<flow-root>/templates/records/project.md`.
- A project closes only with ZERO open items after reassignment, checked on live data.
  A closed project hides every open item under it; 100% progress is not proof.

### Phase 3 — Closures, evidence first

Fan out subagents by kind, `analysis` class with the model named (Delegation Policy in
`<flow-root>/skills/executing-specs/SKILL.md`); a mechanical lookup beneath one is `mechanical`.

- **Shipped:** needs a commit SHA or PR AND a read of code or test proving it. A claim
  is not evidence. A partial ship gets a comment and a description cut to what remains.
- **Duplicates:** verify from the bodies (ground truth beats ticket prose). Merge unique
  detail into the best survivor, then close each duplicate with a comment naming it and a
  `duplicate` relation via `link`. Never use a tracker's own duplicate state: cancel.
  Same-defect-class families are `related`, and stay open.
- **Junk and limbo:** test tickets cancel; items in unmappable states move to real ones.
  A "duplicate" that is live unfinished work reopens.

Every closure carries a comment with its evidence. Ambiguity stays open and is flagged.

### Phase 4 — Fan-out triage sweep

One `analysis`-class subagent per project reads every item's full body and writes a JSON
proposal file to the scratchpad. **Triage agents make no tracker writes.** Per item:

1. One `type/*`: bug → `signal`; investigate/decide → `research`; wish → `idea`;
   scoped work → `task`; programme tracker → `meta` (never ready).
2. A calibrated priority: most work is medium; urgent means broken mainline, open hole
   or launch blocker.
3. A size (required for ready).
4. `stage/execute` (one component, no new pattern) or `stage/ideate` (multi-layer, new
   pattern, architectural decision). In doubt: complex.
5. **The six readiness rules.** Propose `agent/ready` only when ALL hold: (a) concrete
   problem with a recognizable definition of done; (b) executable unsupervised, no
   operator decision embedded; (c) unblocked; (d) not a question, decision or tracker;
   (e) needs no real-world credentials, live third-party accounts or a person at a
   keyboard; (f) sized, with both engine-read sections (`## Validation criteria`,
   `## On Completion`) written from the item, not boilerplate. Too thin: `needs-input`
   plus one crisp question. Readying 100% of a set means the bar was not applied.
6. Missing `blockedBy`/`blocks` edges. An item whose tracked blockers are closed may
   still wait on something untracked (an unaccepted decision): park it with a comment.
7. Operator-only work (real accounts, legal, spend, hardware) stays assigned to the
   operator with no agent label; everything else agent-executable is unassigned.

### Phase 5 — Review gate (human)

Merge proposals into the ledger and check mechanically first: each item proposed once;
each ready proposal complete and not droppable (open blocker, assignee, dead project);
sane priority spread; boilerplate criteria flagged. Present the closure list with
evidence, the project changes, the ready-set size with a sample, and every flag.
**No write happens before this gate clears.**

### Phase 6 — Ordered write pass

**Projects → closures → item fields → relations.** Small batches, each re-read after
writing (partial application happens). Label writes are unions against a read taken just
before the write (other sessions write too). A failed write retries by the adapter's safer
path, then is reported, never dropped.

### Phase 7 — Verify and report

1. `flow audit --json`: every invariant green over the groomed scope. Violations on items
   another session made mid-groom are out of scope: report, do not touch.
2. `flow next -n 10 --json` against the baseline. **The top picks must be work the
   operator would want an agent doing next**; a bigger pool with a wrong top pick fails.
3. Report the before/after numbers, closures with evidence, the project map, the ready-set
   size, every flag and question, and file follow-ups (`origin/from-agent`).

## Guardrails

- **Evidence before assertion.** Check the artifact, not the citation.
- **Check the code, not the ticket.** "Shipped" needs a commit or PR and a read
  of the code or test (phase 3). "Open" needs the same read: an item the code
  already satisfies is closed, not readied.
- **A new invariant ships with its failing fixture row.** Proves the check bites.
- **Per-run helpers stay in the scratchpad.** Only the invariants are code.
- **Concurrent writers exist.** Re-read before every label write; leave other sessions'
  in-flight items alone and flag them.
- **A description rewrite re-signs, it does not accumulate.** It replaces the
  provenance signature already there (`<flow-root>/docs/provenance.md`); two in one body
  leave a reader guessing.
