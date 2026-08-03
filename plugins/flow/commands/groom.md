---
description: Groom the whole backlog — audit, correct, and verify it against the dispatch contract (check = read-only report)
category: flow
allowed-tools: Read, Glob, Bash, Skill, Agent, AskUserQuestion, TaskCreate, TaskUpdate
argument-hint: '[check]'
---

# /flow:groom — the backlog groom

Groom the backlog: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/grooming-backlog/SKILL.md` and follow its
process exactly.

That skill is PM-agnostic: it routes every tracker read or write through the
adapter skill (`${CLAUDE_PLUGIN_ROOT}/skills/linear-adapter/SKILL.md`), which it
reads on demand. Do not touch a tracker directly from this command — the skill
owns the sweep, the invariants, and the human gate.

If the argument is `check`, run the read-only audit (snapshot → oracles →
report, zero writes). With no argument, run the full groom: it will present the
closure list and project restructuring for approval before writing anything.
GROOM sweeps the whole backlog — it does not triage a single new item (that is
`/flow:triage`) and it does not dispatch work (that is the loop).
