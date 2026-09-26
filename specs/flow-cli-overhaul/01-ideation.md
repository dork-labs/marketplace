---
slug: flow-cli-overhaul
issue: null
created: 2026-09-26
status: ideation
---

# Make flow a tool the agent calls, not an engine the agent acts out

**Slug:** flow-cli-overhaul
**Date:** 2026-09-26
**Source:** a live session on 2026-09-25/26 that groomed the DOR backlog (20 → 73 ready items) and then drained all 15 ready Maintenance items: 10 PRs merged, each through an independent adversarial review.

---

## 1) The problem

flow has two halves:

- **Code:** about 9,700 lines of tested TypeScript "oracles" (`scripts/`): dispatch, readiness, audit, recovery and comment rules.
- **Prose:** about 43,000 words in skills and commands (78,000 words across all the plugin's markdown). It tells the agent how to build the oracles' inputs, track state, and act out loops that no runner calls yet.

Every mistake in the source session happened in the prose half, not in the code.

| What went wrong                                                                                     | Root cause                                                                                                                              |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Reported "`dispatch.ts` crashes on `wipCap: null`"; a false alarm                                   | A helper hand-built the script's JSON input wrong. Scripts don't read config themselves.                                                |
| Called DOR-1910 a live P2 bug; it had shipped in #1711                                              | The survey read tracker state only. Nothing checks code before trusting a ticket.                                                       |
| The groom relied on a snapshot script an earlier helper happened to write                           | `getBacklogSnapshot` is prose recipes, not a command.                                                                                   |
| Every worker separately discovered that `agent/ready` and `agent/claimed` are exclusive             | Label rules live in adapter prose, not in a claim command.                                                                              |
| Phase-3 and phase-4 groom proposals disagreed on the DOR-2084/2085 survivor, and nothing flagged it | No conflict check when merging proposals.                                                                                               |
| Had to write a worker brief, reviewer brief and PR watcher by hand                                  | `/flow auto` runs one item at a time. No parallel drain and no review loop.                                                             |
| Workers found items already Done after merge                                                        | Undocumented: the tracker closes on `Closes DOR-x`.                                                                                     |
| The follow-ups we filed sit unready, with no path to ready                                          | Only triage applies `agent/ready`, and nothing runs triage on its own. The triage loop exists in code, but its runner is "deferred P5". |
| DOR-1892 was labelled done but sat In Progress                                                      | State is tracked three times (tracker state, `stage/*`, `agent/*`) and drifts. This breaks Charter G1.                                  |

What worked, and should become part of the product:

- A separate adversarial reviewer at the exact pushed SHA, re-reviewing after every push (including CI fixes). It caught 5 real defects before merge: a self-resuming parked question (DOR-638), a sign-in lockout race (better-auth), a migration that broke on replay (Vercel preview), a leftover seeded changelog fragment, and a test mock missing a function the new code called.
- Resumable workers that own an item from claim to DONE.
- Proving a merge-queue ejection was not the PR's fault by checking the other queue groups that included its commit.

## 2) The principle

> If two agents should always do it the same way, it is **code**. If it needs judgment, it is a **skill**.

## 3) The plan (in build order)

### Step 1: a `flow` CLI that owns every mechanical step

| Command                                          | Replaces                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `flow snapshot`                                  | The prose recipes for `getBacklogSnapshot`, and the per-session pull scripts. Team-scoped, with states resolved and labels namespaced. |
| `flow next [--project X] [-n N]`                 | Hand-built `dispatch.ts` input. Reads config itself.                                                                                   |
| `flow claim` / `flow release` / `flow done <id>` | The label swaps, state moves, signed comments and provenance lines each worker scripted by hand.                                       |
| `flow audit`                                     | `groom check`: snapshot plus `audit-backlog.ts` in one call. Also flags tracker state, `stage/*` and `agent/*` disagreeing.            |
| `flow status`                                    | `commands/status.md` (723 words).                                                                                                      |

Result: the adapter becomes code behind the CLI. `skills/linear-adapter/SKILL.md` (6,800 words) shrinks to the WorkItem shape plus "call `flow`".

### Step 2: a first-class parallel drain with a review loop

- **`flow drain --parallel N`:** one resumable worker per item, each in its own worktree. N is capped by machine load (the session hit a load average of about 500 with 6+ builders plus other sessions, and 5s server tests timed out).
- **Built-in review loop:**
  1. The worker pushes.
  2. A separate reviewer reviews that SHA against `REVIEW.md`.
  3. Findings go back to the worker.
  4. A delta review runs after every push.
  5. The PR opens only when the review is CLEAN.
- **`flow watch`:** watches the PRs and wakes the owning worker on merge, red CI, or a queue ejection. It ships the "prove innocence" check.
- **Seeds:** the session's `WORKER_BRIEF.md`, `REVIEWER_BRIEF.md` and `watch.sh` are saved in `artifacts/` beside this doc.

### Step 3: close the "ready" loop

- **At DONE:** follow-ups run through triage right away. Ready if they pass the six readiness rules, otherwise parked with one question. Today `closing-work` step 4 says nothing about type, priority, project or readiness for a follow-up.
- **Schedules shipped and documented:** daily triage (it also releases claims untouched for 7+ days), weekly `groom check` (read-only), and a monthly full groom (operator-run, because it closes items).
  - `flow-groom` ships monthly and disabled. Change it to weekly `check`.
- **Triage and groom verify against code** before calling something open or shipped.

### Step 4: one source of truth for work state

- The tracker **state** shows broad progress, **one** `agent/*` label shows ownership, and `stage/*` exists only before EXECUTE.
- `flow audit` fails on any disagreement. This makes Charter G1 true in practice.

### Step 5: cut the words (last, after the code exists)

| File                                         | Now (words)      | Target (words)                                                                         |
| -------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `commands/flow.md` (loaded on every `/flow`) | 3,936            | ~600: routing only. The auto-drain, sentinel and Stop-hook text moves to `flow drain`. |
| `skills/linear-adapter/SKILL.md`             | 6,848            | ~1,000                                                                                 |
| `commands/pause.md`                          | 808              | ~100                                                                                   |
| Stage skills                                 | 3,000–4,400 each | ~800–1,200 each                                                                        |
| **Skills and commands total**                | **~43,400**      | **~15,000**                                                                            |

Writing rules for the rewrite:

- One rule per line, with the reason in five words or fewer.
- Each shared rule lives in exactly one file. No copies of "never touch the tracker directly", the stage table, or the provenance rules.
- No dated war stories inside steps. They go in one `docs/why.md`.
- No prose about loops that do not run. Write it when the runner ships.
- Remove the confusing parts: the "trigger doors × execution modes" 2×2, identity-mode prose beyond one line, and loop priorities for unbuilt loops.

### Step 6: measure it (weekly, via `flow status`)

- Ready vs. untriaged count.
- Median days from capture to ready.
- % of PRs CLEAN on first review, and defects caught by review.
- Merge-queue ejections that weren't the PR's fault.
- Plugin word count.

## 4) How to run it

- **Dogfood:** capture this as a tracker project, then ideate, specify and drain it with flow itself.
- **Order: 1 → 2 → 3 → 4 → 5.** The CLI makes the drain easy, the drain speeds up everything after it, and trimming last means new text is born short.
- Keep old commands working while each piece moves. Delete the replaced prose in the same PR that replaces it.
- **Rough size:** step 1 is about a week of agent work, step 2 is 3–4 days, steps 3–5 are 1–2 days each.

## 5) Quick wins available now (no rebuild)

1. Change the `flow-groom` schedule to weekly `check` and enable it. Add a daily triage schedule.
2. Add three lines to `closing-work` step 4: follow-ups get a type, a priority and a project, then go through triage.
3. Add to the adapter: claiming swaps `agent/ready` for `agent/claimed` (same exclusive group), and the tracker auto-closes on `Closes <id>`.
4. Ship `artifacts/` as a documented recipe for parallel drains until `flow drain` exists.

## 6) Open questions for the operator

- CLI runtime: Node script (`node --experimental-strip-types`, as the oracles run today) vs. a bundled binary?
- Should the parallel drain require DorkOS (for resumable agents), or run in plain Claude Code too?
- Should `stage/*` labels be retired entirely after TRIAGE, or kept read-only?
