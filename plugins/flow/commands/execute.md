---
description: Run the EXECUTE stage — implement a validated spec by orchestrating concurrent agents
category: flow
allowed-tools: Task, TaskOutput, Read, Edit(./**), Grep, Glob, Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts"), Bash(git rev-parse --git-dir --git-common-dir), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/spec-worktree.sh:*), EnterWorktree, TaskCreate, TaskList, TaskGet, TaskUpdate, AskUserQuestion
argument-hint: '<path-to-spec-file>'
---

# /flow:execute — EXECUTE stage

Implement the specification at: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/executing-specs/SKILL.md` and follow its process exactly.

Run `flow <verb>` exactly as `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb>`.

Worktree script, exactly: `${CLAUDE_PLUGIN_ROOT}/scripts/spec-worktree.sh <SLUG>`.
Read its supporting files in `${CLAUDE_PLUGIN_ROOT}/skills/executing-specs/` only when told.
