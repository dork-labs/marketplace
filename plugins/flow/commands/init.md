---
description: First-run setup for /flow - pick your tracker, generate its adapter, and scaffold config
category: flow
allowed-tools: Read, Glob, AskUserQuestion, Edit(./**), Skill, Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts"), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts":*), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts"), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/validate-adapter.ts":*), Bash(npm install --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"), Bash(git rev-parse --show-toplevel)
argument-hint: '[--reconfigure]'
---

# /flow:init - first-run setup

Set up `/flow` in this repo: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/initializing-flow/SKILL.md` and follow its process
exactly. `--reconfigure` goes straight to reconfiguring an existing install.

Run `flow <verb>` exactly as `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb>`, and `cf` as `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts"`.

- Install `zod` into the plugin (`npm install --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"`) only after checking it is missing, and at a terminal only after asking.
- Never overwrite committed config without the operator's confirmation.
- Only the generated adapter names the tracker.
