---
slug: flow-generated-state-location
issue: DOR-2285
created: 2026-09-23
status: specified
---

# flow's generated adapter and its pause live in the project, so no plugin update can undo them

**Status:** Approved
**Issue:** DOR-2285
**Date:** 2026-09-23
**Input:** [`01-ideation.md`](./01-ideation.md)
**Builds on:** [`../flow-config-location/02-specification.md`](../flow-config-location/02-specification.md) (DOR-2274)

## Overview

flow 0.9.0 stops writing anything a person owns into its plugin folder:

| What                                   | Old place                                                   | New place                                                    | Committed? |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ | ---------- |
| An adapter `/flow:init` generates      | `<flow-root>/skills/<tracker>-adapter/SKILL.md`             | `<project>/.agents/flow/adapters/<tracker>/SKILL.md`         | yes        |
| A pause                                | `schedule.enabled: false` edited into `skills/flow-drain/SKILL.md` | `<project>/.agents/flow/paused.json`                         | no         |

`scripts/config-files.ts` stays the one place that knows where flow's project files are. Its
`resolve` output gains `flowRoot`, `adapter` and `paused`; its `migrate` moves a legacy adapter
under the DOR-2274 rules; two new subcommands, `pause` and `resume`, own the flag. Every command
and skill that named `<flow-root>/skills/<tracker>-adapter/SKILL.md` reads `adapter.path`
instead, and every autonomous entry point stops when `paused` is set. flow never edits a shipped
file again.

## Background / Problem Statement

- A generated adapter is written into a folder the host replaces: a Claude Code update installs a
  new version folder without it, and a DorkOS update (uninstall + install today) deletes it. Every
  command then points at an adapter that does not exist.
- `/flow:pause` edits `schedule.enabled` in the shipped `flow-drain` file. On DorkOS, once a
  person approves that schedule the database row owns its switch and the file's `enabled` is
  ignored (`apps/server/src/services/tasks/file-sync-gates.ts`, `keepsRowEnabled`), so the pause
  never stops an approved tick. Nothing else reads the flag. Under DOR-2245's file-ownership
  rules the edit would also turn every update into a conflict copy. (The issue expected an
  update to re-enable a paused tick; the file ships `enabled: false`, so an update actually
  leaves it "paused", but the pause never did anything in the first place.)

## Goals

- A generated adapter survives every update, reinstall and uninstall under every host, and is
  committed with the project as team code.
- A pause survives every update, takes effect immediately, applies to every worktree of the
  project, and halts every autonomous entry point under every scheduler.
- Existing installs keep working: a legacy adapter is found and moved with the same safety rules
  as settings.
- No flow command or skill finds the adapter by assuming the harness loaded it as a skill.

## Non-Goals

- Changing DorkOS's scheduler or its approval rules. The Schedules page switch stays the
  host-side way to stop the tick from starting at all.
- Migrating an old pause (see Decision 8 in the ideation: undetectable, and it never worked).
- `.dork/flow/` run state (already in the project).

## Technical Dependencies

Unchanged from DOR-2274: Node ≥ 22.6 with `--experimental-strip-types`, `git` on PATH, no npm
dependency in `config-files.ts`.

## Detailed Design

### Constants

```ts
export const ADAPTERS_DIR = 'adapters';          // under .agents/flow/
export const ADAPTER_FILE = 'SKILL.md';
export const SHIPPED_ADAPTERS = ['linear'] as const; // <flow-root>/skills/<tracker>-adapter/
export const DEFAULT_TRACKER = 'linear';         // the schema default
export const PAUSE_FILE = 'paused.json';
```

`GITIGNORE_LINES` gains `paused.json`; the header reads "this machine's settings, credentials and
pause". `prepare` (and `pause`) append the missing line to a `.gitignore` or `info/exclude` an
earlier flow wrote.

### The tracker

`trackerOf(files)`: `tracker` from the `config.local.json` in use over the `config.json` in use,
else `DEFAULT_TRACKER`. A value that is not a slug (`^[a-z][a-z0-9-]*$`) is `null`: it cannot
name a folder, and it is never joined into a path.

### Adapter resolution

`resolveAdapter(roots, files): AdapterFiles`, only when `files.committed` is not `null`
(otherwise `origin: 'none'`, `tracker: null`):

1. **project**: `<checkout>/.agents/flow/adapters/<tracker>/SKILL.md`, else the main checkout's.
   A project adapter wins over a shipped one, so a team may override `linear` on purpose.
2. **shipped**: `<flow-root>/skills/<tracker>-adapter/SKILL.md` when `tracker` is in
   `SHIPPED_ADAPTERS` and the file exists.
3. **legacy** (tracker not shipped): the first folder in `legacyAdapterDirs(pluginRoot, tracker)`
   that holds a `SKILL.md`, is not marked `MIGRATED_TO`, and has no `DECLINED_BY` line for this
   project: `<flow-root>/skills/<tracker>-adapter/`, then, in Claude Code's cache layout, the same
   folder in each sibling version, newest `SKILL.md` first. `shared` unless the folder is inside
   the checkout or main checkout.
4. **none**.

```ts
export interface AdapterFiles {
  tracker: string | null;
  origin: 'project' | 'shipped' | 'legacy' | 'none';
  path: string | null;   // the SKILL.md to read
  target: string | null; // <committedDir>/adapters/<tracker>/SKILL.md: where one is generated or moved
  shared: boolean;
  moved: MovedSettings[];
}
```

`legacyConfigDirs` and `legacyAdapterDirs` share one helper that lists Claude Code cache
siblings, so the cache-layout rule lives once.

### `resolve`

Prints `{ ok, origin, committed, local, committedDir, localDir, shared, moved, flowRoot, adapter,
paused, errors, warnings }`. New `errors` (at path `(adapter)`), only when a `config.json` was
found:

- `tracker` not a slug: "tracker "<value>" cannot name an adapter".
- origin `none`: `no adapter for tracker "<t>"; run /flow:init to generate one into <target>`.
- origin `legacy`, shared (fail closed, as for settings): "the <t> adapter in <dir> may belong to
  another project; run /flow in this project to confirm".

New `warnings`: legacy in-project ("the <t> adapter is still inside the plugin at <dir>, where an
update can erase it; run config-files.ts migrate to copy it into <target dir>"), and one per
moved adapter folder. `paused` is `{ file, pausedAt }` or `null`; it is state, not an error, so
`ok` ignores it and each caller decides.

### `migrate`

Unchanged for settings, then the adapter, with the same `--confirm` / `--decline` applying to
both (one question: they come from the same plugin folder). Output adds
`adapter: { ok, migrated, needsConfirmation, found, from, wrote, unchanged, leftInPlace, reason }`
where `found` is `{ folder, tracker }`. Top-level `ok` is false when either stopped;
top-level `needsConfirmation` is true when either needs a person.

`migrateAdapter(roots, options)`:

- Resolves settings first (after their migration), then the adapter. Anything but origin
  `legacy` → `migrated: false` with a reason ("already in the project", "flow ships this
  adapter", "nothing to migrate").
- Shared without `--confirm` → nothing copied, `needsConfirmation: true`. `--decline` → the
  project's path is appended to the old adapter folder's `DECLINED_BY`.
- Otherwise the whole folder is copied to `<committedDir>/adapters/<tracker>/`: every regular
  file, byte for byte, recursively, skipping the two marker files and anything that is not a
  regular file or folder (a symlink). `SKILL.md` goes last, because its presence makes the project
  the source. Each file goes through `placeFile`: never overwrites, identical content counts as
  `unchanged`, anything else stops the migration with nothing overwritten. Then `MIGRATED_TO` in
  the old folder. Old files are never deleted; the reason tells the person the old copy can be
  deleted once they have committed the new one, since a host may still offer it as a skill.

### `pause` and `resume`

- `pause`: writes `<localDir>/paused.json` = `{ "pausedAt": "<ISO>" }` (created exclusively; an
  existing flag is kept, `alreadyPaused: true`), after keeping it out of git the same way as the
  local settings file (`.gitignore` in the current checkout, `info/exclude` for the main checkout).
  Prints `{ ok, file, pausedAt, alreadyPaused, ignored }`. `ignored: false` (git would track it)
  still pauses: a pause must never fail for a reason that is not about pausing; the CLI warns.
  Works whether or not flow is configured.
- `resume`: removes `paused.json` from the checkout's and the main checkout's `.agents/flow/`.
  Prints `{ ok, wasPaused, removed }`.
- `paused` in `resolve`: the first `paused.json` found in the checkout's, then the main
  checkout's `.agents/flow/`. Its presence is the pause; `pausedAt` is informational and `null`
  when unreadable (an unreadable flag still pauses: the safe direction for autonomy).

Why ignored and per machine: a committed flag would reach other machines only after a commit and
merge, which is the wrong latency for "stop now", and a flag merged by mistake would silently stop
every teammate's autonomy. A scheduler on another machine (CI) is paused where it runs.

### Who honours the pause

| Entry point                          | Behaviour while `paused` is set                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `skills/flow-drain` (scheduled tick) | Step 0: run `config-files.ts`; if `paused`, stop and report, touching nothing.            |
| `skills/flow-groom` (scheduled check)| Same step 0.                                                                               |
| `/flow continue`                     | The guard stops with "flow is paused (since …); /flow:resume lifts it".                   |
| `/flow auto`                         | Same at start, and re-checked at the start of every iteration; a pause tears the drain down. |
| Manual stage commands, `/flow:status`| Unaffected: pause halts autonomy, never the operator.                                      |

A scheduler still starts a session on schedule while paused; the session ends at step 0. On
DorkOS, switching the tick off on the Schedules page stops it starting at all, and that switch
survives updates; `/flow:pause` says so.

### Consumers

| Where                                                                          | Change                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `commands/flow.md` guard                                                       | Handle `adapter.needsConfirmation`/`adapter.found` with the settings question; the adapter is `adapter.path` (`<flow-root>` inside it is `flowRoot`); the pause rule for `continue`/`auto`. |
| `commands/{capture,triage,ideate,specify,groom,status}.md`, `flow.md` header    | Name the adapter as the `SKILL.md` at `adapter.path`, not `${CLAUDE_PLUGIN_ROOT}/skills/<tracker>-adapter/SKILL.md`.           |
| `commands/pause.md`, `resume.md`                                               | `config-files.ts pause` / `resume` instead of editing `flow-drain`; the Schedules page advice. `Bash(node:*)` allowed.         |
| `commands/status.md`                                                           | Shows the pause.                                                                                                                |
| Stage skills that route through the adapter                                    | One line: the adapter is the `SKILL.md` at `adapter.path` from `config-files.ts`.                                               |
| `skills/flow-drain`, `skills/flow-groom`                                        | Step 0 pause check; the operator-override paragraph rewritten. (Their body is the scheduled prompt, so DorkOS asks for approval again after the update; the CHANGELOG says so.) |
| `skills/initializing-flow` Steps 1, 3, 5a; `skills/building-adapters` Step 3   | Generate into `<committedDir>/adapters/<tracker>/SKILL.md`; the generated adapter's `<flow-root>` note; re-run handling.        |
| `config/CONFIG.md`, `README.md`, `docs/*`, `scripts/config-schema.ts`, `@see`s | Where the adapter lives, resolution order, the pause flag, the Schedules switch.                                                |
| `engine-tests/tracker-confinement.test.ts`                                     | F1's positive half pins `adapter.path`; no command or skill names the plugin path as the adapter to read.                       |
| plugin `.gitignore`                                                            | Unchanged (markers inside a legacy adapter folder live in an installed copy, not this repo).                                   |

### Version

flow 0.8.0 → **0.9.0** in `plugin.json`, `.dork/manifest.json`, `package.json`, both
`package-lock.json` fields, plus a CHANGELOG entry.

## User Experience

- A Jira team updates flow: the first `/flow` moves the adapter into `.agents/flow/adapters/jira/`
  (asking first if the plugin folder may be shared) and asks them to commit it.
- A new setup: `/flow:init` writes the adapter into the project and says to commit it.
- `/flow:pause`: "Paused. Scheduled ticks will stop at their first step. To stop DorkOS starting
  them at all, switch flow-drain off on the Schedules page." `/flow:resume` lifts it.
- After updating to 0.9.0 on DorkOS, the flow-drain and flow-groom ticks wait for approval again,
  because what they do changed.

## Testing Strategy

`engine-tests/config-files.test.ts` (real temp dirs and git), new cases:

- tracker: local over committed; default `linear`; a non-slug is `null` and never becomes a path.
- adapter resolution: project beats shipped; checkout beats main checkout; shipped `linear` needs
  no copy; shipped but missing → none; a legacy adapter for a non-shipped tracker; a
  `skills/linear-adapter` in a legacy cache sibling is never legacy; cache sibling newest first;
  moved folder skipped and reported; declined folder skipped for this project only;
  in-project vs shared; none with a target.
- `SHIPPED_ADAPTERS` equals the `skills/*-adapter` folders this plugin ships (non-vacuous).
- adapter migration: in-project copies the whole folder without asking (bytes identical, marker
  written, old files kept, `SKILL.md` placed last); shared asks, copies nothing; `--confirm` copies;
  `--decline` remembered; conflict stops with nothing overwritten; re-run is a no-op; lands beside
  the `config.json` in use; a symlink in the folder is not followed.
- pause: writes into the main checkout from a worktree; ignored by git (new and pre-0.9
  `.gitignore`); idempotent; resolve reports it from either checkout; resume removes both;
  unreadable flag still pauses; works unconfigured.
- CLI: `resolve` full output (adapter, `flowRoot`, `paused`), adapter errors and warnings,
  `migrate` with a legacy adapter round trip, `pause`/`resume` exit codes.

`engine-tests/tracker-confinement.test.ts`: F1 positive half pins `adapter.path`; a new guard that
no command or stage skill tells the agent to read `skills/<tracker>-adapter/SKILL.md`, and every
stage skill that routes through the adapter names `adapter.path`.

Critical lines are mutation-checked.

## Security Considerations

- A legacy adapter in a folder several projects may share is never copied into a project, or
  used, without a person confirming; a headless run fails closed.
- A tracker value is validated as a slug before it is joined into any path.
- Copies never overwrite and never follow a symlink out of the adapter folder.

## Documentation

`config/CONFIG.md`, `README.md`, `docs/{building-your-adapter,installing-in-your-project,the-dials,
turning-on-autonomy,bring-your-own-scheduler,how-it-works,driving-it-manually}.mdx`,
`docs/SPEC.md`, CHANGELOG.

## Implementation Phases

- **Phase 1:** resolver (adapter, pause) test-first; consumers, docs, tests; version bump.

## Open Questions

1. ~~Should `/flow:pause` still write `enabled: false` into the shipped file as a belt and
   braces?~~ (RESOLVED) **No.** On an approved DorkOS schedule the row owns the switch, so the edit
   does nothing; under DOR-2245 it turns every update into a conflict copy. The flag is the only
   pause; the Schedules switch is the host's own.
2. ~~Should flow flip the DorkOS row itself?~~ (RESOLVED) **No.** flow would call a host API it
   cannot address portably, and it would still do nothing for any other scheduler. The pause
   message tells the person where the switch is.
3. ~~Should the migrated adapter's old copy be deleted?~~ (RESOLVED) **No**, copy-only as in
   DOR-2274; the old folder is marked and the person is told they may delete it. A host may still
   list it as a skill until its next update, but flow itself only ever reads `adapter.path`.
4. ~~Committed or ignored pause?~~ (RESOLVED) Ignored, per machine, in the main checkout (see
   "Why ignored").

## References

- DOR-2285, DOR-2274, DOR-2245.
- dorkos `apps/server/src/services/tasks/{file-sync-gates,task-store,task-file-update,skills-roots}.ts`,
  `packages/harness/src/{sources/installed,plan/installed-projector,vendor-facts/index}.ts`.
