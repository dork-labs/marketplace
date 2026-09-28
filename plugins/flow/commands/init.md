---
description: First-run setup for /flow - pick your tracker, generate its adapter, and scaffold config
category: flow
allowed-tools: Read, Glob, AskUserQuestion, Write, Edit, Skill, Bash(node:*), Bash(npm install:*), Bash(cp:*), Bash(test:*), Bash(grep:*), Bash(cat:*), Bash(echo:*), Bash(mkdir:*), Bash(pwd), Bash(git rev-parse:*)
argument-hint: '[--reconfigure]'
---

# /flow:init - first-run setup

Set up `/flow` in this repo: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/initializing-flow/SKILL.md` and follow its process
exactly. `--reconfigure` goes straight to reconfiguring an existing install.

- Install `zod` into the plugin (`npm install --omit=dev`) only after checking it is missing, and at a terminal only after asking.
- Never overwrite committed config without the operator's confirmation.
- Only the generated adapter names the tracker.
