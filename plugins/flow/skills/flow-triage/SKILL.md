---
name: flow-triage
display-name: /flow daily triage
description: Scheduled daily triage — ready or park every untriaged item, and release claims nobody has touched for a week.
schedule:
  cron: '0 8 * * *'
  timezone: America/Los_Angeles
  enabled: false
  max-runtime: 30m
  permissions: default
---

`<flow-root>` is two folders above this file's `realpath`.

The schedulable **daily triage**: without it, nothing moves new work to ready on its
own. It ships switched off: approve it on the Schedules page, or use any scheduler.

Each firing:

0. **Pause check.** Run step 0 of
   `<flow-root>/skills/flow-drain/SKILL.md`. Stop whenever it says to stop. Tracker
   reads and writes below go through the adapter at `adapter.path`.
1. Take a backlog snapshot.
2. **Release stale claims:** items with `agent/claimed` that have been
   untouched for 7 or more days (no tracker update and no comment). Release one
   only when ALL of these hold; otherwise list it in the report and leave it:
   - No run for it in `.dork/flow/flow-state.json`, whatever its worker's state.
     Recovery owns those.
   - It is not in the review state (the human-review gate) and not assigned to
     a human.
   - Its work lives in this repo. If it may live in another (say, a `repo/*`
     label that is not this repo's), skip it and report it.
   - Match its id in any case (a branch may be `proj-123-…` for `PROJ-123`).
   - No worktree carries its id: `git worktree list --porcelain`.
   - No pushed branch carries its id: `git ls-remote --heads origin`.
   - No open pull request on this repo's host carries its id
     (`gh pr list --state open --search <id>`, or the host's equivalent).
   - Its own links, attachments and comments name no pull
     request or branch in any repo.

   Remove `agent/claimed`, move the item to an `unstarted`-category state, and
   comment why. Do not restore `agent/ready`: step 3 triages it again.

3. **Triage what is untriaged:** open items with no `agent/*` label and no human
   assignee. Run each through Path B of `<flow-root>/skills/triaging-work/SKILL.md`:
   ready it only if it passes the six readiness rules
   (`<flow-root>/skills/grooming-backlog/SKILL.md`, phase 4 step 5); otherwise park
   it with one question (`needsInput`).
4. Report what was readied, parked, released and skipped.

**Floor gates never run unattended.** No rejecting or cancelling, no new
projects, no replies to outside reporters: list those items for the operator.
