---
description: Halt every autonomous /flow mode from one place (drain sentinel + pause flag)
category: flow
allowed-tools: Read, Edit, Write, Glob, Bash(node:*), mcp__dorkos__tasks_list, mcp__dorkos__tasks_update
argument-hint: "[issue-id to reclaim, or empty to halt all autonomy]"
---

# /flow:pause — halt autonomy

Stop the `/flow` loop from advancing on its own: $ARGUMENTS

Halting every mode is ONE action: pause stops every autonomous surface together
so nothing keeps running behind your back:

1. **The drain sentinel.** If `.dork/flow/auto-run.json` exists (a live `/flow auto`
   terminal drain), set its `active` to `false`. The `flow-loop.mjs` Stop hook then
   allows the session to stop at the next gate instead of looping to the next item.
2. **The pause flag.** Run

   ```bash
   node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts" pause
   ```

   It writes this machine's pause, `.agents/flow/paused.json` (always in the main
   checkout, so every worktree and the scheduler's session see the same one), keeps it
   out of git, and prints `{ ok, file, pausedAt, hostSchedules, alreadyPaused, ignored }`.
   Every scheduled tick (`flow-drain`, `flow-groom`), the tracker tick
   (`tending-tracker`), `/flow continue` and `/flow auto` checks it before doing
   anything and stops. It lives in the project, so updating flow cannot undo it. **The
   flag is the pause**: step 3 is a courtesy on top of it, and nothing that goes wrong
   there undoes it. If `ignored` is `false`, tell the operator git does not ignore the
   file, so it could be committed by mistake.
3. **DorkOS schedules, only when the `tasks_list` and `tasks_update` tools are
   available** (DorkOS names them `mcp__dorkos__tasks_list` and
   `mcp__dorkos__tasks_update`). Call `tasks_list`. For every schedule whose `name` is
   `flow-drain` or `flow-groom`, whose `filePath` is inside this project (the main
   checkout or this checkout), and whose `enabled` is `true`, call `tasks_update` with
   `{ "id": <its id>, "enabled": false }`. Then record each id you switched off:

   ```bash
   node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts" pause --host-schedule <id>
   ```

   (one `--host-schedule <id>` per id, in one call). Touch nothing else: not a schedule
   that was already off (a person turned it off, and `/flow:resume` must leave it off),
   and not one whose file is outside this project (another project's). If a call fails,
   say which schedule and carry on. When the tools are not available (not DorkOS, or a
   DorkOS without them), skip this step and say so plainly: "the scheduler will still
   start the tick on time, and it will stop at its first step".

Report what changed (sentinel paused, flag written or already there, since when, and
any schedules switched off) and what was in flight. To see the in-flight items before
or after pausing, use `/flow:status`.

**A tick that is already running is not interrupted.** A drain tick running when you
pause finishes the item it is on, up to that item's review gate; only the next tick
stops at its first step. To stop that item sooner, mark it `agent/paused` (below).

When step 3 did not run, tell the operator what a pause does not do: **a scheduler
still starts the tick on its schedule, and the tick stops at its first step.** To stop
the tick from starting at all, switch it off where it is scheduled: on DorkOS, the
**Schedules** page, a switch that outlasts updates; with cron or CI, disable that job. A
pause on this machine does not reach a scheduler on another one. Never edit `enabled` in
the shipped `flow-drain` or `flow-groom` file: DorkOS ignores the file's switch once a
schedule is approved, and an update replaces the file.

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
