---
slug: flow-usage
issue: DOR-2369
created: 2026-09-26
status: specified
---

# flow records each account's usage from what Claude Code already shows, and `flow fleet` puts every account and session on one screen

**Status:** Approved
**Issues:** DOR-2369 (F3 usage ledger), DOR-2370 (F4 `flow fleet`), DOR-2399 (every runtime, Amendment 1)
**Date:** 2026-09-26
**Input:** [`01-ideation.md`](./01-ideation.md)

## Overview

- `flow usage record` reads the status-line JSON Claude Code hands a status-line script and writes the 5-hour and weekly readings to the shared usage ledger. A two-line, opt-in addition to the status-line script calls it in the background, so the status line never waits.
- `flow usage install-statusline` adds those two lines for each registered account. It changes nothing without `--yes`.
- `flow usage scan` backfills limit hits from transcripts. Running it twice changes nothing.
- `flow usage probe <id>` runs one tiny official Claude Code turn on an account nobody has read yet. It runs nothing without `--yes`.
- `flow fleet` shows every account (5-hour and weekly bars, reset countdowns, role) and every session (account, item, state, host) on one screen. It only reads.

S2 builds on spec unit S1 ([`flow-cli-core`](../flow-cli-core/02-specification.md)). It adds verbs to S1's entry point (§2 there) and writes only through S1's ledger writer (§1.2 there). It changes no shared contract: `CONTRACT_VERSION` stays `1.0.0`.

## Background / Problem Statement

- Today the operator's usage is scraped off the terminal screen, reset times are typed in by hand, and one account's usage is never read ([flow-fleet §1](../flow-fleet/01-ideation.md)).
- The status line already receives `rate_limits.five_hour` and `seven_day` with `used_percentage` and `resets_at`, then throws them away after rendering.
- Transcripts already record every limit hit, structured, with the reset time. Nothing reads them.
- Nothing shows which session is on which account, serving which item, from which host.

## Goals

- Every interactive session feeds its account's ledger with both windows and their reset times, at no visible cost to the status line.
- Past limit hits are recovered from transcripts, safely re-runnable.
- An account nobody has read can be read on request through the official binary, with the cost stated first.
- One read-only screen answers: how much room each account has, when it comes back, and what each session is doing for which item.
- Every reading comes from data the official binary hands us (flow-fleet §3).

## Non-Goals

- Choosing an account for work (dispatch), launchers, checkpoints, handoff (S3).
- DorkOS writing the ledger from SDK events, and the session-list fields `flow fleet` reads from DorkOS (S4: DOR-2380, DOR-2385, DOR-2386).
- Any DorkOS UI (S5, S6).
- A `--watch` mode for `flow fleet` (S3 owns long-running loops).
- Reading accounts that are not registered (S1 `flow accounts add` registers them).
- Reading usage without a model turn from the CLI. The SDK's usage call needs a live SDK process; DorkOS offers it (S4 D3).

## Technical Dependencies

- S1 merged: `scripts/flow.ts` (task 1.5), `scripts/atomic-json.ts`, `scripts/fleet/accounts.ts`, `scripts/fleet/usage-ledger.ts` (task 1.1), `scripts/flow-state-file.ts` (task 1.4).
- Node ≥ 22.6 with `--experimental-strip-types`, as S1.
- No new npm packages. The S2 modules import no npm package at all (see §3.1): `record` runs where `zod` was never installed.
- `/bin/bash` 3.2 or later for the hook (macOS ships 3.2).
- Claude Code ≥ 2.1.263 for structured transcript hits (older ones fall back to the text, §2.4).
- For DorkOS rows in `flow fleet`: a DorkOS release carrying S4's D7 and D8 (`status`, `accountId`, `trackerItem` on `GET /api/sessions`). Before it, DorkOS contributes no rows and `flow fleet` says so (§2.6).

## Detailed Design

### 1. What S2 adds and what it reuses

| S2 piece                        | Reuses from S1                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `usage record`, `scan`, `probe` | `mergeLedger` + the §1.2 lock-and-rename writer, the id pattern                                                                 |
| account lookup                  | `readIdentities` (§1.1a), `dorkHome` resolution                                                                                 |
| `fleet`                         | `readIdentities`, `readFleetPolicy`, `readWindow`, `effectiveReservePct`, `fiveHourRoom`, `weeklyRoom`, the FlowRun file reader |
| every verb                      | `main(argv, deps)`, common flags, exit codes, JSON envelope                                                                     |

Source mapping is the contract table (S1 §1.2 "Mapping each source"), unchanged:

- The status line is `statusline`.
- A transcript hit is `transcript`.
- A probe's `rate_limit_event` is `sdk_event`: the CLI's `stream-json` output carries the same event the SDK passes through.

### 2. The verbs

`flow usage` with no sub-verb, or an unknown one, prints the sub-verb list to stderr and exits 2.

#### 2.1 `flow usage record [--account <id>] [--verbose] [--json]`

**Input.** The status-line JSON on stdin.

- Read at most 1 MiB. More than that: stop reading and record nothing.
- stdin is a TTY: print "pipe the status-line JSON in; see `flow usage --help`" to stderr, exit 2. (A status line never passes a TTY.)

**Which account.**

- `--account <id>`: that registered id.
- Otherwise the config dir: `CLAUDE_CONFIG_DIR` when set and non-empty, else `<os home>/.claude`.
- `accountForConfigDir(identities, dir)`: expand a leading `~`, `path.resolve`, drop a trailing separator, then compare `fs.realpathSync.native` of both sides (falling back to the resolved path when realpath fails). The first match in registry order wins.
- A row whose id fails the id pattern never matches (it has no usage file, S1 §1.1a).
- No match: record nothing, exit 0. An unregistered account is not flow's to track.

**Observations** (`fromStatusLine(payload, now)`, pure).

- For each key of `payload.rate_limits` that matches the contract window-key pattern `^[a-z][a-z0-9_]*$` and holds an object with a finite number `used_percentage`, emit one observation:

| Field        | Value                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `usedPct`    | `used_percentage` clamped to 0–100                                                                             |
| `resetsAt`   | `resets_at` as epoch seconds (a number) or an ISO string, converted to ISO UTC; missing or unparsable → `null` |
| `status`     | `null`                                                                                                         |
| `observedAt` | `now` (the payload has no timestamp; the status line renders what the binary knows at that moment)             |
| `source`     | `"statusline"`                                                                                                 |

- A window without a numeric `used_percentage` is skipped: the contract needs `usedPct` or `status`, and the status line gives no status.
- No `rate_limits`, no valid window, or unparsable JSON: record nothing, exit 0.

**Writing.**

- One call to S1's ledger writer with all observations. It merges under the lock and gives up after 2 s without throwing (S1 §1.2 step 3).
- A watchdog exits the process with 0 after 3 s, whatever it is doing. A killed writer leaves at worst a stale lock (broken after 10 s) and never a torn file (rename is atomic).

**The dedupe stamp.** When the hook (§2.2) sets `FLOW_USAGE_STAMP` and `FLOW_USAGE_FP`:

- Write `FLOW_USAGE_FP` + `\n` to `FLOW_USAGE_STAMP` (temp file + rename, mode `0600`) in exactly two cases:
  - **Nothing could be recorded:** no matching account, or a `rate_limits` with no valid window (for example `null`). Without this, an unregistered config dir would start Node on every render.
  - **A settled write with a faithful fingerprint:** the writer returned without giving up (changed or unchanged), **and** `JSON.parse(fp.slice(1) + "}}")` (the fingerprint without its leading `:`, closed again) deep-equals `payload.rate_limits`. A fingerprint the hook cut short, for example because a future window holds a nested object, fails that check and is never stamped, so it can never hide a change: that reading is recorded on every render instead.
- The stamp path is honored only when its parent is exactly `<dorkHome>/usage` and its basename starts with `.statusline-`. Otherwise it is ignored, so an environment variable can never make `record` write anywhere else.
- A write the writer dropped leaves the stamp alone, so the next render retries.

**Output.**

- Default mode: nothing on stdout, ever. stderr only with `--verbose`.
- Exit 0 in every case but the TTY and argv errors (2). The hook passes no flags.
- `--json`: `{ "v": 1, "ok": true, "account": "<id>" | null, "recorded": ["five_hour", …], "changed": true | false, "dropped": true | false }`. For people and tests; the hook never passes it.

#### 2.2 The status-line hook

**The helper** ships as `plugins/flow/scripts/usage/statusline-hook.sh` (mode 0755, bash 3.2-compatible, builtins only until the final `node`):

```bash
#!/bin/bash
# flow usage recorder. A status-line script runs this in the background.
# It prints nothing and always exits 0. See docs/account-usage.mdx.
IFS= read -r -d '' input || true
case $input in *'"rate_limits"'*) ;; *) exit 0 ;; esac
fp=${input#*'"rate_limits"'}; fp=${fp%%'}}'*}
dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
stamp=${DORK_HOME:-$HOME/.dork}/usage/.statusline-${dir//[^A-Za-z0-9]/_}
last=; [ -r "$stamp" ] && IFS= read -r last < "$stamp"
[ "$fp" = "$last" ] && exit 0
here=${BASH_SOURCE[0]%/*}
printf '%s' "$input" | FLOW_USAGE_FP="$fp" FLOW_USAGE_STAMP="$stamp" \
  "${FLOW_NODE:-node}" --experimental-strip-types "$here/../flow.ts" usage record >/dev/null 2>&1
exit 0
```

- **Dedupe.** The status line re-renders several times a second while a session streams. Starting Node each time would cost about 50 ms of CPU per render across every session. The fingerprint is the text of the `rate_limits` object up to its closing `}}`, so Node starts only when a reading changed.
- **The fingerprint errs toward recording.**
  - JSON with whitespace, a multi-line object or no `}}` makes the fingerprint longer or unreadable as one line, so it never matches and the reading is recorded (merge makes a repeat harmless).
  - A fingerprint cut short inside `rate_limits` (a nested object in some future window) is never stamped, because `record` stamps only a fingerprint that parses back to the whole `rate_limits` object (§2.1).
  - It can only wrongly match when two config dirs sanitize to one stamp name (for example `/a/b` and `/a_b`) _and_ carry byte-identical `rate_limits`, reset times included. That costs one skipped reading equal to one already stored, and is accepted.
- **The stamp is written by `record`**, after a successful merge, not by the hook. A dropped write is retried on the next render.

**The two lines** added to a status-line script, right after the line that captures stdin (`<var>=$(cat)`):

```bash
# flow usage recorder (opt-in): records this account's usage for `flow fleet`. See <flow-root>/docs/account-usage.mdx
{ [ -x '<abs hook path>' ] && printf '%s' "$<var>" | FLOW_NODE='<abs node path>' '<abs hook path>'; } >/dev/null 2>&1 &
```

- `&` runs the whole group in the background, and the redirection covers the whole group, test included. Every stream of the background job goes to `/dev/null`, and a non-interactive shell gives a background job `/dev/null` as stdin. So the status-line script's own stdout reaches EOF as soon as the script ends, and Claude Code never waits for the recorder.
- The redirection must wrap the `[ -x … ] &&` test too. With `[ -x … ] && { …; } >/dev/null 2>&1 &`, the backgrounded subshell that runs the `&&` keeps the status line's stdout open until the recorder ends: a test with a 2 s recorder held the status line for 2.2 s under `/bin/bash` 3.2. The form above returned in under 30 ms under bash 3.2, zsh and sh.
- `[ -x … ]` keeps a moved or removed plugin silent.
- `FLOW_NODE` is the absolute Node that ran `install-statusline`. A status line's `PATH` may not include an nvm Node, and a bare `node` then fails silently. This was the DOR-2121 failure in the DorkOS repo's own hooks. When `FLOW_NODE` is unset (a hand-copied snippet), the hook falls back to `node` on `PATH`.
- If Claude Code kills the status-line process group while a recorder runs, the recorder dies mid-merge. The ledger is still whole (atomic rename), and the next render records again.

#### 2.3 `flow usage install-statusline [--account <id>] [--yes] [--remove] [--json]`

**Targets.** Every registered account with a valid id, or the one `--account` names (unknown id: exit 5).

**Finding the script.** For each target:

- Read `<path>/settings.json`. It needs `statusLine.type` = `"command"` and a string `statusLine.command`.
- The command must be `<script>` or `bash|sh|zsh <script>`, where `<script>` may be single- or double-quoted and may start with `~/`, `$HOME/` or `${HOME}/`. That is expanded, and it must be an existing regular file.
- The script must contain a stdin-capture line matching `^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=["']?\$\(cat\)["']?\s*(#.*)?$`. The first match gives `<var>`.
- Anything else is `manual`: print the two lines with a placeholder variable and the reason (no status line, inline command, not a file, no capture line).

**Planning.**

- The block = the marker comment (starts with `# flow usage recorder`) plus the hook line directly after it.
- Block absent → `insert` after the capture line. Block present and identical → `none`. Block present with other paths → `update` in place. `--remove` with block present → `remove`; absent → `none`.
- The hook path is the realpath of `<flowRoot>/scripts/usage/statusline-hook.sh`. The Node path is `process.execPath`.
- Either path containing `'` or a newline: exit 5 (it cannot be single-quoted safely).
- The hook file is not executable: exit 5 naming it.

**Applying.**

- Without `--yes`: print each account's plan (script, action, line number, the exact lines) and write nothing. Exit 0 (5 if any target is `manual`).
- With `--yes`: for each `insert`, `update` or `remove`:
  - Copy the script to `<script>.flow-backup-<epoch ms>`.
  - Write the new text to a temp file in the same folder with the original mode, then rename it over the script.
  - Re-read it and confirm the block appears exactly once (or not at all after `remove`). A failed check restores the backup and exits 5.
- Nothing else in the script changes, byte for byte: line endings are kept and no trailing newline is added or removed.
- `settings.json` is never written.

**Output.**

- Human: one line per account. For example, `claude3  inserted after line 4 of /…/statusline-command.sh (backup: …)`.
- JSON: `{ v, accounts: [{ id, script | null, action: "insert"|"update"|"remove"|"none"|"manual", reason?, line?, lines?, applied, backup? }] }`.

#### 2.4 `flow usage scan [--account <id>] [--days <n> | --all] [--dry-run] [--json]`

**Files.**

- For each target account (all registered accounts with a valid id, or `--account`), walk `<path>/projects/` recursively for `*.jsonl`. Symlinks are not followed.
- Keep files whose mtime is within the last `--days` (default 8, one weekly window plus a day), or all of them with `--all`.
- A limit hit older than the weekly window can only read as expired or stale (S1 `readWindow`), so older files add nothing by default.

**Lines.**

- Stream each file line by line. Skip a line unless it contains the text `"rate_limit"`; only then `JSON.parse` it. Throughput is bound by disk reads.
- An entry is a hit when `isApiErrorMessage === true`, `error === "rate_limit"`, and `timestamp` parses. Anything else is ignored, including a user message that quotes the same text.
- An unparsable line or unreadable file: a warning, and scanning goes on.

**The observation** (`fromTranscriptEntry(entry)`, pure):

| Field        | Value                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| window key   | `quotaLimits.rateLimitType` when it is a string matching the window-key pattern; else from the first text block: `session limit` → `five_hour`, `weekly limit` → `seven_day`; else **not recorded** (counted as `unidentified`) |
| `usedPct`    | `null`                                                                                                                                                                                                                          |
| `resetsAt`   | `quotaLimits.resetsAt` (epoch seconds) when it is a finite number; else `parseResetText(text, observedAt, key)`; else `null`                                                                                                    |
| `status`     | `"rejected"`                                                                                                                                                                                                                    |
| `observedAt` | the entry's `timestamp`, as ISO UTC                                                                                                                                                                                             |
| `source`     | `"transcript"`                                                                                                                                                                                                                  |

- Model-limit texts ("You've reached your Fable limit…") name no window and no reset. Recording one as `model:<slug>` with no reset would read as `rejected` for 7 days under the stale rule, far longer than the real limit, so they are not recorded.

**`parseResetText(text, observedAt, key)`**, pure, no npm package:

- Pattern: `resets (?:(Jan|Feb|…|Dec) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)`.
- Hours are 12-hour clock: `12am` is hour 0, `12pm` is hour 12, `1am`–`11am` are 1–11, `1pm`–`11pm` are 13–23. Real hits include `12:50am`, `12pm` and `at 12am`.
- The zone is the IANA name in parentheses. An unknown zone (`Intl` throws `RangeError`) → `null`.
- **With a date:** that wall time in that zone, in the year of `observedAt` in that zone. If the result is more than 1 day before `observedAt`, use the next year (a hit on Dec 30 that resets Jan 2).
- **Without a date:** the first instant strictly after `observedAt` whose wall time in that zone is that time.
- Wall time → instant uses `Intl.DateTimeFormat(…, { timeZone })` offsets, re-checked once for a DST shift. A wall time that occurs twice (the repeated hour) takes the earlier instant. A wall time that does not exist (the skipped hour) → `null`.
- **Sanity bound:** the result must be after `observedAt` and at most the window length plus 1 hour later (`five_hour` 6 h, `seven_day` 7 d 1 h). Otherwise → `null`.

**Writing.**

- Per account, keep the latest observation per window key, then call S1's writer once.
- `--dry-run` computes everything and writes nothing.
- Idempotent by the merge rule: a second run finds equal `observedAt` values and leaves the file untouched. An observation older than the stored one loses.

**Output and exit codes.**

- Human, per account: files read, hits, unidentified, and per window `recorded (limited until <local time>)` or `unchanged (a newer reading is stored)`.
- JSON: `{ v, days | "all", accounts: [{ id, files, hits, unidentified, observations: [ … ], changed: [keys] }], warnings }`.
- Exit 0. An unknown `--account`: exit 5.

#### 2.5 `flow usage probe <id> [--model <alias>] [--timeout <s>] [--claude <path>] [--yes] [--json]`

**The cost note, always printed first** (stderr in `--json` mode):

> This runs one short Claude Code turn on `<label or id>` (`<path>`) with model `<model>`. It uses a small part of that account's 5-hour limit, and starts a new 5-hour window if none is running. It sends no files and allows no tools.

- Without `--yes`: print the note plus "Run again with --yes to go ahead." and exit 0. Nothing runs. (Agents cannot answer a prompt, so there is no prompt.)
- `<id>` unknown or invalid: exit 5.

**Running it** (with `--yes`):

- **Binary:** `--claude <path>`, else `FLOW_CLAUDE_BIN`, else `claude` on `PATH`. Not found: exit 3, naming what was tried.
- **Environment:** the current one, with `CLAUDE_CONFIG_DIR=<account path>` — except when the account's realpath equals the realpath of `<os home>/.claude`: then `CLAUDE_CONFIG_DIR` is **removed**. Claude Code 2.1.282 names its stored sign-in differently when the variable is set, even to the default folder, so setting it would read the default account as signed out. With that, and with these removed so the turn bills that account's own sign-in and nothing else: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`. flow reads none of these values; it only leaves them out.
- **Arguments** (an array, never a shell): `-p "Reply with the single word OK." --model <model> --output-format stream-json --verbose --tools "" --strict-mcp-config --no-session-persistence --settings {"disableAllHooks":true}`. `--model` defaults to `haiku`.
- **Never `--bare`:** bare mode signs in with an API key only, so it would not read the account's subscription limits.
- **cwd:** a fresh `mkdtemp` folder, removed afterwards, so no project instructions load.
- **Timeout:** `--timeout` seconds (default 90). Then `SIGTERM` the child by its pid, and `SIGKILL` after 5 s.

**Reading the output** (newline-delimited JSON on stdout):

- `type: "system"`, `subtype: "init"` with an `apiKeySource` other than `"none"`: stop the child. Exit 5 with "this account answered with an API key (`<apiKeySource>`), not its subscription; nothing recorded".
- `type: "rate_limit_event"`: map `rate_limit_info` by the contract's `sdk_event` row: key = `rateLimitType`, `usedPct` = `utilization` × 100, `resetsAt` from epoch seconds, `status`, `observedAt` = when the line was read. No `rateLimitType`: skipped.
- `type: "result"`: the turn is over.
- Other lines are ignored. A line that is not JSON: a warning.

**Recording and exit codes.**

- One writer call with every observation. Exit 0 when at least one was recorded.
- The turn ended with no usable event: exit 5, "the probe finished but reported no usage; nothing recorded".
- Timeout: exit 5. Spawn failure: exit 3.
- Human output: one line per window recorded. JSON: `{ v, account, model, observations, changed, apiKeySource }`.

**The compliance line.** The probe is a real, official Claude Code session on the operator's own account. flow never reads the Keychain or a credentials file, never extracts a token, and never calls a usage endpoint (flow-fleet §3). The guard test in §Testing enforces it.

#### 2.6 `flow fleet [--project <dir>] [--dorkos-url <url> | --no-dorkos] [--json]`

**Reads only.** No file, lock, stamp or tracker is written. The only network call is one `GET` to a loopback DorkOS. It needs no flow project config and no tracker.

**Accounts.**

- Every identity from S1 `readIdentities`, in registry order, with its resolved policy (`readFleetPolicy`).
- For accounts with a valid id: every ledger window through `readWindow(entry, now)`, `effectiveReservePct`, `fiveHourRoom`, `weeklyRoom`.
- `lastSeen` = the newest `observedAt` across its windows.

**Sessions** come from three sources, joined on `sessionId`.

1. **Claude Code session files.**
   - For each account with a valid id, every `<path>/sessions/*.json` (not recursive). A file needs a number `pid` and a string `sessionId`; the rest is optional (`cwd`, `status`, `startedAt`, `procStart`, `name`). Anything else is skipped, with a warning.
   - **Alive** = `process.kill(pid, 0)` succeeds or fails with `EPERM`.
   - Then one `ps -o pid=,lstart= -p <pid,…>` call, run with `TZ=UTC LC_ALL=C` in its environment: Claude Code writes `procStart` in UTC and the C locale (`Fri Sep 25 22:57:30 2026`), while a bare `ps` prints local time in the user's locale. Both strings are trimmed and runs of spaces collapsed to one (`ps` pads single-digit days). A pid whose `lstart` then differs from `procStart` (when both exist) was reused, and counts as dead. If `ps` fails, the kill check stands. Dead sessions are not shown.
2. **DorkOS.**
   - `GET <url>/api/sessions?limit=500`, 1.5 s timeout. `<url>` = `--dorkos-url`, else `FLOW_DORKOS_URL`, else `http://127.0.0.1:<DORKOS_PORT or 4242>`.
   - The host must be `127.0.0.1`, `localhost` or `::1`. Any other host: exit 2, so fleet never sends a request off the machine.
   - Connection refused: the note `DorkOS: not running at <url>` (not a warning). A non-2xx answer (for example 401 with sign-in on): a warning naming the status.
   - Kept: sessions with a `status` (this server holds them live), or whose `trackerItem.runStatus` is `queued`, `running` or `waiting_for_review`.
   - Account: `accountId`, else the identity whose path equals `account`, else `null`.
   - A DorkOS release before S4 D7/D8 returns no `status` and no `trackerItem`, so it contributes no rows, exactly like a newer one with nothing live. Both read the same, so the note says only what is known: `DorkOS: running at <url>, no live sessions` when it kept no rows, and nothing when it kept some. The DorkOS release note for D7/D8 is where a person learns which release reports live sessions.
3. **flow run records.**
   - The main checkouts are those of `--project` (default cwd) and of every distinct `cwd` from sources 1 and 2.
   - Each is found with `git -C <cwd> rev-parse --path-format=absolute --git-common-dir`, whose parent is the main checkout: one call per distinct cwd, at most 8 at once, 2 s timeout each. A failure means no checkout.
   - Each checkout's `.dork/flow/flow-state.json` is read with S1's reader, without a lock. An unreadable file: a warning.
   - Runs with status `queued`, `running` or `waiting_for_review` are kept.

**Joining.**

- A session from source 1 or 2 whose `sessionId` equals a kept run's `sessionId` takes `item` = the run's `identifier`, `stage` = its `stage`, and `host` = the run's `host` when set.
- The same `sessionId` from sources 1 and 2 is one row: DorkOS fields win, and host = `dorkos` unless the run says otherwise.
- A kept run matched by no session is its own row: account = the run's `account` (else `null`), host = the run's `host` (else `null`).
- Host for an unlinked session: source 1 → `cli`, source 2 → `dorkos`. A cmux session is a Claude Code session inside cmux, so it shows as `cli` unless a run written by flow's cmux launcher (S3) says `cmux`.

**State** (first rule that applies):

| Row                 | State                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DorkOS session      | `limited` when `status.limit` is set; `streaming` → `busy`; `blocked` → `parked`; `idle` → `idle`; `error`, `interrupted` as is    |
| Claude Code session | `status` `busy` → `busy`; `idle` → `idle`; any other value shown as is; a missing value → `unknown`                                |
| run with no session | `waiting_for_review` → `parked`; a `workerPid` that is not alive → `stale`; otherwise `unseen` (flow has a run, no host listed it) |
| override            | an `idle` session whose account's `five_hour` or `seven_day` reads `rejected` now (not expired) → `limited`                        |

- The override only replaces `idle`. A busy session on an account the ledger calls limited means the reading is out of date (the window already reset), and the session is doing work.

**Human output.**

Plain, aligned, uncolored (S1 §2), at most 100 columns for up to 12-character ids:

```
Accounts                  5-hour                     week
  claude2  main      [####......]  41%  2h 14m   [#######...]  72%  3d 04h   reserve 50%, seen 3m ago
  claude3  rotation  [##########]  out  0h 42m   [###.......]  31%  5d 11h   limited (5-hour), seen 1h ago
  claude4  kept-out  no reading                  [..........]   0%  reset    seen 6d ago

Sessions
  claude2  DOR-2369  busy     cli     1a2b3c4d  ~/…/marketplace/spec-flow-usage  3h
  claude3  -         limited  cli     9f8e7d6c  ~/Keep/dork-os/dorkos            12m
  claude2  DOR-2370  unseen   dorkos  5e4d3c2b  -                                -

DorkOS: not running at http://127.0.0.1:4242
```

**The account cells.**

- **Bar:** 10 cells, `#` filled = `round(usedPct / 10)`, `.` empty.
- **Percent:** `usedPct` rounded. `out` when `status` is `rejected`. `0%` when expired.
- **Countdown:** `<1m`, `42m`, `2h 14m`, `3d 04h`; `reset` when expired; `-` when `resetsAt` is null.
- **No reading** for a window prints `no reading` in its place.
- **Notes,** in this order when they apply:
  - `reserve N%` for any account with a non-zero reserve, and `reserve N% (0% now: spend-down)` inside its spend-down window.
  - `limited (5-hour|week)`.
  - `kept out of all repos`, for a kept-out account with no scope.
  - `seen <age> ago`.
- A row whose id fails the pattern shows `invalid id, not tracked`.

**The session cells:** account id (`?` when unknown), item (`-`), state, host (`?` when unknown), the first 8 characters of the session id, the place (the cwd with the home folder as `~`, cut from the left to 34 characters with `…`), and the age since `startedAt` (`-` when unknown).

**Ordering and empty cases.**

- Sessions are sorted by account registry order (unknown last), then item, then `startedAt`.
- No accounts: `No accounts registered. Add one: flow accounts add --path ~/.claude`.
- No sessions: `Sessions: none running`.
- A footer line always says: `Sessions on accounts flow does not know are not shown.`
- Warnings go to stderr.

**JSON** (`--json`):

```jsonc
{
  "v": 1,
  "now": "2026-09-26T16:00:00.000Z",
  "handoff": "auto",
  "accounts": [
    {
      "id": "claude2",
      "label": "Claude 2",
      "color": null,
      "path": "/Users/x/.claude2",
      "validId": true,
      "role": "main",
      "reservePct": 50,
      "effectiveReservePct": 50,
      "scopeRepos": [],
      "fiveHourRoom": true,
      "weeklyRoom": true,
      "lastSeen": "2026-09-26T15:57:00.000Z",
      "windows": {
        "five_hour": {
          "usedPct": 41,
          "resetsAt": "…",
          "status": null,
          "observedAt": "…",
          "source": "statusline",
          "expired": false,
        },
      },
    },
  ],
  "sessions": [
    {
      "sessionId": "…",
      "account": "claude2",
      "item": "DOR-2369",
      "stage": "execute",
      "state": "busy",
      "host": "cli",
      "pid": 23914,
      "cwd": "/…",
      "startedAt": "…",
      "sources": ["claude-code", "flow-run"],
    },
  ],
  "dorkos": {
    "url": "http://127.0.0.1:4242",
    "reachable": false,
    "sessionsShown": 0,
  },
  "warnings": ["…"],
}
```

- A stale window is absent from `windows`.
- An expired one carries `expired: true` and reads `usedPct: 0`.

**Exit codes:** 0, or 2 for argv errors and a non-loopback URL.

### 3. Code structure

```
plugins/flow/
  scripts/
    fleet/observations.ts      fromStatusLine, fromTranscriptEntry, fromRateLimitEvent, parseResetText (pure, zero deps)
    fleet/config-dir.ts        accountForConfigDir, defaultConfigDir (zero deps)
    fleet/sessions.ts          readCliSessions, fetchDorkosSessions, collectRuns, joinSessions, sessionState (zero deps; I/O injected)
    fleet/render.ts            renderFleet(model, now) → text; bar, countdown, age helpers (pure)
    cli/usage.ts               record | scan | probe | install-statusline dispatcher
    cli/usage-record.ts        §2.1
    cli/usage-scan.ts          §2.4
    cli/usage-probe.ts         §2.5
    cli/usage-install.ts       §2.3
    cli/fleet.ts               §2.6
    usage/statusline-hook.sh   §2.2 (0755)
  docs/account-usage.mdx
  engine-tests/usage/…, engine-tests/fleet/…, engine-tests/fixtures/usage/…
```

#### 3.1 Zero dependencies

- The `record` path loads `flow.ts` → `cli/usage.ts` → `cli/usage-record.ts` → `fleet/observations.ts`, `fleet/config-dir.ts`, S1's `fleet/accounts.ts`, `fleet/usage-ledger.ts` and `atomic-json.ts`. It imports no npm package.
- `cli/usage.ts` loads each sub-verb with dynamic `import()`, so `record` never loads the scan, probe or install code.
- All S2 modules take `now`, `env`, the file system root and the process runner from `deps` (S1 `main(argv, deps)`), so tests never touch the real home folder, clock or network.

## User Experience

- **Set up once:** `flow usage install-statusline` shows what it would add to each account's status-line script; `--yes` adds it. From then on every interactive session keeps its account's readings current.
- **Catch up:** `flow usage scan` recovers the last week's limit hits.
- **An account nobody has used lately:** `flow fleet` shows `no reading`. `flow usage probe claude4` states the cost; `--yes` runs it.
- **One screen:** `flow fleet` for people. `flow fleet --json` for agents and S3's dispatch.
- **Errors name the fix:**
  - "no stdin-capture line like `input=$(cat)` in <script>; add these two lines by hand: …"
  - "this account answered with an API key, not its subscription"
  - "DorkOS answered 401; sign in, or pass --no-dorkos"

## Testing Strategy

Each test carries a purpose comment and is shown to fail against a broken implementation before it is trusted. Fixtures carry made-up paths, ids and session ids only.

**Fixtures** (`engine-tests/fixtures/usage/`):

- `statusline/`: `full.json` (both windows, epoch `resets_at`), `iso-resets.json`, `no-rate-limits.json` (before the first response), `partial.json` (`seven_day` without `used_percentage`), `extra-window.json` (`seven_day_opus`), `bad-values.json` (string, 140, −5, a key failing the pattern), `pretty.json` (multi-line), `not-json.txt`.
- `transcripts/`: `structured.jsonl` (a `quotaLimits` five_hour hit and a seven_day hit, shaped like the 2.1.280 entry), `text-only.jsonl` (the session text with a time, the weekly text with a date, the weekly text without a date), `model-limit.jsonl` (the Fable text), `decoy.jsonl` (a user message quoting `"error":"rate_limit"`; an ordinary assistant line), `broken.jsonl` (a torn line between two hits).
- `sessions/`: session files with `busy`, `idle`, `shell`; one with a dead pid; one with a reused pid (`procStart` mismatch); one whose `procStart` is a real UTC value with a single-digit day, checked against a stubbed `ps` that prints `lstart` padded (`Sat Sep  5 22:57:30 2026`) so it matches; one missing `sessionId`.
- `dorkos/`: a `GET /api/sessions` body with D7/D8 fields, and one from a release without them.
- `flow-state.json` with running, review, complete and linked runs.

**Unit tests.**

- **`fromStatusLine`:** every statusline fixture → the exact observations: epoch and ISO resets, clamping, skipped windows, an extra window kept.
- **`fromTranscriptEntry`:** structured beats text; text classification; model limits and decoys produce nothing.
- **`parseResetText`:**
  - Time only, rolling past midnight.
  - Date with year rollover (observed Dec 30, resets Jan 2).
  - `12:50am`, `12pm` and `Sep 18 at 12am` give hours 0, 12 and 0.
  - The repeated hour on 2026-11-01 in America/Chicago takes the earlier instant; the skipped hour on 2027-03-14 gives null.
  - An unknown zone gives null; a result outside the sanity bound gives null.
- **`accountForConfigDir`:** unset `CLAUDE_CONFIG_DIR` → `~/.claude`; a trailing slash; a symlinked dir matching its target; an invalid-id row never matches; the first of two matches wins.
- **`sessionState`:** every row of the state table, and the override only replacing `idle`.
- **`renderFleet`:** a golden text for a fixed `now` covering expired, stale, rejected, no reading, spend-down, an invalid id, an unknown account and every session state. Every line is at most 100 columns.

**Verb tests** (`main(argv, deps)`, temp `DORK_HOME`, fake runner).

- **`record`:**
  - No matching account, and a `rate_limits` with no valid window, both write the stamp; a fingerprint cut short (a nested object in a window) is never stamped.
  - Writes both windows with `resetsAt`, and stdout stays empty. (DOR-2369 validation 1.)
  - An unregistered dir, bad JSON or a TTY writes nothing.
  - A dropped write leaves the stamp unwritten.
  - A stamp path outside `<dorkHome>/usage` is ignored.
  - `--json` gives the envelope.
- **`scan`:**
  - Finds the structured hits and the text hits, and skips the decoys. (DOR-2369 validation 2.)
  - The `--days` mtime filter works.
  - A second run leaves the ledger byte-identical, with the same mtime.
  - A newer statusline reading is not overwritten.
  - `--dry-run` writes nothing.
- **`probe`:**
  - Without `--yes`, the runner is never called and the note is printed.
  - With `--yes`, the fake runner receives exactly the §2.5 arguments. Its env has `CLAUDE_CONFIG_DIR` and none of the removed variables. Its cwd is a temp dir that is gone afterwards.
  - A scripted `stream-json` with two `rate_limit_event` lines records both, as `sdk_event`.
  - `apiKeySource: "ANTHROPIC_API_KEY"` exits 5 and records nothing.
  - No event exits 5. A timeout kills the child.
- **`install-statusline`:**
  - Without `--yes`, every script is byte-identical afterwards.
  - With `--yes`: inserts after the capture line; a second run is `none`; moved paths are `update`d; `--remove` restores the original bytes exactly (CRLF and no-final-newline fixtures included).
  - Every `manual` reason is covered, and `settings.json` is never written.
- **`fleet`:**
  - Joins all three sources, so a session serving an item shows it. (DOR-2370 validations 1 and 2.)
  - The `--json` shape holds.
  - Before-and-after snapshots of the temp home, the config dirs and the project (path, size, mtime, bytes) are identical, and the only request is one `GET`. (DOR-2370 validation 3.)
  - DorkOS refused, 401, and pre-D7 bodies each give their note or warning.
  - A non-loopback URL exits 2.

**Process tests** (real `node`, real `bash`):

- **Not blocking:** a status-line script patched by `install-statusline --yes`, whose hook is replaced by one that sleeps 2 s, returns its rendered line in under 50 ms, with `FLOW_NODE` pointing at a stub. This proves the status line never waits.
- **The hook's dedupe:** a real recorder under a temp `DORK_HOME`. The first payload starts `record` and the stamp appears. The same payload again does not start it (the stub counts calls). A changed `used_percentage` starts it again. Run under `/bin/bash` (3.2 on macOS) and the CI bash.
- **Zero dependencies:** `usage record` runs from a copy of `scripts/` with no `node_modules` and writes the ledger.
- **Recorder cost:** measured on the development machine and reported in the PR (median and p95 wall time over 50 runs). Not asserted in CI, whose machines vary.

**The compliance guard** (`engine-tests/usage/compliance-guard.test.ts`):

- It fails if any file under `scripts/fleet/`, `scripts/usage/` or `scripts/cli/usage*.ts` / `cli/fleet.ts` contains `oauth/usage`, `find-generic-password`, `Keychain`, `.credentials.json` or `api.anthropic.com`.
- It fails if any of them reads the value of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. The probe's removal list is the one allowed mention, as a single exported `const` the test finds by name.
- It fails if `fetch(` appears anywhere but `fleet/sessions.ts`.
- Proven by adding a violating line to a temp copy and watching it fail.

## Performance Considerations

- **Status line:** the added lines fork one background job and return. The hook runs only bash builtins until a reading changes. Node starts only then: about 50 ms of CPU, off the status line's path.
- **`record`:** one config read, one ledger read-merge-write under the lock (a few ms), no npm imports.
- **`scan`:** only recent files, with a text prefilter before `JSON.parse`, and one write per account. The operator's five config dirs hold about 9 GB of transcripts in all. The 8-day filter reads a fraction of that.
- **`fleet`:** a handful of small files per account, one `ps`, one `git` per distinct cwd (8 at a time), and one loopback request with a 1.5 s cap. The target is under 1 s with DorkOS stopped. The spec does not assert it.

## Security Considerations

- Usage comes only from what the official binary hands us: the status-line payload, transcripts and a real `claude -p` turn. No Keychain or credentials file is read, no token is extracted, and no Anthropic endpoint is called by flow (flow-fleet §3). The compliance guard enforces it.
- The probe removes API-key and token variables from the child's environment without reading them, and refuses to record a turn that answered on an API key.
- `fleet` talks only to a loopback URL and only with `GET`.
- Ledger files, stamps and backups are `0600`, in `0700` folders (S1 §1.2). Account ids are pattern-checked before they become file names. The stamp path from the environment is confined to `<dorkHome>/usage/.statusline-*`.
- `install-statusline` writes only with `--yes`. It keeps a backup, preserves the mode, verifies after writing, and restores on a failed check. Paths it writes are single-quoted, and a path containing a quote is refused.
- No shell anywhere: every child process gets an argument array.
- flow is a public plugin, so the docs say it plainly: each person must judge their own use against Anthropic's terms. The feature is described as account-aware scheduling, never as a way to get more out of a plan.

## Documentation

- New `docs/account-usage.mdx` (added to `docs/meta.json`), written with the `writing-for-humans` skill:
  - What flow records, where, and from where.
  - The two lines, and `install-statusline`.
  - `scan`, and `probe` with its cost.
  - Reading the `flow fleet` screen.
  - The terms note.
- `README.md`: the S1 verb table gains `usage` and `fleet`.
- `docs/SPEC.md`: the CLI surface gains the two verbs.
- `CHANGELOG.md` and the version bump in `plugin.json`, `.dork/manifest.json` and `package.json`, per PR (`check:bump`).

## Implementation Phases

- **Phase 1, foundations:** the observation mappers and reset-text parser, the config-dir lookup, and the session registry. No verb yet.
- **Phase 2, verbs:** `record` with the hook, `scan`, `probe`, `install-statusline`, `fleet`.
- **Phase 3, prove it:** the docs, then a live run on the operator's machine:
  - `install-statusline` without `--yes` for every account, then `--yes` on one.
  - A `scan`, and one `probe --yes` on one account.
  - `flow fleet` output pasted into the PR.
- Phase 1 needs S1 tasks 1.1, 1.4 and 1.5 merged. One PR per phase (the version-bump check allows one bump per PR).

## Decisions (made autonomously, logged as assumptions)

- **A1. "Under 50 ms" is the cost to the status line, not to the recorder.** Node's own start is about 50 ms, so no Node recorder can finish in 50 ms. The status line pays only a background fork. The hook runs builtins and skips Node when nothing changed.
- **A2. The snippet carries an absolute Node path.** A status line's `PATH` may lack an nvm Node, and a bare `node` then fails silently (DOR-2121).
- **A3. The account is the config dir, matched by realpath against the registry.** The status-line payload names no account. An unregistered dir records nothing.
- **A4. `observedAt` for a status-line reading is the moment `record` runs.** The payload carries no timestamp.
- **A5. Transcripts: the structured `quotaLimits` first, the text second, model limits never.** A model limit with no reset would read as `rejected` for 7 days under the stale rule.
- **A6. `scan` reads the last 8 days by default.** An older hit can only read as expired or stale; `--all` reads everything.
- **A7. `probe` needs `--yes`, defaults to `haiku`, strips key variables, refuses an API-key answer, and records as `sdk_event`.** The CLI's `stream-json` carries the SDK's own event.
- **A8. A `-p` turn emits `rate_limit_event`.** DorkOS sees one on every SDK turn, and the SDK reads the same stream. The Phase 3 live probe confirms it before the PR merges. If the event only appears near a limit, `probe` exits 5 with "reported no usage". That outcome is honest; the design needs no change.
- **A9. DorkOS rows come from `GET /api/sessions` on a loopback URL.** They need S4 D7/D8, and without them the screen degrades with a note. The endpoint lists the server's default project; runs DorkOS hosts elsewhere still show through their `flow-state.json`.
- **A10. An unlinked Claude Code session is host `cli`.** Only a run record can say `cmux`.
- **A11. The state words are `busy`, `idle`, `parked`, `limited`, `stale` and `unseen`.** They cover flow-fleet §4.3's four states plus two for runs with no live session. `parked` means waiting on a person: DorkOS `blocked` or a run at review.
- **A12. `install-statusline` edits only a `[bash|sh|zsh] <file>` command with a `var=$(cat)` line.** Every other shape gets the two lines to paste by hand.
- **A13. No `--watch` on `fleet`.** Long-running loops are S3's.
- **A14. No contract change.** Every mapping is S1 §1.2's table. Using `quotaLimits` for a transcript's window and reset is the contract's "parsed from the message": it is part of the same entry.

## Open Questions

None open.

## Amendment 1 (2026-09-26): every runtime records usage (DOR-2399)

The operator runs flow from Claude Code, Codex and OpenCode sessions (the fleet programme's runtime decisions R1–R9). This amendment extends S2 to every runtime. It builds on contract rev 6 from spec unit S1: the runtime-neutral ledger at `<dorkHome>/runtimes/<runtime>/usage/<account-id>.json` (runtime slugs `claude-code`, `codex`, `opencode`), its optional `plan`, `credits` and `spend` fields, and `windowMinutes` on a window. Where this section names a field or path, rev 6 is the authority; if they differ, rev 6 wins and this section follows.

### A1. Accounts per runtime

- Claude Code accounts are the registry rows, as today.
- Codex and OpenCode have no registry yet (R1). Each has one implicit account, `default`, that stands for the ambient environment:
  - Codex: `CODEX_HOME` when set and non-empty, else `<os home>/.codex`.
  - OpenCode: the data folder `$XDG_DATA_HOME/opencode` when `XDG_DATA_HOME` is set and non-empty, else `<os home>/.local/share/opencode`. The store is `opencode.db` in it, or `OPENCODE_DB` when set (an absolute path, or one relative to the data folder; `:memory:` means no store). This is the same rule as DorkOS `opencode-data-dir.ts`.
- When rev 6 adds `runtimes.codex.accounts[]` or `runtimes.opencode.accounts[]`, the verbs read those rows instead. Nothing here assumes there is only one account.

### A2. Codex: `flow usage scan --runtime codex`

**The mapping is rev 6's.** Contract rev 6 owns how a Codex `rate_limits` payload becomes ledger entries (`codexObservations` in `fleet/usage-ledger.ts`): window keys by `window_minutes` (`five_hour`, `seven_day`, else `window:<minutes>`), `source: "rollout"`, `plan` and `credits`. S2 adds only the scan and the stdin path around it.

**The limit_id rule (in rev 6, accepted by its owner).** Real rollouts carry several limits: `limit_id` `codex` (the main limit), `codex_bengalfox` (`limit_name` "GPT-5.3-Codex-Spark", with its own windows) and `premium`, and their events alternate.

- Only `codex` (or an absent `limit_id`) maps to `five_hour`, `seven_day` or `window:<m>`.
- Any other limit becomes one `model:<slug>` bucket holding its tightest window: the highest `used_percent`, with a tie going to the longer window.
- The slug comes from `limit_name`, else `limit_id`, lowercased with dots kept: `model:gpt-5.3-codex-spark`.

`rate_limit_reached_type` is null in every real event seen, even at 100% used. It means only "non-null → rejected", and no fixture gives it a finer meaning.

**Files.** `<codex home>/sessions/**/rollout-*.jsonl` and `<codex home>/archived_sessions/**/rollout-*.jsonl`, with §2.4's `--days` mtime filter and symlink rule.

**Lines.**

- The text prefilter is `"rate_limits"`.
- An entry counts when `type` is `event_msg`, `payload.type` is `token_count`, and `payload.rate_limits` is an object. `observedAt` is the entry's `timestamp`.
- Newest per key wins, and the account gets one ledger write.

### A3. OpenCode: `flow usage scan --runtime opencode`

**Reading, as DorkOS does it (DorkOS ADR 260825-110420).**

- Copy `opencode.db` plus any `-wal` and `-shm` beside it into a temp folder. Open the copy read-only with `node:sqlite` (`DatabaseSync`, `readOnly: true`), and delete the copy afterwards. The live store is never opened.
- **Allowlist:** one fixed query, `SELECT data FROM message`, and only these JSON fields of `data`: `role`, `providerID`, `cost`, `time.created`, `error.name`, `error.data.statusCode`. No other table or column is ever named.
- `node:sqlite` is detected at runtime with a dynamic `import()`. Where it is missing or needs a flag, flow warns once and records nothing. Its ExperimentalWarning is suppressed for that import only.

**Spend, per provider.**

- `costUsd` = the sum of `cost` over assistant messages created since `periodStart`, the first instant of the current UTC month.
- It is recorded through rev 6's `spend` (`source: "transcript"`) as the account total, with `periodStart` = this month and `observedAt` = the newest message's time. A month with no messages yet records `costUsd: 0` with `observedAt` = the scan time. The per-provider split is shown only in `scan --runtime opencode` output (text and `--json`); the ledger holds the total.
- `limitUsd` is never inferred.
- A local model records cost 0.

**Errors, per provider.**

- For each `providerID`, the newest assistant message decides:
  - an `APIError` with `statusCode` 402 → `credits:<provider>`, rejected;
  - 429 → `rate_limit:<provider>`, rejected;
  - no error → `allowed` for both keys of that provider.
- A success from one provider never clears another's error, so a local model's success cannot hide an OpenRouter credit limit.
- These are rev 6's window-less error entries: `source: "error"`, `status: "rejected"`, `usedPct: null`, and `resetsAt` when known. With no `resetsAt`, an entry goes stale after 1 hour. The provider slug follows the model-slug rule.
- **Dispatch:** rev 6's room checks treat any rejected, unexpired `credits:*` or `rate_limit:*` entry as no room, whatever the other windows say. S2 only writes these entries, and `flow fleet` shows them.

### A4. `flow usage record --runtime <runtime>`

- `--runtime claude-code` (the default) is §2.1, unchanged.
- `--runtime codex` takes one Codex `rate_limits` object, or one whole rollout line, on stdin. It records it for the Codex account by rev 6's mapping (A2), with `observedAt` = now for a bare object, else the line's timestamp. This lets a Codex hook or DorkOS pipe readings in.
- `--runtime opencode` takes one OpenCode assistant message JSON on stdin and records its spend and error signal by A3. With no message store to sum, a single message adds nothing to `costUsd`; it only updates the error signal. Spend comes from `scan`.
- The silence rules of §2.1 apply to every runtime.

### A5. `flow fleet` groups by runtime

- One `Accounts` block per runtime that has an account with ledger data, or a registered account. The headings are `Claude Code`, `Codex` and `OpenCode`.
- Codex rows use the same bars as Claude Code. A `model:*` bucket shows as an extra note (`GPT-5.3-Codex-Spark 12%`), and a known `plan` shows in the notes.
- OpenCode rows show `$<costUsd> this month` in place of the bars, or `$0.00 this month` when the stored `spend.periodStart` is not the current UTC month (a spend reading never goes stale, so last month's total is never shown as this month's). They add `out (credits: <provider>)` or `out (rate limit: <provider>)` for each current rejected error key.
- Sessions are grouped under the same headings. A session's runtime is:
  - its source: a Claude Code session file means `claude-code`;
  - for a DorkOS session, its `runtime` field;
  - for a run-only row, `FlowRun.runtime` when S3 adds it, else `claude-code`.
- The JSON gains `runtime` on every account and session, plus `plan`, `credits` and `spend` on accounts.

### A6. `flow usage prune [--yes] [--json]`

**What it lists** in `<dorkHome>/runtimes/<runtime>/usage/`:

- `<id>.json` and `<id>.json.corrupt-*` whose `<id>` is not a known account of that runtime. Known means a registered Claude Code id, or `default` for Codex and OpenCode while they have no registry.
- A `*.tmp`, `*.lock` or `*.lock.stale-*` file only when it is more than 1 hour old. A younger one may belong to a write in progress.

**Legacy files** in the pre-rev-6 `<dorkHome>/usage/` (`*.json`, `.statusline-*`, `*.corrupt-*`) are listed by the same age rule.

**What it skips:**

- A runtime whose registry key exists in `config.json` but that flow does not read yet (for example `runtimes.codex.accounts` before flow supports it). Its files may be DorkOS's.
- A known account's `<id>.json`, always.

**Deleting:**

- Without `--yes` it lists and exits 0.
- With `--yes` it deletes each file after re-checking its rule.
- The ledger never grows (overwrite-only, R8), so nothing prunes readings by age.

### A7. Journal `usage.snapshot` events

- The shape is proposed to the journal owner (S8, marketplace PR #63) and added to its schema in the same PR that first writes it:

  ```jsonc
  {
    "kind": "usage.snapshot",
    "runtime": "codex",
    "account": "default",
    "windows": {
      "five_hour": { "usedPct": 12, "resetsAt": "…", "status": null },
    },
    "costUsd": 0.75,
  } // costUsd only for a metered account
  ```

- **Sampled (R8):** a line for an account is written only when its last `usage.snapshot` line is more than 60 minutes old, or when a window's `usedPct` moved 5 or more points, or its `status` changed, since that line. That keeps usage from pushing run events out of the capped journal.
- **Who writes it:** `flow usage scan`, `flow usage probe` and the new `flow usage snapshot` (for S3's supervisor pass), each by the sampling rule. The last line per account comes from the journal's `read(target, since)` over the last 24 hours, which spans rotated files.
- **Never from `record`:** the status-line path stays zero-dependency and needs no project.
- **Outside a flow project, or with the journal off:** the verbs write no line and say nothing.
- The journal's size cap and rotation govern retention.

### A8. Tests and compliance

- **Fixtures:**
  - Made-up rollout lines: the `codex` limit with both windows, interleaved with a `codex_bengalfox` model limit, plus credits and the `plus` and `pro` plans.
  - A small `opencode.db` generated in the test with `node:sqlite`. Per-provider cost rows span two months. It holds an OpenRouter 402 followed by an ollama success (the 402 must stay), a later OpenRouter success (which clears it), a 429, and a decoy `credential` table. The test asserts the exact SQL flow ran.
- **Compliance guard:** the OpenCode reader's SQL must equal the one allowlisted query, which the test pins. The Codex modules must never name `auth.json`. The guard checks code, not comments.
- The process test for `record --runtime codex` runs without `node_modules`, like the Claude Code one.

### A9. Decisions (autonomous, logged)

- **B1.** A Codex model-scoped limit becomes one `model:<slug>` bucket holding its tightest window. Rev 6 accepted this.
- **B2.** OpenCode spend is per calendar month (UTC). The local store has no billing period, and a month matches how metered providers bill.
- **B3.** OpenCode errors count only for 402 and 429, per provider. Other API errors are not about usage.
- **B6.** The OpenCode store is read from a copy, through one allowlisted query, as DorkOS ADR 260825-110420 requires.
- **B7.** `usage.snapshot` is sampled: at most one line per account per hour, unless usage moved 5 points or a status changed.
- **B4.** `record` never writes journal lines, so the hot path keeps no project and no dependencies.
- **B5.** Codex and OpenCode each use one implicit `default` account until their registries exist (R1).

## Related ADRs

- None in this repo (the marketplace has no `decisions/`). A1, A5 and A9 are the calls a later reader is most likely to question; they are recorded here.

## References

- [`specs/flow-fleet/01-ideation.md`](../flow-fleet/01-ideation.md) §2, §3, §4.2, §4.3
- [`specs/flow-cli-core/02-specification.md`](../flow-cli-core/02-specification.md) §1.1–§1.4, §2, §7
- DorkOS `specs/claude-account-fleet/02-specification.md` D2, D3, D7, D8 (branch `spec-claude-account-fleet`)
- Linear: DOR-2366 (umbrella), DOR-2369, DOR-2370
