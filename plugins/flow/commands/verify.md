---
description: Run the VERIFY stage — verify recent work, gather proof, and hand off to the human-review gate
category: flow
allowed-tools: Read, Grep, Glob, Edit, Bash(git rev-parse:*), Bash(git diff:*), Bash(git log:*), Task, AskUserQuestion
argument-hint: '[path-to-spec-file]'
---

# /flow:verify — VERIFY stage

Verify the work for: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/verifying-work/SKILL.md` and follow its process exactly.

VERIFY ends parked at the human-review gate (REVIEW); it never declares the work done.
