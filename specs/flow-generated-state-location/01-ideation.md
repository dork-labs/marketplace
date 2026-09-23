---
slug: flow-generated-state-location
issue: DOR-2285
created: 2026-09-23
status: ideation
---

# flow's generated adapter and its pause live in the project, so no plugin update can undo them

**Slug:** flow-generated-state-location
**Issue:** DOR-2285
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief:** DOR-2274 moved flow's settings out of the installed plugin. Two other things
  flow writes inside its plugin folder have the same defect:
  1. the tracker adapter `/flow:init` generates for a tracker flow does not ship, written to
     `<flow-root>/skills/<tracker>-adapter/`;
  2. `/flow:pause`, which edits `schedule.enabled` in the shipped
     `<flow-root>/skills/flow-drain/SKILL.md` (and `/flow:resume`, which edits it back).
  Move both to places the project owns, with a copy-only migration, following the rules
  DOR-2274 settled (`specs/flow-config-location/`).
- **Assumptions:**
  - A generated adapter is team code: the docs already say "commit the adapter as your code"
    (`docs/building-your-adapter.mdx`, "Commit the adapter as your code"; the install table in
    `docs/installing-in-your-project.mdx` marks it committed). The implementation drifted from
    that by writing it into the plugin.
  - A pause is one machine's operational decision about the autonomy running there, and it must
    take effect immediately, without a commit.
  - The DOR-2274 resolver (`scripts/config-files.ts`) is the one place that knows where flow's
    project files are; anything new that answers "where" belongs there.
- **Out of scope:**
  - The drain sentinel and run records under `.dork/flow/` (`auto-run.json`,
    `flow-state.json`). They are already in the project, not the plugin.
  - Changing how DorkOS schedules or approves a discovered task.
  - A tracker adapter being a runnable module (the P5 promotion); it stays a prose skill.

## 2) Pre-reading Log

- `specs/flow-config-location/01-ideation.md`, `02-specification.md`: project folder
  `.agents/flow/`, single resolver, copy-only migration, auto-move only for a plugin inside this
  project (else a person confirms), fail closed headless for unconfirmed shared legacy state,
  worktree rules (committed files beside the one in use or in the current checkout; local files
  in the main checkout, ignored there through `info/exclude`), `MIGRATED_TO` / `DECLINED_BY`
  markers in the old folder.
- `plugins/flow/scripts/config-files.ts`: `findConfigRoots`, `legacyConfigDirs` (own `config/`,
  then Claude Code cache siblings newest first), `resolveConfigFiles`, `prepareConfigDirs`,
  `placeFile` (temp + hard link, never overwrites, reads back), `migrateConfig`, CLI
  `resolve|migrate|prepare`.
- Adapter path readers: `commands/{flow,capture,triage,ideate,specify,groom,status}.md` name
  `${CLAUDE_PLUGIN_ROOT}/skills/<tracker>-adapter/SKILL.md`; `skills/initializing-flow` Step 3
  and `skills/building-adapters` Step 3 write there; `config/CONFIG.md`, `README.md`,
  `docs/SPEC.md`, `docs/how-it-works.mdx`, `scripts/config-schema.ts` (the `tracker` doc and
  its error message) and several `@see` lines in `scripts/*.ts` name it.
  `engine-tests/tracker-confinement.test.ts` (F1) pins the command wording.
- Stage skills say only "Read the adapter skill's contract before acting" and "via the
  adapter"; they rely on the harness having the adapter loaded as a skill (`flow__linear-adapter`)
  or on the command that sent them naming the path.
- Pause readers: `commands/{pause,resume,flow}.md`, `skills/flow-drain/SKILL.md`,
  `skills/flow-groom/SKILL.md` (claims pause switches it off too, though `pause.md` never
  touches it), `docs/{the-dials,turning-on-autonomy,bring-your-own-scheduler}.mdx`, `README.md`.
- DorkOS (dorkos repo, `main`):
  - Schedule discovery watches only `<dorkHome>/skills/` and `<project>/.agents/skills/`, one
    level deep; a plugin skill is found through its `flow__<name>` symlink
    (`apps/server/src/services/tasks/skills-roots.ts:39-54`).
  - A discovered schedule is a database row; it fires only when `enabled && status ===
    'active'` (`task-scheduler-service.ts:520`). A new file parks at `pending_approval`
    whatever its `enabled` says. The Approve button sends `{status, enabled: true}`
    (`task-file-update.ts:103-106`).
  - **For a file inside an installed package (flow is one), once the row is approved the row
    owns `enabled` and the file's value is ignored** (`file-sync-gates.ts:122-165`,
    `keepsRowEnabled`; `task-store.ts:1262-1268`). The approval key covers prompt and cron only,
    so an edit to `enabled` alone never re-parks it.
  - The row's switch can be flipped from the Schedules page (`PATCH /api/tasks/:id`, `enabled`
    is the one field allowed on a package-owned row, `task-file-update.ts:176`) and survives
    package updates while prompt and cron are unchanged.
  - No schedule field reads project state (`packages/skills/src/schedule-schema.ts:98-239`).
  - Harness Sync reads authored skills from `.agents/skills/*` and plugin skills from
    `<plugin>/skills/*`, and links every plugin skill folder as `flow__<name>`
    (`packages/harness/src/sources/installed.ts:594-614`,
    `plan/installed-projector.ts:519-620`). An adopter-added `<flow-root>/skills/jira-adapter/`
    is therefore projected as `flow__jira-adapter`. Nothing reads `.agents/` other than
    `.agents/skills` (and the manifest check in `apply/gitignore.ts:725-731`). Claude Code reads
    `.claude/skills`, never `.agents/` (`packages/harness/src/vendor-facts/index.ts:76-127`).
  - A DorkOS update today is uninstall + install, keeping only `.dork/data/` and
    `.dork/secrets.json` (`services/marketplace/flows/update.ts:9, 82`), so a generated adapter
    inside the plugin is lost there too. Draft ADR 260923-163513 (DOR-2245, unmerged) would keep
    it, and would replace a shipped file a person edited, saving theirs as `*.dork-old`; that
    is exactly what `/flow:pause`'s edit makes of `flow-drain/SKILL.md`.

## 3) Codebase Map

- **Primary:** `scripts/config-files.ts` (adapter resolution, adapter migration, the pause flag),
  `commands/{flow,pause,resume,status}.md`, `skills/flow-drain`, `skills/flow-groom`,
  `skills/initializing-flow`, `skills/building-adapters`.
- **Adapter-path readers:** the seven commands above, every stage skill's "read the adapter"
  line, docs, `config-schema.ts`, `@see` lines.
- **Tests:** `engine-tests/config-files.test.ts` (new cases), `tracker-confinement.test.ts` (F1
  wording), `config-schema.test.ts` (tracker slug comments).
- **Blast radius:** every non-Linear flow install on update (adapter), and every install that
  uses `/flow:pause` (which today does nothing to an approved DorkOS schedule).

## 4) Root Cause Analysis

- **Adapter.** Repro: `/flow:init` with a Jira tracker under Claude Code, then update flow. The
  new version folder has no `skills/jira-adapter/`; every command points at a file that does not
  exist. Under DorkOS `main` the reinstall deletes it the same way. Root cause: user-owned code
  written into a folder the host owns and replaces.
- **Pause.** The issue says an update "silently re-enables a paused tick". The code says
  something worse, and different: the shipped file ships `enabled: false`, so an update resets
  a paused file to paused. But on current DorkOS the file's `enabled` does not matter once the
  schedule is approved, which is the only time it fires: the row owns the switch
  (`keepsRowEnabled`). So `/flow:pause` never stops an approved Pulse tick at all. Under Claude
  Code nothing reads the flag (the person's own scheduler runs `/flow continue`). And under the
  DOR-2245 ownership rules the edit turns into an update conflict. Root cause: the pause is
  stored in a shipped file that the one scheduler that reads it no longer consults, instead of
  in state the tick itself checks.

## 5) Research

### Where a generated adapter lives

1. **Stay in `<flow-root>/skills/`.** Lost on every Claude Code update and every DorkOS reinstall
   today. Rejected.
2. **`.agents/skills/<tracker>-adapter/`** (a real skills root). Survives, and harnesses would
   load it. But DorkOS Harness Sync treats `.agents/skills/*` as the person's own authored skills
   and projects them to every enabled harness, and a harness would then auto-load a
   tracker-writing skill outside any `/flow` run. It is also no longer beside flow's other
   project files. Rejected.
3. **`.agents/flow/adapters/<tracker>/SKILL.md`**, committed. Beside `config.json`, found by the
   same resolver, invisible to every scanner (nothing reads `.agents/` other than
   `.agents/skills`, and Claude Code never reads `.agents/`), so it is loaded only when flow
   reads it by path. **Recommended.** Cost: the adapter is no longer a harness skill, so every
   place that used to lean on the harness having it loaded must name the path. The resolver
   prints it; commands and stage skills read it from there.

### Resolution order for the adapter

Project (`<checkout>/.agents/flow/adapters/<tracker>/`, then the main checkout's) → shipped
(`<flow-root>/skills/<tracker>-adapter/` for a tracker flow ships: `linear`) → legacy
(`<flow-root>/skills/<tracker>-adapter/` for any other tracker, then the same folder in a Claude
Code cache sibling, newest first) → none. A project adapter may override a shipped one on
purpose. Legacy follows DOR-2274: shared unless the plugin is inside this project; shared legacy
is used only after a person confirms, headless runs fail closed; markers in the old adapter
folder.

### How a pause survives

1. **Keep editing the shipped file, re-apply after an update.** Does nothing to an approved
   DorkOS schedule (the row owns the switch), nothing under Claude Code, and becomes a
   `*.dork-old` conflict under DOR-2245. Rejected.
2. **Flip the DorkOS row from flow** (`PATCH /api/tasks/:id`). Works on DorkOS and survives
   updates, but flow would call a host API, need the server's address and credentials, and
   still do nothing for any other scheduler. Rejected as the mechanism; kept as advice (the
   Schedules page switch is how a person stops the tick from starting at all).
3. **A project pause flag every autonomous entry point checks first.** `.agents/flow/paused.json`,
   ignored by git, in the main checkout (like `config.local.json`, so every worktree and the
   scheduler's checkout see one flag). The drain and groom ticks, `/flow continue` and
   `/flow auto` stop when it is there. Works under every scheduler, survives every update,
   takes effect at once. Cost: a scheduler that fires while paused still starts a session, which
   ends at its first step. **Recommended.**

Committed vs ignored: a committed flag would reach CI schedulers and teammates, but only after a
commit and merge, which is the wrong latency for "stop now", and a paused branch merged by
mistake would silently stop everyone's autonomy. Ignored, per machine. A CI scheduler is paused
by switching off that CI job; the docs say so.

## 6) Decisions

| #   | Decision                            | Choice                                                                                                     | Rationale                                                                                             |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Where a generated adapter lives     | `<project>/.agents/flow/adapters/<tracker>/SKILL.md`, committed, beside the `config.json` in use           | Team code, per project, host-independent, invisible to skill scanners.                               |
| 2   | Adapter resolution                  | project → shipped (`linear`) → legacy (own plugin, then cache siblings) → none                             | A project adapter wins, shipped ones need no copy, legacy keeps old installs working until moved.    |
| 3   | Who knows the adapter path          | `config-files.ts resolve` prints `adapter.path` and `flowRoot`; commands and stage skills read it there     | One resolver, as DOR-2274 decided; nothing leans on the harness having the adapter loaded.            |
| 4   | Adapter migration                   | Part of `config-files.ts migrate`: copy-only, whole folder, same confirmation as settings, but no `MIGRATED_TO` lock (revised in review) | One question covers both; an adapter has no credentials and may serve several projects.              |
| 5   | Durable pause                       | `.agents/flow/paused.json` in the main checkout, ignored by git; `config-files.ts pause` / `resume`         | Survives updates, visible from every worktree, effective under every scheduler.                       |
| 6   | Who honours it                      | flow-drain, flow-groom and tending-tracker ticks (first step), `/flow continue`, `/flow auto` (start and each iteration) | Every autonomous entry point; manual stage commands stay available while paused.                     |
| 7   | The shipped `schedule.enabled`      | Never edited by flow again; it stays the package default (`false`). On DorkOS, `/flow:pause` switches the project's schedule rows through DorkOS's `tasks_update` tool when available (revised in review) | Editing the file does nothing on an approved DorkOS schedule; the row is the real switch.            |
| 8   | Legacy pause                        | Nothing to migrate                                                                                         | The shipped default is already `false`, so an edited file is indistinguishable from an untouched one. |
