---
description: Run the VERIFY stage — verify recent work, gather proof, and hand off to the review gate
category: flow
allowed-tools: Read, Grep, Glob, Edit, Bash(git rev-parse HEAD), Bash(git merge-base HEAD origin/HEAD), Bash(git status --porcelain), Bash(git diff), Bash(git diff origin/HEAD...HEAD), Bash(git diff --stat origin/HEAD...HEAD), Bash(git log --oneline origin/HEAD..HEAD), Task, AskUserQuestion
argument-hint: '[path-to-spec-file]'
---

# /flow:verify — VERIFY stage

Verify the work for: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/verifying-work/SKILL.md` and follow its process exactly.

VERIFY ends at the review gate (REVIEW); it never declares the work done.
