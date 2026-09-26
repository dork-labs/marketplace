---
slug: flow-usage
issue: DOR-2369
created: 2026-09-26
status: ideation
builds-on: [flow-fleet, flow-cli-core]
---

# flow usage and flow fleet: record each account's usage, and show every account and session on one screen

**Slug:** flow-usage
**Issues:** DOR-2369 (F3 usage ledger), DOR-2370 (F4 `flow fleet`), under umbrella DOR-2366
**Date:** 2026-09-26

The design is already written. This file only scopes spec unit S2 and points at it.

## Sources

- [`../flow-fleet/01-ideation.md`](../flow-fleet/01-ideation.md): §2 (what the official binary hands us), §3 (compliance), §4.2 (the usage ledger and its feeds), §4.3 (the session registry and `flow fleet`).
- [`../flow-cli-core/02-specification.md`](../flow-cli-core/02-specification.md) §1 (the shared contracts: account identity, fleet policy, the usage ledger, the session↔item link) and §2 (the `flow` entry point, flags, exit codes). S2 adds verbs on that entry point and writes through that ledger writer. It redefines neither.

## What S2 covers

- `flow usage record`: the status-line recorder, plus the two-line opt-in hook and `flow usage install-statusline`.
- `flow usage scan`: backfill limit hits from transcripts.
- `flow usage probe`: one tiny official turn on an account nobody has read yet.
- `flow fleet`: accounts with 5-hour and weekly bars and reset countdowns, and sessions with account, item, state and host, from Claude Code's session files, DorkOS's session list and flow's run records.

## What S2 leaves to later units

- S3: dispatch that uses these readings, launchers, checkpoints, handoff.
- S4: the DorkOS server writing the same ledger from SDK events, and the session-list fields `flow fleet` reads.
- S5/S6: any DorkOS UI.

## Facts checked on this machine (2026-09-26)

- Status-line JSON carries `rate_limits.five_hour` / `seven_day` as `{used_percentage, resets_at}` (epoch seconds) after the first response.
- 228 `"error":"rate_limit"` transcript entries across five config dirs. 173 of them also carry a structured `quotaLimits: {status:"rejected", resetsAt:<epoch s>, rateLimitType:"five_hour"|"seven_day"}`: every session or weekly hit written by 2.1.263 and later. 31 older hits (2.1.224, 2.1.231) carry only text: "You've hit your session limit · resets 3:30pm (America/Chicago)", "You've hit your weekly limit · resets Sep 18 at 3pm (America/Chicago)". 24 model-limit texts ("You've reached your Fable limit…") carry neither a window type nor a reset.
- `<dir>/sessions/<pid>.json` holds `{pid, sessionId, cwd, startedAt, procStart, status, kind, entrypoint, name, …}`; `status` seen: `busy`, `idle`, `shell`.
- Starting `node --experimental-strip-types` costs about 50 ms before any work, so the status line must never wait on it.
- Every account's status line is its own `bash <dir>/statusline-command.sh`, each capturing stdin with `input=$(cat)`.
- `claude --bare` never reads OAuth or the Keychain (API key only), so a probe must not use it.
