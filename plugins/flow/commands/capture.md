---
description: Capture a thought as a low-commitment work item (the /flow CAPTURE stage)
category: flow
allowed-tools: Read, Glob, Skill, Edit(.dork/flow/tmp/**), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts")
argument-hint: '<idea or work description, or a file path>'
---

# /flow:capture — CAPTURE stage

Capture this into the tracker: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/capturing-work/SKILL.md` and follow its process exactly.
Its one tracker write is `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" create`, alone in its Bash call.

No argument: ask the operator for the thought first. CAPTURE only captures; to evaluate or plan, use `/flow:triage`.
