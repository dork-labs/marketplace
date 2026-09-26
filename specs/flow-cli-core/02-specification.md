---
slug: flow-cli-core
issue: DOR-2367
created: 2026-09-26
status: specified
---

# One `flow` command runs every mechanical flow step, and flow and DorkOS share one account list and one usage ledger

**Status:** Approved
**Issues:** DOR-2367 (F1 CLI core), DOR-2368 (F2 accounts), DOR-2376 (F10 state truth)
**Date:** 2026-09-26
**Input:** [`01-ideation.md`](./01-ideation.md)

## Overview

- A new entry point, `scripts/flow.ts`, turns flow's tested oracles into nine verbs: `snapshot`, `next`, `claim`, `release`, `done`, `stage`, `audit`, `status`, `accounts`.
- The CLI reaches the tracker through a **code adapter**: a TypeScript module beside the adapter's `SKILL.md`, called over a transport picked by `connection.transport`.
- The shipped Linear code adapter moves the Composio recipes out of prose and into tested code.
- One rule decides what tracker state, `agent/*` and `stage/*` each mean (F10). It lives in `scripts/work-state.ts`; the writers and the audit both use it.
- Section 1 is the shared contract with DorkOS: the account registry, the usage ledger and the session↔item link. It is written first because DorkOS builds against it in parallel (spec `claude-account-fleet`, dorkos repo).

## 1. Shared contracts (flow ↔ DorkOS)

These three contracts are public and tracker-neutral. Both sides implement them independently and prove it with one fixture set (§1.4). A change to any rule here is a contract change: bump `CONTRACT_VERSION` in the fixture folder and change both sides.

### 1.1 Accounts: identity in DorkOS config, routing policy in flow's own file

The registry is split by owner (operator direction, 2026-09-26). DorkOS core owns who the accounts are and how they look. flow owns how work is routed to them.

`<dorkHome>` below = the `DORK_HOME` environment variable when set and non-empty, else `<os home>/.dork`. flow never uses DorkOS's dev-mode default (`apps/server/.temp/.dork`); a DorkOS dev server that wants flow to see its accounts sets `DORK_HOME`.

#### 1.1a Identity: `<dorkHome>/config.json` → `runtimes.claudeCode.accounts[]` (DorkOS core)

| Field   | Type                               | Default when absent | Meaning                                                                  |
| ------- | ---------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `id`    | string, `^[a-z0-9]+(-[a-z0-9]+)*$` | minted (below)      | What everything else references. Unique in the array.                    |
| `path`  | string, absolute                   | required            | The `CLAUDE_CONFIG_DIR` this account runs in.                            |
| `label` | string \| null                     | `null`              | The operator's name for it.                                              |
| `color` | string `^#[0-9a-f]{6}$` \| null    | `null`              | **New, DorkOS core.** Display color; `null` = a stable default by position. |

- `id`, `path`, `label` exist today (DorkOS `ClaudeCodeAccountSchema`, spec `claude-code-accounts` D1). `color` is the one new field.
- No routing policy lives here. DorkOS core never reads or writes flow's policy.
- A missing file or a missing key means "no accounts", never an error.
- A file DorkOS never touched is valid: flow may create it as `{"runtimes":{"claudeCode":{"accounts":[…]}}}` with no other keys.
- Readers ignore fields they do not know; writers preserve them.
- A row with a missing or non-absolute `path` is skipped, with a warning.
- A row with no `id` gets one at read time by the minting rule; a duplicate `id` keeps the first row and warns.
- A row whose `id` fails the pattern (a hand edit) is listed, with a warning, but has no usage file and cannot be routed: it reads as `kept-out` with `scope.repos: []`.
- A `color` that fails the pattern reads as `null`, with a warning.
- flow writes every row it creates with all four keys, `label` and `color` as `null` when not given, so DorkOS's schema (`label` nullable with no default) accepts it.

**Minting an id** (identical to DorkOS `claudeAccountId`, pinned by fixtures)

- Slugify: lowercase, every run of non `[a-z0-9]` becomes one `-`, trim `-` from both ends.
- Base = slug(label), else slug(basename of path), else `account`.
- If the base is taken, append `-2`, `-3`, … until free.

**What DorkOS must do**

- Add `color` to `ClaudeCodeAccountSchema`: nullable, default `null`, the pattern above.
- Enforce the id pattern on every write, so no new row gets an id the ledger would refuse.
- Re-read the file before each write of `runtimes.claudeCode`, so a flow `accounts add` made while the server runs is not lost.
- Accept a `config.json` that flow created (no `__internal__`, no `version`).
- Keep the minting rule (it already has it).

#### 1.1b Routing policy: `<dorkHome>/flow/fleet.json` (flow-owned)

```jsonc
{
  "v": 1,
  "handoff": "auto",                 // "auto" | "ask"; default "auto"
  "accounts": {
    "claude3": {                     // key = an identity id from 1.1a
      "role": "rotation",            // "main" | "rotation" | "kept-out"
      "reservePct": 0,               // 0–100
      "spendDownWindowHours": 24,    // ≥ 0
      "scope": { "repos": ["acme/app"] } // only read for kept-out
    }
  }
}
```

JSON Schema: `plugins/flow/conformance/fleet/fleet-policy.schema.json`.

| Field                  | Default when absent                                   | Meaning                                                                                  |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `handoff`              | `"auto"`                                              | Fleet-wide: move work off an account that runs out automatically, or ask first.           |
| `role`                 | `"kept-out"`                                          | `main`: the operator's own, drained last. `rotation`: spent freely. `kept-out`: not spent, except on its scoped repos. |
| `reservePct`           | `50` for `main`, else `0`                             | Share of the 7-day window kept back for the operator's own use.                           |
| `spendDownWindowHours` | `24`                                                  | Hours before the 7-day reset in which the reserve drops to 0.                             |
| `scope.repos`          | `[]`                                                  | For `kept-out` only: the repos it may serve. `[]` = never. Ignored for `main` and `rotation`, which serve any repo. |

**Rules**

- **Opt-in by default.** An identity with no entry in `fleet.json`, or no `fleet.json` at all, resolves to `role: "kept-out"`, `scope.repos: []`: nothing is spent until the operator says so.
- Writers store only what the operator set. Defaults are resolved at read time, never written.
- Readers ignore fields they do not know; writers preserve them.
- A `scope.repos` entry is `owner/name`, compared case-insensitively with the `owner/name` parsed from the checkout's `origin` remote (https or ssh form, `.git` stripped). A checkout with no parsable `origin` matches nothing.
- At most one `main`. With two or more, readers keep the first in registry order and treat the rest as `rotation`, with a warning.
- With no `main`, no account has a default reserve; `flow accounts` warns.
- An unknown `role`, an out-of-range `reservePct` or a negative `spendDownWindowHours` reads as absent (the default), with a warning.
- An entry whose key is not a registered identity id is ignored, with a warning (it is kept in the file).
- Writes use the §1.2 lock-and-rename steps, with the lock at `fleet.json.lock`.
- Two writers edit this file: `flow accounts set` in the bare CLI, and the DorkOS Flow extension's server side behind its "Flow" settings tab. Both use the same steps; DorkOS core does not touch it.

**Which repos an account may serve** (`mayServe(policy, repo)`)

- `main`, `rotation`: any repo.
- `kept-out`: only a repo in `scope.repos`.

**The reserve and the spend-down window**

- `effectiveReservePct = 0` when the account's `seven_day` reading has a `resetsAt` and `now ≥ resetsAt − spendDownWindowHours`.
- Otherwise `effectiveReservePct = reservePct`.
- With no `seven_day` `resetsAt`, the reserve stays at `reservePct`.
- **The main-account rule** (operator decision, flow-fleet §8.4): `main` defaults to a 50% reserve, and dispatch offers it work only when no other eligible account has room, or inside its spend-down window. The ordering belongs to dispatch (spec unit S3); the numbers above are the contract.

**Room on an account** (readings per §1.2's read rules)

- `fiveHourRoom`: `false` when the `five_hour` reading is `rejected` or its `usedPct ≥ 100`; `null` when there is no reading; else `true`.
- `weeklyRoom`: `false` when the `seven_day` reading is `rejected` or its `usedPct ≥ 100 − effectiveReservePct`; `null` when there is no reading; else `true`.
- A model bucket is checked like `weeklyRoom` against 100 (no reserve), when dispatch knows the item's model.
- `null` means unknown. Dispatch decides what unknown means; `flow accounts` shows "unknown".

### 1.2 The usage ledger

**Where it lives**

- One file per account: `<dorkHome>/usage/<account-id>.json`. The id is the registry id and must match the id pattern above; anything else is refused (no path traversal).
- Folder mode `0700`, file mode `0600`.

**Shape** (JSON Schema: `plugins/flow/conformance/fleet/usage-ledger.schema.json`)

```jsonc
{
  "v": 1,
  "accountId": "claude3",
  "updatedAt": "2026-09-26T16:04:11.000Z",   // last write, any window
  "windows": {
    "five_hour": {
      "usedPct": 41.5,                        // number 0–100, or null when the source gave none
      "resetsAt": "2026-09-26T19:00:00.000Z", // ISO-8601 UTC, or null
      "status": "allowed",                    // "allowed" | "allowed_warning" | "rejected", or null
      "observedAt": "2026-09-26T16:04:10.000Z", // when the SOURCE saw it, not when it was written
      "source": "statusline"                  // "statusline" | "sdk_event" | "sdk_usage" | "transcript"
    },
    "seven_day": { … },
    "seven_day_opus": { … },
    "seven_day_sonnet": { … },
    "model:opus": { … }                       // a per-model bucket
  }
}
```

**Window keys**

- Known: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`.
- Model buckets: `model:<slug>`, slug `^[a-z0-9][a-z0-9._-]*$`.
- Any other key matching `^[a-z][a-z0-9_]*$` is allowed, so a new SDK window needs no contract change. Readers ignore keys they do not use; writers keep them.

**One entry**

- `observedAt` and `source` are required. At least one of `usedPct` and `status` is non-null.
- All timestamps are ISO-8601 with an explicit zone; writers emit UTC with `Z`.
- `usedPct` is clamped to 0–100 by the writer.

**Mapping each source** (writers convert; the ledger holds one unit)

| Source        | `usedPct`                                   | `resetsAt`                    | `status`             |
| ------------- | ------------------------------------------- | ----------------------------- | -------------------- |
| `statusline`  | `rate_limits.<w>.used_percentage` (0–100)   | `resets_at`, epoch seconds or ISO, to ISO | `null`   |
| `sdk_event`   | `rate_limit_info.utilization` × 100 (0–1 fraction) | `resetsAt` epoch seconds, to ISO | `status`       |
| `sdk_usage`   | `rate_limits.<w>.utilization` (0–100)       | `resets_at` (ISO)             | `null`               |
| `transcript`  | `null`                                      | parsed from the message, else `null` | `"rejected"`  |

- `sdk_event` uses `rateLimitType` as the window key.
- A transcript message whose window cannot be identified is not recorded.

**Reading a window** (`readWindow(entry, now)`)

- Expired: `resetsAt` is set and `now ≥ resetsAt`. An expired entry reads as `usedPct 0`, `status "allowed"`, `expired: true`.
- Stale: `resetsAt` is null and `now − observedAt` exceeds the window length (`five_hour` 5 h; every other key 7 days). A stale entry reads as no reading.
- Otherwise the entry reads as stored.

**Merging** (`mergeLedger(existing, observations, now)`)

- Per window key, an observation replaces the stored entry only when its `observedAt` is strictly later.
- Equal `observedAt`: the stored entry stays (so a replay is a no-op).
- An observation whose `observedAt` is more than 5 minutes after `now` is dropped with a warning, so one bad clock cannot pin a window forever.
- An invalid observation is dropped with a warning; the rest still merge.
- `updatedAt` becomes `now` when anything changed; otherwise the file is not rewritten.
- A newer observation always wins, even with a lower `usedPct` (the window reset).

**Writing** (every writer, flow or DorkOS)

1. Take the lock: create `<id>.json.lock` with exclusive-create (`O_CREAT|O_EXCL`, Node `wx`), writing a fresh token `<pid>:<random 128-bit hex>`. The token, not the pid, identifies the holder, so two writers in one process never mistake each other's lock.
2. A lock older than 10 s (by mtime) is stale. Read its token, then break it:
   - Rename it to `<id>.json.lock.stale-<random>`.
   - Read the moved file's token. If it is not the token judged stale (a fresh lock was renamed by mistake), put it back with `link(moved, <id>.json.lock)` (this fails if a newer lock already exists; a third writer that locked in that gap then overlaps the mistaken holder, which is accepted like the step 7 race), then delete the moved name and retry step 1.
   - If it is the stale token, delete the moved name and retry step 1.
   - Never delete a lock by its original name.
3. Retry with 25–100 ms jittered waits; give up after 2 s total. Giving up drops this write with a warning; it never throws into the caller's turn.
4. Under the lock, read the file. Missing = empty. Unparsable = rename it to `<id>.json.corrupt-<epoch ms>` and start empty.
5. Merge. If nothing changed, release the lock and stop.
6. Write `<id>.json.<pid>.<random>.tmp` in the same folder, `fsync` it, `rename` it over `<id>.json`.
7. Release: read the lock, and delete it only if it still holds this writer's token. A writer that held the lock past 10 s can lose it to a breaker between that read and the delete; this is accepted, because a merge takes milliseconds and every write is a merge. Do not add a second mechanism for it.

**Reading** needs no lock: `rename` is atomic, so a reader sees the old file or the new one, never half of one. An unparsable file reads as empty, with a warning.

### 1.3 The session ↔ item link

**Where it lives**

- `<main checkout>/.dork/flow/flow-state.json`: one file per project, shared by every worktree. `<main checkout>` is the parent of `git rev-parse --git-common-dir`.
- Shape: `Record<issueId, FlowRun>` (`scripts/flow-state.ts`, unchanged except the two fields below).

**Two new optional `FlowRun` fields**

| Field     | Type                               | Meaning                                                                                             |
| --------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `account` | string (a registry id)              | The account the run's **current** session bills. Rewritten on every handoff.                        |
| `host`    | string: `cli`, `dorkos` or `cmux` today | The launcher the current session runs under.                                                   |

- `host` is not the machine. The machine is `provenance.host`.
- `provenance.account` stays what it is: the origin's `CLAUDE_CONFIG_DIR` basename, written once at run start and never updated. `FlowRun.account` is the current registry id.
- The join key between a session and an item is `FlowRun.sessionId`. A DorkOS session whose id matches a record serves that record's `identifier`.

**Rules**

- Readers pass unknown fields through (the store is read-modify-write; see the `looseObject` note in `flow-state.ts`).
- `host` is validated as a bare string, like `provenance.harness`: the vocabulary is pinned in prose, so a record from a future launcher never fails the all-or-nothing reader.
- A writer that finds the existing file present but failing the schema refuses to write and reports the file; it never replaces a file it could not read (that would delete every other run).
- Writers use the §1.2 lock-and-rename steps, with the lock at `flow-state.json.lock`.
- DorkOS reads this file and never writes it, until a later contract moves the store into DorkOS (flow SPEC v2).

### 1.4 The conformance fixture

- Folder: `plugins/flow/conformance/fleet/`, with `CONTRACT_VERSION` (`1.0.0`), the JSON Schemas (`usage-ledger.schema.json`, `fleet-policy.schema.json`), and case files.
- Case files: `account-id.cases.json`, `identity.cases.json` (reading 1.1a rows), `fleet-policy.cases.json` (resolving 1.1b, including unlisted accounts and `mayServe`), `window-read.cases.json`, `room.cases.json`, `ledger-merge.cases.json`, `flow-run.cases.json`.
- Every case is `{ "name": string, "input": object, "expected": object }`, and `now` is always an input, never the wall clock.
- `flow-run.cases.json` gives FlowRun records, some with fields the reader does not know, and the expected read-back (unknown fields preserved).
- flow runs them in `engine-tests/fleet-conformance.test.ts`. DorkOS vendors the folder at a pinned commit and runs its own implementation against it; the DorkOS spec picks the mechanism.
- The fixture folder names no tracker, no price, no plan and nothing private.

## Background / Problem Statement

- Every mistake in the source session came from prose an agent re-reads and re-interprets: hand-built dispatch input, hand-scripted label swaps, per-session snapshot scripts ([flow-cli-overhaul §1](../flow-cli-overhaul/01-ideation.md)).
- Work state is written three ways (tracker state, `stage/*`, `agent/*`) and they drift: DOR-1892 was labelled done but sat In Progress.
- The account list is copied into five scripts that disagree, and usage is scraped off the screen ([flow-fleet §1](../flow-fleet/01-ideation.md)).

## Goals

- Every mechanical step a worker scripted by hand is one `flow` call with tested behavior.
- `flow next` picks exactly what the dispatch oracle picks, with no hand-built input.
- Tracker I/O stays behind the adapter contract; the CLI names no tracker.
- `flow audit` fails on any state/`stage/*`/`agent/*` disagreement, and the rule lives in one file.
- flow and DorkOS read one account list and one ledger, proved by one fixture set; routing policy is flow's own file.
- The prose each verb replaces is deleted in the same PR.

## Non-Goals

- `flow usage record|scan|probe`, the status-line hook, `flow fleet` (spec unit S2).
- Account-aware dispatch, launchers, checkpoints, handoff, `flow drain --parallel`, `flow watch` (S3).
- The DorkOS side of the contracts (S4) and any UI (S5).
- The wider prose trim (S7). S1 deletes only the prose its verbs replace.
- A bundled binary or a `bin/` shim on PATH.
- An `mcp` transport inside the CLI (see Decision D3).
- Fencing a claim across two machines (flow SPEC v2 residue).
- `flow accounts remove` (an id is referenced by agents; removal belongs to the DorkOS settings page).

## Technical Dependencies

- Node ≥ 22.6, run with `--experimental-strip-types`, as the oracles already require (`skills/initializing-flow/SKILL.md`).
- `zod` ^4 (already the one runtime dependency). Verbs that need it load it lazily, so `--help` and a missing install still answer.
- The Composio CLI, for the Linear code adapter over the `cli` transport (verified against `composio` v0.2.31 in the adapter skill).
- No new npm packages.

## Detailed Design

### 2. The entry point

- Command: `node --experimental-strip-types <flow-root>/scripts/flow.ts <verb> [args] [flags]`.
- `<flow-root>` is the `flowRoot` that `config-files.ts` prints (as every skill already resolves it).
- `flow.ts` imports only dependency-free modules at the top. Each verb is a dynamic `import()`.
- A failed `import` of `zod` prints `flow: run "npm install --omit=dev" in <flow-root>` and exits 6.
- `main(argv, deps)` is exported. `deps` injects `env`, `cwd`, `now`, `stdout`, `stderr`, the adapter factory and the process runner, so every verb is unit-testable without a network. The script entry wires the real ones.

**Common flags**

| Flag               | Verbs                        | Meaning                                                                                |
| ------------------ | ---------------------------- | -------------------------------------------------------------------------------------- |
| `--json`           | all                          | One JSON object on stdout (shape per verb, each with `"v": 1`). Default is human text. |
| `--project <dir>`  | all but `accounts`           | The checkout to resolve config and run state from. Default: cwd.                       |
| `--snapshot <file>`| `next`, `audit`, `status`    | Read this saved `flow snapshot --json` output instead of the tracker.                  |
| `--dry-run`        | `claim`, `release`, `done`, `stage`, `accounts add`, `accounts set` | Print the planned change; write nothing. |
| `--session <id>`   | write verbs                  | The harness session id for provenance and `FlowRun.sessionId`. Else `FLOW_SESSION_ID`. |
| `--manual`         | `next`, `claim`              | A person is driving: run even while flow is paused.                                    |
| `--help`, `-h`     | all                          | Usage for the verb (or the verb list). Exit 0.                                         |

- Human text is plain, aligned and uncolored. Diagnostics and warnings go to stderr in both modes.
- In `--json` mode stdout carries exactly one JSON value, also on failure: `{ "v": 1, "ok": false, "error": { "code": <exit code>, "message": "…" } }`.

**Exit codes** (one table for every verb)

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | Success.                                                                                     |
| 1    | The verb's check found problems (`audit` violations, `status` drift with `--strict`).        |
| 2    | Usage error: unknown verb, bad flag, missing argument.                                       |
| 3    | Config error: flow not configured, invalid config, `mcp` transport, no code adapter.         |
| 4    | Tracker error: unreachable, auth failure, a write not confirmed on read-back.                |
| 5    | Precondition failed: item not found, not eligible to claim, claimed by someone else.         |
| 6    | Missing runtime dependency (`zod`).                                                          |
| 7    | Paused (`next`/`claim` without `--manual`).                                                  |

### 3. Config the CLI reads itself

- New `scripts/config-load.ts`: `loadConfig(roots, env) → { config: FlowConfig, secrets, files, warnings }`.
- Files come from `resolveConfigFiles` (`config-files.ts`); nothing new decides where they are.
- Precedence, per `config/CONFIG.md`: env > `config.local.json` > `config.json` > schema defaults. Objects deep-merge; arrays and scalars replace.
- `secrets` is split off before parsing, because `FlowConfigSchema` is `.strict()` and has no `secrets` key.
- Env: `FLOW_TRACKER_ACCOUNT` → `secrets.trackerAccount`; `FLOW_TRACKER_TOKEN` → `secrets.trackerToken`. No other env var is read in S1.
- A legacy or unconfirmed config (`refusalFor` non-null, or `origin: "none"`) exits 3 with the refusal text.
- A Zod failure exits 3 listing each path and message.
- Paused: `pauseState(roots)` non-null.

### 4. The tracker seam (the code adapter)

**Finding it**

- The code adapter is `adapter.ts` in the same folder as the resolved `adapter.path` `SKILL.md` (project `.agents/flow/adapters/<tracker>/`, or the shipped `skills/<tracker>-adapter/`).
- No `adapter.ts` there: tracker verbs exit 3 with "the <tracker> adapter has no code; the flow CLI cannot reach the tracker. The skill still works through the adapter's prose."
- The module exports `CONTRACT_VERSION` (string) and `createAdapter(ctx: AdapterContext): CodeAdapter`.
- A project adapter may `import type` from nothing; `AdapterContext` hands it everything at runtime.

**Types** (`scripts/tracker/types.ts`, dependency-free)

```ts
interface AdapterContext {
  config: FlowConfig;                    // merged, validated
  secrets: { trackerAccount?: string; trackerToken?: string };
  transport: TrackerTransport;           // chosen by connection.transport
  warn(message: string): void;
}

interface TrackerTransport {
  kind: 'cli';
  /** Run an external command with no shell. Rejects on spawn failure or timeout. */
  run(cmd: string, args: readonly string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

interface BacklogSnapshot {
  v: 1;
  tracker: string;
  team: { key: string | null; id: string | null };
  fetchedAt: string;                              // ISO
  items: WorkItem[];                              // every OPEN item, fully normalized
  closed: { identifier: string; title: string; stateCategory: 'completed' | 'canceled' }[];
  projects: WorkItemProject[];                    // only projects the items reference
}

interface WorkStateChange {
  stateCategory?: StateCategory;       // move to a state of this category; absent = leave
  agentLabel?: string | null;          // the one agent/* label; null = remove all; absent = leave
  stageLabel?: string | null;          // the one stage/* label; null = remove all; absent = leave
}

interface CodeAdapter {
  capabilities: readonly Capability[];
  getCurrentUser(): Promise<{ id: string; name?: string }>;
  getBacklogSnapshot(opts?: { includeClosed?: boolean }): Promise<BacklogSnapshot>;
  getItem(identifier: string, opts?: { comments?: number }): Promise<WorkItem & { comments?: ItemComment[] }>;
  applyWorkState(item: WorkItem, change: WorkStateChange): Promise<void>;
  comment(item: WorkItem, body: string): Promise<void>;
}
```

- `Capability` names the five methods. A verb checks the capabilities it needs first and exits 3 naming the missing one.
- `applyWorkState` writes labels and state in one tracker write where the tracker allows it, else labels first (the contract's claim ordering).
- `applyWorkState` computes the label set from a read taken immediately before the write, never from the caller's item.
- Every read that cannot reach the tracker throws; it never returns empty (contract §3). The CLI maps a throw to exit 4.
- The CLI re-reads the item with `getItem` after every write and exits 4 if the result disagrees with the change.

**The transport**

- `connection.transport: "cli"` → `ExternalCliTransport` (`scripts/tracker/external-cli.ts`): `child_process.execFile`, no shell, 60 s default timeout, 64 MB output cap.
- `connection.transport: "mcp"` → exit 3: "the mcp transport exists only inside an agent session; set connection.transport to cli to use the flow CLI". (Decision D3.)
- The transport names no tracker and no command. The adapter supplies the command.

**The adapter contract** (`adapters/SPEC.md`) goes to **1.4.0** (minor, additive) with the code realization, then to **2.0.0** (major) with the F10 rule (§5):

- A new section, "The code realization": the file, the factory, `AdapterContext`, the five methods and their mapping to the verbs.
- `getItem` and `getBacklogSnapshot` join the optional reads. `getBacklogSnapshot` is already what `audit-backlog.ts` names; this makes it a declared verb.
- `applyWorkState` is the code realization of `claim` and `transition`; its label and state effects follow §5.
- An adapter with no code realization still conforms at 1.4.0; it just cannot serve the CLI.
- **2.0.0** changes `transition` and `claim`: a stage whose category is `started` or `completed` removes every `stage/*` label instead of setting one, and `claim` removes `agent/ready` and every `stage/*` label. That breaks the old "set the stage's label" rule, so it is a major bump. The same PR updates `skills/linear-adapter/SKILL.md` and both `adapters/reference/*/SKILL.md` to the new rule, and a project adapter pinned to 1.x keeps working but trips STATE-2 until regenerated (`flow audit` names each item).

**The shipped Linear code adapter** (`skills/linear-adapter/adapter.ts`, inside the tracker-confinement carve-out)

- Every call is `composio execute <SLUG> --account <secrets.trackerAccount> -d <json>`. A missing `trackerAccount` exits 3.
- Reads go through `LINEAR_RUN_QUERY_OR_MUTATION` with GraphQL variables (never string-interpolated), through `team(id:)`, per the verified recipes now in the skill.
- A `storedInFile` response is read from its `outputFilePath`.
- Snapshot: core fields paginated at `first: 150`, relations at `first: 40`, merged by identifier; closed items as titles at `first: 250`; every identifier checked against the `<teamKey>-` prefix.
- Labels are re-namespaced `parent.name/name`; a leaf with no parent stays bare (so GRM-12 can flag it).
- `stateCategory` comes from `state.type`, with Linear's `triage` mapped to `backlog`.
- `applyWorkState` issues one `issueUpdate` with `labelIds` (the full set from a fresh read) and `stateId`. The state is the team's lowest-`position` state of the target category.
- A label the team does not have exits 4 naming it; the adapter never creates labels.
- `comment` uses `commentCreate` with `issueId` as a variable.
- `team.id` is resolved from `team.key` when only the key is set.
- The prose that the code replaces is deleted from `SKILL.md`: the snapshot recipe, the label-write union rule, the claim/transition mechanics. What stays is the `WorkItem` mapping, the verb table, the durability rules and "use `flow` for these".

### 5. One source of truth for work state (F10)

**The rule** (`scripts/work-state.ts`, dependency-free, the only place it is written)

- The tracker **state category** says how far along the item is: `backlog`/`unstarted` not being worked, `started` being worked, `completed`/`canceled` closed.
- **At most one `agent/*` label** says who owns it: `ready` (anyone may claim), `claimed` (an agent is on it), `needs-input` (parked on a person), `completed` (an agent finished it).
- **At most one `stage/*` label** says where the next session resumes, and it exists only while the item is not started (`backlog` or `unstarted`).
- `FlowRun.stage` carries the stage while an item is started.

**Coherence checks** (`stateCoherence(item) → violations[]`, open items only)

| Check      | Fails when                                                    |
| ---------- | ------------------------------------------------------------- |
| `STATE-1`  | more than one `stage/*` label                                 |
| `STATE-2`  | a `started` item carries a `stage/*` label                    |
| `STATE-3`  | `agent/claimed` on an item that is not `started`              |
| `STATE-4`  | `agent/ready` on a `started` item                             |
| `STATE-5`  | `agent/completed` on an open item                             |

- "More than one `agent/*`" stays GRM-13; it is not repeated.
- `audit-backlog.ts` gains **GRM-15 (state coherence)**, which reports every `STATE-n` breach per item. It imports `work-state.ts` (a zero-dependency module, so the oracle still runs before `npm install`).
- GRM-15 is switched on in the same PR as adapter contract 2.0.0 (task 3.3). Before then, the prose adapters still write `stage/*` on started items, and the audit would go red on every in-flight item for a rule nobody could follow yet.
- GRM-10 (ready ⇒ a `stage/*` label) is unchanged and consistent: a ready item is never started.

**The projections** (`projectionFor(event, ctx) → WorkStateChange`; the writers use nothing else)

| Event                 | `stateCategory`             | `agentLabel`                         | `stageLabel`                                                         |
| --------------------- | --------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `claim`               | `started`                   | `agent/claimed`                      | `null`                                                               |
| `release` (`--to ready`) | `unstarted`              | `agent/ready`                        | `stage/<resume stage>`                                               |
| `release` (`--to none`)  | `unstarted`              | `null`                               | `stage/<resume stage>` when known, else absent                       |
| `done`                | `completed`                 | `agent/completed`                    | `null`                                                               |
| `stage` to a stage whose `stateCategory` is `started` or `completed` | that category | absent | `null` |
| `stage` to any other stage | the stage's `stateCategory` if set, else absent | absent            | the stage's `label`                                                  |

- The resume stage is `--stage`, else `FlowRun.stage`, else the `stage/*` label the claim removed (recorded as `FlowRun.stage`).
- **Recovery with no run record** (`re-derive`: claimed on another machine) cannot read the stage off the tracker any more. It derives it from the workspace: `verify` when the item's branch has an open PR, else `execute`. `deriveStage({ hasOpenPr })` in `work-state.ts` is that rule.
- Releasing to `ready` with no known resume stage exits 5 ("pass --stage"), because GRM-10 would fail.
- `needsInput` stays prose in S1 (it posts a question and assigns a person). Its projection is `agentLabel: agent/needs-input` and leaves state alone; the adapter skill says so.

### 6. The verbs

**`flow snapshot [--include-closed] [--out <file>]`**

- Calls `getBacklogSnapshot`; prints a count summary, or the `BacklogSnapshot` with `--json`.
- `--out` writes the JSON to a file too (for `--snapshot` reuse).
- Replaces: the "Building the groom snapshot" recipe and the per-session pull scripts.

**`flow next [-n N] [--project <name|id>]`**

- Loads config; snapshot from the tracker or `--snapshot`.
- Identity: `identity.agent`, or `getCurrentUser().id` when it is `auto`; `identity.reviewer` as configured.
- Ownership: `classifyOwnership` (`identity.ts`) per item, over `ownership.scope`.
- WIP load: open items that are `started` and carry `agent/claimed`, counted by `project.id` and in total.
- Runs `classifyDispatchOutcome(items, { dispatch, ownership, wipCap: autonomy.wipCap }, opts)`, the same function `dispatch.ts` runs.
- `--project` filters candidates to one project (matched on id, else case-insensitive name) before dispatch.
- `-n` (default 1) takes the first N of `picked` (already capped by WIP).
- JSON: `{ v, picked: WorkItem[], eligibleCount, starved, shapeableCount, wip: { total, byProject } }`.
- Exit 0 even when nothing is eligible; `starved` says why.
- Replaces: every prose step that builds `dispatch.ts` input by hand (`commands/flow.md`, `skills/flow-drain`).

**`flow claim <identifier> [--pid N] [--worktree <path>] [--branch <name>] [--account <id>] [--host cli|dorkos|cmux]`**

- Preconditions (exit 5 on any): the item is open; carries `agent/ready`; is not `agent/claimed`; its ownership class is claimable under `ownership`; not paused (exit 7 unless `--manual`).
- Takes the `flow-state.json` lock, so two claims on one machine serialize.
- Writes `projectionFor('claim')`, then verifies by re-read.
- Writes a `FlowRun`: `status: "running"`, `stage` from the removed `stage/*` label (default `execute`), `attemptCount: 0` (or +1 if a record exists), `workerPid`, `startedAt`, `sessionId`, `worktreePath`, `branch`, `account`, `host`, and `provenance` per `docs/provenance.md` (omit what is unknown).
- `--pid` default: the parent of the shell that ran `flow` (the harness), read with `ps -o ppid= -p <process.ppid>`. If that fails, exit 5 asking for `--pid`.
- `sessionId` is required on a FlowRun and never invented: with neither `--session` nor `FLOW_SESSION_ID`, exit 5 asking for one.
- `--worktree` default: the checkout root of `--project`; `--branch` default: its current branch.
- No comment is posted: the label is the signal (agent etiquette: mostly quiet).
- Replaces: the label-swap and state-move steps in the drain, execute and adapter prose.

**`flow release <identifier> [--to ready|none] [--stage <stage>] [--reason <text>]`**

- Default `--to ready`.
- Writes `projectionFor('release')`, verifies, deletes the item's `FlowRun`.
- Posts a signed comment only with `--reason`.

**`flow done <identifier> (--summary <text> | --summary-file <path>) [--pr <url>]`**

- Posts the summary as a signed comment (identity marker + provenance line).
- Idempotent: skips the comment when one of the item's last 10 comments already has the same body up to its provenance line.
- Writes `projectionFor('done')`, verifies. An item the tracker already closed (a merged `Closes <id>`) still gets its labels fixed.
- Sets the `FlowRun` to `status: "complete"`, `completedAt: now`.
- Follow-ups, project pulse and worktree cleanup stay in `closing-work` (judgment).

**`flow stage <identifier> <stage>`**

- `<stage>` is a key of `stages` in config. Writes `projectionFor('stage')`, verifies.
- Updates `FlowRun.stage` when a record exists.
- Replaces: the adapter's `transition` mechanics; stage skills call this.

**`flow audit [--snapshot <file>]`**

- Runs the `audit-backlog.ts` oracle (GRM-1 … GRM-15) over the snapshot's `items` plus `closed`, with `agentIdentity` resolved as in `next`.
- Human: one block per failing invariant; JSON: the oracle's `{ ok, failures }` plus `v`.
- Exit 1 on any failure.
- Replaces: `groom check`'s snapshot-then-oracle steps (`skills/grooming-backlog`, `skills/flow-groom`).

**`flow status [<identifier>] [--strict]`**

- Joins `flow-state.json`, `.dork/flow/auto-run.json` (with its owner-pid check), the pause, and the snapshot.
- Sections: paused banner; drain; in flight (each `FlowRun` plus every `agent/claimed` item, with account and host); parked (`agent/needs-input` items); drift.
- Drift lines: a `running` run whose item is not `started`; a claimed item with no run; a run whose `workerPid` is not alive; any `STATE-n` breach on an in-flight item.
- With an identifier: that item only, plus its last parked question from `getItem(…, { comments: 20 })`.
- `--strict` exits 1 when there is drift.
- DorkOS schedules stay in `commands/status.md` (only an in-session tool can list them). The command shrinks to "run `flow status`, then list schedules when `tasks_list` exists".

**`flow accounts [list] | add --path <dir> [--label <text>] [--color <#rrggbb>] | set [<id>] [policy flags]`**

- `list` (default): every identity (§1.1a) with its resolved policy (§1.1b), its ledger windows via `readWindow`, `effectiveReservePct`, `fiveHourRoom`, `weeklyRoom`, the fleet `handoff`, and every warning.
- `add` registers an identity in `config.json`: expands `~`, requires an absolute path that exists, refuses a path already registered (exit 5), mints the id, and writes the row with all four keys (`label`, `color` as `null` when not given). It writes no policy, so a new account starts kept-out.
- `add` reads `config.json` fresh, changes only `runtimes.claudeCode.accounts`, keeps every other key, then temp-file + `rename`; the file keeps its mode (new file: `0600`).
- When `config.json` has `__internal__` (DorkOS manages it), `add` prints "DorkOS manages this file; you can also add accounts in its settings" and still writes (DorkOS re-reads before writing, §1.1a).
- `set <id>` edits that account's entry in `fleet.json`: `--role main|rotation|kept-out`, `--reserve <0-100>`, `--spend-down-hours <n>`, `--repos owner/name,…` (or `none` for `[]`). Each accepts `default` to delete the field.
- `set` with no id takes only `--handoff auto|ask`.
- `set` refuses an id that is not a registered identity (exit 5), and a second `main` (exit 5, naming the current one).
- Needs no tracker and no flow project config.

### 7. Code structure

```
plugins/flow/
  scripts/
    flow.ts                   entry, argv, verb table, exit codes, output
    cli/                      one module per verb, plus args.ts, output.ts, context.ts, provenance.ts
    config-load.ts            §3
    work-state.ts             §5 (zero deps)
    atomic-json.ts            §1.2 lock + temp + rename (zero deps)
    flow-state-file.ts        the file-backed FlowStateStore, on atomic-json
    fleet/accounts.ts         §1.1a identity read + id minting, §1.1b policy read/write (zero deps)
    fleet/usage-ledger.ts     §1.2 (zero deps)
    tracker/types.ts          §4 types
    tracker/load.ts           find + import adapter.ts, pick the transport
    tracker/external-cli.ts   the cli transport
  skills/linear-adapter/adapter.ts   the Linear code adapter
  conformance/fleet/                 §1.4
  engine-tests/                      tests below
```

- `tsconfig.json` `include` gains `skills/**/*.ts` and `conformance/**/*`.
- `flow-run.ts` and `flow-state.ts` gain `account` and `host` (§1.3).
- The tracker-confinement guard needs no change: the Linear code sits in `skills/linear-adapter/`.

## User Experience

- An agent runs `flow next --json`, then `flow claim DOR-123 --session $SESSION --pid $PPID`, works, and ends with `flow done DOR-123 --summary-file done.md`.
- A person runs `flow status` for one screen of what is in flight, and `flow accounts` to see each account's role, reserve and room.
- Errors name the fix: the missing adapter code, the `npm install` line, the `--stage` a release needs, the label the team lacks.

## Testing Strategy

Each test carries a purpose comment and is shown to fail against a broken implementation before it is trusted.

- **Per verb** (`engine-tests/cli/<verb>.test.ts`): `main(argv, deps)` with a fake adapter and fixture snapshots. Assert stdout JSON, human text on one case, exit code, and the exact `applyWorkState` calls.
- **`next` parity:** for three fixture backlogs, `flow next --json` equals `dispatch.ts` fed the hand-built input for the same items.
- **Projections:** every row of the §5 table; every `STATE-n` check red on a seeded item and green on its fixed twin; GRM-15 added to the audit-backlog bad fixtures.
- **Config:** precedence (env beats local beats committed beats default), `secrets` split, strict-schema failure, refusal, pause.
- **Tracker seam:** loader finds `adapter.ts` for project and shipped adapters; missing code, `mcp` transport and a missing capability each exit 3; a read that throws exits 4; a write whose read-back disagrees exits 4.
- **Linear adapter:** recorded Composio responses (paged, `storedInFile`, cross-team leak, flattened labels, `triage` state) → normalized output passes `validate-adapter.ts` INV-1..5; `applyWorkState` sends one `issueUpdate` whose `labelIds` union a fresh read; GraphQL text never contains an interpolated `$`.
- **Shared contracts:** `engine-tests/fleet-conformance.test.ts` runs every case file (§1.4) against `fleet/accounts.ts`, `fleet/usage-ledger.ts` and `flow-state.ts`; both JSON Schemas validate their good examples and reject their bad ones (ajv, already a dev dependency).
- **Concurrency:** 8 child processes each merge a different window into one ledger at once; all 8 windows survive. Same for 8 FlowRun writes to one `flow-state.json`. A stale lock is broken; a live one is waited on.
- **Accounts:** `add` keeps unknown keys and every other `config.json` section byte-for-byte and writes no policy; `set` writes only `fleet.json` and never `config.json`; defaults are never written; an unlisted account lists as kept-out; the DorkOS-managed note appears only with `__internal__`.
- **Process:** one spawn test runs the real `flow.ts --help` and one verb against a temp project with a file-based fake adapter, so the dynamic imports and exit codes are proved outside the harness.

## Performance Considerations

- A snapshot costs about 7 tracker calls on a 200-item backlog. `--snapshot` lets a drain reuse one pull across `next`, `audit` and `status`.
- `claim`/`release`/`done`/`stage` cost two reads and one write each.
- Ledger and run-state writes hold the lock for one read-merge-write, a few milliseconds.

## Security Considerations

- The transport never uses a shell; arguments are passed as an array, so titles and bodies cannot inject commands.
- `trackerAccount` pins the acting identity on every call; the `mcp` transport, which cannot be pinned, is refused.
- Secrets never reach stdout, stderr or a written file.
- Ledger and run-state files are `0600`; account ids are pattern-checked before they become file names.
- Provenance never carries an email (`docs/provenance.md` §7).

## Documentation

- `README.md`: a short "The flow CLI" section with the verb table.
- `docs/driving-it-manually.mdx`: the manual steps become `flow` calls.
- `docs/SPEC.md`: the CLI surface, the two new FlowRun fields, GRM-15.
- `adapters/SPEC.md`: contract 1.4.0 (§4).
- `docs/building-your-adapter.mdx`: how to add `adapter.ts`.
- `CHANGELOG.md` and the version bump in `plugin.json`, `.dork/manifest.json`, `package.json`, per PR.

## Implementation Phases

- **Phase 1, foundations:** the shared-contract modules and fixtures (first, DorkOS depends on them), config loading, the work-state rule with GRM-15, the FlowRun fields and file store, the CLI skeleton.
- **Phase 2, tracker seam:** the code-adapter loader and transport, contract 1.4.0, the Linear code adapter.
- **Phase 3, verbs:** each verb, deleting the prose it replaces in the same PR.
- **Phase 4, prove it:** docs, and a live run of `flow audit` on the DOR backlog with one fix pass until it exits 0.

## Decisions (made autonomously, logged as assumptions)

- **D1. Node script, not a binary.** Matches the oracles; no build step; resolves ideation open question 1.
- **D2. A code adapter beside `SKILL.md`, loaded by path.** Keeps project adapters committed with the project (DOR-2285) and the Linear code inside the confinement carve-out.
- **D3. The CLI refuses the `mcp` transport.** An MCP server lives inside an agent session; a child process cannot call it, and the acting identity could not be pinned.
- **D4. One write primitive, `applyWorkState`, plus `comment`.** Policy stays in `work-state.ts`; adapters stay mechanical.
- **D5. `stage/*` only on unstarted items (adapter contract 2.0.0).** The ideation's "only before EXECUTE" read literally would leave a released execute-stage item with no resume point and fail GRM-10. Resolves ideation open question 3.
- **D6. Policy is flow's file, not DorkOS config** (operator direction, 2026-09-26, via the orchestrator). DorkOS core keeps identity, `color` and the ledger; roles are `main | rotation | kept-out`, replacing the ideation's `general, reserve, org` and its separate `rotation` flag. Unlisted accounts are kept out.
- **D7. No inferred main account.** Guessing from `~/.claude` or `defaultAccount` could reserve the wrong account; `flow accounts` warns instead.
- **D8. `FlowRun.host` is the launcher, not the machine.** The machine is already `provenance.host`.
- **D9. `flow-state.json` in the main checkout.** Worktrees of one project share one run store, like `paused.json`.
- **D10. `claim` posts no comment.** The label is the signal; `release --reason` and `done` do post.
- **D11. A `stage` verb beyond the eight requested.** Without it `transition` stays prose, and F10's rule would live in two places.
- **D12. `accounts add` writes `config.json` even when DorkOS manages it.** Registering an identity from the bare CLI is DOR-2368's ask; DorkOS re-reads before writing (§1.1a). Policy never touches `config.json`.
- **D13. Default output is human; `--json` is explicit.** Skills always pass `--json`; people get readable text.

## Open Questions

None open. The operator decided compliance, registry home, handoff default, reserve and the org account (flow-fleet §8).

## Related ADRs

- None in this repo (the marketplace has no `decisions/`). D2, D4 and D5 are the ADR-worthy calls; they are recorded here and in `adapters/SPEC.md` 1.4.0.

## References

- [`specs/flow-cli-overhaul/01-ideation.md`](../flow-cli-overhaul/01-ideation.md) steps 1, 4, 5
- [`specs/flow-fleet/01-ideation.md`](../flow-fleet/01-ideation.md) §4.1–4.3, §8, §9
- `plugins/flow/adapters/SPEC.md`, `plugins/flow/docs/SPEC.md`, `plugins/flow/docs/provenance.md`
- DorkOS `packages/shared/src/config-schema.ts` (`ClaudeCodeAccountSchema`, `claudeAccountId`)
- Linear: DOR-2366 (umbrella), DOR-2367, DOR-2368, DOR-2376
