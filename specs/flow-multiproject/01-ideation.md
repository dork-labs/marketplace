---
slug: flow-multiproject
created: 2026-09-28
status: ideation
builds-on: [flow-cli-core, flow-usage, flow-handoff-dispatch]
---

# Flow across many projects: the flow plugin's side

**Slug:** flow-multiproject
**Date:** 2026-09-28
**Companion:** the DorkOS core spec of the same slug, in the `dorkos` repo (`specs/flow-multiproject/`). It adds the extension-API seams this spec builds on. Core lands first; this spec follows it, contract-first.

The design is settled. This file only scopes the plugin's half and points at the sources.

## Sources

- [`design-decisions.md`](design-decisions.md): the operator's visual picks V1-V6 and the non-visual decisions N1-N10. Final; this spec does not reopen them.
- [`converged-design.md`](converged-design.md): the agreed experience (definitions, layers, surfaces, escalation rules, version skew).
- [`design/`](design/): the mockups (visual-companion fragments).

## The problem, in one paragraph

flow is installed in several repos on one computer, but the DorkOS app shows it as if there were one. The Flow tab mixes every project's runs into one list, shows accounts that already live on the account chip, pauses everything or nothing, and has no end time on a pause. Nothing tells you which project needs you, a broken tracker is silent, and a chat that works on several items shows none of them. Settings mix "this computer", "this repo, for everyone" and "this repo, just me" without saying which is which, and "Only for these repos" is flow's rule when it should be DorkOS's, because DorkOS picks the account.

## What this spec covers (the plugin)

- The Flow tab rebuilt as two lenses (project, all projects), following the chat's project, with the tab marker and "Set up flow here". The accounts section leaves the tab.
- Flow home, an extension page at `/x/flow` and `/x/flow/p/<name>`: three bands, a project filter in the URL, Pause all, and a minimal "Capacity this week" tab.
- Pause with a duration, per project and for all projects, in the engine, the routes, the slash command and the command palette.
- The run chip in the status bar, for one item and for several.
- Conditions (paused, can't reach the tracker, nothing ready) and their escalation to the Activity inbox, plus the two decision kinds flow raises: the review gate (👍 Looks good / 👎 Needs changes) and an agent's question (Answer).
- One `ProjectFlowSettings` component used by the per-project settings page and by Settings → Flow, with the shared and just-me boxes and the account checkboxes core enforces; the one-time move of "Only for these repos" into core.
- Multi-project data on the server (core's project registry plus flow's own discovery), per-project tracker health, and a version-skew line that shows only when behaviour differs.
- Graceful behaviour on a DorkOS without the new seams.

## What it leaves to the core spec

Every seam in N1's table, the inbox storage and kinds (N2), the approval flow for extensions (N3, DOR-2517), the project registry (N4), extension discovery across projects (N5), account eligibility and its enforcement (N6), and the session's list of tracker items (N9).

## Facts checked in this worktree (2026-09-28)

- flow's per-project settings live in `.agents/flow/config.json` (committed) and `.agents/flow/config.local.json` (this machine), named in `plugins/flow/scripts/config-names.ts`. The pause flag is `.agents/flow/paused.json` in the main checkout. The run store and journal live in `.dork/flow/`. The V6 mockup's `.dork/flow/config.json` is wrong; the spec uses the real path.
- A project's flow install is `<main checkout>/.dork/plugins/flow/`, with its version in `.claude-plugin/plugin.json`.
- Today's panel server enumerates projects with `discoverCheckouts` (`lib/panel.ts`) from `<dorkHome>/workspaces/*` plus the chat folders the panel was opened beside, and pauses by running `scripts/config-files.ts pause|resume --project <dir>` once per project.
- Pause is the presence of `paused.json`; it has `pausedAt` and `hostSchedules`, and no end time. `flow next`, `flow drain` and `flow claim` refuse to run while it exists (exit 7) unless `--manual`.
- The human-review gate is the REVIEW stage: VERIFY moves the item to `review`, assigns it to a person, and stops. No flow verb records a person's verdict today.
- An agent's question is an item labelled `agent/needs-input`; a non-empty reply comment is the answer (`scripts/drain/answer.ts`).
- The client extension API already has `registerCommand` and `registerDialog`; the palette commands need no new seam.
