---
description: Restore autonomous /flow operation that /flow:pause halted
category: flow
allowed-tools: Read, Edit, Write, Glob, SlashCommand, Bash(node:*)
argument-hint: "[issue-id to un-pause, or empty to restore all autonomy]"
---

# /flow:resume — restore autonomy

Undo a `/flow:pause`: $ARGUMENTS

Resume is the inverse of pause: it restores the autonomous surfaces pause halted:

1. **The pause flag.** Run

   ```bash
   node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts" resume
   ```

   It removes this machine's `.agents/flow/paused.json` (from this checkout and the main
   checkout) and prints `{ ok, wasPaused, removed }`. The next scheduled tick then does
   its work again. If the operator also switched the tick off where it is scheduled (the
   **Schedules** page on DorkOS, or a cron or CI job), remind them to switch it back on
   there; flow does not touch that switch. (Pulse is the one mode that needs a running
   DorkOS server; the terminal drain does not.)

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
