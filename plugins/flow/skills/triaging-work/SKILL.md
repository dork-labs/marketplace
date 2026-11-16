---
name: triaging-work
description: Classify and route incoming Flow work for readiness. Use for /flow:triage.
---

# Triaging Work — the TRIAGE stage

Read [runtime fallbacks](../runtime-guide.md) before proceeding.

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

TRIAGE classifies incoming work and routes it simple-vs-complex. Tracker reads and writes other than the
outcome go through the adapter at `adapter.path`.

**The outcome is one command:**

```bash
flow triage <id> --ready --stage <execute|ideate> --json   # agent/ready + stage/<stage>
flow triage <id> --park '<question>' --json               # signed question + agent/needs-input
```

`--park` asks one question, once. A question longer than one plain line goes in
`.dork/flow/tmp/<id>-question.md` via `--question-file`. Type, priority and size stay
adapter writes. Exit 3: the tracker cannot take the write; 4: retry; 5: the item is
closed or in progress, leave it.

| Input                                         | Path                                 |
| --------------------------------------------- | ------------------------------------ |
| Freeform text or a file, not yet an item      | **A. Intake**: classify, then create |
| An existing captured item awaiting evaluation | **B. Evaluate**: judge, then route   |
| A report in a configured intake source        | **C. Report**: promote, do not move  |

From an intake source → C; the trigger names an item → B; else A.

## The MoSCoW buckets

Every item gets one, on the tracker's own priority, never a label. A repo may keep its
own rubric (its agent instructions name it); follow it where it says more.

| Bucket     | Priority                          | After triage                                                     |
| ---------- | --------------------------------- | ---------------------------------------------------------------- |
| **Must**   | `2` high (`1` urgent: broken now) | its project, ready it (`unstarted`) if the six rules pass        |
| **Should** | `3` medium                        | its project, the backlog; the groom reviews it each cycle        |
| **Could**  | `4` low                           | its project, the backlog; the groom closes it 30 days untouched  |
| **Won't**  | none                              | `canceled` with a one-line reason (a floor gate: Reject, below)  |

Most items are Should; if more than about one in five is a Must, the bar is too low. In
doubt, the lower bucket. Urgent is only for something broken now (mainline red, an open
security hole, data loss, a blocked user with no workaround). **Every triaged item has
a project**; small follow-ups from one PR are one parent item with a checklist.

## Path A — Intake

1. Read the input (a file path: read it and note the path).
2. Classify into exactly one:

   | Category         | Signals                                      | Result                                          |
   | ---------------- | -------------------------------------------- | ----------------------------------------------- |
   | **Idea**         | request, enhancement, "what if", "we should" | one `idea`                                      |
   | **Bug / Signal** | error, regression, anomaly, stack trace      | one `signal`; Must if it breaks the milestone   |
   | **Research**     | "how does X work", "investigate", "compare"  | one `research`                                  |
   | **Feedback**     | names an existing item, "follow-up on"       | comment on it; a `meta` item if it implies work |
   | **Brief**        | 3+ distinct deliverables or workstreams      | a project plus typed items (step 4)             |
   | **Ambiguous**    | no confident class                           | ask the operator                                |

   No strong signal: **Idea**.

3. Create the item(s) with `flow create`, as `<flow-root>/skills/capturing-work/SKILL.md`
   step 4 says: imperative title, the full input as description (with its source path)
   plus `## Proof` and `## Done when`, the type, origin `human`, the bucket's priority,
   a size and the project. `flow create` refuses an item missing any of them, and
   names an open near-duplicate (exit 5): comment there instead. A dependency in the
   description becomes a typed blocking relation (dispatch reads relations, never
   prose). Then route it by its bucket (above): a Must is readied with
   `flow triage --ready` at the stage Path B step 4 picks. Only an Ambiguous input
   (parked) or an `idea` held for Path B stays unready.
4. **A Brief is a floor gate.** Have the proposed decomposition checked (`answeredBy`)
   before creating a project; only on approval create it, the children, and the links.
5. Provenance comment and report (below).

## Path B — Evaluate and route

1. Read the item fully: description, type, relations, project.
2. Check alignment (advances an active project?), feasibility (architecture,
   `decisions/`), duplication (search; link a near-duplicate as related), and whether it
   already shipped (**Check the code**, below).
3. Decide:

   | Decision             | When                                 | Route                                                        |
   | -------------------- | ------------------------------------ | ------------------------------------------------------------ |
   | **Accept**           | aligned, feasible, not a duplicate   | bucket it, set the project, route by bucket (step 4)         |
   | **Reject** (Won't)   | misaligned, infeasible, out of scope | a `canceled`-category state and a comment with the reason    |
   | **Needs research**   | feasibility or scope truly uncertain | a linked `research` item; the original stays in the backlog  |
   | **Needs refinement** | too vague to act on                  | `flow triage --park '<question>'`, assign to the human, stop |

4. **Simple vs complex** picks the stage a Must is readied at (no `agent/ready`, no
   dispatch). A Should or Could stays in the backlog, unreadied, until the groom
   promotes it.
   - **Simple** (one session, one clear component, no new pattern) → a `task`:
     `--stage execute`.
   - **Complex** (3+ files across layers, a new pattern, an architectural decision,
     cross-cutting, multi-session) → `--stage ideate`; the item becomes the spec's context.
   - In doubt: complex.
5. Backfill the bucket's priority, an estimate and a project if missing, and turn prose
   blockers into typed relations. Write the estimate in the tracker's own shape. Never
   write `0` for "unknown": `0` ranks first; leave it empty.
6. Provenance comment and report.

## Path C — Report

**Off unless `intake.sources` names a tracker queue.** It needs the adapter verbs
`listIntake`, `promote` and `resolveIntake`, or says it cannot. GitHub issues:
`<flow-root>/docs/intake.mdx`.

A report belongs to its reporter (their receipt); the work belongs to the team. Many
reports can share one fix, and most reports are not work. So: **promote, not convert.
Link, do not move, and do not mirror.** Never ready a report or give it a `stage/*` label.

Every report leaves by exactly one exit: **Duplicate** (reporter follows the original),
**Promote** (new linked item), **Attach** (link to an existing item), **Needs info**
(question asked), **Decline** (reason given), **Junk** (silent close).

In this order:

1. **Dedupe first**, across the intake source and the tracker. Batch the reading, serialise the writing.
2. **Validate:** unintelligible → Needs info; not about this product → Junk.
3. **Classify** with Path A's vocabulary. This is the reporter's claim; never overwrite
   a triage verdict with it.
4. **Split:** each concern takes its own exit.
5. **Is it work?** Praise, an answered question, a preference nobody will act on: Decline
   with a reason.
6. **Promote** with `promote`: your own imperative title, the problem stated (never the
   pasted prose), a link back to the report; then route and ready it as Path B step 4.
   **Attach** adds the link to the existing item.
7. **Close the loop** with `resolveIntake`: the outcome, plus the reason or question for
   Decline and Needs info.

Decline, Junk and Needs info reply to an outside person: floor gates, checked first.
Promote and Attach need no gate of their own.

## Provenance and report

After any action, post with `flow comment <id> --text-file <f>` (it signs):

```
**Agent Action** — [YYYY-MM-DD]
**Action:** [what was done]
**Reasoning:** [why]
**Next steps:** [the route]
```

Report the items, their types, the decision and
what happens next.

## Guardrails

- **TRIAGE is an intent stage:** in the ambiguous middle, ask (`--park` or
  `AskUserQuestion`, per the channel) rather than guess.
- **Floor gates always stop:** creating a project, rejecting or cancelling someone's
  work, any outward-facing change.
- **Check the code, not the ticket.** Before calling an item open or shipped, read the
  code or tests it names. Work that already shipped is closed with the commit or PR as
  evidence, not triaged.
- **Never remove `agent/from-outside`**, attended or not: list it for a person or the
  PM; close it only when told to (`<flow-root>/docs/intake.mdx`).
- Tracker unavailable: say so and stop. Never fabricate an outcome.
