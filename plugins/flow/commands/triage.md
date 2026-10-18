---
description: Classify and route incoming work, simple-vs-complex (the /flow TRIAGE stage)
category: flow
allowed-tools: Read, Glob, Skill, AskUserQuestion, Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*)
argument-hint: '<freeform brief/idea/bug, a file path, or an existing item identifier>'
---

# /flow:triage — TRIAGE stage

Triage this work: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/triaging-work/SKILL.md` and follow its process exactly.

Run `flow <verb>` exactly as `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb>`.

Its tracker adapter is the `SKILL.md` at `adapter.path`.

No argument: ask the operator for the work (freeform, or an item identifier) first.
TRIAGE classifies and routes only; it never runs the loop, dispatches or audits.
