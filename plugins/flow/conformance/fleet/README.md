# Fleet conformance fixture

This folder is the shared contract between the flow plugin and DorkOS for three
things both of them read and write on one machine:

- **Accounts.** Who the accounts of each runtime (Claude Code, Codex, OpenCode)
  are (DorkOS's `config.json`, with one implicit `default` account for a runtime
  that has none) and how flow may spend them (flow's `fleet.json`, keyed
  `<runtime>:<account-id>`).
- **The usage ledger.** One file per account at
  `<dorkHome>/runtimes/<runtime>/usage/<account-id>.json` with the latest reading
  of each rate-limit window, and the plan, credits and spend when the runtime
  reports them.
- **The session and item link.** The `FlowRun` records in `flow-state.json`.

The rules are written in `specs/flow-cli-core/02-specification.md` section 1
(rev 6) of the `dork-labs/marketplace` repo. The case files here pin those rules as data, so
two independent implementations can prove they agree. flow runs them in
`plugins/flow/engine-tests/fleet-conformance.test.ts`.

## Version

`CONTRACT_VERSION` holds the contract version (semver). Any change to a rule or a
case is a contract change: bump the version and change both sides. A new case
that only pins an existing rule more tightly is a patch; a new field or window
key rule is a minor; a changed or removed rule is a major.

2.0.0 (rev 6) is a major: every contract names the runtime. The ledger moved to
`runtimes/<runtime>/usage/` with a required `runtime`, `fleet.json` keys became
`<runtime>:<account-id>` (bare keys still read as Claude Code), and
`resolveFleetPolicy`, `readIdentities` and `mergeLedger` take the runtime.

## What is here

| File | What it pins | The call it drives |
| --- | --- | --- |
| `account-id.cases.json` | Minting an account id from a label and a path | `mint(label, path, taken) -> id` |
| `identity.cases.json` | Reading one runtime's rows (`runtimes.<claudeCode, codex or opencode>.accounts`) from `config.json` | `readIdentities(config, runtime) -> { accounts, warnings }` |
| `accounts.cases.json` | Every runtime's accounts, with the implicit `default` where a runtime has none | `readAccounts(config) -> { accounts, warnings }` |
| `fleet-policy.cases.json` | Resolving `fleet.json` with defaults (key migration, implicit defaults, runtime settings), plus which repos an account may serve | `resolveFleetPolicy(accounts, fleet)`, `parseOriginRepo(origin)`, `mayServe(policy, repo)` |
| `window-read.cases.json` | What one ledger window means at a given moment | `readWindow(entry, now, key) -> reading or null` |
| `room.cases.json` | The reserve in force and whether an account has room | `effectiveReservePct`, `fiveHourRoom`, `weeklyRoom`, `modelRoom` |
| `eligibility.cases.json` | Room for any kind of account: subscription windows, metered spend, local models | `accountRoom(runtime, policy, ledger, now)`, `spendRoom(spend)` |
| `ledger-merge.cases.json` | Folding new readings (windows, plan, credits, spend) into a ledger | `mergeLedger(existing, observations, now, { runtime, accountId })` |
| `codex-rate-limits.cases.json` | Codex's `rate_limits` payload as ledger observations | `codexObservations(rateLimits, observedAt, source)` |
| `prune.cases.json` | Which ledger files go when their account is no longer registered | `pruneTargets(registered, onDisk)` |
| `flow-run.cases.json` | Reading `flow-state.json`, and keeping unknown fields when one run is written | the all-or-nothing reader, and an upsert by `issueId` |
| `usage-ledger.schema.json` | The ledger file shape (JSON Schema draft-07) | |
| `fleet-policy.schema.json` | The `fleet.json` shape a WRITER may store (JSON Schema draft-07). Readers accept more: no `v` reads as 1, and a bare key from before 2.0.0 reads as `claude-code:<key>` (see the `fleet-policy` cases and spec 1.1b) | |
| `*.examples.json` | Values each schema must accept (`valid`) and reject (`invalid`) | |

Each case file has an `about` field that states the rule and the exact meaning of
every input and expected field. Read it before writing a runner.

## Case format

Every case is `{ "name": string, "input": object, "expected": object }`.

- `now` is always an input when time matters. Never use the wall clock.
- Times are ISO-8601 with an explicit zone. Expected times are UTC with
  milliseconds and `Z`.
- `expected.warnings` is a list of warning codes. Compare it as a multiset (sort
  both sides): the codes are the contract, their order and message text are not.
- Compare every other expected value for deep equality.

## Running the cases from DorkOS

1. Vendor this folder at a pinned commit of `dork-labs/marketplace` (the DorkOS
   spec `claude-account-fleet` picks the mechanism). Record the commit and the
   `CONTRACT_VERSION` next to the copy.
2. Write one runner per case file that feeds `input` to the DorkOS
   implementation and compares against `expected` as described above. The
   `about` field of each file and flow's own runner
   (`fleet-conformance.test.ts`) show the mapping.
3. Fail when a case file is present that has no runner, so a new file in a later
   version cannot pass by being skipped.
4. Validate each `*.examples.json` value against its schema: every `valid` value
   passes and every `invalid` value fails.

## What the fixture does not cover

The cases pin the pure rules. The file mechanics (paths, modes, the
lock-and-rename steps in spec section 1.2 "Writing") are described in the spec
and proven by each side's own tests, because they need real files and real
processes.
