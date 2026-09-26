---
description: Capture a thought as a low-commitment work item (the /flow CAPTURE stage)
category: flow
allowed-tools: Read, Glob, Skill, Bash(node:*)
argument-hint: "<idea or work description, or a file path>"
---

# /flow:capture — CAPTURE stage

Capture this into the tracker: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/capturing-work/SKILL.md` and follow its process exactly.

Its one tracker write is `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" create`,
which reaches the tracker adapter's code itself. Never touch the tracker another way.

If no argument is provided, ask the operator for the thought to capture, then
follow the skill. CAPTURE only captures — it does not triage, evaluate, or plan.
For that, use `/flow:triage`.
