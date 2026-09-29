---
description: Halt every autonomous /flow mode from one place (drain sentinel + pause flag)
category: flow
allowed-tools: Read, Edit, Write, Glob, Bash(node:*), mcp__dorkos__tasks_list, mcp__dorkos__tasks_update
argument-hint: '[issue-id to reclaim | for <duration> | until <time> | empty to halt all autonomy]'
---

# /flow:pause — halt autonomy

Pause: $ARGUMENTS

With an item id, halt only that item: apply `agent/paused` through the adapter at `adapter.path` (the tick honours it at the next stage boundary, see `flow-drain` **One tick**). Otherwise, all in one go:

1. If `.dork/flow/auto-run.json` exists, set its `active` to `false`.
2. Run `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts" pause`. The
   flag is the pause; nothing in step 3 can undo it. On `"ignored": false`, warn that git could commit it.
   With `for <duration>` or `until <time>`, add `--until <ISO time with zone>` and **skip steps 1
   and 3**: flow ends the pause itself, DorkOS or not, and nothing is left for `/flow:resume` to
   switch back on. Refused (exit 2) on a pause that switched schedules off: say to resume first.
3. DorkOS schedules, only when the `tasks_list` and `tasks_update` tools are
   available (load deferred ones first, as `/flow:status` step 2 says): take this project's flow schedules exactly as `/flow:status` step 2 selects them. For each whose `enabled` is `true`, call `tasks_update` with `{ "id": <id>, "enabled": false }`, then record every id in one `config-files.ts pause --host-schedule <id> …` call. Touch no other schedule. A failed call: name it, carry on. When the tools are not available, skip this step and say so: "the scheduler will still start the tick on time, and it will stop at its first step".

Report what changed and what is in flight (`/flow:status`). A running tick is not interrupted: it finishes the item it is on, up to that item's review gate. To stop a tick from starting at all, switch it off where it is scheduled (DorkOS **Schedules** page, or the cron or CI job; a pause here does not reach another machine). Never edit `enabled` in the shipped `flow-drain`, `flow-groom` or `flow-triage` file.
