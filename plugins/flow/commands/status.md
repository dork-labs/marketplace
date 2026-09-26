---
description: Show every in-flight item, parked question and drift across the /flow loop, plus this project's flow schedules
category: flow
allowed-tools: Read, Glob, Skill, AskUserQuestion, Bash(node:*), mcp__dorkos__tasks_list
argument-hint: "[issue-id to focus on, or empty for the whole loop]"
---

# /flow:status — observe the loop

Render one status pane for the `/flow` loop: $ARGUMENTS

This command only reads. It has two steps.

1. **The pane.** Run
   `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" status $ARGUMENTS`
   and show what it prints (it reaches the tracker through the project's code adapter): the pause, the drain, what is in flight, what is parked,
   and any drift. With an issue identifier it shows that item and its last parked
   question. On a non-zero exit, show its message; it names the fix.
2. **The schedules, only when the `tasks_list` tool is available** (DorkOS names it
   `mcp__dorkos__tasks_list`). DorkOS tools may be deferred behind tool search: if
   `tasks_list` is not loaded, load it with ToolSearch first, and treat it as absent
   only when that finds nothing. Call `tasks_list` and keep **this project's flow
   schedules**. Take the `committedDir` and the `localDir` that
   `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts"`
   prints, each with its trailing `/.agents/flow` removed: those are the project's roots.
   A schedule is in this project only when its `filePath` starts with one of those
   roots followed by `/`; a root that is merely the start of another folder's name
   (`/work/app` against `/work/app-2/...`) is a different project. Of those, keep every
   schedule whose `name` is `flow-drain`, `flow-groom` or `flow-triage`, and every schedule a person
   made whose `prompt` runs `/flow continue` (their own cadence for the tick). This
   command only reads: it never calls `tasks_update` and never changes a schedule.

**Schedules.** Under the pane, for each schedule kept in step 2, show its name; when
it runs, in plain words and as written (the `cron` and its `timezone`, e.g. "every hour
at :00 (`0 * * * *`, America/Los_Angeles)"); whether it is on (`enabled`); and its
`status` (`pending_approval` means it is waiting for the operator's approval). When
`tasks_list` was available but none of this project's flow schedules are listed, say
so. When it was not available, say: "flow's scheduled runs fire when your own scheduler
starts them; its entry decides how often". To change how often they fire, point to the
dials page's Cadence section (`docs/the-dials.mdx`), never to the shipped `flow-drain`,
`flow-groom` or `flow-triage` file.
