---
description: Run the DONE stage — report completion, close the work item, and check project follow-ups
category: flow
allowed-tools: Read, Grep, Glob, Bash(git rev-parse:*), Bash(git status:*), ExitWorktree, AskUserQuestion
argument-hint: "[issue-id]"
---

# /flow:done — DONE stage

Close the loop for: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/closing-work/SKILL.md` and follow its process exactly.

DONE runs only after the human-review gate (REVIEW) has approved. The close and
each follow-up go through `flow done` and `flow create`; the project pulse check
reads through the tracker adapter skill. This command never touches a tracker
string directly.
