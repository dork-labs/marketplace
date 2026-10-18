---
description: Run the DONE stage — report completion, close the work item, and check project follow-ups
category: flow
allowed-tools: Read, Grep, Glob, Bash(git rev-parse --git-dir --git-common-dir), Bash(git status --porcelain), Edit(.dork/flow/tmp/**), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts"), ExitWorktree, AskUserQuestion
argument-hint: '[issue-id]'
---

# /flow:done — DONE stage

Close the loop for: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/closing-work/SKILL.md` and follow its process exactly.

Run `flow <verb>` exactly as `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb>`, alone in its Bash call.

DONE runs only after the review gate (REVIEW) approved.
