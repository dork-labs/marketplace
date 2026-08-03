---
name: flow-groom
display-name: /flow groom health check
description: Scheduled read-only backlog health check — run the groom oracles and report, never write.
cron: '0 9 1 * *'
timezone: America/Los_Angeles
enabled: false
max-runtime: 30m
permissions: default
---

> **Flow root.** This skill lives at `<flow-root>/skills/flow-groom/SKILL.md`. If you reached it via a symlink (`.claude/skills/flow__*` or `.agents/skills/flow__*`), resolve the real path first (`realpath <path>`): the flow root is two directories above the skill directory. Every `<flow-root>/...` reference below is relative to that root.

This is the schedulable **groom health check**: a monthly, read-only
`/flow:groom check` fired by an external scheduler (the DorkOS server's
task-scheduler, OS-cron, or CI). It is `enabled: false` by default, the same
explicit opt-in as `flow-drain` (ADR-0295, bring-your-own-scheduler).

Each firing runs the CHECK mode of the grooming-backlog skill
(`<flow-root>/skills/grooming-backlog/SKILL.md`) and stops:

1. Via the adapter, take a full backlog snapshot.
2. Run the groom oracle
   (`node --experimental-strip-types "<flow-root>/scripts/audit-backlog.ts"`)
   and the dispatch oracle over it.
3. Report to the operator: the invariant verdict (which GRM checks fail, on
   which items), the eligible-pool size, and the starvation stats — plus, when
   anything is red, the one-line recommendation to run a full `/flow:groom`.

**This tick never writes.** The full corrective groom closes work items and
restructures projects, which sits behind a human gate by design; a scheduler
must not walk through it. All tracker reads go through **the adapter**; this
tick never names a tracker directly.

**Operator override.** `/flow:pause` sets this task's `enabled: false` along
with the other autonomous surfaces; `/flow:resume` restores it.
