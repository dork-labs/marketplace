---
description: Capture a thought as a triaged work item (the /flow CAPTURE stage)
category: flow
allowed-tools: Read, Glob, Skill(flow:capturing-work), Edit(.dork/flow/tmp/**), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts")
argument-hint: '<idea or work description, or a file path>'
---

# /flow:capture — CAPTURE stage

Capture this into the tracker: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/capturing-work/SKILL.md` and follow its process exactly.
Its one tracker write is `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" create`, alone in its Bash call; when its JSON lists `nearMatches` that are the same work, it is `flow.ts comment` on that item instead.

No argument: ask the operator for the thought first. CAPTURE files a triaged item (type, MoSCoW priority, size, project, proof, done-when); to evaluate, route or ready it, use `/flow:triage`.
