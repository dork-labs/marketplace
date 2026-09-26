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

## 1. Shared contracts (flow ↔ DorkOS), rev 6 (with rev 6d)

These contracts are public and tracker-neutral. Both sides implement them independently and prove it with one fixture set (§1.4). A change to any rule here is a contract change: bump `CONTRACT_VERSION` in the fixture folder and change both sides.

**Rev 6 (contract 2.0.0, breaking) makes every contract runtime-neutral.** flow runs from Claude Code, Codex and OpenCode sessions, so everything it records, reads and routes names the runtime. The runtime slug is `claude-code`, `codex` or `opencode`; anything else is refused before it reaches a path. The binding decisions are summarized in [`../flow-fleet/01-ideation.md`](../flow-fleet/01-ideation.md) "Runtimes" (R1-R9).

**Rev 6d (contract 3.0.0) pins what `default` means.** Found against the operator's real `config.json` (`defaultAccount: null`, one registered row in `~/.claude3`): under rev 6 `default` existed only when a runtime had no registered row, so the operator's main account in `~/.claude` was invisible. Now an account is its folder, not its id; `default` always names the runtime's default folder, and is an alias when a registered row has that folder (§1.1a "The default account (rev 6d)"). The meaning of `default` changed, a changed rule, so the version is a major bump.

### 1.1 Accounts: identity in DorkOS config, routing policy in flow's own file

The registry is split by owner (operator direction, 2026-09-26). DorkOS core owns who the accounts are and how they look. flow owns how work is routed to them.

`<dorkHome>` below = the `DORK_HOME` environment variable when set and non-empty, else `<os home>/.dork`. flow never uses DorkOS's dev-mode default (`apps/server/.temp/.dork`); a DorkOS dev server that wants flow to see its accounts sets `DORK_HOME`.

**An account is a billing identity of ONE runtime:** a `CLAUDE_CONFIG_DIR` for Claude Code, a `CODEX_HOME` for Codex, a provider credential profile for OpenCode. Its key everywhere outside the registry is `<runtime>:<account-id>` (`claude-code:acct-2`, `codex:default`). The same id in two runtimes is two accounts.

#### 1.1a Identity: `<dorkHome>/config.json` → `runtimes.<claudeCode|codex|opencode>.accounts[]` (DorkOS core)

| Runtime       | Config key               | `path` is                        |
| ------------- | ------------------------ | -------------------------------- |
| `claude-code` | `runtimes.claudeCode`    | the account's `CLAUDE_CONFIG_DIR` |
| `codex`       | `runtimes.codex`         | the account's `CODEX_HOME`        |
| `opencode`    | `runtimes.opencode`      | the provider profile's folder     |

Every runtime's rows have the same shape and follow the same rules:

| Field   | Type                               | Default when absent | Meaning                                                                  |
| ------- | ---------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `id`    | string, `^[a-z0-9]+(-[a-z0-9]+)*$` | minted (below)      | What everything else references. Unique in the array.                    |
| `path`  | string, absolute                   | required            | The folder the account runs in (table above).                            |
| `label` | string \| null                     | `null`              | The operator's name for it.                                              |
| `color` | string `^#[0-9a-f]{6}$` \| null    | `null`              | **New, DorkOS core.** Display color; `null` = a stable default by position. |

- `id`, `path`, `label` exist today for Claude Code (DorkOS `ClaudeCodeAccountSchema`, spec `claude-code-accounts` D1). `color` is the one new field. The Codex and OpenCode registries are a later DorkOS backlog item; readers read them when present.
- **The default account.** Every runtime has a `default` account; which account it is follows "The default account (rev 6d)" below.
- **`default` is reserved** for the default account. Minting never produces it (a base of `default` counts as taken, so a label "Default" mints `default-2`). A registered row whose `id` is `default` (a hand edit) is listed with an `id-reserved` warning but is not routable: it has no usage file and reads as `kept-out`, so it can never read the default account's readings or be spent as if it were that account. It never takes the name: `<runtime>:default` always resolves to the real default account.
- A DorkOS row minted as `default` before this rule existed is renamed by DorkOS to the next free `default-N` on its next write of the registry (its config migration), and DorkOS moves any per-account references (agent manifests, launch hints) with it. Until then flow lists it as `id-reserved` and does not route it.
- No routing policy lives here. DorkOS core never reads or writes flow's policy.
- A missing file or a missing key means "no registered accounts" (so each runtime has only its default), never an error.
- A file DorkOS never touched is valid: flow may create it as `{"runtimes":{"claudeCode":{"accounts":[…]}}}` with no other keys.
- Readers ignore fields they do not know; writers preserve them.
- A row with a missing or non-absolute `path` is skipped, with a warning.
- A row with no `id` (or an empty one) gets one at read time by the minting rule. Ids are minted over every object row in array order **before any row is skipped**, exactly as DorkOS `backfillMissingAccountIds` does: every id already present is reserved first, then each missing one is minted from `label` (when a string) and `path` (when a string, else `''`). Skipping first would shift later ids and the two sides would write different ledger files.
- A duplicate `id` keeps the first row and warns.
- A row whose `id` fails the pattern (a hand edit) is listed, with a warning, but has no usage file and cannot be routed: it reads as `kept-out` with `scope.repos: []`.
- A `color` that fails the pattern reads as `null`, with a warning.
- flow writes every row it creates with all four keys, `label` and `color` as `null` when not given, so DorkOS's schema (`label` nullable with no default) accepts it. `flow accounts add` registers Claude Code rows only.

**The default account (rev 6d)** (pinned by `accounts.cases.json`)

1. **Identity is the folder, not the id.** Two folders are the same account when their comparable forms match: expand a leading `~` with the OS home, resolve (this normalizes `..` and drops trailing separators), then take the real path when the folder exists (so a symlink finds its target); a folder that does not exist is compared as normalized, never resolved.
2. **`<runtime>:default` always exists for Claude Code and Codex** and names the runtime's default folder, **machine-wide**:
   - Claude Code: DorkOS `runtimes.claudeCode.defaultAccount` when it is a non-empty path (absolute, or starting with `~`); else `runtimes.claudeCode.activeAccount` (its name before DorkOS 0.65.0) when `defaultAccount` is null or absent; else `<os home>/.claude`. A `defaultAccount` that is text but not a path is ignored with `default-account-invalid`.
   - Codex: `<os home>/.codex`.
   - **Never the process environment** (lead decision after review). A session's own `CLAUDE_CONFIG_DIR` or `CODEX_HOME` must not change which account `default` names: with it, a `flow` command run from a session on claude3 read claude3 as `default`, so `flow usage prune --yes` deleted the main account's live `default.json` and `flow accounts set default` wrote claude3's policy. The variables still say which folder THIS process runs in (`ambientAccountPath`): the status-line recorder uses that to attribute a session, and the launchers to start one, but never to decide identity.
   - OpenCode keeps its ambient default: a `default` with no folder, only while it has no registered row left.
3. **Alias.** When a routable registered row of that runtime has the default folder, `default` is another name for that row. It is not a second account: there is one ledger file (under the row's id), one `fleet.json` policy, and never two readings for one real account. The row carries `isDefault: true`; `flow accounts` shows it as "Claude3 (default)".
4. **Standalone.** When no routable row has the default folder (the operator's case), `default` is its own account, listed after the registered rows: path = the default folder (`~` expanded), label "Main (this computer's sign-in)", ledger `default.json`. No config field names its label today; a later DorkOS field may.
5. **Resolving an id.** Every reader and writer that takes an account id maps `default` to the account it names before it builds a ledger path or a `fleet.json` key: `ledgerPath`/`readLedger`/`recordUsage` callers, the policy lookup and every policy write, `usage probe`/`record`/`scan`, `usage snapshot`, `prune`, account ranking (`chooseAccount` is given the resolved accounts, a standalone `default` included) and the launchers (`launchAccountFor` gives `default` its machine-wide folder, or its row when it is an alias). flow does this in one place, `resolveAccounts(runtime, { config, home, realpath? })` in `scripts/fleet/accounts.ts`, which returns each account with its canonical folder (`canonicalPath`), the default mark (`isDefault`), its ledger id (`ledgerId`, `null` when not routable) and its label; `resolveAccountRef(accounts, runtime, id)` and `accountForPath(accounts, runtime, dir, env)` answer "which account is this id" and "which account runs in this folder".
6. **A session's own folder.** A recorder that runs inside every session (the status-line `flow usage record`, and `record --runtime codex`) reads `CLAUDE_CONFIG_DIR`/`CODEX_HOME` as that session's folder and writes for the account whose folder that is. Since `default` is machine-wide, a session in an unregistered folder that is not the default writes nothing rather than mixing another account's readings into `default.json`.

**Minting an id** (identical to DorkOS `claudeAccountId`, pinned by fixtures)

- Slugify: lowercase, every run of non `[a-z0-9]` becomes one `-`, trim `-` from both ends.
- Base = slug(label), else slug(basename of path), else `account`.
- If the base is taken, append `-2`, `-3`, … until free. `default` is always taken.

**What DorkOS must do**

- Add `color` to `ClaudeCodeAccountSchema`: nullable, default `null`, the pattern above.
- Enforce the id pattern on every write, so no new row gets an id the ledger would refuse.
- Re-read the file before each write of `runtimes.claudeCode`, so a flow `accounts add` made while the server runs is not lost.
- Accept a `config.json` that flow created (no `__internal__`, no `version`).
- Keep the minting rule, and reserve `default` in it (`claudeAccountId` must never return `default`; skip to `default-2`), and refuse `default` as an id on every write.
- When it adds `runtimes.codex.accounts` or `runtimes.opencode.accounts`, use the same row shape and rules.
- When an account is removed from a registry, delete its ledger file (§1.2 "Removing an account").
- **Rev 6d:** resolve `default` exactly as "The default account (rev 6d)" says, machine-wide, from the same inputs (its config, the OS home, real paths) and never from the DorkOS server's own environment, and run `accounts.cases.json` with `input.realpath` as the real-path lookup and `input.env` ignored. Treat `<runtime>:default` as the row it aliases everywhere: write that row's ledger, read its `fleet.json` entry, never create `default.json` for an aliased default, and show one account. A standalone default is a real account: list it, record its readings in `default.json`, and let the operator pick it.

#### 1.1b Routing policy: `<dorkHome>/flow/fleet.json` (flow-owned)

```jsonc
{
  "v": 1,
  "handoff": "auto",                 // "auto" | "ask"; default "auto"
  "runtimes": ["claude-code", "codex"], // preference order; default [] (see below)
  "crossRuntimeFallback": "off",     // "off" | "on"; default "off"
  "accounts": {
    "claude-code:claude3": {         // key = <runtime>:<account-id>
      "role": "rotation",            // "main" | "rotation" | "kept-out"
      "reservePct": 0,               // 0–100
      "spendDownWindowHours": 24,    // ≥ 0
      "scope": { "repos": ["acme/app"] } // only read for kept-out
    },
    "codex:default": { "role": "kept-out" }
  }
}
```

JSON Schema: `plugins/flow/conformance/fleet/fleet-policy.schema.json`. It is the **writer** shape: what a writer may store. Readers accept more (below): a file with no `v`, and bare keys written before 2.0.0, both of which the schema rejects.

| Field                  | Default when absent                                   | Meaning                                                                                  |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `handoff`              | `"auto"`                                              | Fleet-wide: move work off an account that runs out automatically, or ask first.           |
| `runtimes`             | `[]`                                                  | Runtimes in order of preference. `[]` = the runtime the item started on first.            |
| `crossRuntimeFallback` | `"off"`                                               | `on`: a task whose runtime is out may continue on another runtime from its checkpoint.    |
| `role`                 | `"kept-out"` for a registered account; for a standalone `default`, see "The default account's role" | `main`: the operator's own, drained last. `rotation`: spent freely. `kept-out`: not spent, except on its scoped repos. |
| `reservePct`           | `50` for `main`, else `0`                             | Share of the 7-day window kept back for the operator's own use.                           |
| `spendDownWindowHours` | `24`                                                  | Hours before the 7-day reset in which the reserve drops to 0.                             |
| `scope.repos`          | `[]`                                                  | For `kept-out` only: the repos it may serve. `[]` = never. Ignored for `main` and `rotation`, which serve any repo. |

**Rules**

- **Opt-in by default for registered accounts.** A registered account with no entry in `fleet.json`, or no `fleet.json` at all, resolves to `role: "kept-out"`, `scope.repos: []`: nothing is spent until the operator says so.
- **The default account's role (rev 6d, lead decision).** With no stored role, a standalone `default` resolves to `main` (so a 50% reserve, drained last) when its runtime has at least one routable registered account: the operator's own sign-in sits beside rotation accounts. It resolves to `rotation` when it is the runtime's only routable account, since keeping it out would block the runtime. Precedence: (1) an explicit `role` in `fleet.json` always wins; (2) an explicit `main` on another account of the runtime wins over the default's implied `main`, and `default` then reads as `rotation` (`flow accounts set <id> --role main` is allowed while `default` is main only by default); (3) with explicit mains on two accounts, the first in list order wins as before, and a standalone `default` is listed last. An aliased `default` has no role of its own: it is its row.
- **An alias's entry.** When `default` is an alias, an entry under `<runtime>:default` is the aliased row's entry (and not an unknown key); when the row's own key is also stored, the row's wins (`entry-duplicate`). A policy write for `default` stores under the row's key and folds the `default` entry into it.
- **Keys.** An entry's key is `<runtime>:<account-id>`. A bare key with no `:` was written before contract 2.0.0 and reads as `claude-code:<key>`; when both forms are present the prefixed one wins and the bare one is ignored, with a warning. Every write stores the prefixed form (the next write migrates the file).
- Writers store only what the operator set. Defaults are resolved at read time, never written.
- Readers ignore fields they do not know; writers preserve them.
- A `scope.repos` entry is `owner/name`, compared case-insensitively with the `owner/name` parsed from the checkout's `origin` remote (https or ssh form, `.git` stripped). A checkout with no parsable `origin` matches nothing.
- At most one `main` per runtime. With two or more, readers keep the first in registry order and treat the rest as `rotation`, with a warning.
- With no `main` in a runtime that has registered accounts, none of them has a default reserve; `flow accounts` warns.
- An unknown `role`, an out-of-range `reservePct` or a negative `spendDownWindowHours` reads as absent (the default), with a warning. A `runtimes` entry that is not a runtime slug, or repeats one, is dropped with a warning; an unknown `crossRuntimeFallback` reads as `off`, with a warning.
- An entry whose key names no account (an unknown runtime, or an account no longer registered) is ignored, with a warning. `flow accounts` then drops it from the file with a note, unless `config.json` could not be read in full.
- **Version.** A file with no `v` reads as version 1. A file whose `v` is anything else (another number, or a non-number) is not read: every account resolves to its default, with a `fleet-version-unknown` warning, and every writer refuses to write it (never a downgrade), naming the file and its version.
- Writes use the §1.2 lock-and-rename steps, with the lock at `fleet.json.lock`.
- Two writers edit this file: `flow accounts set` in the bare CLI, and the DorkOS Flow extension's server side behind its "Flow" settings tab. Both use the same steps; DorkOS core does not touch it.
- Model fallback stays within a runtime. Which (runtime, account) pair takes an item, using `runtimes` and `crossRuntimeFallback`, belongs to dispatch (spec unit S3, `rankAccounts` over pairs); the fields and their defaults above are the contract.

**Which repos an account may serve** (`mayServe(policy, repo)`)

- `main`, `rotation`: any repo.
- `kept-out`: only a repo in `scope.repos`.

**The reserve and the spend-down window**

- `effectiveReservePct = 0` when the account's `seven_day` reading has a `resetsAt` and `resetsAt − spendDownWindowHours ≤ now < resetsAt`. At or after `resetsAt` the reading has expired (the window reset), so the reserve applies again.
- Otherwise `effectiveReservePct = reservePct`.
- With no `seven_day` `resetsAt`, the reserve stays at `reservePct`.
- **The main-account rule** (operator decision, flow-fleet §8.4): `main` defaults to a 50% reserve, and dispatch offers it work only when no other eligible account has room, or inside its spend-down window. The ordering belongs to dispatch (spec unit S3); the numbers above are the contract.

**Room on an account** (readings per §1.2's read rules)

- `fiveHourRoom`: `false` when the `five_hour` reading is `rejected` or its `usedPct ≥ 100`; `null` when there is no reading; else `true`.
- `weeklyRoom`: `false` when the `seven_day` reading is `rejected` or its `usedPct ≥ 100 − effectiveReservePct`; `null` when there is no reading; else `true`.
- A model bucket (`model:<slug>`, `seven_day_opus`, `seven_day_sonnet`) is checked like `weeklyRoom` against 100 (no reserve), when dispatch knows the item's model (`modelRoom`).
- `spendRoom`: `false` when the ledger's `spend` has a `limitUsd` and `costUsd ≥ limitUsd`; `null` with no spend reading; else `true`.
- `accountRoom(runtime, policy, ledger, now)`, the one answer for any kind of account:
  - `false` when any current window that is not a model bucket is `rejected` or at its ceiling (`seven_day` against `100 − effectiveReservePct`, every other window against 100). This includes a `credits:<slug>` or `rate_limit:<slug>` rejection, whatever the other windows say. Also `false` when `spendRoom` is `false`.
  - Else `true` when the account has a current non-bucket window reading or a spend reading. **A metered account is eligible unless its `spend.limitUsd` is reached.**
  - Else, with nothing to go on: `true` for `opencode` (**a local-model account, no windows and no cap, is always eligible**) and `null` for `claude-code` and `codex`, whose accounts always have subscription windows.
- `null` means unknown. Dispatch decides what unknown means; `flow accounts` shows "unknown".

### 1.2 The usage ledger

**Where it lives**

- One file per account: `<dorkHome>/runtimes/<runtime>/usage/<account-id>.json`. The runtime must be a runtime slug and the id must match the id pattern above (`default` for a standalone default account; an aliased default writes its row's file); anything else is refused (no path traversal).
- Folder mode `0700`, file mode `0600`.
- The folder sits under `runtimes/<runtime>/` because the ledger is core account observation that DorkOS reads without flow, and it is specific to one runtime's accounts. Readers never read the location used before 2.0.0, `<dorkHome>/usage/`.
- **Lifecycle.** The ledger is overwrite-only (one small file per account, the newest reading per window), so it never grows; the history of readings goes to the flow journal as sampled `usage.snapshot` events. A reading past its `resetsAt` reads as empty and is never deleted early.

**Shape** (JSON Schema: `plugins/flow/conformance/fleet/usage-ledger.schema.json`)

```jsonc
{
  "v": 1,
  "runtime": "codex",                         // required; always the runtime in the path
  "accountId": "default",
  "updatedAt": "2026-09-26T16:04:11.000Z",   // last write, any window or fact
  "windows": {
    "five_hour": {
      "usedPct": 41.5,                        // number 0–100, or null when the source gave none
      "resetsAt": "2026-09-26T19:00:00.000Z", // ISO-8601 UTC, or null
      "windowMinutes": 300,                   // optional: the window's length, when the source names it
      "status": null,                         // "allowed" | "allowed_warning" | "rejected", or null
      "observedAt": "2026-09-26T16:04:10.000Z", // when the SOURCE saw it, not when it was written
      "source": "rollout"
    },
    "seven_day": { … },
    "model:gpt-5.3-codex-spark": { … },       // a per-model bucket
    "credits:openrouter": { … }               // an error-only signal (below)
  },
  "plan": { "name": "pro", "observedAt": "…", "source": "rollout" },        // optional
  "credits": { "hasCredits": true, "unlimited": false, "balance": "12.50",   // optional
               "observedAt": "…", "source": "rollout" },
  "spend": { "periodStart": "2026-09-01T00:00:00.000Z", "costUsd": 20,       // optional, metered accounts
             "limitUsd": 25, "observedAt": "…", "source": "provider_api" }
}
```

- `v` stays `1`; contract 2.0.0 adds the required `runtime`. A merge into a file with no `runtime` (or another one) sets it to the path's runtime and rewrites the file. Readers trust the path.
- `plan`, `credits` and `spend` each carry `observedAt` and `source` and merge like a window: newest `observedAt` wins. `balance` is the runtime's own string, or `null`. `limitUsd` is `null` (or absent) with no cap. A spend reading never goes stale.

**Window keys**

- Known: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`.
- Model buckets: `model:<slug>`.
- A window known only by its length: `window:<minutes>`, minutes an integer ≥ 1.
- Error-only signals from one provider: `credits:<slug>` (payment required, out of credits) and `rate_limit:<slug>` (HTTP 429), where the slug is the provider id (`credits:openrouter`). They are window-less entries: `source: "error"`, `status: "rejected"`, `usedPct: null`, and `resetsAt` when the provider says.
- Every `<slug>` above follows `^[a-z0-9][a-z0-9._-]*$`: lowercase, every run of characters outside `[a-z0-9._-]` becomes `-`, anything but a letter or digit trimmed from the start and `-` from the end (`GPT-5.3-Codex-Spark` → `gpt-5.3-codex-spark`).
- Any other key matching `^[a-z][a-z0-9_]*$` is allowed, so a new SDK window needs no contract change. Readers ignore keys they do not use; writers keep them.

**One entry**

- `observedAt` and `source` are required. At least one of `usedPct` and `status` is non-null.
- `windowMinutes`, when present, is an integer ≥ 1; anything else makes the entry invalid.
- All timestamps are ISO-8601 with an explicit zone; writers emit UTC with `Z`.
- `usedPct` is clamped to 0–100 by the writer.

**Mapping each source** (writers convert; the ledger holds one unit)

| Source         | Runtime     | Writer                   | `usedPct`                                   | `resetsAt`                    | `status`             |
| -------------- | ----------- | ------------------------ | ------------------------------------------- | ----------------------------- | -------------------- |
| `statusline`   | Claude Code | flow CLI                 | `rate_limits.<w>.used_percentage` (0–100)   | `resets_at`, epoch seconds or ISO, to ISO | `null`   |
| `sdk_event`    | Claude Code | DorkOS                   | `rate_limit_info.utilization` × 100 (0–1 fraction) | `resetsAt` epoch seconds, to ISO | `status`       |
| `sdk_usage`    | Claude Code | DorkOS, `flow usage probe` | `rate_limits.<w>.utilization` (0–100)     | `resets_at` (ISO)             | `null`               |
| `transcript`   | Claude Code | `flow usage scan`        | `null`                                      | parsed from the message, else `null` | `"rejected"`  |
| `rollout`      | Codex       | `flow usage scan --runtime codex`, DorkOS | see "Codex" below          | see below                     | see below            |
| `sidecar`      | OpenCode    | DorkOS                   | none: per-turn `cost` becomes `spend`       |                               |                      |
| `provider_api` | OpenCode    | DorkOS                   | none: the provider's key API gives `spend` (credit and limit) |              |                      |
| `error`        | any         | DorkOS, flow             | `null`                                      | when the provider says        | `"rejected"`         |

- `sdk_event` uses `rateLimitType` as the window key.
- A transcript message whose window cannot be identified is not recorded.
- All data is official: status line, SDK events, the runtime's own rollout files, the provider's documented key API with the user's own key. No token extraction.

**Codex** (`codexObservations(rateLimits, observedAt, source)`, one `rate_limits` payload)

- One account has several limits, told apart by `limit_id`, and their events alternate. Only the main limit (`limit_id` `"codex"`, or none) maps to plain windows: `primary` and `secondary` are keyed by `window_minutes`, not by slot: `300` → `five_hour`, `10080` → `seven_day`, anything else → `window:<minutes>`.
- Any other limit (e.g. `limit_id` `codex_bengalfox`, `limit_name` `GPT-5.3-Codex-Spark`, or `premium`) becomes ONE `model:<slug>` bucket, the slug from `limit_name`, else `limit_id`. It holds the limit's tightest window: the highest `used_percent`, a tie going to the longer window. Mapping by slot alone would let such a limit overwrite the account's `five_hour` and `seven_day`.
- `used_percent` is `usedPct`, `resets_at` (epoch seconds) is `resetsAt`, and the length is kept as `windowMinutes`. A window with no integer length or numeric percentage is skipped.
- `status` is `null`, except when `rate_limit_reached_type` is not null: then only the window(s) that hit the limit are `"rejected"`: every window with `used_percent ≥ 100`, else the single tightest one (the highest `used_percent`, a tie going to the shorter window, which resets first). A model bucket's one window is `"rejected"`. Marking every window would keep a week-long window rejected long after a 5-hour limit reset, and dispatch, avoiding the account, would never produce a reading that clears it. The type has no other meaning (it is null in real events even at 100%).
- `plan_type` becomes `plan`; `credits` (`has_credits`, `unlimited`, `balance`) becomes `credits`.

**Reading a window** (`readWindow(entry, now, key)`)

- Expired: `resetsAt` is set and `now ≥ resetsAt`. An expired entry reads as `usedPct 0`, `status "allowed"`, `expired: true`.
- Stale: `resetsAt` is null and `now − observedAt` exceeds the window length. The length is 1 hour for `credits:*` and `rate_limit:*`; else the entry's `windowMinutes`, or the minutes in a `window:<minutes>` key; else `five_hour` 5 h and every other key 7 days. A stale entry reads as no reading.
- Otherwise the entry reads as stored.

**Merging** (`mergeLedger(existing, observations, now, { runtime, accountId })`)

- An observation is a window reading (it has a `key`) or a fact (it has a `kind`: `plan`, `credits` or `spend`).
- Per window key, and per fact, an observation replaces the stored entry only when its `observedAt` is strictly later.
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

**Removing an account** (`pruneTargets(registered, onDisk)`)

- A ledger file whose id is not a registered account of its runtime is deleted: by DorkOS when the operator removes the account, and by `flow usage prune` for any left behind.
- `default.json` is kept only while `default` stands alone (rev 6d). Once a routable row has the default folder, `default.json` would be a second reading of that row's account, so it goes like any other and the row's file stays. For OpenCode it goes once the runtime has registered accounts. `registered` holds each account's ledger id.
- Deleting takes the file's lock (step 1), so a writer merging at that moment finishes first or starts after. A missing file is not an error. Nothing is deleted when `config.json` cannot be read in full.

### 1.3 The session ↔ item link

**Where it lives**

- `<main checkout>/.dork/flow/flow-state.json`: one file per project, shared by every worktree. `<main checkout>` is the parent of `git rev-parse --git-common-dir`.
- Shape: `Record<issueId, FlowRun>` (`scripts/flow-state.ts`, unchanged except the three fields below).

**Three optional `FlowRun` fields**

| Field     | Type                               | Meaning                                                                                             |
| --------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `runtime` | string: `claude-code`, `codex` or `opencode` today | The runtime the **current** session runs on. Rewritten on every handoff.            |
| `account` | string (an id in that runtime's registry, or `default`) | The account the current session bills. Rewritten on every handoff. A reader maps `default` to the account it names (rev 6d). |
| `host`    | string: `cli`, `dorkos` or `cmux` today | The launcher the current session runs under.                                                   |

- `host` is not the machine. The machine is `provenance.host`.
- `provenance.account` stays what it is: the origin's `CLAUDE_CONFIG_DIR` basename, written once at run start and never updated. `FlowRun.account` is the current registry id; with `runtime` it forms the account key.
- The join key between a session and an item is `FlowRun.sessionId`. A DorkOS session whose id matches a record serves that record's `identifier`.

**Rules**

- Readers pass unknown fields through (the store is read-modify-write; see the `looseObject` note in `flow-state.ts`).
- `host` and `runtime` are validated as bare strings, like `provenance.harness`: the vocabularies are pinned in prose, so a record from a future launcher or runtime never fails the all-or-nothing reader.
- A writer that finds the existing file present but failing the schema refuses to write and reports the file; it never replaces a file it could not read (that would delete every other run).
- Writers use the §1.2 lock-and-rename steps, with the lock at `flow-state.json.lock`.
- DorkOS reads this file and never writes it, until a later contract moves the store into DorkOS (flow SPEC v2).

### 1.4 The conformance fixture

- Folder: `plugins/flow/conformance/fleet/`, with `CONTRACT_VERSION` (`3.0.0` since rev 6d), the JSON Schemas (`usage-ledger.schema.json`, `fleet-policy.schema.json`), and case files.
- Case files: `account-id.cases.json`, `identity.cases.json` (one runtime's rows), `accounts.cases.json` (every runtime and its default account: standalone, alias, `defaultAccount` set, with the resolution inputs `home` and a `realpath` map given as case inputs so no runner needs the filesystem, and an `env` that must be ignored), `fleet-policy.cases.json` (resolving 1.1b, including key migration, the default account's role and aliases, and `mayServe`), `window-read.cases.json`, `room.cases.json`, `eligibility.cases.json` (`accountRoom`, `spendRoom`: metered and local accounts), `ledger-merge.cases.json`, `codex-rate-limits.cases.json`, `prune.cases.json`, `flow-run.cases.json`.
- Every case is `{ "name": string, "input": object, "expected": object }`, and `now` is always an input, never the wall clock.
- `flow-run.cases.json` gives FlowRun records, some with fields the reader does not know, and the expected read-back (unknown fields preserved).
- flow runs them in `engine-tests/fleet-conformance.test.ts`. DorkOS vendors the folder at a pinned commit and runs its own implementation against it; the DorkOS spec picks the mechanism.
- The fixture folder names no tracker, no price, no plan and nothing private.

**What DorkOS must do for rev 6**

- Read and write ledgers at `<dorkHome>/runtimes/<runtime>/usage/<account-id>.json` with the required `runtime`, and never the old `<dorkHome>/usage/`.
- Read every runtime's registry and resolve each runtime's `default` account by the rev 6d rule.
- Write Codex readings with the Codex rules above, OpenCode `spend` and `credits:*`/`rate_limit:*` signals with the rules above.
- Delete a removed account's ledger file (§1.2 "Removing an account").
- Watch the ledger folders (a file watch plus a periodic read), so readings flow writes reach its views.
- Run the 3.0.0 fixture, including the new case files and the rev 6d cases.

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
| `--session <id>`   | write verbs                  | The harness session id for provenance and `FlowRun.sessionId`. Else `FLOW_SESSION_ID`, else the runtime's own id: `CLAUDE_CODE_SESSION_ID` (Claude Code) or `CODEX_THREAD_ID` (Codex), each set for every shell command. OpenCode sets none (`scripts/cli/session-id.ts`). |
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
| 70   | Internal error: a bug in flow (kept apart from 1, so a crash never reads as audit results).  |

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

**`flow next [-n N] [--for-project <name|id>]`**

- Loads config; snapshot from the tracker or `--snapshot`.
- Identity: `identity.agent`, or `getCurrentUser().id` when it is `auto`; `identity.reviewer` as configured.
- Ownership: `classifyOwnership` (`identity.ts`) per item, over `ownership.scope`.
- WIP load: open items that are `started` and carry `agent/claimed`, counted by `project.id` and in total.
- Runs `classifyDispatchOutcome(items, { dispatch, ownership, wipCap: autonomy.wipCap }, opts)`, the same function `dispatch.ts` runs.
- `--for-project` filters candidates to one project (matched on id, else case-insensitive name) before dispatch; no match exits 5. Its own flag, so the common `--project <dir>` keeps meaning the checkout. The WIP load still counts every project.
- `-n` (default 1) takes the first N of `picked` (already capped by WIP).
- JSON: `{ v, picked: WorkItem[], eligibleCount, starved, shapeableCount, atWipCap, wip: { total, byProject } }`. `atWipCap` is true when nothing is eligible only because work in progress fills `autonomy.wipCap` (ranking again with no cap finds work); `starved` counts claimed in-flight items as shapeable, so a caller checks `atWipCap` first and waits instead of triaging.
- Exit 0 even when nothing is eligible; `starved` says why.
- Replaces: every prose step that builds `dispatch.ts` input by hand (`commands/flow.md`, `skills/flow-drain`).

**`flow claim <identifier> [--pid N] [--worktree <path>] [--branch <name>] [--account <id>] [--host cli|dorkos|cmux] [--runtime claude-code|codex|opencode]`**

- Preconditions (exit 5 on any): the item is open; carries `agent/ready`; is not `agent/claimed`; its ownership class is claimable under `ownership`; not paused (exit 7 unless `--manual`).
- Holds a claim lock, `flow-state.json.claim.lock` (the §1.2 lock steps, its mtime refreshed while held), from the `getItem` that checks the preconditions through the `FlowRun` write, so two claims of one item on one machine serialize: the second reads `agent/claimed` and exits 5. The store's own `flow-state.json.lock` is taken only for the short `FlowRun` write, so `stage`, `done` and `release` writes never wait out a claim's tracker calls.
- Writes `projectionFor('claim')`, then verifies by re-read.
- Writes a `FlowRun`: `status: "running"`, `stage` from the removed `stage/*` label (default `execute`), `attemptCount: 0` (or +1 if a record exists), `workerPid`, `startedAt`, `sessionId`, `worktreePath`, `branch`, `runtime`, `account`, `host`, and `provenance` per `docs/provenance.md` (omit what is unknown).
- `--pid` default: the parent of the shell that ran `flow` (the harness), read with `ps -o ppid= -p <process.ppid>`. If that fails, exit 5 asking for `--pid`.
- `sessionId` is never invented. It is `--session`, else `FLOW_SESSION_ID`, else the runtime's own id (`CLAUDE_CODE_SESSION_ID` under Claude Code, `CODEX_THREAD_ID` under Codex), so a Claude Code or Codex drain needs no flag. With none of them (OpenCode sets no id), the claim exits 5 before any write, naming the flag and the variables: recovery resumes a run by its session id, so a run without one could never be resumed. (Rev 6; before it, the claim recorded `sessionId: ""` and warned.)
- `runtime` (rev 6): `--runtime`, else the runtime the shared `scripts/runtime-detect.ts` finds (its most specific marker wins: Codex, then OpenCode, then Claude Code; `FLOW_RUNTIME` overrides), else omitted. The session id then comes from that runtime's own variable, also when `--runtime` names it (`runtimeSession(env, runtime)` in `scripts/cli/session-id.ts`). A value outside the three slugs exits 2. The same detection fills `provenance.harness`.
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

**`flow accounts [list] | add --path <dir> [--label <text>] [--color <#rrggbb>] | set [<id>] [policy flags]`** (rev 6: per runtime)

- `list` (default): every account of every runtime (§1.1a, each runtime's `default` included: its own row when it stands alone, else marked "(default)" on the row it aliases), grouped by runtime, each with its key, resolved policy (§1.1b), ledger windows via `readWindow`, spend, `effectiveReservePct`, `fiveHourRoom`, `weeklyRoom`, `accountRoom`; then the fleet `handoff`, `runtimes`, `crossRuntimeFallback`, each runtime's main, and every warning.
- `list` drops the `fleet.json` policy of an account that is no longer registered, and prints a note per key (`dropped` in JSON). With `--dry-run` it only says what it would drop. When `config.json` cannot be read in full it drops nothing.
- `add` registers an identity in `config.json`: expands `~`, requires an absolute path that exists, refuses a path already registered (exit 5), mints the id, and writes the row with all four keys (`label`, `color` as `null` when not given). It writes no policy, so a new account starts kept-out.
- `add` reads `config.json` fresh, changes only `runtimes.claudeCode.accounts`, keeps every other key, then temp-file + `rename`; the file keeps its mode (new file: `0600`).
- When `config.json` has `__internal__` (DorkOS manages it), `add` prints "DorkOS manages this file; you can also add accounts in its settings" and still writes (DorkOS re-reads before writing, §1.1a).
- `set <id>` edits that account's entry in `fleet.json`. `<id>` is `<runtime>:<account-id>` (`codex:default`), or a bare id meaning Claude Code. Flags: `--role main|rotation|kept-out`, `--reserve <0-100>`, `--spend-down-hours <n>`, `--repos owner/name,…` (or `none` for `[]`). Each accepts `default` to delete the field.
- `set` with no id takes exactly one fleet-wide setting: `--handoff auto|ask`, `--runtimes <runtime,…>` (each slug once, in order) or `--cross-runtime-fallback off|on`; each accepts `default`.
- `set` refuses an account that does not exist (exit 5; an unknown runtime prefix is exit 2), and a second `main` in the same runtime (exit 5, naming the current one).
- Every write stores keys as `<runtime>:<id>`, so the first `set` migrates a file with bare keys.
- Needs no tracker and no flow project config.

**`flow usage prune [--dry-run]`** (rev 6)

- Deletes `<dorkHome>/runtimes/<runtime>/usage/<id>.json` for every id that is not a registered account of that runtime (`pruneTargets`, §1.2 "Removing an account"), each under the file's lock. `default.json` only once its runtime has registered accounts; never a lock, temp, backup or stamp file.
- `--dry-run` lists what it would delete. Exit 3, deleting nothing, when `config.json` cannot be read in full.
- Lives beside the other `flow usage` sub-verbs (spec `flow-usage`); needs no tracker.

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
