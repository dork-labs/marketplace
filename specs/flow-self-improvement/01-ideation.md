---
slug: flow-self-improvement
issue: DOR-2390
created: 2026-09-26
status: ideation
---

# flow tests itself, keeps notes while it runs, and reviews them

**Slug:** flow-self-improvement
**Date:** 2026-09-26
**Issues:** DOR-2390 (F13), DOR-2391 (F14), DOR-2392 (F15), under DOR-2366 (project "Flow CLI & Account Fleet")

## 1) Intent

The operator, verbatim: "figure out how to test flow. Perhaps have some kind of /flow:self-test or
something like that, where flow can test and improve itself. It would also be nice if the flow
plugin could keep notes on its own performance while it's running, and those can be reviewed every
once in a while to help improve the plugin as well."

The 2026-09-25/26 session was a manual retro of flow
([`../flow-cli-overhaul/01-ideation.md`](../flow-cli-overhaul/01-ideation.md) §1). Each row of its
table is something a check, a journal or a retro should have caught on its own:

| Session finding                                          | What would have caught it                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| A helper hand-built `dispatch.ts` input wrong            | A journal `oracle.error` event, then a retro cluster              |
| Every worker rediscovered the `agent/ready`/`claimed` swap | A scenario run (claim on the fake tracker) and friction notes   |
| Worker, reviewer briefs and a PR watcher written by hand  | `workaround` notes ("improvised a script the plugin should ship") |
| Follow-ups sat unready with no path to ready              | A retro measure: ready vs untriaged, capture→ready days          |
| 43,000 words of prose, rules copied across files          | Doc lint: word ratchet and the duplicate-rule detector            |

## 2) What exists

- `engine-tests/`: 31 Vitest files over the oracles, run by the `flow plugin` CI job. Contributor
  only: shipped installs have `zod` and nothing else.
- `scripts/validate-adapter.ts` + `adapters/reference/fixtures/work-items.{good,bad}.json`: the
  five conformance invariants over normalized WorkItems.
- `scripts/validate-config.ts`, the generated `config/config.schema.json` (CI checks freshness).
- `.dork/flow/` holds run state (`flow-state.json`) and is gitignored in this repo.
- No fake tracker, no scenario tests across stages, no record of how a run went, no measure of
  flow's own health.
- DorkOS's `packages/evals` is the model for live evals: drive a real session, score what happened
  (files, rows, tool calls), never the prose; a paid path needs its own flag beside its own key.

## 3) Shape

Three features, all `flow` verbs on the CLI that S1 (`flow-cli-core`, `scripts/flow.ts`) defines:

1. **`flow selftest`** (and `/flow:self-test`): tier `fast` (static checks, seconds), tier
   `scenarios` (deterministic stage runs on an in-memory fake tracker), tier `live` (opt-in model
   evals, never in CI). `--file` files failures as tracker items.
2. **The journal**: `.dork/flow/journal.jsonl`, append-only, local, redacted. The CLI writes events
   itself; agents add friction notes with `flow note`.
3. **`flow retro`** plus a weekly `flow-retro` schedule (off by default): measures, clusters, and
   files deduped improvement items.

## 4) Decisions (full autonomy; each logged as an assumption in the spec)

See `02-specification.md` §Assumptions. Main ones: scenarios run in CI through Vitest as well as
from the verb; the word budget is a ratchet, not today's target; the journal lives in the main
checkout so every worktree writes one file; live evals need `FLOW_SELFTEST_LIVE=1` and refuse
under `CI`; the retro proposes, an agent edits, and filing is a separate explicit step.
