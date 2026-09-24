---
description: Show every in-flight item, parked question, and assumption trail across the /flow loop
category: flow
allowed-tools: Read, Glob, Skill, AskUserQuestion, Bash(node:*), mcp__dorkos__tasks_list
argument-hint: "[issue-id to focus on, or empty for the whole loop]"
---

# /flow:status — observe the loop

Render one status pane for the `/flow` loop: $ARGUMENTS

This is an OBSERVE command: it reads, never advances. It joins five sources into
a single pane:

1. **`.dork/flow/flow-state.json`**: the durable per-issue run records (the typed
   the flow engine's `readFlowState` shape). The session↔issue association, worktree,
   branch, stage, and status of every run.
2. **`.dork/flow/auto-run.json`**: the `/flow auto` drain sentinel, if a drain is
   live (`active`, `ready`, `shapeable`, `startedAt`, `pid`, and `sessionId`, the
   session the drain belongs to). **A sentinel is not
   a live drain until its owner is checked.** Before reporting one, verify the
   recorded `pid` is still running (`kill -0 <pid>`); treat a dead owner, or an
   `active` sentinel whose `startedAt` is more than 24 hours old (the pid may
   have been recycled onto an unrelated process), as an ORPHAN, not a drain.
3. **The tracker, via the adapter**: titles, labels, parked questions, and
   assumption comments. Read the adapter, the `SKILL.md` at the `adapter.path` that
   `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts"`
   prints, and use its verbs; never touch a tracker string directly from this command.
4. **The pause**: the `paused` that the same command prints. When it is not `null`,
   head the pane with "Paused since `<pausedAt>`: scheduled ticks, `/flow continue` and
   `/flow auto` stop at their first step; `/flow:resume` lifts it".
5. **The schedules, only when the `tasks_list` tool is available** (DorkOS names it
   `mcp__dorkos__tasks_list`). DorkOS tools may be deferred behind tool search: if
   `tasks_list` is not loaded, load it with ToolSearch first, and treat it as absent
   only when that finds nothing. Call `tasks_list`. Keep every schedule whose `name` is
   `flow-drain` or `flow-groom` and whose `filePath` is inside this project (the main
   checkout or this checkout); a schedule elsewhere belongs to another project. This
   command only reads: it never calls `tasks_update` and never changes a schedule.

Render, in this order:

- **In flight.** Every claimed / in-flight item: each FlowRun in `flow-state.json`
  plus every `agent/claimed` item on the tracker. For each, show `PROJ-123 - Title`
  (resolve the title via the adapter, per its display convention), then its
  worktree path, branch, `sessionId`, and current `stage` / `status` from the
  FlowRun. If a drain is live, head the pane with the `auto-run.json` sentinel
  (`active`, `ready` ready vs `shapeable` behind the readiness gate). If the
  sentinel is an orphan, say so instead — "stale drain sentinel (pid N gone)" —
  and note that the next Stop in that repo reaps it automatically.
- **Schedules.** How often flow's scheduled runs fire. For each schedule kept in
  source 5, show its name; when it runs, in plain words and as written (the `cron`
  and its `timezone`, e.g. "every hour at :00 (`0 * * * *`, America/Los_Angeles)");
  whether it is on (`enabled`); and its `status` (`pending_approval` means it is
  waiting for the operator's approval). When `tasks_list` was available but none of
  this project's flow schedules are listed, say so. When it was not available, say:
  "flow's scheduled runs fire when your own scheduler starts them; its entry decides
  how often". To change how often they fire, point to the dials page's Cadence
  section (`docs/the-dials.mdx`), never to the shipped `flow-drain` or `flow-groom`
  file.
- **Parked.** Every `agent/needs-input` item: via the adapter, list the
  parked items, and for each show the open question text and how long it has waited
  (now minus the parking comment's timestamp).
- **Why.** The per-item assumption trail: via the adapter, read each item's
  `agent/assumption` comments (or the assumption-log artifact), so the review gate
  stays auditable.

With an issue identifier as `$ARGUMENTS`, scope the pane to that one item (its
FlowRun, its parked question, its assumption trail). With no argument, show the
whole loop. When nothing is in flight and no drain is live, say so plainly rather
than rendering an empty pane.
