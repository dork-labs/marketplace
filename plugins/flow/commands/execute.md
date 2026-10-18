---
description: Run the EXECUTE stage — implement a validated spec by orchestrating concurrent agents
category: flow
allowed-tools: Task, TaskOutput, Read, Write, Edit, Grep, Glob, Bash(jq:*), Bash(grep:*), Bash(cat:*), Bash(echo:*), Bash(date:*), Bash(mkdir:*), Bash(hostname:*), Bash(git rev-parse --git-dir --git-common-dir), Bash(git branch --show-current), Bash(git status --porcelain), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/spec-worktree.sh:*), EnterWorktree, TaskCreate, TaskList, TaskGet, TaskUpdate, AskUserQuestion
argument-hint: '<path-to-spec-file>'
---

# /flow:execute — EXECUTE stage

Implement the specification at: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/executing-specs/SKILL.md` and follow its process exactly.
Read its supporting files in `${CLAUDE_PLUGIN_ROOT}/skills/executing-specs/` only when told.
