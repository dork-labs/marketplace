---
description: '/flow SPECIFY stage — turn an ideation artifact into a validated specification'
category: workflow
allowed-tools: Read, Grep, Glob, Task, TaskOutput, Write, Edit, AskUserQuestion, Bash(git:*), Bash(node:*), Bash(npx:*), Bash(python3:*), Bash(mkdir:*)
argument-hint: '<path-to-01-ideation.md>'
---

# /flow:specify

SPECIFY the work from the ideation artifact at: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/specifying-work/SKILL.md` and follow its process
exactly. Produce the spec and draft-ADR shapes under `${CLAUDE_PLUGIN_ROOT}/templates/docs/`.
Next stage: `/flow:decompose`.

Tracked work: the adapter is the `SKILL.md` at `adapter.path`. With no tracked item or no adapter, leave the tracker alone.
