---
description: '/flow SPECIFY stage — turn an ideation artifact into a validated specification'
category: workflow
allowed-tools: Read, Grep, Glob, Task, TaskOutput, Edit(specs/**), Edit(decisions/**), AskUserQuestion, Bash(git rev-parse --show-toplevel), Edit(.dork/flow/tmp/**), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts")
argument-hint: '<path-to-01-ideation.md>'
---

# /flow:specify

SPECIFY the work from the ideation artifact at: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/specifying-work/SKILL.md` and follow its process
exactly. Produce the spec and draft-ADR shapes under `${CLAUDE_PLUGIN_ROOT}/templates/docs/`.
Next stage: `/flow:decompose`.

Run `flow <verb>` exactly as `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb>`.

Tracked work: the adapter is the `SKILL.md` at `adapter.path`. With no tracked item or no adapter, leave the tracker alone.
