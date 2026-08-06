---
name: executing-specs
description: Orchestrates parallel implementation of decomposed specifications with incremental progress tracking. Use when running the /flow:execute stage (the EXECUTE stage of the /flow engine).
disable-model-invocation: true
---

# Executing Specifications

> **Flow root.** This skill lives at `<flow-root>/skills/executing-specs/SKILL.md`. If you reached it via a symlink (`.claude/skills/flow__*` or `.agents/skills/flow__*`), resolve the real path first (`realpath <path>`): the flow root is two directories above the skill directory. Every `<flow-root>/...` reference below is relative to that root.

Implement a specification by orchestrating parallel background agents across dependency-aware batches, with incremental persistence to survive context compaction.

## Stage: EXECUTE in the `/flow` model

This skill is the **EXECUTE stage** of the unified `/flow` stage model (the spec's stage spine: … DECOMPOSE → **EXECUTE** → VERIFY → ⟦HUMAN REVIEW⟧ → DONE …). A PM transition into the EXECUTE stage and the thin `/flow:execute` command are two triggers for this same skill; its PM projection is In Progress + the `agent/claimed` label. When tracker I/O is needed (claiming the work item, the In Progress transition, breadcrumbs), route it through the **tracker adapter** skill by naming its capability verbs — this skill never touches a tracker string directly. The behavior below is unchanged.

## Supporting Files

| File                                 | When Loaded         | Purpose                                   |
| ------------------------------------ | ------------------- | ----------------------------------------- |
| `implementation-summary-template.md` | Phase 1 (once)      | Scaffold for `04-implementation.md`       |
| `analysis-agent-prompt.md`           | Phase 2 (once)      | Full prompt for the analysis agent        |
| `implementation-agent-prompt.md`     | Phase 3 (per batch) | Full prompt for each implementation agent |

**Key rule**: Read supporting files on demand, not upfront. This keeps context lean.

---

## Delegation Policy

Everything below dispatches workers. Two rules govern every dispatch, and this is the one place they are written down — the other stage skills refer here rather than restating them.

### Which model a worker runs on

Three tiers exist, and only two of them are yours to hand out:

| Tier        | What it means                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `frontier`  | The seat **you** are orchestrating from. Not a delegate tier: flow never names it, never binds it, and never routes a worker onto it. |
| `workhorse` | The strong general-purpose model this machine can reach.                                                                              |
| `fast`      | The cheap quick one.                                                                                                                  |

**The invariant: every delegated worker names its model explicitly.** Never dispatch a worker with the model left unspecified. On a harness that inherits the parent's model when you omit one, an orchestrator sitting at `frontier` that omits it runs _every_ delegate at frontier cost — silently, and with nothing in the run to show it happened. Resolve the model as: work class → `models.tiers.<class>` → `models.bindings.<tier>`.

| Work class       | What it covers                                                           | Tier                          |
| ---------------- | ------------------------------------------------------------------------ | ----------------------------- |
| `implementation` | The agents that write the change.                                        | `models.tiers.implementation` |
| `review`         | Spec-compliance and code-quality reviewers.                              | `models.tiers.review`         |
| `analysis`       | Planning, execution-plan, and investigation agents.                      | `models.tiers.analysis`       |
| `mechanical`     | Searches, scaffolds, renames, log triage — work with a checkable answer. | `models.tiers.mechanical`     |

**Degradation — the policy never blocks work:**

- **A harness with one model** → bind both tiers to it. The policy becomes a no-op; that is a valid configuration, not an error.
- **A tier with no binding** → fall back to the harness's default model **and note it in the run**. A silent fallback is indistinguishable from a policy that worked.
- **A bound model that errors** → fall back sideways (the other tier) or down (`workhorse` → `fast`). **Never up** to the model you are orchestrating on: an error is not a reason to spend frontier tokens on a delegate.
- **An explicit human instruction** ("use the big model for this one") overrides the policy, and is logged as an assumption.

### The resume ladder

When work needs to continue — a failed task, a follow-up, a review fix, a later session picking the item back up — **continue the worker that already did the reasoning** before starting one that has to re-derive it. Three rungs, in order:

1. **Continue the originating worker.** Requires two things to be true: you are on the **same machine** the run started on (compare `provenance.host` in `.dork/flow/flow-state.json` against this machine), and the harness has **retained that worker's context** and supports continuing it. When both hold, continue it — it still holds the reasoning, the dead ends it already ruled out, and the shape of the code it wrote.
2. **A fresh worker, seeded from the durable artifacts.** Hand it the worktree (**the worktree is ground truth** — the committed diff outranks any account of it), `.dork/flow/flow-state.json`, `04-implementation.md`, and the task record. Say in the run that you started fresh and why rung 1 was unavailable.
3. **Escalate to the human.** When neither rung produces a worker that can proceed.

`context.resume` sets how far down you may fall:

- **`"prefer"` (default)** — try rung 1, drop to rung 2 when it is unavailable, and say which happened.
- **`"require"`** — rung 1 or nothing. If the originating worker cannot be continued, **surface it loudly and stop**. Never silently degrade to rung 2: a restart that reads like a resume is exactly the failure this setting exists to prevent.
- **`"never"`** — always start at rung 2, even when rung 1 is available.

When `context.perIssue` is `"sticky-session"`, this item's follow-ups and rework return to the originating session as a matter of policy, so rung 1 is the expected path rather than an optimization.

---

## Phase 0: Choose Workspace

Execution changes code — decide where it runs before any agent starts.

### 0.1 Detect Current State

```bash
git rev-parse --git-dir --git-common-dir && git branch --show-current && git status --porcelain
```

If the two rev-parse paths **differ**, the session is already in a secondary worktree — the workspace question is settled, so skip 0.2 through 0.4 and execute here. Still do **0.5**: a run always records where it came from.

### 0.2 The Config Decides — Read `workspace.isolation`

Read `workspace.isolation` from `<flow-root>/config/config.json`. It has already answered this question; do not re-ask it.

- **`"worktree"` (the default) → isolate, without asking.** Create the isolated worktree and execute there. The rationale is _one checkout, one writer_: a checkout is routinely shared with other agents and sessions, and two writers in one checkout corrupt each other's work. Say in one line that you isolated and why; do not turn it into a question.
- **`"none"` → execute in place, without asking.** The operator has opted out of isolation deliberately.

To isolate, create an isolated git worktree for this spec (e.g. `git worktree add ../spec-<SLUG> -b spec-<SLUG>`) and work in it; if your harness provides dedicated worktree tooling, prefer that (it can provision dependencies, ports, and env, and switch the session in without a restart). `workspace.flow` names which of the two the operator expects.

**Two things override the config**, and only two:

- **An explicit human instruction** for this run ("do it right here", "isolate this one"). Follow it and log it as an assumption.
- **A config that cannot decide** — missing, unreadable, or resolving to something the ladder above does not cover. Fall back to 0.3.

### 0.3 Fallback: Ask, When the Config Cannot Decide

Only when 0.2 did not resolve. These triggers apply the _one checkout, one writer_ rule by inspection instead of by policy — recommend an isolated worktree when any of them holds (usually at least one does):

- the working tree has uncommitted changes unrelated to this spec
- the current branch is a different topic than this spec
- another agent or session is working in this checkout
- a dev server in the main checkout should keep running undisturbed

If a trigger applies, ask the human: execute in place, or isolate in a worktree. If none applies, execute in place without asking.

### 0.4 Record the Choice

If a worktree was created, note its path and branch in `04-implementation.md` (Session section) so the completion step and the `/flow:done` stage can offer cleanup.

### 0.5 Stamp the Run's Provenance

Write a `provenance` block onto this issue's record in `.dork/flow/flow-state.json`, so a later session can find its way back to this one. Fill in whatever the running harness can actually determine:

| Field       | What it is                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`   | The agent harness you are running in, as it names itself.                                                                                                |
| `sessionId` | This session's own id. Some harnesses expose it directly; on others it is derivable from where the session's transcript is written. Derive, never guess. |
| `agentId`   | The worker/agent id this run is operating as, when the harness assigns one.                                                                              |
| `host`      | This machine's hostname. Load-bearing: a retained transcript is only reachable from the machine holding it.                                              |
| `worktree`  | The absolute path this run is executing in (from 0.2/0.3).                                                                                               |
| `branch`    | The branch this run is on.                                                                                                                               |

**Omit any field you cannot determine — never fabricate one.** A missing field costs a later session one rung on the resume ladder; a fabricated one sends it chasing a worker that does not exist, and makes the run report a resume that never happened.

---

## Phase 1: Setup & Scaffold

### 1.1 Extract Feature Slug

```
SPEC_FILE = <the spec path from user arguments>
SLUG = extract second path segment (e.g., "user-auth" from "specs/user-auth/02-specification.md")
TASKS_JSON = "specs/<SLUG>/03-tasks.json"
TASKS_FILE = "specs/<SLUG>/03-tasks.md"
IMPL_FILE = "specs/<SLUG>/04-implementation.md"
```

Display:

```
Executing specification: <SPEC_FILE>
Feature slug: <SLUG>
```

### 1.2 Quick Validation

1. **Verify spec exists**: Check `SPEC_FILE` exists
2. **Verify tasks exist**: Use `TaskList()` to check for tasks with `[<slug>]` in subject
   - If no tasks: Display "No tasks found. Run the `/flow:decompose` stage first." and stop
3. **Count tasks**: Total, completed, pending/in-progress

### 1.3 Scaffold 04-implementation.md (IMMEDIATELY)

This is the critical behavioral change: scaffold the implementation file NOW, before any agents run.

**If `IMPL_FILE` does NOT exist (new session):**

1. Read `<flow-root>/skills/executing-specs/implementation-summary-template.md`
2. Extract the feature name from the spec's title (first `# heading` in `02-specification.md`)
3. Substitute variables:
   - `[FEATURE_NAME]` → feature name from spec
   - `[DATE]` → today's date (YYYY-MM-DD)
   - `[SLUG]` → feature slug
   - `[TOTAL]` → total task count
4. Write to `specs/<SLUG>/04-implementation.md`

**If `IMPL_FILE` DOES exist (resume session):**

1. Read the existing file
2. Find the last `### Session N` header, increment to N+1
3. Append a new session section:

   ```
   ### Session <N+1> - <DATE>

   **Workers:** _(none yet)_

   _(No tasks completed yet)_
   ```

   Read the previous session's **Workers** line and its per-task worker ids before you start: they are the handles rung 1 of the resume ladder needs to continue an existing worker rather than start a cold one.

4. Update "Last Updated" date in frontmatter

Display:

```
Quick validation:
  Specification found
  Tasks found: <count> tasks for <SLUG>
  [New implementation / Resuming session <N+1>]
  Implementation file: specs/<SLUG>/04-implementation.md (scaffolded)
```

---

## Phase 2: Spawn Analysis Agent

1. Read `<flow-root>/skills/executing-specs/analysis-agent-prompt.md`
2. Substitute `[SPEC_PATH]` and `[SLUG]` in the prompt text
3. Launch a background worker. This is the **`analysis`** class — name its model explicitly, resolved through the Delegation Policy above:

```
Task(
  description: "Analyze <SLUG> execution plan",
  prompt: <substituted analysis prompt>,
  subagent_type: "general-purpose",
  run_in_background: true
)
```

Display:

```
Analyzing tasks and building execution plan...
```

4. Wait for result: `TaskOutput(task_id: <id>, block: true)`
5. Parse the returned execution plan (session info, batches, cross-session context)

---

## Phase 3: Execute Batches

### 3.1 Display Execution Plan

```
═══════════════════════════════════════════════════
              EXECUTION PLAN
═══════════════════════════════════════════════════

Task Summary:
   Completed: <X> tasks (skipping)
   In Progress: <Y> tasks (will resume)
   Pending: <Z> tasks (will execute)

Execution Batches (parallel groups):
   Batch 1: [Task 1.1, 1.2, 1.3] - No dependencies
   Batch 2: [Task 2.1, 2.2] - Depends on Batch 1
   ...

Estimated: <N> parallel batches
   (vs <M> sequential tasks without parallelization)

═══════════════════════════════════════════════════
```

### 3.2 Proceed (Default: Auto-Execute)

By default, proceed immediately to full execution — **do not ask**. Only pause if the user explicitly passed `--pause`, `--step`, or `--review` in the arguments.

If a pause flag was passed:

```
AskUserQuestion:
  "Ready to execute <Z> tasks in <N> parallel batches?"
  Options:
  - "Execute all batches" (Recommended) - Run all tasks to completion
  - "Execute one batch" - Run only the first batch, then pause
  - "Review tasks first" - Show detailed task list before executing
```

Otherwise, display:

```
Executing all <Z> tasks across <N> batches...
```

### 3.3 Execute Each Batch

For each batch in the execution plan:

**Step A: Read prompt and launch agents**

1. Read `<flow-root>/skills/executing-specs/implementation-agent-prompt.md`
2. For each task in the batch:
   - Substitute `[TASK_ID]` with the task's ID
   - Substitute `[CROSS_SESSION_CONTEXT]` with context from the analysis agent (or "N/A - first session")
   - Launch as the **`implementation`** class, naming the model explicitly (Delegation Policy). **Record the worker id or name the harness assigns** — Step E persists it, and it is what rung 1 of the resume ladder needs later:
     ```
     Task(
       description: "Implement <task.subject>",
       prompt: <substituted implementation prompt>,
       subagent_type: <agent type from execution plan>,
       run_in_background: true
     )
     ```

Display:

```
Batch <N>: Launching <X> parallel agents
   -> <Task 1> <subject>
   -> <Task 2> <subject>
```

**Step B: Wait for all agents in batch**

```
for agent_id in batch.agent_ids:
  result = TaskOutput(task_id: agent_id, block: true)
```

Display as each completes:

```
   [Task 1] Completed
   [Task 2] Completed with warnings
```

**Step C: Handle failures**

If any task failed:

```
Batch <N> had failures:
   [Task 3]: <error description>

Options:
- "Continue the failed task's worker" (default) - Resume it with the failure
- "Skip and continue" - Mark as blocked, proceed to next batch
- "Stop execution" - Pause for manual intervention
```

**Retrying means continuing, not relaunching.** The default is rung 1 of the resume ladder: go back to the worker that failed, hand it the failure, and let it carry on from the context it already has. Relaunching from zero throws away everything it learned and usually reproduces the same failure. Fall to rung 2 — a fresh worker seeded from `04-implementation.md`, the task record, and the diff so far — only when the harness cannot continue that worker, and say so when you do.

**Step D: Two-Stage Review (per task)**

After each task's agent completes successfully:

Reviewers are the **`review`** class; name their model explicitly (Delegation Policy).

**Stage 1 — Spec Compliance Review:**
Dispatch a review agent to verify the implementation matches the task spec:

- Did the agent implement everything requested?
- Did the agent add anything not requested?
- Did the agent misinterpret any requirements?
- CRITICAL: The reviewer must read actual code, not trust the implementer's report.

If issues found: **continue the implementer's own worker** to fix them (rung 1 — it wrote the code and knows why), then re-review. Only seed a fresh worker from the task record and the diff if that worker cannot be continued.

**Stage 2 — Code Quality Review (only after Stage 1 passes):**
Dispatch a fresh reviewing subagent (or your harness's code-review skill or agent if it has one) to review the diff for correctness, security, and adherence to the spec, giving it:

- `{WHAT_WAS_IMPLEMENTED}`: from the implementer's report
- `{PLAN_OR_REQUIREMENTS}`: the task description from `03-tasks.json`
- `{BASE_SHA}`: commit before task
- `{HEAD_SHA}`: current commit
- `{DESCRIPTION}`: task summary

If Critical or Important issues found: continue the implementer's worker to fix them, then re-review. (The **reviewer** is always a separate worker — never the one that wrote the change. Continuing applies to fixing, not to reviewing.)

Never start Stage 2 before Stage 1 passes.

**Step E: APPEND batch results to 04-implementation.md (INCREMENTAL WRITE)**

This is the second critical behavioral change: persist results after EACH batch, not at the end.

1. Read current `specs/<SLUG>/04-implementation.md`
2. For each successful task in the batch, parse the agent's result report
3. **Update "Tasks Completed" section** — Under the current session header, replace `_(No tasks completed yet)_` (if first batch) or append after existing entries, recording **which worker did it**:
   ```
   - Task #<ID>: <subject> — worker: <worker id/name, or "unknown">
   ```
   The worker id is the handle the harness assigned when you launched the task (Step A). Write `unknown` when the harness assigned none — never invent one. A later session reads this to attempt rung 1 of the resume ladder for a follow-up on this exact task, and a wrong id is worse than a missing one.
4. **Update "Files Modified/Created" section** — Append any new files from agent reports (deduplicate)
5. **Update "Known Issues" section** — Append any issues from agent reports
6. **Update task count** — Increment "Tasks Completed: X / Total" in the Progress section
7. **Update the session's Workers line** — the roster of worker ids this session used, so a resume attempt has one place to look
8. Write the updated file

**Step F: Update task status**

```
for task in batch.successful_tasks:
  TaskUpdate({ taskId: task.id, status: "completed" })
```

**Step G: Display batch summary**

```
Batch <N> complete: <X>/<Y> tasks succeeded
   Proceeding to Batch <N+1>...
```

---

## Phase 4: Finalize

After all batches complete:

### 4.1 Finalize Implementation Summary

1. Read `specs/<SLUG>/04-implementation.md`
2. Change `**Status:** In Progress` to `**Status:** Complete`
3. Verify task count matches total
4. Add any final implementation notes under the current session
5. Write the updated file

### 4.1b Update Manifest Status

If your project tracks specs in a `specs/manifest.json`, update this spec's entry
to status `implemented` so the manifest stays in sync. Use your harness's
manifest-maintenance command or script if it provides one; otherwise edit the
entry directly. (Skip this step entirely if your project has no spec manifest.)

### 4.2 Display Completion Summary

```
═══════════════════════════════════════════════════
              IMPLEMENTATION COMPLETE
═══════════════════════════════════════════════════

All tasks completed successfully

Summary:
   - Tasks completed: <X>
   - Files modified: <Y>
   - Execution time: <T>

Implementation summary: specs/<SLUG>/04-implementation.md

Documentation Review:
   If the change affects documentation, reconcile the docs

Next steps:
   - Manifest status updated to "implemented"
   - Commit the changes
   - To incorporate post-implementation feedback, revise the spec and re-run
     decompose + execute
   - If this ran in a dedicated worktree (Phase 0): merge via PR, then remove the
     worktree (e.g. `git worktree remove` + delete the branch), or use your
     harness's worktree cleanup

═══════════════════════════════════════════════════
```

---

## Execution Modes

### Full Execution (Default)

Execute all batches to completion. Best for dedicated implementation sessions.

### Single Batch Mode

Execute one batch at a time, pause for review. Best for large implementations or when you want to review progress between phases.

### Dry Run Mode

Show execution plan without executing. Best for understanding scope or verifying task dependencies.

---

## Error Handling

### Agent Timeout

If an agent doesn't complete within expected time:

1. Check agent status with `TaskOutput(task_id, block: false)`
2. Offer to wait longer or cancel

### Task Failure

If an agent reports failure:

1. Display the error details
2. Offer options: continue that worker (the default — rung 1 of the resume ladder), skip, or stop
3. If continuing is impossible, seed a fresh worker from `04-implementation.md`, the task record, and the diff so far, and say that you did
4. If skipping, mark dependent tasks as blocked

### Dependency Issues

If circular dependencies detected:

1. Display the cycle
2. Ask user which task to execute first
3. Or suggest running the `/flow:decompose` stage to fix dependencies

---

## Session Continuity

1. **First run**: Phase 1 scaffolds `04-implementation.md` with Session 1
2. **Each batch**: Phase 3 Step E appends results incrementally
3. **Subsequent runs**: Phase 1 detects existing file, increments session number
4. **Context preservation**: Completed tasks, files modified, known issues passed to agents via cross-session context
5. **No duplication**: Completed tasks skipped automatically via TaskList status
6. **Worker continuity**: Phase 0.5 stamps the run's provenance and Step E records each task's worker, so a later session can try to continue the exact worker that did the work (the resume ladder) instead of re-deriving it

---

## Integration with Other Stages & Commands

EXECUTE is one stage of the `/flow` spine (`… DECOMPOSE → **EXECUTE** → VERIFY → ⟦REVIEW⟧ → DONE …`). Its neighbors:

| Stage / Capability | Relationship                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `/flow:decompose`  | **The prior stage** — creates the `03-tasks.json` tasks to execute          |
| Isolate a worktree | Phase 0 reads `workspace.isolation`; it only asks when config cannot decide |
| `/flow:verify`     | **The next stage** — proves completion, opens the PR, hands to REVIEW       |
| Post-impl feedback | To incorporate feedback, revise the spec then re-decompose and re-execute   |
| Commit             | Commit the changes after execution                                          |
| Docs reconcile     | If the change affects documentation, reconcile the docs                     |
| `/flow:done`       | Closes the work after REVIEW approval; offers Phase 0 worktree cleanup      |
| Worktree cleanup   | After merge, remove the Phase 0 worktree (e.g. `git worktree remove`)       |

---

## Troubleshooting

### "No tasks found"

Run the `/flow:decompose` stage first to create tasks from the specification.

### "All tasks already completed"

The implementation is done. Check `04-implementation.md` for summary.

### Agents taking too long

Large tasks may take several minutes. Use `TaskOutput(block: false)` to check progress.

### Context limits in agents

Each agent has isolated context. If a single task is too large, consider splitting it in the decompose phase.
