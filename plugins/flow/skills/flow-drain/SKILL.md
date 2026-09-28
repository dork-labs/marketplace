---
name: flow-drain
display-name: /flow drain ready queue
description: Claim the top-ranked eligible issue and carry it to its review gate.
schedule:
  cron: "0 * * * *"
  timezone: America/Los_Angeles
  enabled: false
  max-runtime: 2h
  permissions: acceptEdits
---

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

This file holds the one tick of the `/flow` loop. A scheduled firing, and
`/flow continue`, run one tick and stop; `/flow auto` runs **Auto** below. It ships
`schedule.enabled: false`: on DorkOS, approve it on the Schedules page; elsewhere,
point your own scheduler (OS cron, CI) at it.

## One tick

0. **Pause check, before anything else.** Run
   `node --experimental-strip-types "<flow-root>/scripts/config-files.ts"`. If the check cannot run or its output cannot be read, stop: never act without knowing
   whether flow is paused. When its
   `paused` is not `null`, report "flow is paused (since `<pausedAt>`); `/flow:resume`
   lifts it" and stop, touching nothing else. When it says `"ok": false`, report its
   first error and stop. Otherwise the tracker adapter is the `SKILL.md` at its
   `adapter.path` (inside it, `<flow-root>` means the output's `flowRoot`).
1. **Identity.** Resolve it once per tick with the adapter's `getCurrentUser`; never
   hand an oracle the literal `"auto"`. Re-read an item's state through the adapter
   before acting on it.
2. **Recovery.** Read `.dork/flow/flow-state.json`; drop records whose item is closed.
   For each `agent/claimed`, started, not `agent/needs-input` item, probe its worker and
   worktree and run `node --experimental-strip-types "<flow-root>/scripts/recovery.ts"`.
   `resume`: re-attach the worktree at HEAD and resume its `sessionId`. Otherwise act on
   `restart-clean`, `escalate` (`agent/blocked`) or `re-derive`. Skip runs with `drain`
   set: `flow drain` recovers its own.
3. **Inbox.** Before claiming anything new, un-park answered `agent/needs-input` items:
   poll the adapter's `getInbox`, apply the comment-response rules in
   `<flow-root>/skills/tending-tracker/SKILL.md`, resume with `--resume <sessionId>`.
   Skip runs with `drain` set.
4. **Dispatch.** A scheduled firing with `drain.parallel` at 1 or more runs
   `flow drain --tick` and stops. Otherwise take `flow next --json`:
   - Empty `picked`: at `atWipCap`, offer no triage. `starved`: report "Queue starved:
     0 ready, <M> shapeable: run a triage pass?" and offer `/flow:triage` or stop. Else
     the queue is drained.
   - Otherwise provision `picked[0]`'s worktree and claim it:
     `node --experimental-strip-types "<flow-root>/scripts/flow.ts" claim <id> --session <session id> --worktree <path> --branch <branch> --json`
     (Claude Code and Codex supply `--session`).
   - Move stages with `flow stage <id> <stage> --json` up to its human-review gate
     (REVIEW), never past it. DONE is `flow done`, after a human approves.
   - At each decision run `<flow-root>/scripts/involvement.ts`. A live terminal asks
     inline with `AskUserQuestion`, never a parked tracker comment.
   - At each stage boundary, if the item carries `agent/paused`: advance it no
     further, run `flow release <id> --to none --json`, leave the worktree, move on.
     Reassigning an item on the tracker hands it to a person or another agent.

Stop at the review gate or a genuine question.

## Auto

Never on a scheduled firing: the scheduler repeats ticks itself.

1. **Pause check.** Run step 0 of `<flow-root>/skills/flow-drain/SKILL.md` (above).
   Stop whenever it says to stop.
2. **Start.** Write `.dork/flow/auto-run.json` (not `flow-state.json`) =
   `{ "active": true, "ready": <eligibleCount>, "shapeable": <shapeableCount>, "startedAt": "<ISO>", "pid": <pid>, "sessionId": "${CLAUDE_SESSION_ID}" }`,
   counts from `flow next --json`. If `sessionId` still reads as a `${…}` placeholder,
   say the drain will stop after each item.
3. **Each iteration.** **Pause check.** Run step 0 of
   `<flow-root>/skills/flow-drain/SKILL.md` again. Stop whenever it says to stop; then
   claim nothing more and keep the sentinel, `active` set to `false`. Otherwise run one
   tick and write the new `ready` and `shapeable` counts.
4. End early with `<promise>ABORT</promise>`, cleanly with `<promise>PHASE_COMPLETE:auto</promise>`.
5. **Stop.** Drained or aborted: delete the sentinel. Never leave a stale one.

`/flow:pause` halts every tick through the pause flag step 0 reads. Neither pause nor
resume edits this file: an update replaces it. To stop a scheduler starting the tick,
switch it off where it is scheduled.
