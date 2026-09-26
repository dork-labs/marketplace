---
slug: flow-handoff-dispatch
issue: DOR-2373
created: 2026-09-26
status: specified
---

# flow checkpoints its work, starts sessions on the account with room, drains in parallel through a review loop, and hands work off when an account runs out

**Status:** Approved
**Issues:** DOR-2371 (F5 checkpoints), DOR-2372 (F6 launchers), DOR-2373 (F7 dispatch, `flow drain --parallel`, `flow watch`), DOR-2374 (F8 auto-handoff)
**Date:** 2026-09-26
**Input:** [`01-ideation.md`](./01-ideation.md)
**Builds on:** [`../flow-cli-core/02-specification.md`](../flow-cli-core/02-specification.md) (S1). Its §1 contracts bind this spec; where this spec restates one, S1 wins.

## Overview

- **Checkpoints.** A short `HANDOFF.md` in the worktree says what is done, what is next, the open questions and the exact next command. `flow checkpoint` writes it; the CLI fills every fact it can measure (SHAs, dirty tree, account). It is written at every stage boundary, after each EXECUTE task, and when the account warns.
- **Launchers.** One `Launcher` interface starts, messages, observes and stops a top-level Claude Code session on a named account in a named worktree. Three implementations: plain CLI (headless `claude -p`), cmux, DorkOS.
- **Dispatch.** A pure function ranks accounts for an item: eligibility first (scope, room on both windows and the model, reserve, capacity), then remaining weekly headroom ÷ hours to the weekly reset, with warm-cache affinity first and the main account last outside its spend-down window. `flow next` returns the account with the item.
- **Parallel drain.** `flow drain --parallel N` claims items, starts one worker per item on its own account and worktree, starts a separate reviewer at every pushed SHA, loops fixes until the review is CLEAN, lets the worker open the PR only then, watches it, and wakes the worker on merge, red CI or a queue ejection. Launches stop when the machine is busy.
- **`flow watch`** replaces `templates/drain/watch.sh`, and adds the "not this PR's fault" check for queue ejections.
- **Handoff.** A pure state machine: on a warning the worker finishes its step, checkpoints and stops; on a hard limit the run is marked limited with its reset time. With `handoff: auto` a new session on another eligible account resumes from `HANDOFF.md` in the same worktree; with `handoff: ask` the run waits and says why. No transcript is ever moved.

## Background / Problem Statement

- The 2026-09-25/26 drain ran by hand: the orchestrator wrote a worker brief, a reviewer brief and a PR watcher, relayed findings between agents, and tracked which worker was where ([flow-cli-overhaul §1](../flow-cli-overhaul/01-ideation.md)). The review loop caught five real defects; nothing but the orchestrator's memory enforced it.
- Subagents bill their parent's account, so a drain from one session spends one account while others sit idle and reset unused ([flow-fleet §1–2](../flow-fleet/01-ideation.md)).
- When an account runs out mid-task the work stops, and moving it is manual. Moving a transcript is unreliable (signatures, side files, cold cache), so flow needs a resumable checkpoint instead.
- That drain hit a machine load near 500, and 5 s server tests timed out; every rerun spent more usage.

## Goals

- A fresh session given only "resume from HANDOFF.md" continues the work (DOR-2371).
- Each launcher starts a real official session on the named account in the named worktree; all three pass one contract suite; a missing host is reported, never guessed (DOR-2372).
- An account resetting sooner with less left beats one resetting later with more; the main account gets work only when no other is eligible or inside its spend-down window; a parallel drain opens no PR before a CLEAN review (DOR-2373).
- A hard limit mid-item hands off with no operator action in `auto`; in `ask` the run parks and says why; no transcript moves (DOR-2374).
- Every decision above is a pure, fixture-tested function; I/O lives in thin runners.

## Non-Goals

- Writing the ledger from the status line or transcripts, `flow usage`, `flow fleet` (S2). S3 reads the ledger through S1's `fleet/usage-ledger.ts` and writes only what its own headless sessions stream (§2.3).
- The DorkOS server side: `session_start`, a session's `limit`, `account.limited`, and a server dispatcher that reacts to `rate_limit_event` at once (S4). S3 uses them when present.
- Any UI (S5, S6).
- A tmux launcher. The ideation offered it as an option for the CLI host; cmux already covers a visible session, and headless covers the rest (Decision D7).
- Transcript migration. It stays an opt-in, by-hand tool outside flow (cmux-control), with its risks written there.
- Detecting two ready items that touch the same files. The operator groups or sequences them with `--items`, as the hand recipe says.
- A forge other than GitHub (Decision D10).
- Cross-machine drains. One supervisor per project per machine (§4.1).

## Technical Dependencies

- Everything S1 ships: `scripts/flow.ts` and its `main(argv, deps)`, exit codes and `--json` envelope; `atomic-json.ts`; `flow-state-file.ts`; `fleet/accounts.ts` (`readIdentities`, `readFleetPolicy`, `mayServe`, `effectiveReservePct`, `fiveHourRoom`, `weeklyRoom`); `fleet/usage-ledger.ts` (`readLedger`, `readWindow`, `mergeLedger`); `config-load.ts`; the code adapter (`applyWorkState`, `comment`, `getItem`); the `claim`, `release`, `stage`, `done` verbs.
- Node ≥ 22.6 with `--experimental-strip-types`; `zod` ^4 lazily in verbs only. No new npm packages. Every pure module in §1, §3, §4.4 and §5 is dependency-free, like S1's fleet modules.
- Claude Code CLI with `-p`, `--output-format stream-json --verbose`, `--session-id <uuid>`, `--resume <id>`, `--permission-mode`, `--model` (all present in `claude --help` on 2026-09-26). The headless stream carries the SDK's `rate_limit_event` messages, since the SDK is built on this stream; task 2.1 confirms it against the installed version before relying on it, and the transcript fallback (§2.3) covers a version that does not.
- Claude Code hooks: `PostToolUse` with `hookSpecificOutput.additionalContext` (task 4.2 confirms against the installed version; §5.4 has the fallback).
- cmux: `workspace create --name --cwd --focus false --command … --json` (returns `workspace_ref`), `identify`, `send --surface`, `top --all --processes --format tsv`, `workspace rename`. Checked against the operator's install and `cmux-control` (`CLAUDE.md` lines 49–93, `bin/morning.sh`) on 2026-09-26. Only `workspace create` accepts `--command` there.
- DorkOS HTTP (exists today): `GET /api/health`; `POST /api/sessions/:id/messages` with `{ content, cwd, runtime, account, seedContext }` (`packages/shared/src/schemas.ts` `SendMessageRequestSchema`; an unknown `account` is ignored with a server-side warning, so the launcher verifies); `GET /api/sessions/:id`, whose `account` is the absolute `CLAUDE_CONFIG_DIR` the session bills. From S4 when present: MCP tool `session_start` on `/mcp` (result `{ sessionId, runtime, account, status }`), and `status: { lifecycle, limit }` on the session.
- `gh` (GitHub CLI), signed in, for the forge (§4.6).

## Detailed Design

### 1. Checkpoints: `HANDOFF.md` (DOR-2371)

**Where it lives**

- `<worktree>/.dork/flow/HANDOFF.md`. The previous copy is kept as `HANDOFF.prev.md` beside it.
- Every drain file sits under `<worktree>/.dork/flow/drain/` (briefs, messages, reviews, logs).
- Neither is ever committed. Before its first write, the writer makes sure `<git common dir>/info/exclude` holds the two lines `/.dork/flow/HANDOFF*.md` and `/.dork/flow/drain/` (append if missing, never duplicate). `info/exclude` covers every worktree of the repo and changes no tracked file.

**Shape**

````markdown
<!-- flow:handoff {"v":1,"identifier":"ACME-12","stage":"execute","trigger":"task","writtenAt":"2026-09-26T18:02:11.000Z","sessionId":"6f1c…","account":"claude3","host":"cli","branch":"ACME-12-export-csv","headSha":"4be1…","pushedSha":"4be1…","dirty":false,"spec":"specs/export-csv/02-specification.md","task":"1.3","pr":null,"reviewRound":null} -->

# Handoff: ACME-12 Export the report as CSV

## Done

- Task 1.3: the CSV writer escapes quotes and newlines; tests in `src/export/__tests__/csv.test.ts`.

## Next

- Task 1.4: wire the writer to the Export button.

## Open questions

None.

## Next command

```sh
pnpm vitest run src/export
```
````

**The header** is one HTML comment on line 1, `<!-- flow:handoff <json> -->`, the same single-line pattern as the provenance line. It parses with `JSON.parse` and no dependency.

| Field         | Type                                                                                     | Filled by                                                  |
| ------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `v`           | `1`                                                                                      | CLI                                                        |
| `identifier`  | string                                                                                   | argument                                                   |
| `stage`       | `FlowStage`: where the next session resumes                                              | `FlowRun.stage` (the new stage at a stage boundary)        |
| `trigger`     | `stage` \| `task` \| `fix` \| `limit-warning` \| `limit-rejected` \| `manual` \| `synthesized` | `--trigger` (`fix`: a push answering review findings or red CI) |
| `writtenAt`   | ISO UTC                                                                                  | `deps.now`                                                 |
| `sessionId`   | string \| null                                                                           | `--session`, `FLOW_SESSION_ID`, else `FlowRun.sessionId`    |
| `account`     | registry id \| null                                                                      | `FlowRun.account`                                          |
| `host`        | string \| null                                                                           | `FlowRun.host`                                             |
| `branch`      | string                                                                                   | `git rev-parse --abbrev-ref HEAD`                          |
| `headSha`     | string                                                                                   | `git rev-parse HEAD`                                       |
| `pushedSha`   | string \| null                                                                           | `git ls-remote origin refs/heads/<branch>`; null if absent |
| `dirty`       | boolean                                                                                  | `git status --porcelain` non-empty (excluded files do not count) |
| `spec`        | repo-relative path \| null                                                               | `--spec`, else null                                        |
| `task`        | task id \| null                                                                          | `--task` (required when `trigger` is `task`)               |
| `pr`          | URL \| null                                                                              | `FlowRun.drain.pr.url`                                     |
| `reviewRound` | number \| null                                                                           | `FlowRun.drain.reviewRound`                                |

- The agent never writes the header. Every measurable fact comes from git and the run record, so it cannot drift from the worktree.
- A reader ignores header fields it does not know. A header with `v` greater than 1 still reads its known fields.

**The body** is the agent's judgment, passed with `--body-file`:

- Exactly four `##` sections, in order: `Done`, `Next`, `Open questions`, `Next command`.
- Each is non-empty. `Open questions` may say `None.`
- `Next command` holds exactly one fenced code block with at least one non-blank line: the command the next session runs first.
- The whole file is at most 16 KB. Longer is refused (exit 5): a checkpoint is a pointer to the work, not a copy of it.
- The CLI writes the `# Handoff: <identifier> <title>` line; a body that has its own `#` title is refused.

**`flow checkpoint <identifier> --trigger <trigger> --body-file <file> [--task <id>] [--spec <path>]`**

- Runs in the item's worktree (`--project`, default cwd). Refuses (exit 5) when cwd is not a git worktree.
- Validates the body, builds the header, writes `HANDOFF.md` by temp file + `rename` (the old one first renamed to `HANDOFF.prev.md`), then sets `FlowRun.checkpointAt` and `FlowRun.checkpointSha` (= `headSha`) through the S1 store when a run exists.
- No run record is fine: the header takes what git and the flags give; `sessionId`, `account`, `host` are null.
- `--json`: `{ v, path, header }`.

**When a checkpoint is written**

| Moment | Who writes it | What enforces it |
| --- | --- | --- |
| Every stage boundary | The stage skill, through `flow stage <id> <stage> --checkpoint-file <file>`, which writes the checkpoint (trigger `stage`, `stage` = the new stage) then transitions | For a run with `FlowRun.drain` set, `flow stage` without `--checkpoint-file` exits 5. Outside a drain it warns on stderr. |
| After each EXECUTE task | The worker, `flow checkpoint <id> --trigger task --task <id>` after the task's commit | `flow report <id> pushed` (§4.5) refuses a SHA with no checkpoint at it (`checkpointSha` must equal the pushed SHA) |
| When the account warns | The worker, `flow checkpoint <id> --trigger limit-warning`, told by the hook (§5.4) or the supervisor's message | The handoff machine (§5) treats a warning episode as wound down only when a `limit-warning` checkpoint newer than `limit.since` exists; past the grace time it writes a synthesized one |

**A synthesized checkpoint** (`synthesizeCheckpoint(prev, facts)`, pure) is what the supervisor writes when a session stopped without a fresh one (a hard stop, or a worker that ignored the wind-down):

- `trigger: "synthesized"`, measured header as usual.
- `Done`: the previous checkpoint's `Done`, plus `git log --oneline <prev.headSha>..HEAD` (up to 20 lines) as "commits since the last checkpoint".
- `Next` and `Next command`: the previous checkpoint's.
- `Open questions`: the previous ones, plus "The previous session stopped at <time> (<reason>) without a checkpoint. Run `git status` and check any uncommitted work before continuing."
- With no previous checkpoint: `Next` is "Continue the `<stage>` stage of <identifier>. Read the worker brief at `<brief path>`." and `Next command` is `git status && git log --oneline -5`.

**The resume message** (rendered by `messages.ts`, §4.4) is the only thing a new session is told:

> You are continuing <identifier> in this worktree (<path>), on branch <branch>. Read `.dork/flow/HANDOFF.md`, then your brief at `.dork/flow/drain/briefs/worker.md`, then run the command under "Next command". The previous session was on another account; do not run `flow claim`, the run is already yours.

### 2. Launchers (DOR-2372)

#### 2.1 The interface (`scripts/launchers/types.ts`, dependency-free)

```ts
type HostName = 'cli' | 'cmux' | 'dorkos';

interface LaunchAccount {
  id: string;   // registry id (S1 §1.1a)
  path: string; // absolute CLAUDE_CONFIG_DIR
}

interface LaunchRequest {
  role: 'worker' | 'reviewer';
  identifier: string;            // the tracker item, for titles and logs
  account: LaunchAccount | null; // null = the ambient account (§3.4)
  cwd: string;                   // absolute; must exist
  promptFile: string;            // absolute; the first message's content
  sessionId: string;             // a fresh UUID the caller minted (a host may replace it; §2.6)
  model?: string;                // a models.bindings value
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions';
  title: string;                 // e.g. "ACME-12 worker"
}

interface SessionHandle {
  host: HostName;
  sessionId: string;
  account: string | null;        // registry id
  cwd: string;
  pid?: number;                  // cli, cmux: the claude process flow started
  surface?: string;              // cmux
  workspace?: string;            // cmux
  logFile?: string;              // cli: the stream-json log
  logOffset?: number;            // cli: bytes already ingested (§2.3)
}

type SessionState =
  | { kind: 'busy' }
  | { kind: 'idle' }
  | { kind: 'exited'; code: number | null }
  | { kind: 'limited'; window: string | null; resetsAt: string | null }
  | { kind: 'unknown'; reason: string };

interface Launcher {
  readonly host: HostName;
  /** Can this host start a session right now? Never throws. */
  probe(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Start a session and deliver the first message. Throws LaunchError. */
  start(req: LaunchRequest): Promise<SessionHandle>;
  /** Deliver a message file to a session, resuming it if it has exited. */
  send(h: SessionHandle, messageFile: string): Promise<{ result: 'delivered' | 'queued'; handle: SessionHandle }>;
  state(h: SessionHandle): Promise<SessionState>;
  /** Stop a session flow started. Never kills anything flow did not start. */
  stop(h: SessionHandle): Promise<'stopped' | 'left-idle' | 'not-running'>;
}

class LaunchError extends Error {
  code: 'unavailable' | 'bad-request' | 'wrong-account' | 'not-started' | 'auth' | 'refused';
}
```

- The handle is stored in `FlowRun.drain.worker` / `.reviewer` (§4.3), so a later tick or a restarted supervisor adopts the session.
- Launchers are constructed with injected deps (`run` for `execFile`, `spawn`, `fetch`, `fs`, `env`, `now`, `sleep`), so the contract suite (§2.7) runs them against fakes.

**Rules every launcher keeps**

- **No shell.** Every command is an argv array through `execFile`/`spawn`. The one shell line flow builds is cmux's `--command` (§2.4), through one `shellQuote` function; any value with a newline or NUL is refused (`bad-request`).
- **Validate first.** `cwd` and `promptFile` absolute and existing; `account.path` absolute. Else `bad-request`, nothing started.
- **The account is set, then verified.** cli and cmux set `CLAUDE_CONFIG_DIR=<account.path>` for the child. For the ambient account they set it to the supervisor's resolved ambient dir (its own `CLAUDE_CONFIG_DIR`, else `~/.claude`), explicitly, because a cmux shell does not inherit the supervisor's environment. Each launcher then proves the session bills that account (below); a mismatch stops the session if flow can, and throws `wrong-account`.
- **No other credential rides along.** A config dir names the account only if nothing overrides its login. cli and cmux remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` from the child (cli: from the spawn env; cmux: the `--command` line starts with `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN`, since cmux's shell may export them). Otherwise the session would silently bill that key instead of the named account.
- **The first message is a pointer.** Every message is a file; the session gets one line: `Read <file> and do exactly what it says.` (cmux turns each newline into Enter, and a positional prompt does not survive `--command`.)
- **Started means started.** `start` returns only after the session is confirmed busy or its transcript exists, within `startTimeoutMs` (default 90 s). Else `not-started`.
- **Stop only what flow started**, by the pid it recorded, after checking the pid still runs a `claude` command (`ps -o command= -p <pid>`). Nothing is killed by name.

**Proving the account** (`proveAccount`, shared by cli and cmux): the transcript `<account.path>/projects/*/<sessionId>.jsonl` exists, so the session runs in that config dir. The cli launcher also reads `apiKeySource` on the stream's `system`/`init` message and throws `wrong-account` unless it is `none` (the config dir's own login, not a key); an interactive cmux session shows no init message, so there the stripped environment is the guarantee. DorkOS proves the dir through the API (§2.5); its runtime owns which credential it uses.

#### 2.2 Host resolution (`scripts/launchers/resolve.ts`)

`resolveHost(pref, env, probes)` is pure over the probe results:

- `pref` is `--host`, else `drain.host` in config, else `auto`.
- A named host whose probe fails is an error (exit 3) that prints the probe's reason. It never falls back: **a missing host is reported, not guessed**.
- `auto` picks, in order: `cmux` when `CMUX_SURFACE_ID` is set and the cmux probe passes (the supervisor itself runs inside cmux); `dorkos` when its probe passes; else `cli` when its probe passes; else exit 3 listing all three reasons.
- The choice and why are printed once at drain start (stderr), and recorded on each run as `FlowRun.host`.

#### 2.3 Plain CLI launcher (`scripts/launchers/cli.ts`)

- **probe:** `claude --version` exits 0. Else "the `claude` binary is not on PATH".
- **start:** spawn, detached, with `cwd` and the account env (credential variables removed):
  `claude -p "Read <promptFile> and do exactly what it says." --output-format stream-json --verbose --session-id <sessionId> --permission-mode <mode> [--model <model>]`
  stdout to `<cwd>/.dork/flow/drain/logs/<sessionId>.jsonl`, stderr to `….err.log`, `unref()`. Handle gets `pid`, `logFile`, `logOffset: 0`. Confirmed started when the log's first `system`/`init` line arrives and `proveAccount` passes.
- **send:** pid alive → write the message under `.dork/flow/drain/inbox/<sessionId>/` and return `queued`; the runner delivers queued messages when the process exits. Pid gone → spawn `claude -p "<pointer>" --resume <sessionId> …` with the same account, cwd, mode and log file (appending); `delivered`, with the new pid in the handle.
- **state:** pid alive → `busy`. Else read the log from the last `system`/`init`: a `rate_limit_event` with `status: "rejected"`, or a `result` whose error is a rate limit → `limited` (window and reset from the event); else `exited` with the exit code the runner recorded, or `null`.
- **Ledger:** each tick the runner calls `ingestStreamLog(handle)`: every `rate_limit_event` after `logOffset` becomes an observation per S1 §1.2's `sdk_event` row (`utilization × 100`, `resetsAt` epoch seconds → ISO, `rateLimitType` as the window key, `observedAt` = when the runner read the line, since the event carries no time) and is merged into `<dorkHome>/runtimes/claude-code/usage/<account>.json` through S1's writer; `logOffset` advances. A headless session has no status line, so this is its only live usage source. The ambient account (no registry id) records nothing.
- **Transcript fallback:** when the stream carries no `rate_limit_event` (a Claude Code version without it), `transcriptLimit(path)` reads the last 64 KB of the session transcript for the structured `"error":"rate_limit"` entry, per S1's `transcript` row.
- **stop:** SIGTERM the recorded pid (after the `ps` check) → `stopped`; no process → `not-running`.

#### 2.4 cmux launcher (`scripts/launchers/cmux.ts`)

The sequence is cmux-control's, proven by hand (`CLAUDE.md` lines 49–93).

- **Binary:** `CMUX_BUNDLED_CLI_PATH` when set, else `cmux` on PATH.
- **probe:** `cmux identify --json` exits 0. Else "cmux is not running (`<stderr first line>`)".
- **start:**
  1. `cmux workspace create --name <title> --cwd <cwd> --focus false --json --command "env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR=<q(path)> claude --session-id <sessionId> --permission-mode <mode> [--model <q(model)>]"` → `workspace_ref` (for the ambient account, `path` is the supervisor's resolved ambient dir). `--command` delivers the line and Enter at spawn time.
  2. Wait (≤ 30 s, polling 500 ms) for `<account dir>/sessions/<pid>.json` whose `sessionId` equals ours → `pid`.
  3. Resolve the surface: the row of `cmux top --all --processes --format tsv` whose process is `pid` → `surface`.
  4. `cmux send --surface <surface> "Read <promptFile> and do exactly what it says.\n"`. Never `--workspace`: it hits whichever surface is selected.
  5. Confirmed when `sessions/<pid>.json` shows `status: "busy"` or `proveAccount` passes, within the timeout. Idle with no transcript means the pointer never arrived: `not-started`.
- **send:** check the surface still hosts our pid and `sessions/<pid>.json` still names our `sessionId` (surface numbers are not stable across a cmux restart; re-resolve from the pid). Then `cmux send --surface … "<pointer>\n"`; Claude Code queues input typed while busy → `delivered`. Process gone → a new workspace with `claude --resume <sessionId> --permission-mode <mode>` (permission mode is not restored on resume, so it is always passed), then the pointer; the handle gets the new pid, surface and workspace.
- **state:** pid alive → `sessions/<pid>.json` `status` (`busy` or `idle`); `transcriptLimit` → `limited`; pid gone → `exited` (`code: null`).
- **stop:** SIGTERM the pid (after the `ps` check), then `cmux workspace rename <workspace> --title "<title> (stopped)"`. The workspace stays, so the operator can read it.

#### 2.5 DorkOS launcher (`scripts/launchers/dorkos.ts`)

- **Base URL:** `DORKOS_URL`, else `http://127.0.0.1:<DORKOS_PORT or 4242>`.
- **Token** (only for `/mcp`): `DORKOS_MCP_TOKEN`, else the file `<dorkHome>/mcp-local-token`. Never logged or printed.
- **probe:** `GET /api/health` answers 2xx within 3 s. Else "DorkOS is not answering at <url>".
- **start**, preferring the MCP tool:
  1. `POST /mcp` JSON-RPC `tools/list` with the bearer token. When it lists `session_start`: `tools/call session_start { prompt: <pointer>, cwd, account: account.id, runtime: "claude-code", model, permissionMode, seedContext }`. The tool mints the session id; the handle takes the result's `sessionId`. The tool applies DorkOS's own guards, its launch cap and its permission clamp; a refusal is `refused` with the tool's words, never retried through the route (a guard's no is policy). **Landing order:** S4's account guards consult the Flow extension (S4 X3), so the extension's guard must ship with or before `session_start` accepting `account`; until both are live on a machine, a refused launch releases the claim and says why.
  2. Otherwise (no token, a 401, or no such tool): `POST /api/sessions/<sessionId>/messages { content: <pointer>, cwd, runtime: "claude-code", account: account.id, seedContext }` → 202.
  3. `seedContext` is one line: "flow started this session as the <role> for <identifier> (flow id <minted id>)." The ambient account omits `account`.
- **The canonical id:** DorkOS may rebind a route-started session to the id its runtime assigns. The handle (and so `FlowRun.sessionId`, which the hook and DorkOS's flow-run link match on) takes the `id` that `GET /api/sessions/<sessionId>` returns, never the id flow minted.
- **Proving the account:** `GET /api/sessions/<sessionId>` (retry for up to the start timeout until it exists); its `account` must equal `account.path` after `path.resolve`. The HTTP route ignores an unknown id with only a server-side warning, so this check is what makes the launch honest. A mismatch throws `wrong-account` and the session is left idle (DorkOS has no stop call flow may use).
- **send:** `POST /api/sessions/<id>/messages { content: <pointer> }` → 202 `delivered` (DorkOS queues a message sent while a turn runs).
- **state:** `GET /api/sessions/<id>`. With S4's `status`: `limit` set → `limited`; `lifecycle` running → `busy`; otherwise `idle`. Without it (an older DorkOS): `unknown` ("this DorkOS does not report session status"); the runner then relies on the ledger, which DorkOS writes (S4), and on reports.
- **stop:** `left-idle`. The session stays in DorkOS for the person.
- **Errors:** a 401 or 403 on the HTTP route → `auth`: "DorkOS refused the request because sign-in is on. Set DORKOS_MCP_TOKEN to an API key." Any other non-2xx → `unavailable` with the status and the server's message.
- **`workerPid`:** a DorkOS session is not a local process flow started, so the run's `workerPid` is `-1`, and liveness for `host: dorkos` comes from `state` (§4.3).

#### 2.6 Session ids and the claim

- The runner mints the UUID before the claim, and the claim writes the run as `status: "queued"` (an existing `FlowRunStatus`: "claimed, run record written, worker not yet launched") with that id. S1's claim writes `running`; S3 adds an internal `queued` option to the claim function, not a new flag.
- After `start` returns, the run becomes `running` with the handle's `sessionId` (the MCP tool may have minted a different one), `workerPid` (the pid, or `-1`), `account` and `host`.
- If `start` throws, the claim is released (`--to ready`, with the resume stage) and the error is reported. No run record ever names a session that was not started or planned.

#### 2.7 The contract suite (`engine-tests/launchers/contract.ts`)

One `describe` factory, `launcherContract(name, makeHarness)`, runs identical cases against each launcher, where each harness provides the launcher wired to fakes plus a way to script the fake host:

- cli: a fake `spawn`/`execFile` recording argv, env and cwd, and writing a scripted stream log and transcript file into a temp config dir.
- cmux: a fake `cmux` executable (a small Node script on a temp PATH) that records its argv and plays scripted `workspace create`, `top` and `send` replies; the fake claude writes `sessions/<pid>.json` and the transcript.
- dorkos: an in-process HTTP server with `/api/health`, `/api/sessions/:id/messages`, `/api/sessions/:id` and `/mcp` (with and without `session_start`).

Cases, each asserted on the fake's record, not on the launcher's return alone:

1. `start` runs the session in the requested `cwd` on the requested account (env `CLAUDE_CONFIG_DIR` = path, or the DorkOS body's `account` = id) and returns a handle with the session id and host.
2. The ambient account (`account: null`) passes the supervisor's own `CLAUDE_CONFIG_DIR` through unchanged (cli/cmux) or omits `account` (dorkos).
3. The first message is a single line pointing at `promptFile`.
4. A session that bills another account throws `wrong-account` (cli/cmux: the transcript appears under a different dir; dorkos: the session's `account` differs).
5. A host that is not there: `probe` returns `ok: false` with a reason, and `start` throws `unavailable` with that reason. Nothing else is tried.
6. A session that never confirms within the timeout throws `not-started` (the fake clock advances).
7. `send` delivers a single-line pointer to a live session, and resumes an exited one on the same account and cwd.
8. `state` maps the fake's busy, idle, exited and limited signals.
9. `stop` stops only a pid flow started (a pid whose `ps` command is not `claude` is left alone), and DorkOS answers `left-idle`.
10. No command runs through a shell: every recorded call is an argv array; cmux's `--command` string round-trips a path containing a space, a quote and `$` through `shellQuote` exactly.
11. `bad-request` for a relative `cwd`, a missing `promptFile`, or a value with a newline.
12. With `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` in the supervisor's environment, none reaches the child (cli env; cmux `env -u` prefix); a cli stream whose init reports an `apiKeySource` other than `none` throws `wrong-account`.

**Live smoke** (`engine-tests/launchers/live.test.ts`): one real session per host, gated by `FLOW_LAUNCHER_LIVE=1` read at module scope, with `FLOW_LAUNCHER_LIVE_ACCOUNT=<id>`. Each starts a session in a temp git repo with the message "Reply with the single word ready, then stop.", proves the account, waits for idle or exit, and stops it. It spends a few tokens of a real subscription, so it never runs in CI or in `npm test` without the flag; the task's PR records its output as the evidence for "starts a real official session".

#### 2.8 Runtimes (operator direction, 2026-09-26)

flow runs from Claude Code, Codex and OpenCode sessions, so a launch names a runtime as well as an account.

- `LaunchRequest.runtime` and `SessionHandle.runtime` are `claude-code` | `codex` | `opencode`. An account belongs to one runtime: a `CLAUDE_CONFIG_DIR`, a `CODEX_HOME`, or an OpenCode provider profile. A runtime with no registered accounts has one implicit `default` account, the ambient environment.
- `Launcher.supports(runtime)` answers before anything starts. An unsupported (host, runtime) pair throws `unsupported` with its reason and starts nothing; flow never swaps in another runtime or host.
- `resolveHost` takes the runtime: a named host that cannot run it is an error naming the pair; `auto` picks the first host that both probes ok and supports it.

| Host | claude-code | codex | opencode |
| --- | --- | --- | --- |
| cli | `claude -p … --output-format stream-json` with `CLAUDE_CONFIG_DIR` | `codex exec --json -C <cwd> …` with `CODEX_HOME` (`acceptEdits` = workspace-write with network on and the shared git dir writable, so a worker can commit and push); resume `codex exec resume <id>` | `opencode run --format json …` in the worktree; resume `--session <id>` |
| cmux | interactive `claude`, as §2.4 | unsupported today ("use --host cli") | unsupported today ("use --host cli") |
| dorkos | `session_start` / the route with `runtime: "claude-code"` | the same with `runtime: "codex"` | the same with `runtime: "opencode"` |

**Proving the account, per runtime:** Claude Code as §2.1 (`apiKeySource`, the transcript under the config dir). Codex: the session's rollout file exists under `<CODEX_HOME>/sessions/`, and its `plan_type` is recorded when reported; `OPENAI_API_KEY` and `CODEX_API_KEY` are stripped so the `CODEX_HOME` login is what bills. OpenCode: the session's provider matches the account's provider when the account names one. DorkOS: the session reports the requested `runtime` and, for claude-code, the requested config dir.

The wind-down hook (§5.4) is Claude-only; Codex and OpenCode workers get the supervisor's `wind-down` message. Ranking over (runtime, account) pairs, `fleet.runtimes`, and `crossRuntimeFallback` belong to phases 3 and 4 and are specified there.

### 3. Account-aware dispatch (DOR-2373)

All of §3 lives in `scripts/drain/account-rank.ts`: pure, dependency-free, fed S1's resolved identities, policy and `readWindow` results. `now` is always an input.

#### 3.1 The limit signal (shared by eligibility and handoff)

`limitSignal({ windows, policy, model, now, warnMarginPct })` → `{ level: 'ok' | 'warning' | 'exhausted' | 'unknown', window, resetsAt, cause: 'limit' | 'reserve' | null }`

Windows checked, each with a ceiling:

| Window | Ceiling |
| --- | --- |
| `five_hour` | 100 |
| `seven_day` | `100 − effectiveReservePct` (S1 §1.1b) |
| each of `modelBucketsFor(model)` | 100 |

- `exhausted` when any checked window's `status` is `rejected` or `usedPct ≥ ceiling`. `cause` is `reserve` when only the reserve made it exhausted (weekly `usedPct` under 100), else `limit`.
- `warning` when not exhausted and any window's `status` is `allowed_warning` or `usedPct ≥ ceiling − warnMarginPct` (`drain.warnMarginPct`, default 10).
- `ok` when every checked window has a reading and none trips; `unknown` when none trips and some window has no reading.
- `window` and `resetsAt` name the worst window (exhausted before warning; then the soonest `resetsAt`).
- `modelBucketsFor(model)`: `model:<slug>` where slug is the model lowercased with every run of characters outside `[a-z0-9._-]` turned into `-`; plus `seven_day_opus` when the model contains `opus`, `seven_day_sonnet` when it contains `sonnet`. No model → none. A bucket the ledger does not have reads as no reading, which never blocks.

#### 3.2 Eligibility

`rankAccounts(input)` where `input = { now, repo, accounts, model, affinity, exclude, liveByAccount, opts: { warnMarginPct, maxLivePerAccount } }` and each account carries its identity, resolved policy and windows. An account is ineligible, with every reason that applies:

| Reason | When |
| --- | --- |
| `not-routable` | its id fails the pattern (S1 §1.1a) |
| `excluded` | in `exclude` (the account a handoff is leaving) |
| `out-of-scope` | `!mayServe(policy, repo)` (kept-out outside its `scope.repos`, including every unlisted account) |
| `limited` | `limitSignal` is `exhausted` |
| `near-limit` | `limitSignal` is `warning`: new work would wind down at once |
| `at-capacity` | `liveByAccount[id] ≥ maxLivePerAccount` (default 2): several workers on one account burn its 5-hour window together |

An `unknown` signal is eligible: no reading is not evidence of no room, and S2's probe exists to fill it.

#### 3.3 Ordering

Eligible accounts are ordered in three tiers:

1. **Warm cache.** `affinity` (the account of the item's current or last session) when eligible, and not a `main` outside its spend-down window (that would break S1's "main only when no other is eligible"). A follow-up step that stays there resumes a warm prompt cache; eligibility already excludes an account near a limit.
2. **Use it before you lose it.** Every other eligible account, except a `main` outside its spend-down window, by `score` descending:
   - `remaining = (100 − effectiveReservePct) − seven_day.usedPct`; with no weekly reading, `100 − effectiveReservePct`.
   - `hours = max(1, (seven_day.resetsAt − now) / 1 h)`; with no reset time, `168`.
   - `score = remaining ÷ hours`.
   - Ties: the lower `five_hour.usedPct` (no reading counts as 0), then `id` ascending.
3. **The main account last.** A `main` outside its spend-down window, by the same score. Inside its window its reserve is 0 and it joins tier 2, where its short `hours` usually puts it first.

Output: `{ pick: string | null, ranked: { id, tier, score, signal }[], ineligible: { id, reasons }[] }`.

Worked example (the DOR-2373 criterion): A has 40% left resetting in 24 h (`score` 1.67); B has 60% left resetting in 144 h (0.42). A ranks first.

#### 3.4 Choosing the account, and the ambient account

`chooseAccount({ identities, rank, ambientPath })`:

- **No identities registered:** `{ account: null, reason: 'no-registry' }`. The session runs on the ambient account (`CLAUDE_CONFIG_DIR`, else `~/.claude`), as flow does today. A one-account user needs no fleet setup.
- **Identities registered:** the rank's `pick`, or `{ account: none, reasons }` when nothing is eligible. It **never** falls back to the ambient account, because the ambient dir may itself be a kept-out account (the client's org account), and S1's rule is that nothing is spent until the operator says so. `flow next` and `flow drain` then print "No account may take work for <repo>: <per-account reasons>. Run `flow accounts set <id> --role rotation` to allow one."

#### 3.5 `flow next` picks the account too

S1's `flow next` gains, per picked item, `account: { pick, ranked, ineligible, reason }` (JSON) and a `→ <account label>` suffix (human).

- `repo` comes from the `--project` checkout's `origin` (S1 §1.1b parsing). `model` is `models.bindings[models.tiers.implementation]`, or null.
- With `-n N`, items are assigned in rank order, and each assignment adds one to `liveByAccount`, so N items spread across accounts instead of piling onto one.
- `liveByAccount` counts `running` and `queued` runs in `flow-state.json` by `FlowRun.account` (worker and reviewer handles both count).
- `--no-account` skips assignment (S1 behavior). Assignment needs no tracker call.

#### 3.6 The machine-load cap

`launchBudget({ load1, cpus, live, parallel, maxLoadPerCpu })` → `{ slots, reason }`:

- `slots = 0`, `reason: 'machine-busy'` when `load1 / cpus ≥ maxLoadPerCpu` (default 1.5; `os.loadavg()[0]`, `os.availableParallelism()`).
- Else `slots = max(0, parallel − live)`, where `live` counts worker and reviewer sessions of this drain that are not exited.
- Only new launches wait. Running sessions are never stopped for load.

#### 3.7 Runtimes (contract rev 6)

- Candidates are (runtime, account) pairs: `claude-code:acct-2`, `codex:default`. A runtime with no registered accounts has one implicit `default` account (rotation), which is its ambient environment; it is ranked like any other account, so policy, room and capacity all apply. This replaces §3.4's `no-registry` ambient fallback: there is no fallback outside the ranking.
- The item's runtime is `FlowRun.runtime`, else the first entry of `fleet.runtimes`, else `claude-code`. Same-runtime candidates always rank first.
- With `fleet.crossRuntimeFallback: off` (the default) other runtimes are left out entirely. With it `on` they rank after every same-runtime candidate, in `fleet.runtimes` order, then any unlisted runtime. `HANDOFF.md` is runtime-neutral, so a continuation on another runtime reads the same checkpoint.
- Room follows S1's `accountRoom`: windowed accounts as §3.1; a metered account (OpenCode on an API key) is eligible until `spend.limitUsd`; a local-model account is always eligible.
- Model buckets apply only within the candidate's own runtime, and use S1's `bucketSlug`.
- `liveByAccount` is keyed `<runtime>:<id>`.

### 4. The parallel drain (DOR-2373)

#### 4.1 `flow drain`

`flow drain [--parallel N] [--host auto|cli|cmux|dorkos] [--items <id,…>] [--project <name|id>] [--permission-mode <mode>] [--tick] [--manual] [--dry-run]`

- `--parallel` defaults to `drain.parallel` (§6), which defaults to 0. With 0 and no flag, it exits 2: "set --parallel or drain.parallel".
- `--tick`: one pass, then exit. This is what a scheduler runs (the DorkOS `flow-drain` schedule, cron). Without it the command loops every `drain.pollSeconds` (default 60) until no run is active and nothing is eligible, or SIGINT. SIGINT exits and leaves every session running; the next `flow drain` adopts them from `flow-state.json`.
- **One supervisor per project:** `<main checkout>/.dork/flow/drain.lock` holds `{ pid, token, startedAt }`, created with exclusive-create. A lock whose pid is alive → exit 5 ("a drain is already running, pid N"). A dead pid's lock is replaced by rename-then-verify, as S1 §1.2 step 2 breaks a stale lock. `--tick` holds it only for the pass.
- Paused → exit 7 unless `--manual` (S1). `--dry-run` prints each action a pass would take and changes nothing.
- `--items` restricts picking to those identifiers (in the given order), for items the operator has grouped or sequenced.

#### 4.2 One pass

1. **Gather facts** for every run in `flow-state.json` with `drain` set and `status` `queued` or `running`: `launcher.state` of the worker and reviewer; `ingestStreamLog` for cli handles; the account's ledger windows; the checkpoint header; the reports recorded on the run (§4.5); the forge's PR status when `drain.pr` is set, and `prForBranch` (any open PR on the run's branch) while it is not; the tracker item (one `getItem` per run) to notice it closed or lost its claim.
2. **Decide** with the two pure reducers: `drainStep` (§4.4) and `nextHandoffAction` (§5). Each returns the new run state and a list of actions.
3. **Act**, in order: stop sessions, send messages, handoffs, launches, forge calls, tracker writes. Each action is idempotent against the recorded state, so a pass that dies midway is repeated safely next time.
4. **Fill slots:** `launchBudget` → `flow next -n <slots>` logic (with `--items`) → for each pick with an account: mint an id, provision the worktree, render the brief, claim (`queued`), `start`, record `running`. A pick with no account is skipped and reported.
5. **Report** one line per run that changed (stdout; `--json` gives `{ v, runs: [{ identifier, phase, account, host, event }] }`).
6. **Usage for the retro:** each pass writes the journal's usage snapshot for the accounts it considered, at most once per 15 minutes per `<runtime>:<account>`, so trends exist without anyone running `flow usage scan`.

#### 4.3 The run's drain state

`FlowRun` gains optional fields. They are flow's own: S1 §1.3 already makes every reader pass unknown fields through, and DorkOS reads only `identifier`, `sessionId`, `stage` and `status`, so this is not a contract change. `flow-run.cases.json` gains a case proving a record carrying them reads back unchanged.

```ts
interface FlowRun {
  // … S1 fields …
  checkpointAt?: string;          // ISO, the last flow checkpoint
  checkpointSha?: string;         // headSha of that checkpoint
  drain?: DrainState;
  limit?: RunLimit;               // §5
}

interface DrainState {
  v: 1;
  rev: number;                    // bumped by every write (§4.3)
  phase: 'working' | 'reviewing' | 'fixing' | 'pr-ready' | 'watching' | 'fixing-ci' | 'closing' | 'parked';
  worker: SessionHandle | null;
  reviewer: (SessionHandle & { sha: string; worktree: string; tokenHash: string; pending?: boolean }) | null; // tokenHash: §4.5
  // worker handles carry pending?: boolean too (§4.3, intent before launch)
  pushedSha: string | null;       // last SHA the worker reported pushed
  reviewedSha: string | null;     // the SHA of the latest verdict
  verdict: 'clean' | 'changes' | null;
  reviewRound: number;            // verdicts so far
  pr: { repo: string; number: number; url: string; armed: boolean; disarmedForReview: boolean } | null;
  rearmedFor: string | null;      // the head SHA an innocent ejection was re-armed for (once per SHA)
  nudges: number;                 // "you stopped without reporting" messages sent this phase
  wakeAfter: string | null;       // skip this run until then
  handoffs: { from: string | null; to: string | null; at: string; reason: 'warning' | 'rejected' | 'manual' | 'reset' }[];
  parkedReason: string | null;
}
```

- `status` stays in S1's enum. A new status value would make every older reader reject the whole file (the `FlowRunStatus` schema is a `z.enum` inside an all-or-nothing record), which is why "limited" and every drain phase are fields, not statuses.
- For `host: dorkos`, `workerPid` is `-1`. S1's `flow status` drift check "a run whose `workerPid` is not alive" skips runs with `drain` set and reports `launcher.state` instead (task 3.5 changes it).

**flow's recovery pass leaves drain runs alone.** The existing recovery ladder (`skills/flow-drain` step 1, `scripts/recovery.ts`) treats a run whose `workerPid` is dead as an orphan and resumes its session. A cli worker exits after every `-p` turn and a DorkOS worker has `workerPid: -1`, so recovery would resume a session the supervisor already manages: two writers in one worktree. Recovery skips every run with `drain` set; the supervisor is their only recovery (task 3.5).

**Who writes which field.** Three kinds of writer touch one run: the supervisor, the `flow report`/`flow pr` verbs a worker or reviewer runs, and `flow handoff`. Every write goes through S1's locked read-modify-write, and ownership is split so no writer overwrites another's news:

- **Report-owned:** `pushedSha`, `verdict`, `reviewedSha`, `reviewRound`, `pr`, `checkpointAt`, `checkpointSha`. Only the verbs write them.
- **Supervisor-owned:** everything else under `drain` and `limit`, plus the run's `account`, `host`, `sessionId`, `workerPid` on launch and handoff.
- **Compare-and-set:** every write by every writer (`flow checkpoint`, `flow report`, `flow pr`, `flow handoff`, the supervisor) bumps `drain.rev` (an integer). The supervisor applies a pass's result for a run only if, re-read under the lock, `rev` still equals what it gathered. If a report landed in between, that run's decision is dropped and re-made next pass.
- **Intent before launch:** a pass that will start a session first writes, by that compare-and-set, the intent: the minted `sessionId`, the role, and for a reviewer the SHA and the token's hash, in the handle slot with `pending: true`. Only then does it call `start`. The resulting handle is written by a second update that needs no unchanged `rev` (the slot is supervisor-owned and the intent already claimed it). A pass that dies between the two leaves a pending slot, which the next pass resolves by looking for the minted session (below).
- **Adopt before releasing:** a pending slot, or a `queued` run with no handle, older than the start timeout, is checked for its minted session first (cli and cmux: `sessions/*.json` and the transcript under the account dir; DorkOS: `GET /api/sessions/<id>`). Found → adopted into the slot. Not found → the slot is cleared (a `queued` worker's claim is released to ready). **Except a worker on DorkOS**, where `session_start` may have minted the id server-side (the intent is written before the launcher picks its path), so "not found" proves nothing: that run parks instead ("the supervisor stopped while starting a DorkOS session; check DorkOS for a session in <worktree> whose context names flow id <minted id>, then `flow release` or re-run"). The `seedContext` carries the minted id for exactly this search. A reviewer slot is simply cleared and a fresh reviewer started: it works in its own detached worktree, so there is no second-writer risk. A live worker is never orphaned into a second writer.
- **One handoff at a time:** a handoff first sets `limit.state = 'handing-off'` with a fresh `handoffToken`, by compare-and-set on the old `sessionId`. A second handoff (the supervisor and `flow handoff` at once) finds the state taken and stops. If the starting session fails, the state goes back to `awaiting-handoff`.

#### 4.4 The drain reducer (`scripts/drain/drain-step.ts`, pure)

`drainStep(run, facts, cfg, now)` → `{ run, actions }`. The handoff reducer runs first; while `run.limit` is set, `drainStep` only records reports and takes no phase step that would message the worker.

| Phase | Fact | Next phase | Actions |
| --- | --- | --- | --- |
| (picked) | | `working` | provision worktree, render worker brief, claim `queued`, start worker |
| `working` | report `pushed` S | `reviewing` | start reviewer at S (§4.7) |
| `working` | worker exited or idle with no new report, `nudges < 2` | `working` | send `continue` ("you stopped before reporting a push; continue from HANDOFF.md, or run `flow report <id> blocked`"); `nudges + 1` |
| `working` | the same, `nudges = 2` | `parked` | park: "the worker stopped twice without pushing" |
| `reviewing` | verdict `clean` at S, S is the branch head on origin, no PR | `pr-ready` | stop reviewer; send `open-pr` |
| `reviewing` | verdict `clean` at S, S is the head, PR exists | `watching` | stop reviewer; arm the PR if `disarmedForReview` |
| `reviewing` | verdict `changes` at S | `fixing` | stop reviewer; send `review-findings` with the findings file |
| `reviewing` | report `pushed` S2 before a verdict at S | `reviewing` | stop reviewer; start reviewer at S2 (a verdict for S arriving later is stale and ignored) |
| `reviewing` | reviewer exited with no verdict | `reviewing` | start a new reviewer at S (once; twice → `parked`) |
| `fixing` | report `pushed` S2 | `reviewing` | start reviewer at S2 with `deltaFrom` = the last reviewed SHA |
| `fixing` | worker stopped with no push | `fixing` | as the `working` nudge rows |
| any review phase | `reviewRound ≥ drain.maxReviewRounds` (default 5) with verdict `changes` | `parked` | park: "the review did not come back clean after N rounds" |
| `pr-ready` | `drain.pr` recorded by `flow pr` | `watching` | none |
| `watching` | forge: merged | `closing` | send `merged` ("run DONE: closing-work, then `flow done`") |
| `watching` | forge: failing checks | `fixing-ci` | send `ci-red` with the failing check names and run links |
| `watching` | forge: neither armed nor queued, and `judgeEjection` is `innocent`, `rearmedFor` ≠ head | `watching` | arm once; `rearmedFor = head` |
| `watching` | forge: neither armed nor queued, otherwise | `fixing-ci` | send `ci-red` with the ejection's failing checks |
| `watching` | forge: closed, not merged | `parked` | park: "the PR was closed without merging" |
| `fixing-ci` | report `pushed` S3 | `reviewing` | (`flow report` disarmed the PR) start reviewer at S3, `deltaFrom` the last reviewed SHA |
| `closing` | run `status` became `complete` (`flow done`) | (removed from the active set) | stop any live session flow started |
| `reviewing` | verdict `clean` at S, but the origin head moved past S | `reviewing` | if `pushedSha` is the head, start a reviewer there; else send `continue` ("report your push with `flow report pushed`") |
| `pr-ready`, `watching` | report `pushed` S ≠ `reviewedSha` | `reviewing` | (`flow report` disarmed an armed PR) start reviewer at S, `deltaFrom` the last reviewed SHA |
| `working`, `reviewing`, `fixing` | the forge shows a PR for the branch while `drain.pr` is null | `parked` | disarm it; park: "a PR was opened before a clean review" |
| (queued) | `status: "queued"` with no worker handle, or a pending one, older than the start timeout (a crash between claim and start) | `working` or (released) | adopt the minted session if it exists (§4.3), else release the claim to ready with its resume stage |
| any | tracker item closed or cancelled by someone else, or it lost `agent/claimed` | `parked` | stop sessions; no tracker write |
| any | report `blocked` | `parked` | (the report already posted the question) |

- **Park** = `drain.phase = 'parked'`, `parkedReason` set, and, unless the item was taken away, the S1 `needs-input` projection plus one signed comment with the reason, through the adapter. A parked run leaves the active set; S1's inbox path resumes it when the person answers, and the next `flow drain` pass adopts it back into `working` with a `continue` message.
- **Messages** come from `scripts/drain/messages.ts`: `continue`, `open-pr`, `review-findings`, `ci-red`, `merged`, `wind-down`, `resume-from-handoff`, `limit-cleared`. Each renders to `.dork/flow/drain/messages/<seq>-<kind>.md` in the worker's worktree and is delivered with `launcher.send`. Every message ends with the command the worker should run next.

#### 4.5 Reports: `flow report`

The worker and reviewer tell the supervisor what happened through one verb. The CLI checks each claim against git or the forge before recording it on the run.

**`flow report <identifier> pushed [--sha <sha>]`** (worker)

- `sha` defaults to `git rev-parse HEAD` in the worktree.
- Exit 5 unless `git ls-remote origin refs/heads/<branch>` equals it ("push first").
- Exit 5 unless `FlowRun.checkpointSha` equals it ("write a checkpoint at this commit first: `flow checkpoint <id> --trigger task --task <task>`, or `--trigger fix` for a review or CI fix"). This is what makes "after each task" enforceable.
- When a PR exists and is armed, disarm it (forge) and set `disarmedForReview`. A push to an open PR is not reviewed yet, and an armed PR could merge it.
- Records `pushedSha`.

**`flow report <identifier> verdict --sha <sha> --token <t> (--clean | --changes --findings-file <file>)`** (reviewer)

- Requires `--token <t>` whose SHA-256 equals `drain.reviewer.tokenHash`: the supervisor mints a random 128-bit hex per review, renders it into that reviewer's brief only, and stores only its hash (the worker can read `flow-state.json`). A worker (or a stale reviewer) cannot record a verdict, on any host, without depending on session ids a host may mint later. Exit 5 on a missing or wrong token.
- A `sha` other than `drain.pushedSha` is recorded as stale (warning, exit 0) and changes nothing.
- `--changes` copies the findings file to `<worker worktree>/.dork/flow/drain/reviews/<round>-<sha7>.md`.
- Records `verdict`, `reviewedSha`, `reviewRound + 1`.

**`flow report <identifier> blocked --question-file <file>`** (worker)

- Applies the S1 `needs-input` projection and posts the question as a signed comment through the adapter; sets `drain.phase = 'parked'`.

#### 4.6 The PR gate and the forge

**`flow pr <identifier> --title <text> --body-file <file> [--arm | --no-arm]`**

- Exit 5 unless the run's `verdict` is `clean` and `reviewedSha` equals the branch head on origin (`git ls-remote`). **This is the gate that makes "no PR before a CLEAN review" true in code**: the worker brief never runs `gh pr create` itself.
- Appends the provenance line to the body when missing (`docs/provenance.md`).
- Creates the PR (head = the run's branch, base = origin's default branch), arms it when `--arm` or `drain.armAutoMerge` (default false), records `drain.pr`.
- Exit 5 when a PR already exists for the branch (it records the existing one instead, so a retry is safe).

**The forge** (`scripts/forge/types.ts`, `scripts/forge/github.ts`): `branchHead`, `prForBranch` (`gh pr list --head <branch> --state open`), `createPr`, `prStatus` (`{ state: 'open' | 'merged' | 'closed', failing: { name, url }[], armed, queued, headSha }`), `arm`, `disarm`, `recentGroupFailures(base, checkNames, sinceMinutes)`. The GitHub implementation runs `gh` with argv arrays: `gh pr create`, `gh pr view --json state,autoMergeRequest,statusCheckRollup,headRefOid`, `gh pr merge --auto` / `--disable-auto`, `gh api graphql` for `isInMergeQueue`, `gh run list --event merge_group`. The failing-check rule is `watch.sh`'s: a check run's `conclusion` in `FAILURE | CANCELLED | TIMED_OUT | ACTION_REQUIRED`, or a commit status's `state` in `FAILURE | ERROR`. A remote that is not on github.com (or `GH_HOST`) exits 3: "flow drain supports GitHub only today".

**`flow watch`** replaces `templates/drain/watch.sh` (deleted in the same PR):

`flow watch [<identifier>…] [--pr <owner/repo>#<n>]… [--follow] [--interval <s>]`

- Watches the given runs' PRs (default: every run with `drain.pr`), plus any raw `--pr` (for work outside flow).
- Prints one line per event: `<id or pr> MERGED | CLOSED | FAILING: <checks> | EJECTED (<innocent|suspect|unknown>) | NOT-ARMED-NOT-QUEUED`.
- Without `--follow` it exits 0 on the first event (the `watch.sh` behavior a caller can block on); with it, it keeps going.
- Five failed reads in a row for one PR → exit 4 naming it (a mistyped repo or an expired login), never a silent wait.
- `--interval` default 90 s.

**`judgeEjection` (`scripts/forge/ejection.ts`, pure):** input the PR's failing checks at ejection and `recentGroupFailures` (merge-group runs on the same base branch in the last 30 minutes that did not contain this PR, with their failing check names). `innocent` when every failing check also failed in at least one of those runs; `suspect` when any failing check failed only here; `unknown` when there were no other runs or no failing checks were reported. Only `innocent` re-arms, and only once per head SHA. This is the "prove innocence" check from the source session.

#### 4.7 Workers, reviewers and briefs

**The worker**

- **Worktree:** `<dorkHome>/workspaces/<repo name>/<branch>`, branch `<identifier>-<slug>` (slug: the title lowercased, runs of non-alphanumerics to `-`, at most 40 characters). Created with `git worktree add <path> -b <branch> origin/<default>` after `git fetch origin`. An existing worktree on that branch is reused (a resumed run). S3 always uses plain `git worktree` (Decision D8).
- **Brief:** `templates/drain/worker-brief.md` becomes a template the CLI renders to `<worktree>/.dork/flow/drain/briefs/worker.md`. Placeholders: `{{identifier}}`, `{{title}}`, `{{worktree}}`, `{{branch}}`, `{{flow}}` (the full `node --experimental-strip-types <flow-root>/scripts/flow.ts` command), `{{accountLabel}}`, `{{rubric}}`. The rewritten brief keeps the recipe's phases and replaces each hand step with its verb: `flow checkpoint` after each task; `flow report pushed` after each push; wait for a message; `flow pr` when told; `flow report blocked` for a question; `closing-work` then `flow done` when told the PR merged. It no longer tells the worker to claim (the supervisor did) or to open a PR with `gh`.
- **Model:** `models.bindings[models.tiers.implementation]`.

**The reviewer**

- A separate top-level session, account chosen by `rankAccounts` with no affinity. Any eligible account will do: independence comes from a fresh session that never saw the worker's reasoning, not from a different account.
- Its cwd is a detached worktree the supervisor creates at `<dorkHome>/workspaces/<repo name>/review-<identifier>-<sha7>` (`git worktree add --detach <path> <sha>` after fetching the branch), removed after the verdict. The worker's worktree is never shared.
- **Brief:** `templates/drain/reviewer-brief.md` rendered with `{{identifier}}`, `{{sha}}`, `{{base}}` (merge-base with origin's default branch), `{{deltaFrom}}` ("also read `git diff <deltaFrom> <sha>` first" when set), `{{rubric}}` (`review.rubric`), `{{flow}}`, `{{findingsFile}}`, `{{token}}`. It ends with `flow report <id> verdict --sha <sha> --token <token> …`. The worktree steps the hand brief listed move into the supervisor.
- **Model:** `models.bindings[models.tiers.review]`.
- The reviewer is one-shot: after its verdict the supervisor stops it (cli exits by itself; cmux is stopped; DorkOS is left idle).

**Permission mode:** `--permission-mode`, else `drain.permissionMode` (default `acceptEdits`). A headless worker under `acceptEdits` can run only the commands the project's own Claude Code settings allow, so a repo whose allowlist does not cover its tests needs the operator to allow them or to choose `bypassPermissions` explicitly. flow never chooses `bypassPermissions` on its own, and DorkOS clamps it anyway.

#### 4.8 Who runs the loop

- **CLI or cmux:** the operator runs `flow drain --parallel N` in a terminal (in cmux, its own workspace). It is the supervisor `flow-fleet` §4.7 calls `flow dispatch --watch`.
- **DorkOS:** the `flow-drain` scheduled skill. When `drain.parallel ≥ 1`, its dispatch step runs `flow drain --tick` instead of carrying one item in its own session; at 0 it does what it does today. A tick per firing keeps the supervisor out of long-running background processes, which DorkOS ends after a turn. Reacting to a `rate_limit_event` within seconds is S4's server dispatcher; until it exists the reaction waits for the next tick.

### 5. Handoff on a limit (DOR-2374)

#### 5.1 The run's limit

```ts
interface RunLimit {
  level: 'warning' | 'exhausted';
  account: string | null;     // the account that hit it
  window: string | null;
  resetsAt: string | null;
  cause: 'limit' | 'reserve';
  since: string;              // ISO, when the episode began
  state: 'winding-down' | 'awaiting-handoff' | 'pending-approval' | 'waiting-reset' | 'handing-off';
  handoffToken: string | null; // set with 'handing-off' (§4.3)
  handingOffAt: string | null; // when 'handing-off' was set
  handoffSessionId: string | null; // the session id minted for the new session, for adoption
  notifiedAt: string | null;  // the ask-mode comment, once per episode
}
```

The **signal** each pass is the worse of `limitSignal` over the run's account's ledger (every host writes it) and the worker's `launcher.state` (`limited` counts as exhausted). The ambient account has no ledger; it relies on `launcher.state` alone.

#### 5.2 The state machine (`scripts/drain/handoff.ts`, pure)

`nextHandoffAction({ run, signal, session, checkpoint, policy, candidates, now, cfg })` → `{ run, actions }`, where `candidates` is `rankAccounts` with `exclude: [run.account]` and no affinity, and `policy.handoff` is `auto` or `ask` (S1 §1.1b; default `auto`).

| State | Condition | Next | Actions |
| --- | --- | --- | --- |
| (none) | signal `warning` | `winding-down` | send `wind-down` ("finish the step you are on, commit, run `flow checkpoint <id> --trigger limit-warning`, report any push, then stop and take no new step on this account") |
| (none) | signal `exhausted` | `awaiting-handoff` | none yet; the session cannot do more on this account |
| `winding-down` | signal back to `ok` before a handoff (a window reset) | (cleared) | when the worker has stopped: send `limit-cleared` ("continue") |
| `winding-down` | signal `exhausted` | `awaiting-handoff` | none |
| `winding-down` | a `limit-warning` checkpoint newer than `since`, and the worker idle or exited | `awaiting-handoff` | none |
| `winding-down` | worker idle or exited, no such checkpoint, `drain.windDownGraceMinutes` (default 20) passed since `since` | `awaiting-handoff` | write a synthesized checkpoint |
| `awaiting-handoff` | no checkpoint newer than `since` | (same) | write a synthesized checkpoint first |
| `awaiting-handoff` | `auto`, a candidate | (cleared) | **handoff** to the candidate (§5.3), reason `warning` or `rejected` |
| `awaiting-handoff` | `ask`, a candidate | `pending-approval` | **notify** once (§5.5) |
| `awaiting-handoff` | no candidate | `waiting-reset` | `wakeAfter` = the earliest `resetsAt` among this account's exhausted window and every account ineligible for `limited` or `near-limit`; none known → now + 30 min |
| `pending-approval` | the operator ran `flow handoff` | (cleared) | the verb itself hands off (§5.3), reason `manual` |
| `pending-approval` | the run's own account's signal is `ok` again | (cleared) | **resume here**: `send` `limit-cleared` to the same session, reason `reset` |
| `waiting-reset` | `now ≥ wakeAfter`, own account `ok` | (cleared) | resume here, reason `reset` |
| `waiting-reset` | `now ≥ wakeAfter`, a candidate | as `awaiting-handoff` | as `awaiting-handoff` (auto hands off, ask notifies) |
| `handing-off` | older than the start timeout (the mover died) | (cleared) or `awaiting-handoff` | if the new session it minted exists, adopt it and finish §5.3 step 5; else back to `awaiting-handoff`, token cleared; on DorkOS via `session_start` (server-minted id) park instead, as in §4.3 |

- Resuming on the same account after its reset is not a move between accounts, so `ask` allows it without approval (Decision D5). It keeps the warm transcript.
- A reviewer that hits a limit is not handed off: the supervisor stops it and starts a new reviewer at the same SHA on another account. A review restarts cheaply; no checkpoint is needed.
- The same machine runs whether the cause is the real limit or the main account's reserve.

#### 5.3 A handoff

1. Make sure a checkpoint newer than `limit.since` exists (synthesize one if not).
2. `launcher.stop(old)`: cli and cmux stop the process flow started; DorkOS leaves it idle. This keeps one writer per worktree: a limited session that a person later types into must not share the worktree with its successor.
3. The host is the run's `host`. If its probe fails, the handoff does not happen and the run parks with the probe's reason: switching hosts would be a guess (§2.2).
4. `start` a new worker on the candidate account, same `cwd`, first message `resume-from-handoff` (§1). Model and permission mode as before.
5. Rewrite the run: `account`, `host`, `sessionId`, `workerPid`, `drain.worker`; append to `drain.handoffs`; clear `limit`. `provenance` is untouched (S1: written once at run start).
6. The phase does not change: the new session continues whatever the old one was doing, and reports as usual.

**No transcript moves.** A handoff reads and writes only the worktree, `flow-state.json` and the ledger. It never reads or writes any account's `projects/` directory, and the tests assert exactly that (§Testing).

**`flow handoff <identifier> [--to <account-id>] [--reason <text>]`**

- The operator's approval in `ask` mode, and a manual move in any mode.
- `--to` must be eligible (`rankAccounts` with the run's account excluded); else exit 5 with its reasons. Without `--to`, the top candidate.
- Runs §5.3 with reason `manual`, whether or not the run is limited.
- Refuses (exit 5) while a `flow drain` holds the lock and the run is not limited, so a manual move never races a live supervisor mid-step. While limited it may run; the `handing-off` compare-and-set (§4.3) makes sure only one of it and the supervisor moves the run.

#### 5.4 Telling a live worker about a warning: the hook

A worker learns of a warning two ways. The supervisor's `wind-down` message works on every host but arrives only at the next pass. The hook tells the worker between tool calls.

- `hooks/hooks.json` gains a `PostToolUse` entry: `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" limit-check --hook`.
- `flow limit-check --hook` reads the hook's stdin JSON (`session_id`, `cwd`), finds the run whose `sessionId` matches in `cwd`'s main-checkout `flow-state.json`, computes `limitSignal` for its account from the ledger, and when it is `warning` or `exhausted` prints `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<the wind-down text>"}}`.
- **Once per episode:** it records `{ window, resetsAt }` in `.dork/flow/drain/limit-notified-<sessionId>.json` and stays silent while that matches.
- **Silent for everything else:** no matching run (a session outside flow), no ledger, any error. It always exits 0: a hook that fails must never block the worker's tool call. It imports no `zod`, reads no tracker and makes no network call; it reads two small files.
- If the installed Claude Code does not honor `additionalContext` on `PostToolUse` (checked in task 4.2), the hook is not shipped and the supervisor's message is the only path. The spec's behavior does not change, only its latency.

#### 5.5 `ask` mode says why

- Once per episode (`notifiedAt`), a signed comment on the item through the adapter: "<account label> reached its <window label> limit (resets <local time>). This run is waiting. To continue on <candidate label> now, run `flow handoff <id> --to <candidate>`. Otherwise it continues here when the limit resets."
- `flow status` (S1) shows the run's line as "limited until <time>, waiting for approval to move to <candidate>". `flow drain` prints the same line each pass it stays so.
- The item's labels do not change: the agent still owns the item, and the run resumes without a person when the limit resets. That is why this is not the `needs-input` park.
- On DorkOS, S4's `account.limited` notification also fires for the session. flow adds none of its own.

### 6. Config: the `drain` block

`scripts/config-schema.ts` gains `drain` (committed policy unless noted), with `config/config.schema.json` regenerated and `config/CONFIG.md` documenting each field:

| Field | Type, default | Meaning |
| --- | --- | --- |
| `parallel` | int ≥ 0, `0` | Workers at once. 0 = the scheduled tick carries one item itself, as today. |
| `maxLoadPerCpu` | number > 0, `1.5` | No new launch while the 1-minute load per CPU is at or above this. |
| `maxLivePerAccount` | int ≥ 1, `2` | Sessions (worker or reviewer) on one account at once. |
| `maxReviewRounds` | int ≥ 1, `5` | Review verdicts before a run parks. |
| `warnMarginPct` | 0–50, `10` | How close to a ceiling counts as a warning. |
| `windDownGraceMinutes` | int ≥ 1, `20` | How long a warned worker has to checkpoint before flow writes one for it. |
| `pollSeconds` | int ≥ 10, `60` | Pass interval without `--tick`. |
| `armAutoMerge` | boolean, `false` | Whether `flow pr` arms auto-merge. |
| `host` | `auto` \| `cli` \| `cmux` \| `dorkos`, `auto` | Machine-specific: belongs in `config.local.json`. |
| `permissionMode` | `default` \| `acceptEdits` \| `bypassPermissions`, `acceptEdits` | Machine-specific: belongs in `config.local.json`. |

`fleet.json` does not change: `handoff` already lives there (S1 §1.1b).

### 7. Code structure

```
plugins/flow/
  scripts/
    drain/checkpoint.ts       §1 render, parse, validate, synthesize, exclude (zero deps)
    drain/account-rank.ts     §3 limitSignal, modelBucketsFor, rankAccounts, chooseAccount, launchBudget (zero deps)
    drain/state.ts            DrainState, RunLimit types
    drain/drain-step.ts       §4.4 reducer (zero deps)
    drain/handoff.ts          §5.2 reducer (zero deps)
    drain/messages.ts         §4.4 message templates
    drain/briefs.ts           brief rendering (placeholders; an unresolved {{…}} throws)
    drain/worktree.ts         provision, reuse, detached review worktrees, removal
    drain/stream-log.ts       ingestStreamLog, transcriptLimit
    drain/runner.ts           one pass: gather facts, run reducers, apply actions (all I/O here)
    launchers/types.ts        §2.1
    launchers/resolve.ts      §2.2
    launchers/{cli,cmux,dorkos}.ts
    launchers/shell-quote.ts  the one shell-quoting function (cmux --command)
    forge/types.ts, forge/github.ts, forge/ejection.ts
    cli/{checkpoint,drain,report,pr,watch,handoff,limit-check}.ts   verbs, registered in S1's verb table
  hooks/hooks.json            + PostToolUse limit-check
  templates/drain/worker-brief.md, reviewer-brief.md   rewritten as templates
  templates/drain/watch.sh    deleted
  engine-tests/drain/…, engine-tests/launchers/…, engine-tests/forge/…
```

- `scripts/**` stays tracker-neutral: tracker writes go through S1's code adapter; the forge is GitHub and is not a tracker.
- Pure modules import nothing outside `scripts/`, so they run before `npm install`.

## User Experience

- **The operator, CLI or cmux:** `flow accounts set claude3 --role rotation` once per account, then `flow drain --parallel 3`. The supervisor prints which host it chose and why, then one line per change: "ACME-12 claimed on claude3 (cli)", "ACME-12 pushed 4be1c2d, reviewer started on claude4", "ACME-12 review: changes (2 findings), sent to the worker", "ACME-12 PR #88 open, watching", "ACME-14 claude3 warned (weekly 91%); winding down", "ACME-14 moved to claude4 (weekly limit on claude3 until Thu 09:00)".
- **The operator, DorkOS:** sets `drain.parallel` and approves the `flow-drain` schedule; each firing runs a pass. Sessions appear in DorkOS on their accounts, linked to their items (S4 D8).
- **A worker** reads its brief, works, and runs `flow checkpoint`, `flow report pushed`, `flow pr` and `flow done` when told. A message always ends with the next command.
- **Nothing eligible:** `flow next` and `flow drain` say which account is out for which reason, and the command that would allow one.
- **Errors name the fix:** the missing host and its probe's reason, "push first", "write a checkpoint at this commit first", "no CLEAN review at <sha>", "DorkOS refused the request because sign-in is on".

## Testing Strategy

Each test carries a purpose comment and is shown to fail against a broken implementation before it is trusted. `now` is always injected; no test reads the wall clock.

- **Checkpoints** (`engine-tests/drain/checkpoint.test.ts`): render → parse round trip; each body rule refused with its message (missing section, wrong order, empty section, no code block, two code blocks, a `#` title, over 16 KB); header facts come from git in a temp repo (dirty tree, unpushed branch → `pushedSha: null`); `HANDOFF.prev.md` kept; the exclude lines appended once across two writes and two worktrees; a synthesized checkpoint with and without a previous one. `flow stage --checkpoint-file` writes then transitions; `flow stage` on a drain run without it exits 5. `flow report pushed` refuses a SHA without a checkpoint at it.
- **Resume contract:** for a fixture run, the rendered `resume-from-handoff` message plus `HANDOFF.md` name the worktree, branch, identifier, stage, brief path and next command, and tell the session not to claim. (The model-in-the-loop half is the live proof, task 4.4.)
- **Dispatch** (`engine-tests/drain/account-rank.cases.json`, `{ name, input, expected }`, `now` in `input`): the DOR-2373 example (sooner-with-less beats later-with-more); main last with rotation eligible; main first-eligible when every rotation account is out; main inside its spend-down window joins tier 2 and wins on its short horizon; affinity first when eligible, skipped when near a limit; each ineligibility reason alone; unknown readings eligible; ties by five-hour then id; model buckets (`opus` → `seven_day_opus`); `-n` spreading via `liveByAccount`; `chooseAccount` ambient only with no registry, and never ambient with a registry and nothing eligible. `limitSignal`: each window's ceiling, reserve cause, `allowed_warning`, expired windows reading as allowed (via S1 `readWindow`). `launchBudget`: busy machine → 0 slots; live sessions count reviewers.
- **Drain reducer** (`engine-tests/drain/drain-step.test.ts`): one case per row of the §4.4 table, asserting the next phase and the exact actions. Plus a property: across every row, no `createPr` action exists (only `flow pr` creates PRs), and `open-pr` is sent only from a state with a `clean` verdict at the branch head.
- **Handoff reducer** (`engine-tests/drain/handoff.test.ts`): one case per row of the §5.2 table in both `auto` and `ask`; a warning that clears before handoff; the synthesized-checkpoint paths; a limited reviewer restarts at the same SHA elsewhere; `ask` notifies exactly once per episode.
- **Reports and the PR gate** (`engine-tests/cli/report.test.ts`, `pr.test.ts`, fake forge + temp repo with a bare origin): `pushed` refuses an unpushed SHA; a push on an armed PR disarms it; a verdict from the worker's own session exits 5; a stale verdict changes nothing; `flow pr` exits 5 without a clean verdict at the origin head, and when the head moved after the verdict; a second `flow pr` records the existing PR.
- **Forge** (`engine-tests/forge/*.test.ts`): recorded `gh` JSON for merged, closed, failing (check run and commit status), armed, queued, neither; `judgeEjection` innocent, suspect and unknown; `flow watch` exits on the first event, `--follow` continues, five read errors exit 4.
- **Launchers:** the §2.7 contract suite against all three; `resolveHost` fixtures (named host down → error with the reason and no fallback; auto order); `ingestStreamLog` maps a recorded `rate_limit_event` to the S1 `sdk_event` observation and advances the offset; `transcriptLimit` on recorded transcript tails. The live smoke is gated (§2.7).
- **The hook** (`engine-tests/cli/limit-check.test.ts`, spawning the real script): a ledger at `allowed_warning` for the run's account prints `additionalContext` once, then stays silent for the same episode and speaks again for a new one; a session with no run, a missing ledger and a corrupt ledger all exit 0 with no output.
- **End to end with fakes** (`engine-tests/drain/runner.test.ts`: fake launcher, fake forge, fake adapter, temp repo, temp `DORK_HOME`):
  - One item from pick to `closing`: claimed `queued` then `running`; a reviewer started at the pushed SHA on a separate session; `changes` → the worker gets the findings; a second push → a delta review; `clean` → `open-pr`; `flow pr`; red CI → `ci-red`; a push → the PR is disarmed, reviewed, and re-armed on `clean`; merged → `merged`. The forge fake records that no PR was created and no arm happened before a clean verdict at the head.
  - Two items and two rotation accounts: each worker on its own account; a busy machine (fake load) launches nothing new.
  - **Handoff, `auto`:** the fake ledger flips the worker's account to `rejected` mid-item; the next pass writes a synthesized checkpoint, stops the old session, starts a new one on the other account with cwd = the same worktree and the resume message, rewrites `FlowRun.account`, `host`, `sessionId`, and appends to `handoffs`, with no operator call.
  - **Handoff, `ask`:** the same flip posts one comment naming the candidate and the command, starts nothing, and a second pass posts nothing more; `flow handoff` then moves it; separately, the account's reset lets it resume on the same session.
  - **No transcript moves:** across both handoff cases, the fake filesystem records no read or write under any account's `projects/` directory.
- **Config:** the `drain` defaults, each bound, and the regenerated schema (the existing drift check).

## Performance Considerations

- A pass costs, per active run, one `state` call, one small ledger read, one checkpoint header read, one `getItem`, and one `gh pr view` once a PR exists. At 60 s and a handful of runs this stays far inside GitHub's API budget.
- The launch cap reads `os.loadavg()` once per pass. Load is the constraint the source session hit, so launching waits rather than piling on.
- The hook reads two small files and exits; it runs after every tool call, so it must stay well under 100 ms, and it does no network or tracker work.
- A handoff re-bills the whole context on the new account. That is why affinity keeps a follow-up on its warm account, and why the warning path checkpoints before the hard stop instead of after.

## Security Considerations

- **Only official sessions.** Every session is the `claude` binary or DorkOS's official runtime. Usage comes only from what the official binary hands over (stream events, transcripts, the ledger other official paths write). No token is read from the Keychain (flow-fleet §3).
- **Public wording:** "account-aware scheduling" and "hand work off when an account hits its limit". The docs carry flow-fleet's note that each user judges their own use against Anthropic's terms, and never advertise "maximum limits".
- **Scope is enforced before launch:** a kept-out account (the client's org account) is never picked for a repo outside its scope, and the ambient fallback exists only when no accounts are registered (§3.4).
- **No shell** except cmux's `--command`, built by one tested quoting function that refuses newlines and NUL.
- **Power is the operator's:** flow never selects `bypassPermissions` itself; DorkOS clamps it further.
- **The DorkOS token** is read from its `0600` file or the environment, sent only to the configured DorkOS URL, and never printed or logged.
- **Stops are by recorded pid**, verified to still be a `claude` process, never by name.
- **No transcript is moved or read across accounts.**

## Documentation

- `docs/parallel-drain.mdx`: rewritten around `flow drain`: set up accounts, pick a host, run it, what each line means, how review gates the PR, what happens at a limit, `ask` vs `auto`. The hand recipe is removed (the verbs replace it).
- `README.md`: the new verbs in S1's verb table.
- `docs/SPEC.md`: checkpoints, the drain phases, the handoff states, the new `FlowRun` fields.
- `docs/the-dials.mdx` and `config/CONFIG.md`: the `drain` block.
- Stage skills (`executing-specs`, `verifying-work`, `specifying-work`, `decomposing-work`): `flow stage … --checkpoint-file` at their boundaries (`closing-work` has none: `flow done` ends the run and nothing resumes after it); `verifying-work`: in a drain run (the worker brief says so), skip its own review and PR steps, `flow report pushed` and wait: the drain's reviewer and `flow pr` replace them; `executing-specs`: `flow checkpoint --trigger task` after each task. `skills/flow-drain/SKILL.md`: the `drain.parallel` branch.
- `CHANGELOG.md` and the version bump in `plugin.json`, `.dork/manifest.json`, `package.json`, per PR.

## Implementation Phases

- **Phase 1, pure foundations:** checkpoints and `flow checkpoint`; account ranking, the limit signal and the load cap; the new `FlowRun` fields and the `drain` config block.
- **Phase 2, launchers:** the interface, host resolution, the contract suite and the CLI launcher; cmux; DorkOS; the live smoke.
- **Phase 3, dispatch and drain:** `flow next` picks accounts; the forge, `flow report` and `flow pr`; `flow watch`; the drain reducer; the runner and `flow drain` with the briefs and docs.
- **Phase 4, handoff:** the handoff reducer; the hook; `flow handoff` and the runner wiring; a live proof drain.

## Decisions (made autonomously, logged as assumptions)

- **D1. The parallel drain runs on every host, not only DorkOS** (resolves flow-cli-overhaul §6 question 2). The launcher is the only part that differs, and the operator's cmux and CLI habits are where the source session ran.
- **D2. `HANDOFF.md` lives in `<worktree>/.dork/flow/`, kept out of git by `info/exclude`.** A worktree-root file would be swept into commits by `git add -A`; `info/exclude` covers every worktree and touches no tracked file.
- **D3. The checkpoint header is one JSON comment the CLI writes; the body is the agent's.** Facts are measured, so they cannot drift; judgment stays prose. JSON in a comment parses with no dependency, like the provenance line.
- **D4. "After each EXECUTE task" is enforced at the push report**, the one step every task reaches that flow can check.
- **D5. In `ask` mode, resuming on the same account after its reset needs no approval.** It is not a move between accounts, and it keeps the warm transcript.
- **D6. `ask` mode notifies with one comment and leaves the labels alone**, rather than the `needs-input` park: the agent still owns the item and resumes without a person at the reset.
- **D7. No tmux launcher.** cmux covers a visible session and headless covers the rest; a fourth implementation is cost without a user today.
- **D8. The drain always uses plain `git worktree`**, whatever `workspace.flow` says: the supervisor must know the path, and `gtr` owns its own.
- **D9. Only `flow pr` opens a PR, and it checks the verdict.** A brief that tells the worker to wait is prose; a verb that refuses is code (flow-cli-overhaul §2).
- **D10. GitHub is the only forge**, behind a small interface. Every repo flow runs in today is on GitHub.
- **D11. The reviewer is a top-level session on any eligible account.** Independence comes from a fresh context, and a subagent would bill the worker's account anyway.
- **D12. Limited and drain phases are fields, not `FlowRunStatus` values**, because a new enum value would make older readers reject the whole run store.
- **D13. Unknown usage is eligible; near-limit is not.** No reading is not evidence of no room, but starting work that must wind down at once wastes a handoff.
- **D14. At most 2 sessions per account by default**, because parallel workers share one 5-hour window.
- **D15. The DorkOS launcher prefers `session_start` and falls back to the HTTP route**, verifying the account afterward either way, since the route ignores an unknown account.
- **D16. Load cap 1.5 per CPU**, applied to launches only. The source session's failure was new launches on a saturated machine, not the running ones.

- **D17. Launchers strip API-key variables and the cli launcher checks `apiKeySource`.** A config dir only names the account when no key overrides its login; billing the wrong credential silently is the failure the fleet exists to prevent.
- **D18. A verdict needs the reviewer's one-time token**, not a session-id comparison. Session ids can be minted by the host after the brief is rendered, and a missing `--session` would otherwise let a worker approve itself.
- **D19. A handoff never switches hosts.** A failed probe parks the run with its reason, consistent with "a missing host is reported, not guessed".
- **D20. Drain runs are exempt from flow's recovery ladder**, which judges liveness by pid; the supervisor, which asks the launcher, is their only recovery.

## Open Questions

None open. The operator decided handoff mode, reserve, the org account and transcript migration (flow-fleet §8).

## Related ADRs

- None in this repo (the marketplace has no `decisions/`). D2, D9 and D12 are the ADR-worthy calls; they are recorded here and in `docs/SPEC.md`.

## References

- [`specs/flow-fleet/01-ideation.md`](../flow-fleet/01-ideation.md) §2, §3, §4.4–4.7, §5, §8
- [`specs/flow-cli-overhaul/01-ideation.md`](../flow-cli-overhaul/01-ideation.md) §1, §3 step 2, §6
- [`specs/flow-cli-core/02-specification.md`](../flow-cli-core/02-specification.md) §1–7
- `plugins/flow/docs/parallel-drain.mdx`, `plugins/flow/templates/drain/*`
- DorkOS: `packages/shared/src/schemas.ts` (`SendMessageRequestSchema`, `SEED_CONTEXT_MAX_LENGTH`), `apps/server/src/services/core/auth/mcp-local-token.ts`, spec `claude-account-fleet` D4, D5, D7, D8
- cmux-control: `CLAUDE.md` (addressing, spawning, resuming), `bin/morning.sh`
- Tracker: DOR-2366 (umbrella), DOR-2371, DOR-2372, DOR-2373, DOR-2374
