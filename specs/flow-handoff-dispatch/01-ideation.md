---
slug: flow-handoff-dispatch
issue: DOR-2373
created: 2026-09-26
status: ideation
builds-on: [flow-cli-overhaul, flow-fleet, flow-cli-core]
---

# Checkpoints, launchers, account-aware dispatch, a parallel drain with its review loop, and handoff on a limit

**Slug:** flow-handoff-dispatch
**Issues:** DOR-2371 (F5 checkpoints), DOR-2372 (F6 launchers), DOR-2373 (F7 dispatch, `flow drain --parallel`, `flow watch`), DOR-2374 (F8 auto-handoff), under umbrella DOR-2366
**Date:** 2026-09-26

The design is already written. This file only scopes spec unit S3 and points at it.

## Sources

- [`../flow-fleet/01-ideation.md`](../flow-fleet/01-ideation.md): §4.4 (dispatch), §4.5 (launchers), §4.6 (handoff by checkpoint), §4.7 (who runs the loop), §5 (gaps: 5-hour window, per-model limits, load caps, proactive checkpoints), §8 (operator decisions).
- [`../flow-cli-overhaul/01-ideation.md`](../flow-cli-overhaul/01-ideation.md): step 2 (`flow drain --parallel N`, the built-in review loop, `flow watch`).
- [`../flow-cli-core/02-specification.md`](../flow-cli-core/02-specification.md) §1 (S1): the binding contracts this unit consumes: account identity, the `fleet.json` policy (roles `main | rotation | kept-out`, unlisted = kept-out, main reserve 50% drained last inside a 24 h spend-down window, `handoff: auto | ask`), the usage ledger with `readWindow`, `fiveHourRoom` and `weeklyRoom`, and `FlowRun.account` + `FlowRun.host`.
- The hand-run recipe it turns into code: `plugins/flow/docs/parallel-drain.mdx` and `plugins/flow/templates/drain/` (worker brief, reviewer brief, `watch.sh`), shipped in #52.
- DorkOS spec `claude-account-fleet` (S4, dorkos repo, in flight): the `session_start` MCP tool and a session's `limit`. Today's `POST /api/sessions/:id/messages` already takes `account`, `cwd`, `runtime` and `seedContext`.

## Facts that shape it

- Subagents run on their parent's account, so work on another account needs a top-level session. A launcher starts one.
- A transcript cannot move between accounts reliably, so handoff is by checkpoint: a new session on the new account reads `HANDOFF.md` in the same worktree.
- Limits reach flow three ways: the ledger (every host writes it; S2 and S4 specify the writers), the SDK's `rate_limit_event` (`allowed | allowed_warning | rejected`) in a headless session's stream, and the transcript's `rate_limit` error.
- The 2026-09-25 drain reached a machine load near 500 and timed out tests. Launches need a load cap.

## What S3 covers

- `HANDOFF.md`: its schema, `flow checkpoint`, and the three moments it is written.
- One `Launcher` interface with DorkOS, cmux and plain-CLI implementations and one contract test suite.
- Dispatch scoring as a pure function; `flow next` picks the account as well as the item.
- `flow drain --parallel N`: worker, reviewer at the pushed SHA, fix loop, PR only on CLEAN, watch, DONE.
- `flow watch`, replacing `watch.sh`.
- The handoff state machine (warning, rejected, auto and ask) and `flow handoff`.

## What S3 leaves to other units

- Writing the ledger from the status line and transcripts, and `flow fleet` (S2). S3 reads the ledger through S1's module and writes only the observations its own headless sessions stream.
- The DorkOS server side: `session_start`, the session `limit`, the `account.limited` notification, a server-side dispatcher that reacts to events at once (S4).
- Any UI (S5, S6).

## Decisions carried in

- Operator (flow-fleet §8, 2026-09-26): handoff automatic by default with `handoff: ask`; main account 50% reserve, drained last; the org account stays out; transcript migration is never automatic.
- flow-cli-overhaul §6 open question 2 ("should the parallel drain require DorkOS?"): **no**. It runs under all three launchers (spec Decision D1).
