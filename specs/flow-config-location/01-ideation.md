---
slug: flow-config-location
issue: DOR-2274
created: 2026-09-23
status: ideation
---

# flow's settings live in the project, so no plugin update can erase them

**Slug:** flow-config-location
**Issue:** DOR-2274
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief:** flow keeps its per-project settings (`config.json`, `config.local.json`)
  inside the installed plugin, at `<flow-root>/config/`. DorkOS is making those files survive
  its own updates (DOR-2245), but a bare Claude Code install has no such rule: a copied plugin
  lives in `~/.claude/plugins/cache/<marketplace>/flow/<version>/`, and every update installs
  into a new version directory. The settings stay behind in the old one, which Claude Code
  sweeps after about 14 days. Move the settings somewhere every host keeps, with a one-time
  migration from the old place.
- **Assumptions:**
  - `config.json` is team policy meant to be committed with the project; `config.local.json`
    is one machine's secrets and overrides and must never be committed.
  - The same plugin install can serve several projects (a DorkOS global install, or a Claude
    Code user-scope install), each with its own tracker team.
  - The Bash tool does not receive `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` in its
    environment (Claude Code exports them only to hooks, MCP and LSP processes), so a script
    run from a skill has to find its files some other way.
- **Out of scope:**
  - Other state flow writes into its own plugin directory: the adapter `/flow:init` generates
    at `<flow-root>/skills/<tracker>-adapter/`, and the `schedule.enabled` edit `/flow:pause`
    makes in `<flow-root>/skills/flow-drain/SKILL.md`. Both have the same bare-Claude-Code
    problem. They are recorded as follow-ups, not folded in.
  - Loading and merging the config for the agent (a promoted config loader). Skills keep
    reading the two files and applying the documented precedence themselves; this change only
    decides, in one place, which two files those are.

## 2) Pre-reading Log

- `plugins/flow/config/CONFIG.md`: the triad (committed `config.json`, gitignored
  `config.local.json`, committed `config.local.example.json`) and the precedence
  `env > local > committed > schema defaults`. Its "Getting started" already says
  `.agents/flow/config.local.json`.
- `plugins/flow/README.md`: "v1 reads `.agents/flow/config.json` only" (the contract).
  `docs/the-dials.mdx`, `docs/how-it-works.mdx`, `docs/turning-on-autonomy.mdx` and
  `scripts/config-schema.ts` all name `.agents/flow/config.json` too. That path dates from
  when flow was vendored into the dorkos repo at `.agents/flow/`; since becoming a plugin it
  has been read from `<flow-root>/config/` while the docs kept the old name.
- `plugins/flow/commands/flow.md`: the first-run guard reads
  `${CLAUDE_PLUGIN_ROOT}/config/config.json` and pipes it through `validate-config.ts`.
- `plugins/flow/skills/initializing-flow/SKILL.md`: Step 1 detects and Step 4 writes both files
  under `<flow-root>/config/`; Step 4.3 greps the repo `.gitignore` for `config.local.json`.
- `plugins/flow/skills/executing-specs/SKILL.md`, `skills/verifying-work/SKILL.md`,
  `commands/pause.md`, `commands/resume.md`: read or edit `<flow-root>/config/config.json`.
- `plugins/flow/scripts/validate-config.ts`: dependency-free validator; reads a config from
  stdin or `--input`, reports unknown keys as warnings (DOR-2246).
- No shipped script reads a config file from disk today. Every read is prose an agent follows.
- dorkos ADR 260923-163515 (draft, DOR-2245): under DorkOS, `${CLAUDE_PLUGIN_DATA}` is
  `<installRoot>/.dork/data/`, one per install. It is rewritten inline in commands and hooks,
  exported to projected hooks, and **cannot be rewritten in a projected skill**.
- dorkos ADR 260923-163513 (draft, DOR-2245): files a package did not install survive update,
  reinstall and uninstall, so under DorkOS the legacy `<flow-root>/config/` files keep existing.
- Claude Code plugins reference: `${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`,
  one per plugin per user, survives updates, deleted on uninstall from the last scope unless
  `--keep-data`. `${CLAUDE_PLUGIN_ROOT}` for a copied plugin is a version directory in
  `~/.claude/plugins/cache/`, which changes on update; the old one lingers about 14 days.
  Both are substituted inline in skill content and hook commands, exported to hook/MCP/LSP
  processes, and **not** substituted in Bash tool commands.
- dorkos `packages/harness/src/apply/gitignore.ts`: some teams ignore `.agents/` wholesale
  (`canonicalLayerIgnoredBy`); DorkOS treats that as legal but worth saying.

## 3) Codebase Map

- **Primary components:** `plugins/flow/scripts/` (new resolver), `commands/flow.md`
  (first-run guard), `skills/initializing-flow/SKILL.md` (detect + write),
  `config/CONFIG.md` (the documented contract).
- **Readers of a config path in prose:** `commands/{flow,pause,resume,init}.md`,
  `skills/{executing-specs,verifying-work,initializing-flow}/SKILL.md`, adapter skills
  (name `config.local.json` without a path), docs pages.
- **Tests that read a config from the plugin dir:** `engine-tests/config-schema.test.ts`,
  `stage-projection.test.ts`, `scripts-cli.test.ts` (each falls back from a host's
  `config/config.json` to `config.example.json`).
- **Blast radius:** every flow install on upgrade. Under DorkOS the legacy files still exist, so
  a failed or skipped migration degrades to today's behaviour. Under bare Claude Code the
  upgrade to this version is itself the update that strands the settings, so the migration
  must find the previous version directory.

## 4) Root Cause Analysis

- **Repro:** install flow from a Claude Code marketplace, run `/flow:init`, update the plugin.
  `/flow` routes back to `/flow:init`.
- **Observed vs expected:** settings written by `/flow:init` vanish on update; expected to be kept.
- **Evidence:** `/flow:init` writes into `<flow-root>/config/`; Claude Code's plugin root for a
  copied plugin is per version.
- **Root cause:** user state is stored inside a directory the host owns and replaces. The
  package manager is not wrong to replace it; flow is wrong to write there.

## 5) Research

Candidate homes, per file:

1. **`${CLAUDE_PLUGIN_DATA}` for both.** Survives updates in both hosts. But in Claude Code it is
   one directory per user, so two projects with different tracker teams collide; team policy
   there cannot be committed; a script run through the Bash tool cannot see the variable; and a
   DorkOS-projected skill cannot have it rewritten. Rejected.
2. **Committed file in the project, local file in `${CLAUDE_PLUGIN_DATA}`.** Fixes policy, but
   the local half keeps the per-user collision (two projects, two Linear teams, one file) and
   the Bash-tool visibility problem. It also resolves to different places under DorkOS and
   Claude Code, so a person cannot say where their secrets are. Rejected.
3. **Both in the project: `.agents/flow/config.json` (committed) and
   `.agents/flow/config.local.json` (ignored by a `.agents/flow/.gitignore` flow writes).**
   Per project, per machine, same path under every host (DorkOS, Claude Code, Codex, OpenCode),
   findable from the Bash tool by the project root alone, and the committed half is the path
   the README and docs already promise. The one gap is git worktrees: an ignored file does not
   exist in a new worktree, so the resolver also looks in the main checkout. **Recommended.**

## 6) Decisions

| #   | Decision                              | Choice                                                                                              | Rationale                                                                                                                                                 |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where committed policy lives          | `<project>/.agents/flow/config.json`                                                                | Committable, per project, host-independent; the documented contract.                                                                                     |
| 2   | Where per-machine local lives         | `<project>/.agents/flow/config.local.json`, ignored by `.agents/flow/.gitignore`                    | Per project and per machine, which `${CLAUDE_PLUGIN_DATA}` is not in Claude Code; visible to scripts; the self-contained ignore needs no root edit.      |
| 3   | Worktrees                             | Look in the current checkout, then the main checkout; write `config.json` to the current checkout and the local file to the main checkout (revised in review, see the spec)                                               | An ignored file never reaches a new worktree; the main checkout is the project's home.                                                                   |
| 4   | One resolver                          | `scripts/config-files.ts`: a dependency-free module + CLI every command and skill calls           | Single source for "which two files"; runs before `npm install`.                                                                                          |
| 5   | Legacy fallback                       | Read `<flow-root>/config/`, then a sibling version directory when flow sits in Claude Code's cache | Nothing breaks if migration has not run; the sibling search is the only way a bare-Claude-Code upgrade to this version can find the settings it left behind. |
| 6   | Migration                             | At the `/flow` first-run guard and `/flow:init`, copy-only, never deletes; automatic only for a plugin folder inside the project, confirmed by a person otherwise, with a `MIGRATED_TO` marker (revised in review, see the spec) the old files | A shared install may still serve another project from the old file; copying is idempotent and safe to repeat.                                            |
| 7   | A missing `config.json` everywhere    | Still "not configured" (route to `/flow:init`), not "run on defaults"                             | Defaults cannot name a tracker team; per-field defaults still apply to a file that exists.                                                               |
