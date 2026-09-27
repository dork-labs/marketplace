---
description: Run the DECOMPOSE stage — break a validated spec into tasks and mirror them into the tracker
category: flow
allowed-tools: Read, Task, TaskOutput, Write, Bash(mkdir:*), Bash(cat:*), Bash(grep:*), Bash(echo:*), Bash(basename:*), Bash(date:*), TaskCreate, TaskList, TaskGet, TaskUpdate
argument-hint: '<path-to-spec-file>'
---

# /flow:decompose — DECOMPOSE stage

Decompose the specification at: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/decomposing-work/SKILL.md` and follow its process exactly.
