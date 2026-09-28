---
name: flow-groom
display-name: /flow groom health check
description: Scheduled read-only backlog health check — run the groom oracles and report, never write.
schedule:
  cron: '0 9 * * 1'
  timezone: America/Los_Angeles
  enabled: false
  max-runtime: 30m
  permissions: default
---

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

The schedulable **groom health check**: a weekly, read-only
`/flow:groom check`. The full groom closes items, so it stays operator-run. Off
until you approve it on the Schedules page (DorkOS) or wire your own scheduler.

Each firing runs the CHECK mode of `<flow-root>/skills/grooming-backlog/SKILL.md`:

0. **Pause check.** Run step 0 of
   `<flow-root>/skills/flow-drain/SKILL.md`. Stop whenever it says to stop.
1. Pull once: `flow snapshot --include-closed --out <scratch>/backlog.json`.
   Run `flow audit --snapshot <scratch>/backlog.json --json` and `flow next --snapshot <scratch>/backlog.json --json`.
2. Report the failing invariants and their items, the eligible-pool size and the
   starvation stats; when anything is red, recommend a full `/flow:groom`.

**This tick never writes.** Closing and restructuring sit behind a human gate.
