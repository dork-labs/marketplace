---
slug: flow-schedule-cadence
issue: DOR-2300
created: 2026-09-23
status: ideation
---

# How often flow's scheduled runs fire is set where they are scheduled, never in a file an update replaces

**Slug:** flow-schedule-cadence
**Issue:** DOR-2300
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief:** Changing how often flow's autonomy tick runs (`schedule.cron` in
  `<flow-root>/skills/flow-drain/SKILL.md`, and the same for `flow-groom`) means editing the
  shipped skill file. A plugin update replaces that file, and DorkOS treats an edited body or cron
  as a content change that needs approval again. Same class as DOR-2274 and DOR-2285: state a
  person owns, kept in a file the host owns. Give the cadence one home that survives updates and
  does not force a new approval every time the operator tunes it.
- **Assumptions (checked against the code below, not taken from the brief):**
  - The orchestrator's working hypothesis was "on DorkOS the Schedules page (or `tasks_update`)
    edits the row, like `enabled`, and the shipped cron is only the default". **The code says
    otherwise** (section 2): DorkOS refuses to change the timing of a schedule an installed package
    owns, on the page and through the agent tool alike, and the sync copies the file's cron over
    the row every time.
  - A person who fires the tick from their own scheduler (OS cron, CI, a poller) already owns its
    cadence there, in a place no flow update touches.
- **Out of scope:**
  - Implementing the DorkOS change. It is recommended as a separate dorkos ticket (section 7).
  - The per-reconciler `loops.<id>.intervalMs` dials (the deferred P5 runner's contract).
  - `schedule.max-runtime` and `schedule.permissions` (what a run may do, not when it fires).

## 2) Pre-reading Log

- `specs/flow-config-location/` (DOR-2274) and `specs/flow-generated-state-location/` (DOR-2285):
  a person's state lives in the project, never in the plugin folder; flow never edits a shipped
  file; `/flow:pause` reaches DorkOS rows only through `tasks_list` / `tasks_update`, as a
  courtesy, loading deferred tools with ToolSearch before treating them as absent.
- `plugins/flow/skills/flow-drain/SKILL.md` (`cron: "0 * * * *"`) and `skills/flow-groom/SKILL.md`
  (`cron: '0 9 1 * *'`), both `timezone: America/Los_Angeles`, `enabled: false`.
- Places that tell a person to edit the shipped cron, or imply it:
  - `docs/the-dials.mdx`: the "Where the dials live" table names the `schedule:` block as the
    place that owns the cadence; the "Cadence: the Pulse cron" section and its table ("Tighten for
    a busier queue"); the "Which dial should I touch?" row "Make the autonomous tick fire more
    often → `flow-drain` `schedule.cron`".
  - `docs/turning-on-autonomy.mdx`, Pulse seat step "Tune cadence and limits": points at
    `loops.*.intervalMs`, which the dials page itself says the v1 tick does not honour.
  - `docs/bring-your-own-scheduler.mdx`: sends a reader to the dials page "for the cadence".
- DorkOS (`dorkos` repo, `main` at `b29ba8b9b`), `apps/server/src/`:
  - **Sync reads the cron from the file, every time.** `services/tasks/task-store.ts:1260` and
    `:1338` write `cron: incomingCron` (the file's `schedule.cron`) on every upsert. The only
    column a package-owned row keeps against its file is `enabled`
    (`task-store.ts:1268`, `keepsRowEnabled` in `services/tasks/file-sync-gates.ts:158`).
  - **Approval is keyed on prompt and cron.** `scheduleContentKey` =
    `JSON.stringify([prompt, cron])` (`services/tasks/schedule-permission-clamp.ts:116`); the arm
    gate compares the file's `{prompt: body, cron}` against the approved key
    (`file-sync-gates.ts:97`). An edited cron in the file parks the schedule at
    `pending_approval`.
  - **A package-owned schedule's timing cannot be changed on the row.** `PATCH /api/tasks/:id`
    (the Schedules page) and the `tasks_update` agent tool both go through `applyTaskFileUpdate`
    (`routes/tasks.ts:460`, `services/runtimes/claude-code/mcp-tools/task-tools.ts:650`). For a
    file an installed package owns, only changes that `landsOnRowAlone` accepts pass
    (`services/tasks/lifecycle/update-task-file.ts:181`), and that set is `enabled` alone
    (`services/tasks/task-file-update.ts:176`). A `cron` or `timezone` change answers 409
    `schedule_package_owned`: "You can switch this schedule on or off here; to change what it does,
    edit the package or make your own copy of the skill" (`update-task-file.ts:196-208`).
  - For a schedule a person owns (not a package's), a cron edit on the Schedules page re-approves
    in the same act (`routes/tasks.ts:515`, trusted caller only); an agent's `tasks_update` cron
    edit re-parks it and says so (`REAPPROVAL_NOTE`, `task-tools.ts:105`).
  - `tasks_list` returns every row with `name`, `cron`, `timezone`, `enabled`, `status`,
    `filePath` (`task-tools.ts:328`, `TaskSchema` in `packages/shared/src/schemas.ts:4528`).

## 3) Codebase Map

- **Primary:** `plugins/flow/docs/the-dials.mdx`, `docs/turning-on-autonomy.mdx`,
  `docs/bring-your-own-scheduler.mdx`, `commands/status.md`.
- **Not touched on purpose:** the bodies and `schedule:` blocks of `skills/flow-drain` and
  `skills/flow-groom`. On DorkOS the body is the scheduled prompt and the cron is the other half of
  the approval key, so any edit there makes every DorkOS user approve the tick again; nothing in
  them tells a person to edit the cron, so nothing needs to change.
- **Tests:** a new `engine-tests/cadence-contract.test.ts`.
- **Blast radius:** documentation and one observe-only command. No script, schema or schedule
  changes.

## 4) Root Cause Analysis

- **Repro (DorkOS).** Approve `flow-drain`, then try to run it every 15 minutes. The Schedules page
  refuses the edit (409 `schedule_package_owned`). The only remaining route is the one flow's docs
  give: edit `schedule.cron` in the plugin's `flow-drain/SKILL.md`. DorkOS then parks the schedule
  for approval (the cron is half the approval key), and the next flow update replaces the file,
  which puts the hourly default back and parks it for approval again.
- **Repro (any other scheduler).** A person's crontab line or CI job decides when the tick fires.
  flow's `schedule.cron` is read by nothing there, yet the dials page names it as the cadence.
- **Root cause.** flow's docs name the shipped file as the place cadence lives. On DorkOS that
  place is owned by the package and replaced on update, and DorkOS offers no row-level override for
  a package schedule's timing, only for its on/off switch. Elsewhere that place is not read at all.

## 5) Research

### Where the cadence can live

1. **Keep "edit the shipped `schedule.cron`".** Lost on every update; re-parks on DorkOS on every
   edit and every update. This is the defect. Rejected.
2. **A project field, e.g. `autonomy.cadence` in `.agents/flow/config.json`.** Survives updates and
   is committed. But no scheduler reads it: DorkOS reads the file and the row, a crontab or a CI
   `schedule:` is static text. For it to matter flow would have to push it into the host. On
   DorkOS that push is `tasks_update {cron}`, which is refused for a package schedule today, and
   an agent's cron edit is exactly the substitution DorkOS re-parks by design, so every tune would
   need a new approval anyway. And the dials page promises "every dial here is a real, validated
   field; nothing is aspirational". A field nothing reads would break that promise. **Rejected.**
3. **A cadence gate inside the tick** (the scheduler fires often; the tick exits early unless
   `autonomy.cadence` says it is due, like `isCadenceDue`). Works under every scheduler and can
   only ever slow the tick down, never speed it up past the shipped heartbeat. To be useful the
   shipped heartbeat would have to be fast (every 5 minutes), and on DorkOS every fire starts an
   agent session: about 288 sessions a day that mostly read a skill and stop, each spending
   tokens and filling run history. **Rejected.**
4. **The cadence lives where the tick is scheduled.** Own scheduler: its own entry, which it
   already is, and no update touches it. DorkOS: the schedule row on the Schedules page, with the
   shipped cron as the package default. The person's edit there is a trusted act, so it can carry
   its own approval. **Recommended.** It needs one DorkOS change: a package schedule's timing has
   to be something the row may hold, like `enabled` (section 7). Until DorkOS ships it, a DorkOS
   user who needs a different cadence fires the tick from their own scheduler and leaves
   `flow-drain` switched off.

### What flow can do now, without DorkOS

- Stop telling people to edit the shipped cron, and say plainly where the cadence is set for each
  kind of scheduler, including what DorkOS does today.
- Show the cadence actually in use: `/flow:status` reads this project's `flow-drain` / `flow-groom`
  rows through `tasks_list` when DorkOS's tools are there (read-only, the same discovery rule as
  `/flow:pause`), and otherwise says the tick's cadence is whatever fires it. When DorkOS later
  lets a row hold its own cadence, this report keeps telling the truth with no flow change.
- Guard it: a test that no command, skill or doc sends a person to edit a shipped schedule's
  timing, that the documented defaults match the shipped files, and that `/flow:status` only reads.

## 6) Decisions

| #   | Decision                                   | Choice                                                                                                                  | Rationale                                                                                                              |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | The one source of truth for cadence        | Wherever the tick is scheduled: the person's own scheduler entry, or (on DorkOS) the schedule row                       | Each scheduler already owns when it fires; a second copy in flow would be read by nothing or drift from the real one. |
| 2   | The shipped `schedule.cron` / `timezone`   | The package default DorkOS starts from; never an instruction to edit                                                     | It is the package's file; an update replaces it and an edit re-parks on DorkOS.                                        |
| 3   | A flow config field for cadence            | None                                                                                                                    | Nothing would read it (section 5, option 2); the dials promise only real dials.                                        |
| 4   | DorkOS today                               | Say plainly the tick runs at flow's default there; for another cadence, use your own scheduler and keep `flow-drain` off | True today; the one path that survives updates and needs no re-approval per change.                                   |
| 5   | DorkOS change                              | Recommended separate dorkos ticket: a package schedule's cron and timezone may be held by the row, set on the Schedules page | Mirrors the `enabled` precedent (FB-26); the only place a person can tune a package schedule without editing the package. |
| 6   | `/flow` affordance                          | `/flow:status` shows the cadence in use, read-only                                                                      | Lets a person see what actually fires; survives the DorkOS change unchanged.                                           |
| 7   | The shipped tick skills                    | Untouched                                                                                                               | Their body and cron are DorkOS's approval key; editing them would make everyone approve again, for no gain.            |

## 7) Recommended DorkOS ticket (not implemented here)

**Title:** Let a person change when a package's schedule runs on the Schedules page.

- **Today:** a package schedule's `cron` and `timezone` are refused on the row
  (`task-file-update.ts:176`, `update-task-file.ts:181-208`), and the sync copies the file's cron
  over the row every time (`task-store.ts:1260, 1338`). The only way to change when a package's
  schedule runs is to edit the package's file, which the next update replaces and which parks the
  schedule for approval again.
- **Minimal change:** treat the timing like the on/off switch. Keep the file's `cron` / `timezone`
  as the package default, and let the row hold a person's own timing that the sync leaves alone
  (for example nullable override columns, with the scheduler and the approval key using the
  effective value, override first). A trusted edit on the Schedules page sets it and re-approves in
  the same act (as `routes/tasks.ts:515` already does for a person's own schedule); an agent's
  `tasks_update` timing change still re-parks. A way to go back to the package default.
- **Why the key must use the effective timing:** so a package update that changes only its default
  cron does not re-park a schedule whose person already chose their own, while a changed prompt
  still does.
- **Follow-up in flow when it ships:** the dials page's DorkOS paragraph points at the Schedules
  page instead of your own scheduler; `/flow:status` needs no change.
