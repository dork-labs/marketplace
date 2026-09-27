---
description: '/flow IDEATE stage — shape a brief into a structured ideation artifact'
category: workflow
allowed-tools: Read, Grep, Glob, Task, TaskOutput, Write, Edit, AskUserQuestion, Bash(git:*), Bash(node:*), Bash(npx:*), Bash(python3:*), Bash(mkdir:*)
argument-hint: '<task-brief-or-path-to-notes>'
---

# /flow:ideate

IDEATE the work described by: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/ideating-features/SKILL.md` and follow its process exactly.
Produce the shape of `${CLAUDE_PLUGIN_ROOT}/templates/docs/ideation.md`. Next stage: `/flow:specify`.

Tracked work: the adapter is the `SKILL.md` at `adapter.path`. Untracked, or no adapter: skip tracker projection silently.
