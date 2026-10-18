---
description: '/flow IDEATE stage — shape a brief into a structured ideation artifact'
category: workflow
allowed-tools: Read, Grep, Glob, Task, TaskOutput, Edit(specs/**), AskUserQuestion, Bash(git rev-parse --show-toplevel), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*)
argument-hint: '<task-brief-or-path-to-notes>'
---

# /flow:ideate

IDEATE the work described by: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/ideating-features/SKILL.md` and follow its process exactly.

Run `flow <verb>` exactly as `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb>`.

Produce the shape of `${CLAUDE_PLUGIN_ROOT}/templates/docs/ideation.md`. Next stage: `/flow:specify`.

Tracked work: the adapter is the `SKILL.md` at `adapter.path`. Untracked, or no adapter: skip tracker projection silently.
