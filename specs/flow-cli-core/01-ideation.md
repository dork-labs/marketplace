---
slug: flow-cli-core
issue: DOR-2367
created: 2026-09-26
status: ideation
builds-on: [flow-cli-overhaul, flow-fleet]
---

# flow CLI core, the shared account contracts, and one source of truth for work state

**Slug:** flow-cli-core
**Issues:** DOR-2367 (F1 CLI core), DOR-2368 (F2 accounts), DOR-2376 (F10 state truth), under umbrella DOR-2366
**Date:** 2026-09-26

The design is already written. This file only scopes spec unit S1 and points at it.

## Sources

- [`../flow-cli-overhaul/01-ideation.md`](../flow-cli-overhaul/01-ideation.md): step 1 (the `flow` CLI), step 4 (one source of truth for work state), step 5 (delete the prose each verb replaces).
- [`../flow-fleet/01-ideation.md`](../flow-fleet/01-ideation.md): §4.1 (account registry), §4.2 (usage ledger), §4.3 (session registry), §8 (operator decisions), §9 (the CLI is the plugin's `scripts/` behind one entry point).

## What S1 covers

- The `flow` entry point and its verbs: snapshot, next, claim, release, done, stage, audit, status, accounts.
- The code adapter behind the existing adapter contract, and the Linear one.
- The contracts DorkOS builds against in parallel: account identity and policy, the usage ledger file, the session↔item link.
- The F10 rule and its audit check.

## What S1 leaves to later units

- S2: `flow usage record|scan|probe`, the status-line hook, `flow fleet`.
- S3: account-aware dispatch, launchers, checkpoints, handoff, `flow drain --parallel`.
- S4/S5: the DorkOS server and UI side.
- S7: the wider prose trim.

## Decisions carried in

- Operator (flow-fleet §8, 2026-09-26): compliance risk accepted; registry home is the DorkOS config; handoff automatic by default; main account 50% reserve, drained last; the client's org account stays out.
- Operator (via the orchestrator, 2026-09-26): routing policy lives in flow's own `<dork-home>/flow/fleet.json`; DorkOS core owns identity, `color` and the ledger.
- Open questions from flow-cli-overhaul §6: 1 (runtime) and 3 (`stage/*` after TRIAGE) are resolved in the spec's Decisions; 2 (drain on DorkOS only) belongs to S3.
