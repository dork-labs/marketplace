---
name: flow-order
display-name: /flow work order views
description: Scheduled hourly rewrite of the two saved tracker views from the work order; writes positions only.
schedule:
  cron: '0 * * * *'
  timezone: America/Los_Angeles
  enabled: false
  max-runtime: 10m
  permissions: default
  scope: project
  projectFile: .agents/flow/config.json
metadata:
  flow-needs:
    - 'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts")'
    - 'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" note --kind friction:*)'
    - 'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" order --check-order --json)'
    - 'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" order --write-order --json)'
    - 'Read(${CLAUDE_PLUGIN_ROOT}/**)'
    - 'Read(.dork/flow/**)'
    - 'tracker:read'
    - 'tracker:write-positions'
---

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

The hourly **work order views** run: it writes the work order into the two
saved tracker views `order.views` names. It ships switched off.

**Refused tool:** `<flow-root>/skills/flow-drain/refused-tool.md`.

Each firing:

0. **Pause check.** Run step 0 of
   `<flow-root>/skills/flow-drain/SKILL.md`. Stop whenever it says to stop.
1. Run `flow order --write-order --json`. Exit 3 means `order.views` is not
   set: report the message and stop. Exit 1 (it hit `order.maxWrites`) or
   5 (another run is writing): go on to step 2.
2. Run `flow order --check-order --json` (it saves what the Flow page shows).
   Report, in one line, what step 1 wrote and whether both views are in order.

**This run writes positions only**: never a label, a state or a comment.
Fields decide the order.
