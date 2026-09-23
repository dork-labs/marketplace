---
description: Restore autonomous /flow operation that /flow:pause halted
category: flow
allowed-tools: Read, Edit, Write, Glob, SlashCommand, Bash(node:*), mcp__dorkos__tasks_update
argument-hint: "[issue-id to un-pause, or empty to restore all autonomy]"
---

# /flow:resume — restore autonomy

Undo a `/flow:pause`: $ARGUMENTS

Resume is the inverse of pause: it restores the autonomous surfaces pause halted:

1. **The pause flag.** Run

   ```bash
   node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts" resume
   ```

   It removes the project's `.agents/flow/paused.json` (always in the main checkout)
   and prints `{ ok, wasPaused, removed, hostSchedules }`. The next scheduled tick then
   does its work again. (Pulse is the one mode that needs a running DorkOS server; the
   terminal drain does not.)

   **The DorkOS schedules `/flow:pause` switched off.** `hostSchedules` lists exactly
   those, by id. DorkOS tools may be deferred behind tool search: if `tasks_update` is
   not loaded, load it with ToolSearch first, and treat it as absent only when that
   finds nothing. When the `tasks_update` tool is available (`mcp__dorkos__tasks_update`
   on DorkOS), call it with `{ "id": <id>, "enabled": true }` for each id in the list,
   and for nothing else: a schedule that was off before the pause stays off. If a call
   fails (the schedule was removed, or needs approval again after an update), say which
   one and tell the operator to check it on the **Schedules** page. When the tool is not
   available and the list is not empty, tell the operator to switch those schedules on
   there. If the operator switched a tick off themselves (the Schedules page, or a cron
   or CI job), remind them to switch it back on where they did.

2. **The terminal drain.** If a paused `.dork/flow/auto-run.json` sentinel is still
   present (`active: false`), restart the drain with `/flow auto`, which rewrites the
   sentinel to `active: true` and continues from the ready queue. If no sentinel
   exists, there is no terminal drain to resume; start one with `/flow auto` when you
   want it.

   A paused sentinel is never reaped — `/flow:pause` writes `active: false`
   precisely so this command can read it back, and the Stop hook leaves that state
   alone. A MISSING sentinel, though, can mean the hook reaped an orphan whose owner
   had died, so it is not evidence the queue drained: check the ready
   queue rather than assuming.

## Un-pausing a specific item

To release a single item that `/flow:pause` parked with `agent/paused`, name its
identifier: via the adapter, remove the `agent/paused` marker so the next
tick may advance it again. If the item was reassigned to a human or another agent
via the ownership policy, hand it back the same way (reassign on the tracker via the
adapter).

## Re-enabling a single reconciler loop

If you silenced one loop via `loops.<id>.enabled: false` (see `/flow:pause`), flip
it back to `true` in the project's `.agents/flow/config.json`. See the dials guide
(`${CLAUDE_PLUGIN_ROOT}/docs/the-dials.mdx`).
