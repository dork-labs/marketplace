---
slug: flow-schedule-cadence
issue: DOR-2300
created: 2026-09-23
status: specified
---

# How often flow's scheduled runs fire is set where they are scheduled, never in a file an update replaces

**Status:** Approved
**Issue:** DOR-2300
**Date:** 2026-09-23
**Input:** [`01-ideation.md`](./01-ideation.md)
**Builds on:** [`../flow-generated-state-location/02-specification.md`](../flow-generated-state-location/02-specification.md) (DOR-2285)

## Overview

flow 0.10.0 stops sending people to the shipped `schedule:` block to change how often the
`flow-drain` tick and the `flow-groom` check fire. The cadence lives where the run is scheduled:

| Who fires the tick                          | Where its cadence lives                                   | Survives a flow update? |
| ------------------------------------------- | --------------------------------------------------------- | ----------------------- |
| Your own scheduler (OS cron, CI, a poller)  | That scheduler's own entry                                | yes (flow never sees it) |
| DorkOS                                      | The schedule on the Schedules page, starting from flow's default | yes, once DorkOS lets a package schedule hold its own timing (recommended dorkos ticket); today DorkOS runs flow's default |

The shipped `schedule.cron` / `schedule.timezone` are documented as the package's defaults, not
as a dial. `/flow:status` shows the cadence each of this project's flow schedules actually uses
when DorkOS's schedule tools are there. A test guards all of it.

## Background / Problem Statement

- flow's docs name `schedule.cron` in `<flow-root>/skills/flow-drain/SKILL.md` as the cadence dial
  (`docs/the-dials.mdx`: "Where the dials live", "Cadence: the Pulse cron", and the "Which dial"
  row "Make the autonomous tick fire more often").
- On DorkOS, editing that file parks the schedule for approval (the approval key is
  `[prompt, cron]`, `schedule-permission-clamp.ts:116`), and the next update replaces the file,
  putting the default back and parking it again. The Schedules page and `tasks_update` cannot help:
  for a schedule an installed package owns, only `enabled` may change on the row
  (`task-file-update.ts:176`, `lifecycle/update-task-file.ts:181`); a timing change answers 409
  `schedule_package_owned`, and the sync copies the file's cron over the row on every pass
  (`task-store.ts:1260, 1338`).
- Under any other scheduler nothing reads the shipped cron at all; the scheduler's own entry
  decides.
- `docs/turning-on-autonomy.mdx` tells a Pulse-seat reader to "tune cadence" with
  `loops.*.intervalMs`, which the dials page says the v1 tick does not honour.

## Goals

- No command, skill or doc tells a person to edit a shipped schedule's timing.
- A person can find, for their scheduler, the one place that decides how often the tick fires,
  and it is a place no flow update touches (or, on DorkOS today, an honest statement that the
  default applies and the supported way around it).
- A person can see the cadence in use from `/flow`.
- The documented defaults can never drift from the shipped files.

## Non-Goals

- Implementing the DorkOS change (recommended ticket in the ideation, section 7).
- A flow config field for cadence (ideation, section 5, option 2: nothing would read it).
- A cadence gate inside the tick (ideation, section 5, option 3).
- Changing the shipped tick skills. Their body and cron are DorkOS's approval key; any edit makes
  every DorkOS user approve the tick again. Nothing in them tells a person to edit the cron.
- The `loops.<id>.intervalMs` contract (the deferred P5 runner's).

## Technical Dependencies

None new. `/flow:status` gains an optional read through DorkOS's `tasks_list` agent tool
(`mcp__dorkos__tasks_list`), the same tool `/flow:pause` already uses.

## Detailed Design

### `docs/the-dials.mdx`

- **"Where the dials live"**: the second row stops naming the shipped `schedule:` block as the
  owner of the cadence. It reads: "Where the tick is scheduled (your own scheduler's entry, or the
  schedule on DorkOS's Schedules page) | How often the scheduled runs fire | That scheduler". The
  lead-in sentence says the one exception is how often the scheduled runs fire.
- **"Cadence"** section, renamed "Cadence: set it where the tick is scheduled":
  1. flow ships two scheduled runs and their defaults, in one table: `flow-drain` `0 * * * *`
     (top of every hour), `flow-groom` `0 9 1 * *` (09:00 on the 1st of each month), both
     `America/Los_Angeles`. They are the package's defaults: DorkOS starts from them; any other
     scheduler never reads them.
  2. **Your own scheduler**: its own entry is the cadence. Change it there; a flow update never
     touches it.
  3. **DorkOS**: runs the tick at flow's default. DorkOS lets you switch a package's schedule on
     or off on the Schedules page but not change when it runs, and the file is the package's: an
     edit there is undone by the next update, and DorkOS asks you to approve the schedule again
     after the edit and again after the update. If you need a different cadence, leave
     `flow-drain` switched off on DorkOS and fire the tick from your own scheduler
     ([Bring your own scheduler](/docs/guides/flow/bring-your-own-scheduler)).
  4. `/flow:status` shows the cadence each of this project's flow schedules uses.
  5. The existing YAML example and the `schedule.*` table stay, re-titled as "what the shipped
     block holds", with the `When to change` column rewritten: `cron` and `timezone` say "where it
     is scheduled (above)", never "tighten"/"loosen"; `enabled` keeps "Leave it"; `max-runtime`
     and `permissions` say they are the package's too, so a change there is also undone by an
     update (flow ships them as its considered defaults).
- **"Which dial should I touch?"**: "Make the autonomous tick fire more often" → "Change it where
  the tick is scheduled ([Cadence](#cadence-set-it-where-the-tick-is-scheduled))".

### `docs/turning-on-autonomy.mdx`

Pulse-seat step "Tune cadence and limits" becomes: the tick runs at flow's default hourly
cadence on DorkOS (see the dials page, Cadence, for how to run it at another); the work-in-progress
caps are `autonomy.wipCap`. The `loops` intervals are no longer offered as the tick's cadence.

### `docs/bring-your-own-scheduler.mdx`

- The "On any other harness" section says the scheduler's own entry is the cadence, that flow's
  shipped `schedule.cron` is not read by it, and that a flow update never changes it.
- The DorkOS callout's pointer "for the cadence" says what the dials page now says: DorkOS runs
  the default; for another cadence, use your own scheduler.

### `commands/status.md`

- `allowed-tools` gains `mcp__dorkos__tasks_list` (never `tasks_update`).
- A fifth source, **The schedules**: only when the `tasks_list` tool is available (DorkOS:
  `mcp__dorkos__tasks_list`; if it is deferred, load it with ToolSearch first, and treat it as
  absent only when that finds nothing). Call `tasks_list`. For every schedule whose `name` is
  `flow-drain` or `flow-groom` and whose `filePath` is inside this project (the main checkout or
  this checkout), show its name, when it runs (the `cron` in plain words and as written, with its
  `timezone`), whether it is on (`enabled`), and its `status` (`pending_approval` = waiting for
  your approval). This command only reads: it never calls `tasks_update` or changes a schedule.
  When the tool is absent: "flow's scheduled runs fire when your own scheduler starts them; its
  entry decides how often". When it is there but none of this project's flow schedules are
  listed, say so.
- The pane renders a **Schedules** section after the pause line.

### Version

flow 0.9.0 → **0.10.0** (`/flow:status` gains a section) in `plugin.json`, `.dork/manifest.json`,
`package.json`, both `package-lock.json` fields, plus a CHANGELOG entry.

## User Experience

- A person on DorkOS who wants the tick every 15 minutes reads the dials page: flow's default is
  hourly; DorkOS will not change a package's timing; the supported way is their own scheduler with
  `flow-drain` off. They are no longer led into an edit an update silently undoes.
- A person with a crontab line reads that the line is the cadence, and that flow's `schedule.cron`
  means nothing to it.
- `/flow:status` on DorkOS: "Schedules: flow-drain, every hour at :00 (`0 * * * *`,
  America/Los_Angeles), on, active. flow-groom, 09:00 on the 1st of each month
  (`0 9 1 * *`), off, waiting for your approval."
- No re-approval on update: the shipped tick skills are unchanged.

## Testing Strategy

`engine-tests/cadence-contract.test.ts`, each guard shown to bite on a planted break:

- **Only the dials page's Cadence section names a shipped schedule's timing field.** Every
  `.md`/`.mdx` under `commands/`, `skills/`, `docs/` plus `README.md` and `config/CONFIG.md` is
  scanned for `schedule.cron` / `schedule.timezone`; the only allowed occurrences are inside the
  Cadence section of `docs/the-dials.mdx`. The scan is non-vacuous (it reads a known minimum
  number of files and does find the allowed occurrences).
- **The Cadence section says where cadence lives**: it names the package default, your own
  scheduler's entry, what DorkOS does today (switch on or off, not when it runs), the update and
  re-approval consequence, and `/flow:status`; it contains no "tighten"/"loosen"/"fire more often"
  instruction aimed at the shipped block.
- **Documented defaults equal the shipped ones**: `cron` and `timezone` parsed from the frontmatter
  of `skills/flow-drain/SKILL.md` and `skills/flow-groom/SKILL.md` each appear in the Cadence
  section's defaults table on the row for that schedule.
- **The "Which dial" row** for firing more often points at the Cadence section and does not name
  `schedule.cron`.
- **`/flow:status` reads and never writes**: its `allowed-tools` holds `mcp__dorkos__tasks_list`
  and no `tasks_update`; its schedules source names `tasks_list`, the ToolSearch rule, the
  `flow-drain`/`flow-groom` + inside-this-project filter, the absent-tool sentence, and a
  never-changes-a-schedule line.
- **The Pulse-seat step** does not offer `loops` intervals as the tick's cadence.

## Security Considerations

`/flow:status` only reads DorkOS rows; its `allowed-tools` cannot pre-approve `tasks_update`, and
the test pins that.

## Documentation

`docs/the-dials.mdx`, `docs/turning-on-autonomy.mdx`, `docs/bring-your-own-scheduler.mdx`,
`commands/status.md`, CHANGELOG.

## Implementation Phases

- **Phase 1:** guard test first (failing), then docs and `/flow:status`, then version bump.

## Open Questions

1. ~~Should flow add `autonomy.cadence` to `config.json` so other schedulers can read it?~~
   (RESOLVED) **No.** A crontab or CI `schedule:` is static text, DorkOS reads the file and the
   row, and flow pushing the value into DorkOS through `tasks_update` is refused for a package
   schedule and, even once allowed, is an agent's edit that re-parks by design. A field nothing
   reads breaks the dials page's "nothing is aspirational" promise.
2. ~~Should flow's docs tell DorkOS users to set the cadence on the Schedules page now?~~
   (RESOLVED) **No.** DorkOS refuses it today (409 `schedule_package_owned`). The docs state what
   is true now; the DorkOS ticket carries the follow-up to change the paragraph when it ships.
3. ~~Should the shipped hourly default change?~~ (RESOLVED) **No.** Any change to the cron makes
   every DorkOS user approve the tick again; the default is not the defect.

## References

- DOR-2300, DOR-2285, DOR-2274; DorkOS FB-26 (the row-held `enabled` precedent).
- dorkos `apps/server/src/services/tasks/{file-sync-gates,task-store,task-file-update,schedule-permission-clamp}.ts`,
  `services/tasks/lifecycle/update-task-file.ts`, `routes/tasks.ts`,
  `services/runtimes/claude-code/mcp-tools/task-tools.ts`.
