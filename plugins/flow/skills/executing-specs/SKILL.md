---
name: executing-specs
description: Orchestrates parallel implementation of decomposed specifications with incremental progress tracking. Use when running the /flow:execute stage (the EXECUTE stage of the /flow engine).
disable-model-invocation: true
---

# Executing Specifications

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

The EXECUTE stage: implement a spec with background workers across dependency-ordered
batches, persisting progress so a compaction or a new session loses nothing. Tracker
breadcrumbs go through the adapter at `adapter.path`. Read the prompt files beside this
skill only when their phase starts.

## Delegation Policy

The one home for these two rules; other skills point here.

### Which model a worker runs on

`frontier` is the seat you orchestrate from: never a delegate tier. `workhorse` is the
strong general model, `fast` the cheap one.

**Every delegated worker names its model explicitly.** An omitted model can silently
inherit frontier. Resolve: work class → `models.tiers.<class>` → `models.bindings.<tier>`.

| Work class       | Covers                                              |
| ---------------- | --------------------------------------------------- |
| `implementation` | Workers that write the change.                      |
| `review`         | Spec-compliance and code-quality reviewers.         |
| `analysis`       | Planning, execution-plan and investigation workers. |
| `mechanical`     | Searches, scaffolds, renames, log triage.           |

The policy never blocks work:

- One model on the harness: bind both tiers to it.
- A tier with no binding: use the harness default **and note it in the run**.
- A bound model errors: fall back sideways or down (`workhorse` → `fast`), **never up**.
- An explicit human instruction overrides the policy; log it as an assumption.

### The resume ladder

When work continues (a failed task, a fix, a later session), continue the worker that
already reasoned before starting one that must re-derive it:

1. **Continue the originating worker**, when you are on the same machine
   (`provenance.host` in `.dork/flow/flow-state.json`) and the harness retained and can
   continue it.
2. **A fresh worker seeded from the artifacts**: the worktree (ground truth; the diff
   outranks any account of it), `flow-state.json`, `04-implementation.md`, the task
   record. Say you started fresh and why.
3. **Escalate to the human.**

`context.resume`: `"prefer"` (default) tries 1 then 2 and says which; `"require"` is 1
or a loud stop, never a silent 2; `"never"` starts at 2. With `context.perIssue` at
`"sticky-session"`, follow-ups return to the originating session by policy.

## Phase 0: Workspace

1. `git rev-parse --git-dir --git-common-dir`: the two differ → already in a worktree;
   execute here, skip to 5.
2. Read `workspace.isolation` from the project's flow settings; it has answered, do not
   re-ask. `"worktree"` (default): isolate without asking, and say so in one line (one
   checkout, one writer). `"none"`: execute in place; if another agent or session works
   in this checkout, warn and proceed. Prefer the harness's worktree tooling; else
   `git worktree add ../spec-<SLUG> -b spec-<SLUG>`.
3. Only two things override the config: an explicit human instruction for this run
   (logged as an assumption), or a config that cannot decide.
4. Config cannot decide: recommend a worktree if the tree has unrelated changes, the
   branch is another topic, another writer is here, or a dev server must keep running;
   then ask. None apply: execute in place.
5. Record a created worktree's path and branch in `04-implementation.md`.
6. **Claim** an item this session has not claimed (`--manual` when a person drives):
   `node --experimental-strip-types "<flow-root>/scripts/flow.ts" claim <id> --session <this session's id> --worktree <path> --branch <branch> --json`.
   It records the run and its provenance (`<flow-root>/docs/provenance.md`). Exit 5
   names the blocker; exit 7 means paused. Add `instanceId` and `resumeUrl` when you
   have them; never fabricate a field.

## Phase 1: Setup

- Slug is the spec path's second segment; `TASKS_JSON = specs/<SLUG>/03-tasks.json`,
  `IMPL_FILE = specs/<SLUG>/04-implementation.md`.
- No `[<slug>]` tasks in `TaskList()`: say "run `/flow:decompose` first" and stop.
- Scaffold `IMPL_FILE` **now**, before any worker: new → fill
  `implementation-summary-template.md` (`[FEATURE_NAME]`, `[DATE]`, `[SLUG]`,
  `[TOTAL]`); existing → append `### Session <N+1> - <DATE>` with an empty **Workers**
  line, and read the last session's worker ids (rung 1 needs them).

## Phase 2: Analysis

Fill `[SPEC_PATH]` and `[SLUG]` in `analysis-agent-prompt.md` and run it as an
`analysis` worker in the background. Parse its plan: batches and cross-session context.

## Phase 3: Batches

Show the plan, then run every batch without asking, unless the arguments carry
`--pause`, `--step` or `--review` (then offer all / one batch / review first). Per batch:

1. **Launch** one `implementation` worker per task from `implementation-agent-prompt.md`
   (`[TASK_ID]`, `[CROSS_SESSION_CONTEXT]`), and record each worker id.
2. **Wait** for all of them.
3. **Failure:** the default is to continue that worker with the failure (rung 1), not
   relaunch. If it cannot continue, the resume ladder decides; never pick the fallback
   yourself. Skipping marks dependents blocked.
4. **Two-stage review, per task**, by `review` workers, never the one that wrote it:
   - Stage 1, spec compliance: everything asked, nothing extra, nothing misread; the
     reviewer reads code, not the report.
   - Stage 2, code quality (correctness, security, spec fit) on `BASE_SHA..HEAD_SHA`,
     **never before stage 1 passes**.
   - Issues: continue the implementer's worker to fix, then re-review.
5. **Append to `IMPL_FILE` after each batch**, not at the end: each task as
   `- Task #<ID>: <subject> — worker: <id or "unknown">` (never an invented id), files
   touched, known issues, the completed count, the session's Workers line.
6. `TaskUpdate` each success to `completed`, then after its commit
   `flow checkpoint <id> --trigger task --task <task id> --body-file <f>` (Done, Next,
   Open questions, Next command).

A circular dependency: show the cycle, ask which goes first, or suggest `/flow:decompose`.

## Phase 4: Finish

1. Set `**Status:** Complete` in `IMPL_FILE`; check the count matches.
2. With a `specs/manifest.json`, set this spec to `implemented`.
3. `flow stage <id> verify --checkpoint-file <f>` writes the checkpoint VERIFY resumes
   from, then moves the item.
4. Report the summary; if docs are affected, reconcile them. Feedback later means revise
   the spec, then decompose and execute again.
