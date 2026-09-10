---
name: triaging-work
description: The /flow engine's TRIAGE stage — classify and route incoming work. Classifies a freeform brief/idea/bug/question into the right work-item type, evaluates an already-captured item (accept/reject/needs-research/needs-refinement) and routes it simple-vs-complex (stay-in-tracker task vs escalate to the spec workflow), or runs an intake pass over reports other people filed, promoting them into work without consuming them. Use when the goal is to evaluate and route work, not just capture it. Generalizes the legacy /pm triage/intake path; PM-agnostic.
---

# Triaging Work — the TRIAGE stage

> **Flow root.** This skill lives at `<flow-root>/skills/triaging-work/SKILL.md`. If you reached it via a symlink (`.claude/skills/flow__*` or `.agents/skills/flow__*`), resolve the real path first (`realpath <path>`): the flow root is two directories above the skill directory. Every `<flow-root>/...` reference below is relative to that root.

> **What this is.** The second stage on the `/flow` spine
> (`CAPTURE → TRIAGE → IDEATE → …`, spec §1). TRIAGE is where raw work earns its
> shape: an incoming brief is **classified** into the right work-item type, and an
> already-captured item is **evaluated and routed** — accepted into the backlog,
> rejected, sent to research, or bounced back for refinement — and the
> **simple-vs-complex** decision is made (does this stay a tracker task, or
> escalate into the spec workflow?).
>
> **Scope.** This skill owns **only** triage/intake + complexity routing. The
> legacy `/pm` command bundled seven jobs (intake, triage, the autonomous loop,
> dispatch, audit, project-status management, the review dashboard); per spec
> §1/§10 those split apart — the **loop engine** (claim → carry to the review gate)
> is a later stage's concern, and a separate **audit** skill owns workspace-health
> checks. TRIAGE does not run the loop, dispatch work, or audit the workspace.
>
> **This is a prose contract, not code.** The agent reads this skill and follows
> it. A thin `/flow:triage` command and a PM-driven transition are two **triggers**
> for this one skill (spec §1).

## The one rule: never touch the tracker directly

This skill is **PM-agnostic**. It never names a tracker API, a tool string, or a
tracker-specific field. **Every tracker read or write goes through the
adapter skill** (the v1 `PMClient`, spec §3) by naming one of its
capability verbs — e.g. _"via the adapter, transition the item …"_. The
adapter owns all the tracker tooling and projects the generic `WorkItem`
shape onto the tracker (the type-label set; a `backlog`/`unstarted` state —
the tracker's Backlog/Todo); those mappings are the _adapter's_ concern, not this
skill's.

Read the adapter skill's contract before acting.

## Three entry shapes

TRIAGE handles three shapes of input. Decide which one applies first.

| Input                                                                                        | Path                                     |
| -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Freeform text / a file** that is not yet a work item (a brief, idea, bug, question)        | **A. Classify** — classify, then create  |
| **An existing captured item** awaiting evaluation (e.g. an `idea` sitting in intake/backlog) | **B. Evaluate** — judge, then route      |
| **Reports someone outside filed**, waiting in a configured intake source                     | **C. Intake** — promote, do not consume  |

- The trigger names an **intake source** (or asks for an intake pass) → path C.
  Path C exists only when `connection.intake` names at least one source; with
  that key absent — the default — there is nothing to trigger and TRIAGE has
  exactly the two paths above.
- The trigger names a **specific existing item** → path B.
- Anything else is freeform → path A.

All three are the same stage. TRIAGE already owns "classify and route incoming
work", and a report is incoming work of a third shape — not a fourth stage.

## Path A — Classify freeform input

1. **Read the input.** If it is a file path, read the file and use its contents;
   note the source path.
2. **Classify into exactly one category** using this rubric:

   | Category              | Signals                                                                            | Result                                                                         |
   | --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
   | **Idea**              | feature request, enhancement, "what if", "we should", suggestion                   | one `idea` item                                                                |
   | **Bug / Signal**      | error report, regression, metric anomaly, "broken", "failing", stack trace         | one `signal` item, **high** priority                                           |
   | **Research question** | "how does X work", "what's the best way to", "investigate", "compare"              | one `research` item                                                            |
   | **Feedback**          | references an existing item (by identifier), "regarding", "follow-up on", critique | find the related item and comment; create a `meta` item if it implies new work |
   | **Brief**             | multi-concern document, project-level scope, 3+ distinct deliverables/workstreams  | decompose into a project + several typed items (see below)                     |
   | **Ambiguous**         | cannot classify with confidence                                                    | ask the operator to clarify (TRIAGE is an intent stage — ask)                  |

   **Default to Idea** when no strong signal matches — it is the lowest-commitment
   entry point and is cheap to re-classify.

3. **Create the item(s) via the adapter** with: a concise imperative
   **title**; the full input as the **description** (include the source path if
   from a file); the chosen **type**; **origin** `human`; and **priority/size**
   set only when scope is already clear (a signal is high priority; ideas stay
   unset until commitment). If the description claims a dependency on another item,
   ask the adapter to create the typed **blocking relation** — dispatch reads the
   relation graph, never prose blocker claims. **Then ready the work for dispatch:**
   under the full-autonomy posture (decisions A0/A1) an accepted intake item is
   readied broadly, so via the adapter apply the durable `agent/ready` label
   - the successor `stage/*` label (a clearly-actionable item → `stage/execute`;
     work that still needs shaping → `stage/ideate`), exactly as Path B's Accept
     routing does (step 4 there). The only intake that stays unreadied is an
     `Ambiguous` input parked for clarification or a deliberately low-commitment
     `idea` held back for later Path B evaluation; a `Brief` is readied per route
     after its decomposition gate (next step) clears.
4. **Brief → project decomposition is a hard gate.** If the input is a brief (3+
   distinct concerns), this is a sticky, outward-shaping decision: **stop and
   present** the proposed decomposition (each concern → its type) and **ask for
   approval before creating a project** (spec §5 — sticky + project creation is a
   floor-level gate). Only on approval, via the adapter, create the project
   and the child items and link them.
5. **Leave a provenance trail and report** (see _Provenance_ below).

## Path B — Evaluate an existing item & route it

1. **Read the item fully** via the adapter (description, type, relations,
   project).
2. **Evaluate** across three quick checks:
   - **Alignment** — does it advance an active project's goals? (Pull projects via
     the adapter.) Note the project for assignment if it aligns.
   - **Feasibility** — is it feasible within the current architecture and known
     constraints? (Check `decisions/` if uncertain.) Estimate rough scope.
   - **Duplication** — search existing items via the adapter; if a near-duplicate
     exists, link it as related and note it.
3. **Decide and route** (drive the tracker side through the adapter):

   | Decision             | Criteria                                           | Routing                                                                                                                                       |
   | -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
   | **Accept**           | aligned, feasible, not a duplicate                 | transition to the backlog; assign to the aligned project; apply `agent/ready` + the `stage/*` label; then route simple-vs-complex (next step) |
   | **Reject**           | misaligned, infeasible, or out of scope            | transition to a `canceled`-category state; comment the reason                                                                                 |
   | **Needs research**   | feasibility or scope genuinely uncertain           | create a linked `research` item; keep the original in the backlog                                                                             |
   | **Needs refinement** | too vague to act on — the originator must say more | `needsInput`: post the question, apply the needs-input label, assign to the human, stop                                                       |

4. **On Accept, make the simple-vs-complex routing call** — the heart of TRIAGE.
   This call selects the **path**, never whether readiness is applied: under the
   full-autonomy posture (decisions A0/A1) every accepted item is readied for
   dispatch on both routes. Whichever route you take, **via the adapter,
   apply `agent/ready` + the `stage/*` label** so the dispatch eligibility gate
   (the `agent/ready` constant `node --experimental-strip-types "<flow-root>/scripts/dispatch.ts"` matches on) can
   pick the work up; without `agent/ready`
   the item sits behind the gate and never dispatches (the keystone fix).
   - **Simple** (single-session, clear scope — roughly: single file / one
     clearly-scoped component, no new architectural pattern, no cross-cutting
     concern) → keep it **in the tracker** as a `task` (or a small set of `task`
     sub-items). It flows straight toward EXECUTE; via the adapter, apply
     `agent/ready` + `stage/execute` (the execute-adjacent stage label). It does
     **not** need the spec workflow.
   - **Complex** (3+ files across layers, introduces a new pattern, needs an
     architectural decision, cross-cutting, or multi-session) → **escalate to the
     spec workflow**: route onward to IDEATE (`ideating-features`) → SPECIFY; via
     the adapter, apply `agent/ready` + `stage/ideate`. The item becomes the
     spec's context and is linked for traceability; the spec carries the work from
     there.
   - **When in doubt, prefer complex** — over-planning is cheaper than
     under-planning.

5. **Set durable native fields.** While accepting, backfill a native **priority**
   and **estimate/size** if missing (these drive dispatch and the circuit
   breaker), and convert any prose blocker claims to typed relations — all via the
   adapter.

   Write the estimate in whatever shape the tracker's own estimate field takes —
   the adapter passes it through unconverted, so never reshape it by hand. Never
   write `0` to mean "I don't know": `0` is a real, smallest estimate that ranks
   the item AHEAD of everything, while leaving the field unset ranks it neutral
   (behind every concrete estimate). If you cannot size it honestly, leave it
   empty.
6. **Leave a provenance trail and report** (see _Provenance_ below).

## Path C — Intake (promote a report; never consume it)

Path C handles work **other people filed**: a support message, a public issue, a
feedback-form submission, a question sitting in a sales queue, a tracker's own
un-triaged lane. Each one is a **report**, and a report is not a work item.

**The rule is: link, do not move and do not mirror.** Three facts make that
non-negotiable, and every step below follows from them:

1. **The report is the reporter's receipt.** Something outside the loop may be
   reading its state back to them. Repurpose it as work and you destroy a record
   that was never yours.
2. **Many reports, one fix.** Five reports routinely resolve to one work item —
   and you cannot move five objects into one. A link points five ways; a move
   cannot.
3. **Most reports are not work.** Four of the six exits below create nothing at
   all, and raw reporter prose is not dispatchable input in any case.

This is why Path C **promotes** where Path B **converts**. Never run Path B on a
report: accepting one in place would ready raw prose for dispatch, in the wrong
place, and burn the receipt.

### Before anything: is intake configured?

Read `connection.intake` from config. **Empty or absent means Path C does not
apply** — say so plainly and stop; do not improvise an intake pass out of the
other two paths. Each configured entry carries:

| Field         | What it is                                                                            |
| ------------- | --------------------------------------------------------------------------------------- |
| `id`          | the source's name, used in the trigger and in every provenance line                   |
| `label`       | what to call it when talking to a person (falls back to `id`)                         |
| `coordinates` | where the reports live — **the adapter reads this**, never you                        |
| `promoteTo`   | where promoted work lands (`null` = the team flow already works in)                   |
| `outcomes`    | the source's own reporter-facing status per exit — **the words the reporter reads**  |

(Not to be confused with `involvement.calibration.stageBias.intake`, which is the
same word for a different thing: the shaping stages' ask-vs-proceed bias. It
applies here, but it is not what switches Path C on.)

Intake also names three **optional** adapter verbs — `listIntake`, `promote`,
`resolveIntake`. An adapter may not have them, and absence is never an error:
check what it declares, take the fallback below, and **say which path you took**.

| Verb            | If the adapter does not have it                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `listIntake`    | ask the operator to hand the reports in as text, and run the same pass over them                             |
| `promote`       | create the work item the way Path A creates one, then record the link as a comment on both sides             |
| `resolveIntake` | comment the outcome on the report when it is reachable as an item, otherwise report it for a person to close |

### The six exits

Every report leaves through exactly one of these. There is no seventh, and
"leave it open" is not an exit — an untouched report is the failure this path
exists to end.

| Exit           | Work side                            | Reporter sees            |
| -------------- | ------------------------------------ | ------------------------ |
| **Duplicate**  | none — merged into the earlier report | merged; follows the original |
| **Promote**    | a **new** work item, linked back     | accepted                 |
| **Attach**     | a link to an **existing** work item  | accepted                 |
| **Needs info** | none                                 | one question, asked      |
| **Decline**    | none                                 | the reason               |
| **Junk**       | none                                 | nothing — closed quietly |

Only `Promote` creates work; only `Promote` and `Attach` touch work at all; every
exit records an outcome on the report. The machine-readable form of this table is
`<flow-root>/scripts/intake.ts` (`INTAKE_ROUTING`) — the same six exits, so the
prose and the engine cannot drift.

### The pass, in order

The order is the design. **Dedupe first**, because it is the cheapest filter and
it changes what every later step is looking at. Measured on the first hand-run of
this pass — 12 reports, which produced 6 promotes, 1 attach and 2 junk, the rest
merged or sent back for detail — one report shrank from "build the feature" to
"fix the copy" purely because the duplicate search ran before anyone read it as a
feature request, and another was nearly filed as a regression of work that had
already shipped. Same step, both catches; neither survives being run later.

1. **Dedupe.** Pull the work-side candidate set via the adapter and search it for
   each report's subject, and check the reports against each other. Three
   outcomes: matches an existing **report** → `Duplicate`; matches existing
   **work** → `Attach`; matches nothing → carry on. Do this **once for the whole
   batch**: it is a set operation whose cost amortizes (one pull served every
   report in the hand-run), and it is what forces real evidence per item rather
   than a first impression.
2. **Validate.** Is the report intelligible and about this product at all?
   Unintelligible or unanswerable-as-written → `Needs info`. Spam → `Junk`.
3. **Classify.** Name the underlying concern with the Path A rubric — bug/signal,
   idea, research question. Classify the **concern**, never the reporter's mood.
4. **Split.** One message may carry several concerns. Split them now: each gets
   its own exit, and one report may produce a promote **and** an attach. Deciding
   before splitting commits every concern to one exit, which is how a two-line
   bug report becomes a feature project.
5. **Decide if it is work.** Aligned, feasible, worth doing → `Promote` (or
   `Attach` if step 1 found the work already exists). Understood and not doing it
   → `Decline`, with the reason. Not enough to act on → `Needs info`. If you have
   to reproduce or check something first, do it here: verifying is part of
   deciding, never a seventh exit and never a reason to leave a report open.
6. **Promote and link.** Via the adapter, `promote` the report — creating a new
   work item, or attaching to an existing one — and confirm the **link** landed.
   A report the adapter reports as **already linked** is already promoted: take
   the existing work item, never a second copy of it.
   A promotion that created work but recorded no link is a failed promotion, not
   a partial one: the link is what replaces moving the report. Write the work
   item in **our** words (a clear imperative title, the concern stated as work),
   with the report's reference carried in the description as provenance. Never
   paste raw reporter prose in as the work item's body. Then shape it like any
   accepted item: type, priority, size, and the `agent/ready` + `stage/*` labels
   per Path B step 4 — a promoted item joins the normal backlog and follows the
   normal simple-vs-complex routing from there.
7. **Resolve — close the loop.** Via the adapter, `resolveIntake` each report
   with its exit, the linked work item where there is one, and the message where
   the exit carries one. Never skip this: a pass that promotes work and tells the
   reporter nothing has done the invisible half of the job only.

**Batch the reading, serialise the writing.** Step 1 pulls once for everyone;
steps 2-7 run per report, in order, one at a time. Batching's failure mode is
anchoring — reading twelve reports at once and pattern-matching the eleventh
against the first — and the dedupe search is the discipline that prevents it,
because it demands evidence for each report individually.

### The gate: every exit but one is outward-facing

Five of the six exits put words or a status in front of an outside person, and
**`outward-facing` is a calibration floor trigger** — the floor always stops, at
any confidence (spec §5). So the write half of Path C is gated: present the
proposed outcomes and **ask before writing them**. Ask **once per batch**, not
once per report — one table of "report → exit → what the reporter will see" is
reviewable in a way twelve separate questions are not. `Junk` is the only exit
that reaches nobody, and the only one that needs no permission.

The work half is not gated any harder than normal triage: creating and shaping a
work item is inward-facing and follows the usual ladder.

## Provenance (all three paths)

After any triage action, via the adapter post a structured next-steps
comment so the item stays self-documenting:

```
**Agent Action** — [YYYY-MM-DD]
**Action:** [e.g. "Triaged idea — accepted, moved to backlog" / "Classified input as research"]
**Reasoning:** [brief rationale]
**Next steps:** [the routing decision — e.g. "Simple: convert to task" / "Complex: route to IDEATE"]
```

On Path C the comment goes on the **work item**, not on the report — the work
item is ours to annotate, and it names the source and the report's reference so
the trail runs both ways:

```
**Agent Action** — [YYYY-MM-DD]
**Action:** Promoted from intake source `<source-id>` (report `<reference>`)
**Reasoning:** [why this is work, and what the dedupe pass found]
**Next steps:** [Simple: convert to task / Complex: route to IDEATE]
```

The agent's own comments carry the adapter's identity marker, so the
comment-response rules (spec §5) never mistake them for a human reply — the
adapter applies that on write. Then report to the operator: identifier(s) with
title (`PROJ-157 - Title`, per the adapter's display convention), type(s),
the accept/route decision, and what happens next. A Path C pass reports the whole
batch: how many reports, the exit each took, and the work items that came out.

## Guardrails & calibration

- **TRIAGE is an intent stage** (spec §5 stage bias): in the ambiguous middle
  (reversible but not confident), **lean toward asking** rather than guessing —
  classification and routing shape everything downstream. Use `needsInput` /
  `AskUserQuestion` per the inferred comms channel.
- **Floor gates always stop**, even at full confidence: creating a project,
  rejecting/cancelling someone's work, or any outward-facing change → present and
  ask first. On Path C that covers five of the six exits, since anything the
  reporter reads back is outward-facing.
- **Never consume a report** (Path C): no exit moves it into the backlog, retypes
  it as work, or copies its body into a work item. It is linked, and it keeps its
  own life.
- **Stay in your lane.** TRIAGE classifies and routes; it does **not** run the
  autonomous loop, claim/dispatch work for execution, or audit the workspace —
  those are separate concerns (the loop engine and the audit skill).
- **If the tracker is unavailable**, the adapter will say so — surface the
  limitation plainly and stop. Never fabricate a triage outcome.

## Stage handoff

TRIAGE's successors depend on the routing decision: rejected items leave the loop;
accepted **simple** work is readied (`agent/ready` + `stage/execute`) and flows
toward EXECUTE as a tracker `task`; accepted **complex** work is readied
(`agent/ready` + `stage/ideate`) and escalates to IDEATE → SPECIFY (the spec
workflow); needs-research spins off a `research` item; needs-refinement parks on
the human until they reply.

Path C's successors are the same ones: a **promoted** report becomes an ordinary
work item that takes the simple-vs-complex routing above, readied exactly like
any accepted item. The other five exits produce no work, so they have no
successor stage — the report's own life ends at its outcome, which is the point
of keeping the two apart.

Readiness (`agent/ready`) is the dispatch fuel TRIAGE produces: without it the
dispatch eligibility gate holds the item out regardless of its state category, so
the loop starves. TRIAGE is the first readiness producer; DECOMPOSE (see
`decomposing-work`) is the second, readying the execute-ready tasks it emits.
