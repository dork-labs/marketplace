---
description: Groom the whole backlog — audit, correct, and verify it against the dispatch contract (check = read-only report)
category: flow
allowed-tools: Read, Glob, Grep, Edit(.dork/flow/tmp/**), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts"), Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/audit-backlog.ts":*), Skill, Agent, AskUserQuestion, TaskCreate, TaskUpdate
argument-hint: '[check]'
---

# /flow:groom — the backlog groom

Groom the backlog: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/grooming-backlog/SKILL.md` and follow its
process exactly. Its tracker adapter is the `SKILL.md` at `adapter.path`.

Run `flow <verb>` exactly as `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb>`, alone in its Bash call.

Its `<scratch>` (the scratchpad) is `.dork/flow/tmp/groom/`.

`check`: the read-only audit, zero writes. No argument: the full groom, which asks
approval for its closures and project changes before writing. GROOM neither triages
one new item (`/flow:triage`) nor dispatches work.
