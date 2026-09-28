---
description: Restore autonomous /flow operation that /flow:pause halted
category: flow
allowed-tools: Read, Edit, Write, Glob, SlashCommand, Bash(node:*), mcp__dorkos__tasks_update
argument-hint: '[issue-id to un-pause, or empty to restore all autonomy]'
---

# /flow:resume — restore autonomy

Resume: $ARGUMENTS

With an item id, remove its `agent/paused` marker through the adapter at `adapter.path` (and reassign it back, if it was handed to someone). Otherwise:

1. Run `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts" resume`. It prints `hostSchedules`: the DorkOS schedules the pause switched off.
2. When `tasks_update` is available (load it as `/flow:status` step 2 says), call it with `{ "id": <id>, "enabled": true }` for each id in the list,
   and for nothing else: a schedule that was off before the pause stays off. A failed call: name it and point to the **Schedules** page. Tool absent and the list not empty: tell the operator to switch those on there. If they switched a tick off themselves, remind them to switch it back on where they did.
3. A sentinel `.dork/flow/auto-run.json` with `active: false`: restart the drain with `/flow auto`. The hook never reaps a paused sentinel. A missing sentinel may be an orphan the hook reaped, not a drained queue: check the queue before saying so.
