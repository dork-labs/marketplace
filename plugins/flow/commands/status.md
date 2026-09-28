---
description: Show every in-flight item, parked question and drift across the /flow loop, plus this project's flow schedules
category: flow
allowed-tools: Read, Glob, Skill, AskUserQuestion, Bash(node:*), mcp__dorkos__tasks_list
argument-hint: '[issue-id to focus on, or empty for the whole loop]'
---

# /flow:status — observe the loop

Show the `/flow` loop: $ARGUMENTS

This command only reads.

1. Run `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" status $ARGUMENTS` (it reaches the tracker through the adapter's code) and show what it prints. On a non-zero exit, show its message; it names the fix.
2. **The schedules, only when the `tasks_list` tool is available** (DorkOS: `mcp__dorkos__tasks_list`). DorkOS tools may be deferred: when one is not loaded, load it with ToolSearch first, and treat it as absent only when that finds nothing. Call `tasks_list` and keep **this project's flow schedules**. Take the `committedDir` and the `localDir` that
   `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts"` prints, each with its trailing `/.agents/flow` removed: the project's roots. A schedule is in this project only when its `filePath` starts with one of those
   roots followed by `/`; a root that is merely the start of another folder's name (`/work/app` against `/work/app-2/...`) is another project. Of those, keep each whose `name` is `flow-drain`, `flow-groom` or `flow-triage`, and each a person made whose `prompt` runs `/flow continue`. This command never calls `tasks_update`.

**Schedules.** Under the pane, per kept schedule: its name; when it runs, in plain words and as written (the `cron`
and its `timezone`, e.g. "every hour at :00 (`0 * * * *`, America/Los_Angeles)"); whether it is `enabled`; its `status` (`pending_approval` means it waits for the operator's approval). None kept: say so. No tool: say "flow's scheduled runs fire when your own scheduler starts them; its entry decides
how often". To change how often, point to the dials page's Cadence section (`docs/the-dials.mdx`), never to the shipped schedule files.
