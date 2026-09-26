---
name: flow-triage
display-name: /flow daily triage
description: Scheduled daily triage — ready or park every untriaged item, and release claims nobody has touched for a week.
schedule:
  cron: '0 8 * * *'
  timezone: America/Los_Angeles
  enabled: false
  max-runtime: 30m
  permissions: acceptEdits
---

> **Flow root.** This skill lives at `<flow-root>/skills/flow-triage/SKILL.md`. If you reached it via a symlink (`.claude/skills/flow__*` or `.agents/skills/flow__*`), resolve the real path first (`realpath <path>`): the flow root is two directories above the skill directory. Every `<flow-root>/...` reference below is relative to that root.

This is the schedulable **daily triage**. Without it, nothing moves new work to
ready on its own. The `schedule:` block in the frontmatter above is what makes
this file a scheduled task.

It ships `schedule.enabled: false`, the same explicit opt-in as `flow-drain`. To
switch it on with DorkOS, approve it on the Schedules page. On any other harness,
point your own scheduler (OS cron, CI) at it.

Each firing:

0. **Pause check, before anything else.** Run
   `node --experimental-strip-types "<flow-root>/scripts/config-files.ts"`. If the check cannot run or its output cannot be read, stop: never act without knowing
   whether flow is paused. When its
   `paused` is not `null`, report "flow is paused (since `<pausedAt>`); `/flow:resume`
   lifts it" and stop. When it says `"ok": false`, report its first error and stop.
   Otherwise the adapter is the `SKILL.md` at its `adapter.path` (inside it,
   `<flow-root>` means the output's `flowRoot`).
1. Via the adapter, take a backlog snapshot.
2. **Triage what is untriaged:** open items with no `agent/*` label and no human
   assignee. Run each through Path B of `<flow-root>/skills/triaging-work/SKILL.md`.
   - Mark it ready only if it passes the six readiness rules
     (`<flow-root>/skills/grooming-backlog/SKILL.md`, phase 4 step 5).
   - Otherwise, park it with one question (`needsInput`).
3. **Release stale claims:** items with `agent/claimed` that have been
   untouched for 7 or more days (no tracker update and no comment). Via the
   adapter, remove `agent/claimed`, move the item to an `unstarted`-category
   state, and comment why. The next run triages it again.
   - Skip an item with an open pull request or a live run in
     `.dork/flow/flow-state.json`. List it in the report.
4. Report: what was readied, parked, released and skipped.

**Floor gates never run unattended.** No rejecting or cancelling, no new
projects, no replies to outside reporters. List those items for the operator.
All tracker reads and writes go through **the adapter**; this tick never names a
tracker directly.

**Operator override.** `/flow:pause` halts this tick along with the other
autonomous surfaces, through the project's pause flag that step 0 reads;
`/flow:resume` lifts it. Neither edits this file: it is the package's, and an
update replaces it.
