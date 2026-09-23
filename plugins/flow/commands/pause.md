---
description: Halt every autonomous /flow mode from one place (drain sentinel + pause flag)
category: flow
allowed-tools: Read, Edit, Write, Glob, Bash(node:*)
argument-hint: "[issue-id to reclaim, or empty to halt all autonomy]"
---

# /flow:pause — halt autonomy

Stop the `/flow` loop from advancing on its own: $ARGUMENTS

Halting every mode is ONE action: pause stops BOTH autonomous surfaces together
so nothing keeps running behind your back:

1. **The drain sentinel.** If `.dork/flow/auto-run.json` exists (a live `/flow auto`
   terminal drain), set its `active` to `false`. The `flow-loop.mjs` Stop hook then
   allows the session to stop at the next gate instead of looping to the next item.
2. **The pause flag.** Run

   ```bash
   node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts" pause
   ```

   It writes this machine's pause, `.agents/flow/paused.json` (in the main checkout
   when you are in a git worktree, so every worktree sees it), keeps it out of git, and
   prints `{ ok, file, pausedAt, alreadyPaused, ignored }`. Every scheduled tick
   (`flow-drain`, `flow-groom`), `/flow continue` and `/flow auto` checks it before
   doing anything and stops. It lives in the project, so updating flow cannot undo it.
   If `ignored` is `false`, tell the operator git does not ignore the file, so it could
   be committed by mistake.

Report what changed (sentinel paused, flag written or already there, since when) and
what was in flight. To see the in-flight items before or after pausing, use
`/flow:status`.

Then tell the operator what a pause does not do: **a scheduler still starts the tick on
its schedule, and the tick stops at its first step.** To stop the tick from starting at
all, switch it off where it is scheduled: on DorkOS, turn `flow-drain` (and `flow-groom`,
if it is on) off on the **Schedules** page, a switch that outlasts updates; with cron or
CI, disable that job. A pause on this machine does not reach a scheduler on another one.
Never edit `enabled` in the shipped `flow-drain` or `flow-groom` file: DorkOS ignores the
file's switch once a schedule is approved, and an update replaces the file.

## Reclaiming or redirecting a specific item

To stop ONE running item rather than all autonomy, name its identifier. Via the
adapter, apply the **`agent/paused`** marker to that item. A running tick
honors `agent/paused` **at stage boundaries**: it finishes no further stage, stops
advancing the item, and releases the claim cleanly (drops `agent/claimed`) rather
than abandoning a half-done stage. To hand the item to a human or another agent
instead, use the ownership-policy reassignment (reassign on the tracker via the
adapter); the loop's `classifyOwnership` then treats it as not-ours.

## Finer-grained control (a config edit, not a command)

To disable or reprioritize ONE reconciler loop rather than pausing everything, edit
the `loops` config in the project's `.agents/flow/config.json`: `loops.<id>.enabled: false`
silences that loop (e.g. `loops.triage`, `loops.hygiene`), and `loops.<id>.priority`
reorders the tick. See the dials guide (`${CLAUDE_PLUGIN_ROOT}/docs/the-dials.mdx`). Resume
everything with `/flow:resume`.
