---
description: Groom the whole backlog — audit, correct, and verify it against the dispatch contract (check = read-only report)
category: flow
allowed-tools: Read, Glob, Bash, Skill, Agent, AskUserQuestion, TaskCreate, TaskUpdate
argument-hint: '[check]'
---

# /flow:groom — the backlog groom

Groom the backlog: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/grooming-backlog/SKILL.md` and follow its
process exactly. Its tracker adapter is the `SKILL.md` at `adapter.path`.

`check`: the read-only audit, zero writes. No argument: the full groom, which asks
approval for its closures and project changes before writing. GROOM neither triages
one new item (`/flow:triage`) nor dispatches work.
