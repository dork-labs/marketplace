---
description: Run the DECOMPOSE stage — break a validated spec into tasks and mirror them into the tracker
category: flow
allowed-tools: Read, Task, TaskOutput, Edit(specs/**), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*), TaskCreate, TaskList, TaskGet, TaskUpdate
argument-hint: '<path-to-spec-file>'
---

# /flow:decompose — DECOMPOSE stage

Decompose the specification at: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/decomposing-work/SKILL.md` and follow its process exactly.

Run `flow <verb>` exactly as `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb>`.

