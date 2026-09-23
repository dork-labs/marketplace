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
- `projectDir` (where new files are written) = `<mainCheckout ?? checkout>/.agents/flow`. The
  main checkout is the project's home: an ignored file written in a worktree would be invisible
  from the main checkout and every other worktree.

The pair of files is chosen as a unit, first match wins:

1. **project**: `<checkout>/.agents/flow/config.json`, else `<mainCheckout>/.agents/flow/config.json`.
   `config.local.json` is then looked up the same way (checkout, then main checkout), independently,
   and may be absent. Legacy files are never consulted once the project has a `config.json`.
2. **legacy**: the first of these directories that holds a `config.json`; `config.local.json` is
   taken from the same directory or is absent (never mixed across directories):
   1. `<flow-root>/config/` (DorkOS installs, `--plugin-dir`, a local-directory marketplace).
   2. When `<flow-root>` is `…/plugins/cache/<marketplace>/<plugin>/<version>` (Claude Code's
      documented cache layout), each sibling version directory's `config/`, newest
      `config.json` modification time first. This is how the upgrade to this very version finds
      settings the previous version wrote.
3. **none**: not configured. `/flow` routes to `/flow:init`, as today. Per-field schema defaults
   still apply to any `config.json` that exists; a missing file is not "all defaults", because
   defaults cannot name a tracker team.

### `scripts/config-files.ts`

Pure core plus a thin CLI, in the shape of the other oracle scripts.

```ts
export const PROJECT_CONFIG_DIR = '.agents/flow';
export const CONFIG_FILE = 'config.json';
export const LOCAL_CONFIG_FILE = 'config.local.json';
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/dork-labs/marketplace/main/plugins/flow/config/config.schema.json';

export interface ConfigRoots { checkout: string; mainCheckout: string | null; pluginRoot: string }
export type ConfigOrigin = 'project' | 'legacy' | 'none';
export interface ConfigFiles {
  origin: ConfigOrigin;
  committed: string | null;   // absolute path of the config.json in use
  local: string | null;       // absolute path of the config.local.json in use
  projectDir: string;         // where the project's files live / will be written
}

export function findConfigRoots(cwd: string, pluginRoot: string): ConfigRoots;
export function legacyConfigDirs(pluginRoot: string): string[];
export function resolveConfigFiles(roots: ConfigRoots): ConfigFiles;
export function prepareProjectDir(projectDir: string): PrepareResult;
export function migrateConfig(roots: ConfigRoots): MigrationResult;
```

CLI: `node --experimental-strip-types "<flow-root>/scripts/config-files.ts" [resolve|migrate|prepare] [--project <dir>]`.

- **`resolve`** (default). Prints
  `{ ok, origin, committed, local, projectDir, errors, warnings }` and exits `0` when `ok`.
  `ok` is true when a `config.json` was found, parses, and passes `validateConfig` (warnings
  allowed). `errors`/`warnings` are `validate-config`'s `{ path, message }` issues for the
  committed file; unreadable JSON is one error at `(root)`. Two more warnings:
  - origin `legacy`: "settings are still inside the flow plugin at <dir>; run `migrate`".
  - the project's `config.json` is ignored by git: "team settings in <path> are ignored by git,
    so they are not shared" (the file still works).
- **`migrate`**. Idempotent, copy-only. Prints
  `{ ok, migrated, from, wrote, unchanged, leftInPlace, reason }`; exit `0` unless `ok` is false.
  - origin `project` → `migrated: false`, reason "already in the project". origin `none` →
    `migrated: false`, reason "nothing to migrate".
  - origin `legacy`: the committed file must parse as JSON, or the migration stops with
    `ok: false` and writes nothing.
  - `config.local.json` first, when the legacy directory has one: `prepare`, then copy the bytes
    exactly, owner-only permissions (`0o600`), written to a temporary file in the same directory
    and hard-linked into place so an existing file is never overwritten. The copy is verified by
    reading it back and comparing bytes.
  - `config.json` last, because its presence is what makes the project the source. Content is
    the legacy object with any `$schema` that is not a URL replaced by `CONFIG_SCHEMA_URL` (a relative path
    to the plugin cannot work from the project, and an absolute one would name one machine's
    cache in a committed file), serialised with two-space indent and a trailing newline. Same
    temp-and-link write; verified by parsing it back and comparing deeply.
  - A destination that already exists with the same content counts as `unchanged` (a re-run
    after a crash between the two writes finishes the job). One with different content stops
    the migration with `ok: false` naming both paths; nothing is overwritten.
  - The legacy files are **never deleted** and are listed in `leftInPlace`. Another project
    using the same install may still depend on them; once this project has its own
    `config.json` they are no longer read for it.
- **`prepare`**. Creates `projectDir`, ensures `projectDir/.gitignore` has a
  `config.local.json` line (creating the file, or appending the line), and when inside a git
  repo confirms with `git check-ignore` that `projectDir/config.local.json` is ignored. Prints
  `{ ok, projectDir, committed, local, gitignore }` with the target paths. `ok: false` (exit 1)
  when git would still track the local file (a negation rule elsewhere); nothing secret may be
  written then.

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

- Upgrading: the first `/flow` after the update says it copied the settings into
  `.agents/flow/`, names the files, and asks the person to commit `config.json` and
  `.gitignore` (never `config.local.json`, which is ignored). Nothing else changes.
- Fresh install: `/flow:init` writes into `.agents/flow/` and says so.
- Worktrees: a new worktree finds the main checkout's files; nothing to copy.
- Conflict: if `.agents/flow/config.local.json` already exists with different content, flow
  stops the migration, names both files, and keeps reading the legacy pair until the person
  resolves it.

## Testing Strategy

`engine-tests/config-files.test.ts`, real temporary directories and real `git`:

- resolve: project beats legacy; checkout beats main checkout; a worktree finds the main
  checkout's local file; legacy own dir beats a cache sibling; newest sibling wins; a sibling is
  never consulted outside the cache layout; `local` never mixes directories; `none` when nothing.
- migrate: copies both files, local bytes identical and mode `0o600`, `$schema` rewritten (a URL kept),
  `.gitignore` written and effective; second run is a no-op; a crash-shaped state (local copied,
  committed not) completes; a differing destination stops with nothing overwritten; invalid legacy
  JSON writes nothing; legacy files still exist after; two projects migrating from one shared
  install each get their own copy.
- prepare: appends to an existing `.gitignore` without duplicating; `ok: false` when a negation
  rule keeps the file tracked.
- CLI: `resolve` exit codes and warnings (legacy, ignored committed file, secrets block, invalid
  JSON); `migrate` output shape.

Each test carries a purpose comment; the critical lines (never-overwrite, write order, ignore
check, sibling ordering) are mutation-checked.

## Performance Considerations

Three to four `git` invocations per `/flow` start; negligible.

## Security Considerations

- The local file (tracker credentials) is written only after git is proven to ignore it, with
  owner-only permissions, and its content is never printed; the CLI prints paths only.
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
2. ~~Should the `/flow` guard migrate automatically or ask?~~ (RESOLVED)
   **Answer:** Automatically. **Rationale:** it is copy-only and idempotent, and for bare
   Claude Code the source is a cache directory Claude Code deletes after about 14 days; asking
   risks the window closing.

## Related ADRs

- dorkos ADR 260923-163513, 260923-163515 (DOR-2245, draft). This repo keeps no `decisions/`
  log, so the decisions above are recorded here.

## References

- DOR-2274, DOR-2245, DOR-2246.
- Claude Code plugins reference, "Environment variables" and "Persistent data directory".
