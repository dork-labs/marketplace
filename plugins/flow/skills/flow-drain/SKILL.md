---
name: flow-drain
display-name: /flow drain ready queue
description: Claim the top-ranked eligible issue and carry it to its review gate.
schedule:
  cron: "0 * * * *"
  timezone: America/Los_Angeles
  enabled: false
  max-runtime: 2h
  permissions: acceptEdits
---

> **Flow root.** This skill lives at `<flow-root>/skills/flow-drain/SKILL.md`. If you reached it via a symlink (`.claude/skills/flow__*` or `.agents/skills/flow__*`), resolve the real path first (`realpath <path>`): the flow root is two directories above the skill directory. Every `<flow-root>/...` reference below is relative to that root.

This is the schedulable **Pulse tick**: one tick of the `/flow` autonomous loop,
fired by a scheduler. The `schedule:` block in the frontmatter above is what
makes this file a scheduled task.

Installed at project scope, a DorkOS release that has schedule discovery picks
this tick up and asks you to approve it on the Schedules page; nothing fires
until you do. On any other harness, wire your own scheduler to it (OS-cron, CI).
It ships `schedule.enabled: false` either way — installing a package never arms
its own cron.

Each firing runs exactly **one `/flow continue` tick** and then stops; the
scheduler provides the repetition. This is NOT `/flow auto` (which loops a single
session via the Stop-hook sentinel). The canonical tick procedure lives in the
`/flow` orchestrator (`<flow-root>/commands/flow.md`); this task is only the scheduled
trigger over it. In reconciler-registry order, one tick:

0. **Pause check, before anything else.** Run
   `node --experimental-strip-types "<flow-root>/scripts/config-files.ts"`. When its
   `paused` is not `null`, flow is paused on this machine: report "flow is paused
   (since `<pausedAt>`); `/flow:resume` lifts it" and stop, touching nothing else. When
   it says `"ok": false`, report its first error and stop. Otherwise the tracker adapter
   for the steps below is the `SKILL.md` at its `adapter.path` (inside it, `<flow-root>`
   means the output's `flowRoot`).
1. **Recovery.** Re-adopt any orphaned claimed work: read
   `.dork/flow/flow-state.json`, GC closed-issue records, probe the worker, and
   resume / restart-clean / escalate per the recovery script
   (`node --experimental-strip-types "<flow-root>/scripts/recovery.ts"`).
2. **Inbox / resume.** Un-park items whose `agent/needs-input` question was
   answered, and resume the parked run.
3. **Dispatch.** Rank the adapter's eligible work
   (`node --experimental-strip-types "<flow-root>/scripts/dispatch.ts"`, JSON in, JSON out), claim the
   top-ranked item (durable label plus state), provision its worktree, persist a
   `FlowRun` to `.dork/flow/flow-state.json`, and carry it to its human-review
   gate.

Stop at the review gate or on a genuine question. All tracker reads and writes go
through **the adapter**; this tick never names a tracker directly.

**Operator override.** At each stage boundary, via the adapter, check for the
`agent/paused` marker: if present, advance no further, release the claim
(`agent/claimed`) cleanly, and stop. `/flow:pause` halts every tick through the
project's pause flag that step 0 reads; `/flow:resume` lifts it. Neither edits
this file: it is the package's, and an update replaces it. To stop the scheduler
starting the tick at all, switch it off where it is scheduled (on DorkOS, the
Schedules page).
