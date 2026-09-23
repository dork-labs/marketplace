---
slug: flow-config-location
issue: DOR-2274
created: 2026-09-23
status: specified
---

# flow's settings live in the project, so no plugin update can erase them

**Status:** Approved
**Issue:** DOR-2274
**Date:** 2026-09-23
**Input:** [`01-ideation.md`](./01-ideation.md)

## Overview

flow 0.8.0 reads its two settings files from the project, not from inside the installed plugin:

| File                | New home                                   | Committed? |
| ------------------- | ------------------------------------------ | ---------- |
| `config.json`       | `<project>/.agents/flow/config.json`       | yes        |
| `config.local.json` | `<project>/.agents/flow/config.local.json` | no         |

One dependency-free script, `plugins/flow/scripts/config-files.ts`, is the only place that
knows where the files are. It finds them, validates the committed one, copies settings from the
old place the first time it sees them there, and prepares the folder for `/flow:init`. Every
command and skill that used to name `<flow-root>/config/config.json` asks it instead.

## Background / Problem Statement

`/flow:init` writes both files into `<flow-root>/config/`. In a bare Claude Code install from a
marketplace, `<flow-root>` is `~/.claude/plugins/cache/<marketplace>/flow/<version>/`, and an
update installs into a new version directory. The new version starts with no settings, so
`/flow` sends the person back to `/flow:init`; the old directory is swept after about 14 days.
DorkOS keeps the files across its own updates (DOR-2245), which fixes one host, not the cause:
flow stores a person's state in a directory the host owns and replaces.

## Goals

- Settings survive every plugin update, reinstall and uninstall under DorkOS and bare Claude Code.
- Team policy (`config.json`) can be committed with the project; per-machine settings cannot be.
- Two projects that share one flow install keep separate settings.
- An existing install upgrades without re-running `/flow:init`, including a bare Claude Code
  install whose settings sit in the previous version's cache directory.
- One module answers "which files", and it runs before `npm install`.

## Non-Goals

- The adapter `/flow:init` generates into `<flow-root>/skills/<tracker>-adapter/`, and the
  `schedule.enabled` edit `/flow:pause` makes in `<flow-root>/skills/flow-drain/SKILL.md`. Same
  root cause, separate follow-ups.
- Merging the two files for the agent. Skills keep applying the documented precedence
  (`env > config.local.json > config.json > schema defaults`) themselves.
- Validating `config.local.json`'s policy overrides (unchanged from today).
- A `WORKFLOW.md` override (still the promoted loader's job).

## Technical Dependencies

- Node ≥ 22.6 with `--experimental-strip-types` (already required by every flow script).
- `git` on PATH for checkout detection and the ignore check; everything degrades to the current
  directory outside a repo.
- No new npm dependency. The module imports only `node:*` and `./validate-config.ts`, which is
  itself dependency-free.

## Detailed Design

### Resolution order

Project root detection, from the working directory (or `--project <dir>`):

- `checkout` = `git rev-parse --show-toplevel`, or the directory itself outside a repo.
- `mainCheckout` = the parent of `git rev-parse --path-format=absolute --git-common-dir` when that
  directory is named `.git` and differs from `checkout` (a linked worktree); otherwise none. A
  bare repository or a submodule has no main checkout to fall back to.
- Outside git, a starting folder that is the home folder is refused by every command: its
  settings would land in `~/.agents/flow/` and apply to every folder beneath it.

Which files are read, first match wins:

1. **project**: `<checkout>/.agents/flow/config.json`, else `<mainCheckout>/.agents/flow/config.json`.
   `config.local.json` is then looked up the same way (checkout, then main checkout), independently,
   and may be absent. Legacy files are never consulted once the project has a `config.json`.
2. **legacy**: the first of these directories that holds a `config.json` and no `MIGRATED_TO`
   marker; `config.local.json` is taken from the same directory or is absent (never mixed with
   the project's, or across directories):
   1. `<flow-root>/config/` (DorkOS installs, `--plugin-dir`, a local-directory marketplace).
   2. When `<flow-root>` is `…/plugins/cache/<marketplace>/<plugin>/<version>` (Claude Code's
      documented cache layout), each sibling version directory's `config/`, newest
      `config.json` modification time first. This is how the upgrade to this very version finds
      settings the previous version wrote.

   A legacy folder is **shared** unless it sits inside `checkout` or `mainCheckout` (a DorkOS
   project-scope install, `<project>/.dork/plugins/flow`). A shared folder may serve several
   projects, so its settings may be another project's.
3. **none**: not configured. `/flow` routes to `/flow:init`, as today. Per-field schema defaults
   still apply to any `config.json` that exists; a missing file is not "all defaults", because
   defaults cannot name a tracker team.

Where files are written (review finding 2):

- `committedDir`: the folder of the `config.json` in use; for a fresh setup, the **current
  checkout** (`config.json` is committed, so it belongs to the branch being worked on, which is
  also where `resolve` looks first).
- `localDir`: the folder of the `config.local.json` in use; otherwise the **main checkout**
  (`<mainCheckout ?? checkout>`). An ignored file never reaches a new worktree, so the main
  checkout is the one place every worktree of the project finds it.
- Both folders get the flow-written `.gitignore`, because a local file may be written in either.

### `scripts/config-files.ts`

Pure core plus a thin CLI, in the shape of the other oracle scripts.

```ts
export const PROJECT_CONFIG_DIR = '.agents/flow';
export const CONFIG_FILE = 'config.json';
export const LOCAL_CONFIG_FILE = 'config.local.json';
export const MIGRATED_MARKER = 'MIGRATED_TO';
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/dork-labs/marketplace/main/plugins/flow/config/config.schema.json';

export interface ConfigRoots { checkout: string; mainCheckout: string | null; inGit: boolean; pluginRoot: string }
export type ConfigOrigin = 'project' | 'legacy' | 'none';
export interface ConfigFiles {
  origin: ConfigOrigin;
  committed: string | null;   // the config.json in use
  local: string | null;       // the config.local.json in use
  committedDir: string;       // where config.json is / will be written
  localDir: string;           // where config.local.json is / will be written
  shared: boolean;            // legacy origin outside this project
  moved: { folder: string; movedTo: string }[]; // legacy folders skipped by their marker
}

export function findConfigRoots(cwd: string, pluginRoot: string): ConfigRoots;
export function refusalFor(roots: ConfigRoots): string | null;
export function legacyConfigDirs(pluginRoot: string): string[];
export function resolveConfigFiles(roots: ConfigRoots): ConfigFiles;
export function prepareConfigDirs(files: Pick<ConfigFiles, 'committedDir' | 'localDir'>): PrepareResult;
export function migrateConfig(roots: ConfigRoots, options?: { confirm?: boolean }): MigrationResult;
```

CLI: `node --experimental-strip-types "<flow-root>/scripts/config-files.ts" [resolve|migrate|prepare] [--confirm] [--project <dir>]`.

- **`resolve`** (default). Prints
  `{ ok, origin, committed, local, committedDir, localDir, shared, moved, errors, warnings }`
  and exits `0` when `ok`. `ok` is true when a `config.json` was found, parses, and passes
  `validateConfig` (warnings allowed). `errors`/`warnings` are `validate-config`'s
  `{ path, message }` issues for the committed file; unreadable JSON is one error at `(root)`.
  More warnings, at path `(file)`:
  - origin `legacy`, not shared: "settings are still inside the plugin at <dir>; run `migrate`".
  - origin `legacy`, shared: names the folder, tracker, team and workspace, and says to run
    `migrate --confirm` if they are this project's, otherwise `/flow:init`.
  - each `moved` folder: "the settings in <dir> were moved to <project>; flow did not use them".
  - the project's `config.json` is ignored by git: "team settings in <path> are ignored by git,
    so they are not shared" (the file still works).
- **`migrate`**. Idempotent, copy-only. Prints
  `{ ok, migrated, needsConfirmation, found, from, wrote, unchanged, leftInPlace, reason }`;
  exit `0` unless `ok` is false.
  - origin `project` → `migrated: false`, reason "already in the project". origin `none` →
    `migrated: false`, reason "nothing to migrate".
  - origin `legacy`, **shared, without `--confirm`** (review finding 1): nothing is copied;
    `needsConfirmation: true` and `found` = `{ folder, tracker, team, workspace }` (team and
    workspace from the local file over the committed one; never a credential). The `/flow` guard
    and `/flow:init` show `found` and ask "Are these this project's settings?"; yes runs
    `migrate --confirm`, no sets the project up fresh, and a headless run keeps reading the
    legacy files (the pre-0.8.0 behaviour) without copying.
  - origin `legacy`, not shared or confirmed: the committed file must parse as a JSON object, or
    the migration stops with `ok: false` and writes nothing. Then `prepare`.
  - `config.local.json` first, when the legacy directory has one; a `prepare` that is not `ok`
    stops the migration with nothing written. Bytes copied exactly, owner-only (`0o600`),
    written to a temporary file in the same directory and hard-linked into place so an
    existing file is never overwritten. On a filesystem without hard links (`ENOTSUP`, `EPERM`,
    `ENOSYS`: exFAT, FAT, some network mounts) the file is created exclusively (`wx`) instead
    (review finding 3). The copy is read back and compared; a copy that does not match is
    removed and the migration stops.
  - `config.json` last, because its presence is what makes the project the source. Content is
    the legacy object with any `$schema` that is not a URL replaced by `CONFIG_SCHEMA_URL` (a
    relative path to the plugin cannot work from the project, and an absolute one would name one
    machine's cache in a committed file), serialised with two-space indent and a trailing
    newline. Same write; verified by parsing it back and comparing deeply.
  - A destination that already holds the same content counts as `unchanged` (a re-run after a
    crash between the two writes finishes the job). Anything else there, including something
    that cannot be read as a file, stops the migration with `ok: false` naming both paths;
    nothing is overwritten.
  - The legacy files are **never deleted** and are listed in `leftInPlace`. After a successful
    migration the legacy folder gets `MIGRATED_TO` holding the project's path (the main
    checkout's, or the checkout's), so the next project on a shared install is told the settings
    belong to that project and is routed to `/flow:init` rather than inheriting them. A folder
    that cannot be written to is reported in `reason`; the migration still succeeds.
- **`prepare`**. Creates `committedDir` and `localDir`, ensures each has a `.gitignore` holding
  `config.local.json` and `.config.local.json.*.tmp` (creating the file, or appending the
  missing lines; review finding 5), and when inside a git repo confirms with `git check-ignore`
  that `config.local.json` is ignored in each. Prints `{ ok, committed, local, gitignores }`
  with the target paths. `ok: false` (exit 1) when git would still track the local file (a
  negation rule, or a copy already committed); nothing secret may be written then.

The ignore lives in `.agents/flow/.gitignore`, beside the files, rather than in the project's
root `.gitignore`: it needs no edit to a file the person owns, travels with the folder, and is
committed with `config.json`.

### Why not `${CLAUDE_PLUGIN_DATA}`

- In Claude Code it is `~/.claude/plugins/data/<id>/`, one per plugin **per user**, shared by
  every project. flow's settings are per project (each names a tracker team).
- A per-machine data directory is never in the repo, so team policy there cannot be committed.
- Claude Code does not substitute it in Bash tool commands or export it to them, and DorkOS
  (ADR 260923-163515) cannot rewrite it inside a projected skill, so a script run from a skill
  has no reliable way to find it.
- It resolves to different places under DorkOS (`<installRoot>/.dork/data/`) and Claude Code,
  so the answer to "where are my secrets?" would depend on the host.

### Consumers

| Where                                   | Change                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands/flow.md` first-run guard      | Run `config-files.ts migrate`, then `config-files.ts resolve`; route to `/flow:init` only when resolve says `ok: false`. Show migration results and every warning, secrets warning first. Replaces the `validate-config.ts` pipe.       |
| `commands/flow.md`, `pause.md`, `resume.md` | "Edit `loops` in the project's `.agents/flow/config.json`" instead of `${CLAUDE_PLUGIN_ROOT}/config/config.json`.                                                                                                                  |
| `skills/initializing-flow` Step 1       | Detect with `config-files.ts migrate` then `resolve`: `origin: none` is a fresh install; otherwise a re-run naming the file it found.                                                                                                   |
| `skills/initializing-flow` Step 4       | `config-files.ts prepare` first (stops on `ok: false`), then write `config.json` and `config.local.json` to the paths it prints. Seed from `<flow-root>/config/config.example.json` and `config.local.example.json`. Replaces the grep. |
| `skills/executing-specs`, `verifying-work` | Read the field from the project's `.agents/flow/config.json` (`config-files.ts` prints the path).                                                                                                                                  |
| `validate-config.ts`                    | Logic unchanged. `config-files.ts` imports `validateConfig`; the CLI stays for validating an arbitrary config object.                                                                                                                  |
| `config/config.example.json`            | `$schema` becomes `CONFIG_SCHEMA_URL`, so a copy works from the project.                                                                                                                                                              |
| `config/config.local.example.json`      | Its `//` note points at the right place.                                                                                                                                                                                              |
| `config/CONFIG.md`, README, docs        | Say where the files live, why, the worktree rule, and the migration.                                                                                                                                                                  |
| `.gitignore` (plugin)                   | Kept: it protects a `--plugin-dir` checkout that still holds legacy files. Comment updated.                                                                                                                                           |
| engine tests                            | The three tests that read "the host's `config/config.json`, else the template" read the template only. A plugin folder no longer holds live settings.                                                                               |

### Version

flow 0.7.4 → **0.8.0** (where settings live changes) in `plugin.json`, `.dork/manifest.json`,
`package.json`, `package-lock.json`, plus a CHANGELOG entry.

## User Experience

- Upgrading, plugin inside the project (DorkOS project scope): the first `/flow` copies the
  settings into `.agents/flow/`, names the files, and asks the person to commit `config.json`
  and `.gitignore` (never `config.local.json`, which is ignored).
- Upgrading, plugin in a shared place (Claude Code cache, `--plugin-dir`, a DorkOS user-scope
  install): `/flow` shows the folder, tracker, team and workspace it found and asks whether they
  are this project's. Yes moves them as above; no runs `/flow:init` for a fresh setup.
- A second project on a shared install whose settings already moved: told where they went and
  sent to `/flow:init`.
- Fresh install: `/flow:init` writes into `.agents/flow/` and says so.
- Worktrees: a new worktree finds the main checkout's local file; nothing to copy.
- Conflict: if a destination already exists with different content, flow stops the migration,
  names both files, and keeps reading the legacy pair until the person resolves it.

## Testing Strategy

`engine-tests/config-files.test.ts`, real temporary directories and real `git`:

- roots: top level from a subfolder; main checkout from a linked worktree; no main checkout for a
  submodule; the folder itself outside git; the home folder refused outside git only.
- resolve: project beats legacy; checkout beats main checkout, per file; fresh-setup targets
  (checkout for `config.json`, main checkout for the local file); legacy own dir beats a cache
  sibling; newest sibling wins; a sibling is never consulted outside the cache layout; a legacy
  `config.json` never pairs with the project's local file; inside-project vs shared; a
  `MIGRATED_TO` folder is skipped and reported; `none` when nothing.
- migrate: in-project copies both files without asking (local bytes identical, `0o600`,
  `$schema` rewritten, `.gitignore` effective, no temp left); shared without confirmation copies
  nothing and describes the settings without a secret; confirmed copies and writes the marker;
  a second project on the shared install gets nothing; legacy files still exist; second run is a
  no-op; an interrupted migration completes; a differing local file stops with nothing
  overwritten; something else at the `config.json` destination stops it; a tracked/negated
  local file writes nothing; invalid legacy JSON writes nothing; bare-relative `$schema`
  rewritten and a URL kept; a worktree splits the files between branch and main checkout.
- prepare: both folders get an effective `.gitignore` (temp copies ignored too); appends to an
  existing `.gitignore` without duplicating; `ok: false` when a negation rule keeps the file
  tracked.
- CLI: `resolve` exit codes and warnings (shared legacy described, ignored committed file,
  secrets block, invalid JSON); the migrate → `--confirm` round trip; `prepare` targets; the home
  folder refused; an unknown subcommand is exit 2.

`engine-tests/config-files-no-hard-links.test.ts` replaces `linkSync` with one that fails
`ENOTSUP`: the migration still copies both files (owner-only, no temp left), still never
overwrites, and removes a torn copy and stops.

Each test carries a purpose comment; the critical lines are mutation-checked.

## Performance Considerations

Three to four `git` invocations per `/flow` start; negligible.

## Security Considerations

- The local file (tracker credentials) is written only after git is proven to ignore it, with
  owner-only permissions, and its content is never printed; the CLI prints paths and non-secret
  coordinates (tracker, team key, workspace slug) only.
- Settings in a plugin folder several projects may share are never copied into a project
  without a person confirming they are that project's, and a moved folder is marked so no other
  project reads it.
- Nothing is deleted or overwritten, so a failed migration cannot lose settings.

## Documentation

`config/CONFIG.md`, `README.md`, `docs/installing-in-your-project.mdx`, `docs/the-dials.mdx`,
flow's CHANGELOG.

## Implementation Phases

- **Phase 1:** the resolver module with tests; consumers, docs, tests switched; version bump.

## Open Questions

1. ~~Should the migration delete the old files after verifying the copy?~~ (RESOLVED)
   **Answer:** No. **Rationale:** a DorkOS global install or a Claude Code install can serve
   several projects from one legacy file; deleting it after one project migrates would strip
   the others. Once a project has its own `config.json` the old files are never read for it.
2. ~~Should the `/flow` guard migrate automatically or ask?~~ (RESOLVED, revised in review)
   **Answer:** Automatically only when the old plugin folder is inside this project; otherwise
   ask first. **Rationale:** the first draft always copied, and review showed the cost: under a
   shared install (Claude Code's cache, `--plugin-dir`, a DorkOS user-scope install) the old
   folder holds whichever project last ran `/flow:init`, so project B would be handed project
   A's settings and token and told to commit them, and every later project would inherit them
   too. A folder inside the project can only be that project's. Anywhere else a person
   confirms, and the `MIGRATED_TO` marker stops the next project from inheriting them.
3. ~~Where do new files go in a linked worktree?~~ (RESOLVED in review)
   **Answer:** `config.json` next to the one in use, else the current checkout;
   `config.local.json` next to the one in use, else the main checkout; a `.gitignore` in both.
   **Rationale:** the first draft wrote both to the main checkout while `resolve` read the
   worktree's own `config.json` first, and left the worktree's folder with no `.gitignore`, so a
   local file placed there by hand was not ignored.

## Related ADRs

- dorkos ADR 260923-163513, 260923-163515 (DOR-2245, draft). This repo keeps no `decisions/`
  log, so the decisions above are recorded here.

## References

- DOR-2274, DOR-2245, DOR-2246.
- Claude Code plugins reference, "Environment variables" and "Persistent data directory".
