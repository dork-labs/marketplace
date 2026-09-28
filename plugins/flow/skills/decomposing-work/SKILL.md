---
name: decomposing-work
description: The /flow engine's DECOMPOSE stage — break a validated specification into actionable tasks in 03-tasks.json, mirror the active phase into the tracker as a plan checklist, and project the stage/decompose label. Use when running /flow:decompose or advancing a work item into the DECOMPOSE stage.
---

# Decomposing Work — the DECOMPOSE stage

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

DECOMPOSE turns a frozen spec into `specs/<slug>/03-tasks.json`, the canonical task list,
and mirrors it into the tracker as a projection. Tracker writes (`transition`, `comment`,
`createSubIssue`, `getRelations`) go through the adapter at `adapter.path`.

### 1. Resolve

The slug is the spec path's second segment. `SPEC_FILE` must exist and be a complete
spec (SPECIFY's output); otherwise stop and report.

### 2. Mode

- No `03-tasks.json`, or no tasks for the slug → **full**.
- It exists and the spec's changelog has entries after its `generatedAt` →
  **incremental**: keep done tasks, update affected pending ones, add only new work.
- No new entries → **skip**: "No changes since last decompose (<date>); delete
  `03-tasks.json` to force", and stop.

### 3. Write the task files (background worker)

A background worker (model named, per the Delegation Policy in
`<flow-root>/skills/executing-specs/SKILL.md`) writes `03-tasks.json` and a readable
`03-tasks.md`. It has no Task API access.

```jsonc
{
  "spec": "<SPEC_PATH>",
  "slug": "<SLUG>",
  "generatedAt": "<ISO 8601>",
  "mode": "full | incremental",
  "lastDecomposeDate": "<DATE | null>",
  "tasks": [
    {
      "id": "1.1",
      "phase": 1,
      "phaseName": "Foundation",
      "subject": "[<SLUG>] [P1] Imperative task title",
      "description": "FULL self-contained implementation detail",
      "activeForm": "Present-continuous spinner form",
      "size": "small | medium | large | xl",
      "priority": "high | medium | low",
      "dependencies": ["1.0"],
      "parallelWith": ["1.2"],
      "issue": null,
      "parentIssue": null, // set only on promotion (step 6)
    },
  ],
}
```

**Descriptions are self-contained:** full code, requirements, acceptance criteria and
test scenarios, copied unchanged later. Never "as specified", "from the spec", "see
specification", "as described above", or "implement according to spec".

### 4. Load the Task API (main context)

The Task API is a live display of `03-tasks.json`, not a second source of truth.

1. Read `03-tasks.json` (malformed: parse `03-tasks.md` headers
   `^### Task (\d+)\.(\d+): (.+)$`, or redo step 3).
2. Skip tasks already in `TaskList()` for `[<slug>]` (safe to re-run).
3. `TaskCreate({ subject, description, activeForm })` for each missing one, one retry.
4. `TaskUpdate({ taskId, addBlockedBy })` for dependencies that exist.
5. Spot-check 2-3 descriptions for the forbidden phrases; warn, do not block.

### 5. Mirror into the tracker

- `flow stage <id> decompose --checkpoint-file <f>`.
- Mirror the **active phase** as a plan checklist generated from `03-tasks.json`; never
  hand-edit it, regenerate it.
- Optionally a breadcrumb `comment`.
- **Ready the execute-ready work:** add `agent/ready` to the item (and any promoted
  sub-issue). Without it dispatch never picks it up; DECOMPOSE is the second readiness
  producer after TRIAGE.

No linked item or no tracker: skip the mirror; the files on disk are the result.

### 6. Sub-issue promotion (rare)

Promote a task only when `size ≥ decomposition.subIssueThreshold` (default `"xl"`):
`createSubIssue(parent, spec)`, then write the identifier into that task's `issue` and
`parentIssue`. That is the only home of the task→issue map; never a top-level `issues` list.

### 7. Report

Spec path, mode, both files, task counts by phase, the parallel and critical path, any
promoted sub-issues, and next: `/flow:execute specs/<SLUG>/02-specification.md`.

**Calibration.** An execution stage: the ambiguous middle proceeds on the best default
with an `agent/assumption` trail; the floor is checked (`answeredBy`) via `needsInput`. Plan
approval is off by default (`gates.planApproval: false`).
