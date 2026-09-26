---
name: flow-retro
display-name: /flow retro
description: Scheduled weekly retro — measure how flow's own runs went and file up to five concrete fixes to flow, never ready.
schedule:
  cron: '0 9 * * 1'
  timezone: America/Los_Angeles
  enabled: false
  max-runtime: 20m
  permissions: default
---

`<flow-root>` below is the folder two levels above this file's real path (run `realpath` on it first if you reached it through a `flow__*` symlink).

This is the schedulable **weekly retro**: flow looks back over its own journal
and self-test results, and files what should change in flow itself. It ships
`schedule.enabled: false`. To switch it on with DorkOS, approve it on the
Schedules page; on any other harness, point your own scheduler at it.

`flow` below means `node --experimental-strip-types "<flow-root>/scripts/flow.ts"`.

Each firing:

0. **Pause check, before anything else:** run step 0 of
   `<flow-root>/skills/flow-groom/SKILL.md` exactly as written there, and stop
   whenever it says to stop.
1. Run `flow selftest --json`, so this week's history has a fresh entry.
2. Run `flow retro --json` and read its `measures` and `proposals`.
3. For each proposal, keep it, merge it into another, or drop it. Rewrite each
   kept one's `title` and `proposal` as one concrete change to one named plugin
   file. Keep its `fingerprint`, `rule` and `evidence` as they are.
4. Write the edited list as JSON to a temp file, then run
   `flow retro --file --input <file>`.
5. Report the measures that moved and what was filed, commented on, declined
   or held back by the cap.

**This tick never edits plugin files.** It only files tracker items, and they
are never `agent/ready`: a person or triage decides.
