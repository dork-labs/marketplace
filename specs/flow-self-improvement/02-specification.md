---
slug: flow-self-improvement
issue: DOR-2390
created: 2026-09-26
status: specified
---

# flow tests itself, keeps notes while it runs, and reviews them

**Status:** Approved
**Issues:** DOR-2390 (self-test), DOR-2391 (journal), DOR-2392 (retro); umbrella DOR-2366
**Date:** 2026-09-26
**Input:** [`01-ideation.md`](./01-ideation.md)
**Builds on:** S1 `flow-cli-core` (DOR-2367): the `flow` CLI at `scripts/flow.ts` and the typed
tracker client behind it.

## Overview

| Verb                                  | What it does                                                             | Writes                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `flow selftest [--tier …] [--file]`   | Runs flow's own checks in three tiers and reports                        | `.dork/flow/selftest/latest.json`; items with `--file`   |
| `flow note --kind <k> "<text>"`       | An agent records friction it hit                                         | one journal line                                         |
| `flow journal record <kind> …`        | Records an event the CLI cannot see (review verdict, CI red, handoff)    | one journal line                                         |
| `flow journal tail [-n N] [--kind k]` | Prints recent journal lines                                              | nothing                                                  |
| `flow retro [--since 7d] [--file]`    | Measures flow's health, proposes improvements, and files them when asked | `.dork/flow/retro/<date>.{json,md}`; items with `--file` |

`/flow:self-test` is a thin command over `flow selftest`. `skills/flow-retro/SKILL.md` is a weekly
schedule, shipped off.

## Background / Problem Statement

- flow's oracles are tested (31 Vitest files), but nothing tests a run across stages, and the
  prose half, where every mistake of the 2026-09-25/26 session happened
  ([`../flow-cli-overhaul/01-ideation.md`](../flow-cli-overhaul/01-ideation.md) §1), has no check
  at all.
- Engine tests need the contributor toolchain; a shipped install has only `zod`, so an adopter
  cannot check their install.
- flow records nothing about how its runs go. The session's retro was reconstructed by hand from
  memory and transcripts.
- The flow-cli-overhaul step 6 measures have no code behind them.

## Goals

- One command tells a person or an agent whether this flow install and its prose are healthy, for
  free, in seconds, with no network.
- Cross-stage behaviour is tested deterministically, in CI, with no tracker account.
- A live model can be pointed at a stage skill and scored on outcomes, only when someone decides
  to spend.
- Every run leaves a small, local, secret-free record; agents can add what code cannot see.
- A periodic review turns that record into deduped tracker items for the plugin.

## Non-Goals

- DorkOS UI (see "How DorkOS surfaces it").
- Sending anything outside the project's own tracker. Upstreaming a finding to the plugin's public
  repo stays a human act.
- Grading an agent's prose. Live oracles read the tracker and the filesystem only.
- The drain review loop and `flow watch` (S3, DOR-2373). This spec defines the events they will
  write, and a manual entry point until then.

## Technical Dependencies

- S1 (DOR-2367): `scripts/flow.ts` verb registry, the typed tracker client (`TrackerClient`, the
  `PMClient` of `adapters/SPEC.md` §1, plus S1's create and snapshot verbs), and tracker selection
  from config. If S1's names differ, use S1's; the contracts below are by role.
- No new runtime dependency. Vitest stays dev-only. The live tier uses the `claude` CLI found on
  `PATH`.

## Detailed Design

### 1. Self-test (`scripts/selftest/`, DOR-2390)

`flow selftest` runs `fast` then `scenarios` by default. `--tier fast|scenarios|live|all` narrows or
widens (`all` = fast + scenarios + live). Every check returns
`{ id, tier, status: pass|fail|skip, ms, detail, fingerprint }`.

**Exit codes:** 0 no failures; 1 at least one `fail`; 2 the harness itself broke. A `skip` never
counts as a pass: the text report lists each skip with its reason, and `--strict` turns skips into
exit 1.

#### Tier `fast` (free, no network; under 10 s without `engine-tests`)

| Check id              | What it asserts                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine-tests`        | `vitest run` passes. Runs only when `node_modules/vitest` exists in the flow root; otherwise `skip` ("contributor toolchain not installed"). Always `skip` when `VITEST` is set ("already inside Vitest"), so a test that runs the fast tier never starts Vitest again.                     |
| `adapter-conformance` | `validate-adapter.ts` passes on `adapters/reference/fixtures/work-items.good.json` and fails with exactly `["INV-3"]` on `work-items.bad.json`, as `engine-tests/validate-adapter.test.ts` pins (a harness that passes the bad fixture is broken). Same for the fake tracker's own fixture. |
| `config`              | `validate-config.ts` passes on `config/config.example.json` and on the project's resolved config (from `config-files.ts`).                                                                                                                                                                  |
| `schema-fresh`        | `config/config.schema.json` equals the schema built from `config-schema.ts` (same builder CI uses, in memory, no `tsx`).                                                                                                                                                                    |
| `doc-lint/*`          | The rules below, over `commands/**/*.md`, `skills/**/SKILL.md`, `docs/**/*.{md,mdx}`, `README.md`.                                                                                                                                                                                          |

Doc-lint rules (`scripts/selftest/doc-lint.ts`, pure over `{ path, text }[]`):

- **`doc-lint/words`**: word count per file against `selftest/word-budgets.json`
  (`{ "<path>": { "baseline": n, "target": n } }`). **Ratchet:** fail when a file grows above its
  baseline; report its distance to target. `flow selftest --rebaseline` lowers baselines to today's
  counts (never raises one). A file missing from the budget file fails with "add a budget". Targets
  seed from flow-cli-overhaul step 5; baselines from today's counts.
- **`doc-lint/duplicate-rule`**: a normalized sentence (lowercased, markdown and punctuation
  stripped, at least 8 words) found in two or more files fails, naming both. Allowed repeats live in
  `selftest/duplicate-allow.json`, each with a reason (the adapter-location paragraph is repeated
  today; S7 removes the copies and the allow entries).
- **`doc-lint/links`**: every relative markdown link resolves to a file; an `#anchor` resolves to a
  heading slug in the target.
- **`doc-lint/frontmatter`**: every `SKILL.md` has `name` equal to its folder and a non-empty
  `description`; every command has a `description`. A `schedule:` block has a 5-field `cron`, a
  timezone Node's `Intl` accepts, `enabled: false` (the opt-in convention), `max-runtime`, and
  `permissions`.
- **`doc-lint/war-stories`**: inside a numbered or bulleted step of a skill or command, a line
  with a date (`20\d\d-\d\d-\d\d`) or an id (`[A-Z]{2,}-\d+`) fails, except ids whose prefix
  is in the rule-id list in `selftest/war-story-allow.json` (`INV`, `GRM`, `UTF`, `ADR`, and any
  added with a reason). The answer is the same on every install. `docs/why.md` (created by S7; absent today) and `CHANGELOG.md` are
  exempt. Today's hits are listed in `selftest/war-story-allow.json` so the check
  starts green and only new ones fail; S7 empties the list.

#### Tier `scenarios` (free, deterministic, no network)

**The fake tracker** (`scripts/tracker/fake.ts`): an implementation of S1's `TrackerClient` over an
in-memory store, optionally persisted to a JSON file (for the live tier's child process). It
behaves like the reference tracker where flow depends on it:

- the five state categories, with team-style display names (`Triage`, `Todo`, `In Progress`, `Done`,
  `Canceled`) so a test that matches a display name fails;
- exclusive label groups (`agent/*`, `type/*`, `stage/*`): adding one removes its siblings;
- a closing reference in a merged PR body (`Closes <id>`) moves the item to `completed`
  (`fake.mergePr({ body })`), matching the behaviour the session found undocumented;
- comments with authors and timestamps; `getInbox` returns comments after a watermark;
- a clock injected by the test, never `Date.now()`.

It ships its fixture `adapters/reference/fake/fixture.json`, passes `validate-adapter.ts`, and
passes S1's adapter conformance suite. `adapters/reference/fake/SKILL.md` is a short adapter skill
("every verb: `flow tracker <verb>`"); the live sandbox copies it to
`.agents/flow/adapters/fake/SKILL.md`, the project path `resolveAdapter` (`config-files.ts`) reads
first, so a prose-driven agent reaches it.

**Scenarios** (`scripts/selftest/scenarios/*.ts`), each a function
`(ctx: { tracker, clock, flow }) => Promise<void>` that drives `flow` verbs in-process against the
fake and asserts on the fake's state:

| Scenario          | Steps and assertions                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lifecycle`       | capture → item in `backlog`, `origin/*`, no `agent/ready`. Triage-accept → one `type/*`, a priority, `agent/ready`. `flow next` returns it. `flow claim` → `agent/claimed` and no `agent/ready`, `started`. Merge with `Closes` → `completed`. `flow done` → `agent/completed`, one signed comment carrying a provenance line. |
| `groom-audit`     | Load `engine-tests/fixtures/backlog.bad.json` into the fake; `flow audit` reports exactly the GRM ids `audit-backlog.test.ts` expects from that fixture. `backlog.good.json` reports none.                                                                                                                                     |
| `recovery-ladder` | A claimed, started item with a dead worker pid and an intact worktree → resume; missing worktree → restart; `agent/needs-input` → never reclaimed; retries past `recovery.maxRetries` → the configured `onExhausted`.                                                                                                          |
| `inbox-rules`     | One comment per comment-response rule (self-authored, addressed, ambiguous, and so on) → the expected respond/act/ignore; a reply to a parked question resumes it; an empty reply does not.                                                                                                                                    |
| `state-agreement` | An item `completed` in the tracker but still `agent/claimed` → `flow audit` flags the disagreement (flow-cli-overhaul step 4). Ships with DOR-2376, not before: until then it is not in the list, so no scenario is skipped for lack of a check.                                                                               |

The same scenarios run in CI: `engine-tests/selftest-scenarios.test.ts` imports and runs each one,
so the `flow plugin` job covers them with no new workflow.

#### Tier `live` (opt-in, spends, never in CI)

Modelled on `dorkos/packages/evals`: prompt a real session, then score what happened, never its
words.

- **Gate (checked before anything starts):** `FLOW_SELFTEST_LIVE=1` is required. A credential alone
  arms nothing. Refuse when `CI` is set, whatever else is set. Refusals name the missing piece and
  exit 2.
- **Credential:** `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then the local `claude`
  sign-in. The report records which one paid. No credential → every case `fail` with
  "no credential", never a skip or a pass.
- **Sandbox per case:** a temp git repo with the fixture files, a committed
  `.agents/flow/config.json` selecting the `fake` tracker at a temp store path, and the flow root
  given with `--plugin-dir`. The child runs
  `claude -p "<case prompt>" --plugin-dir <flow-root> --output-format stream-json --verbose
--max-turns <n> --max-budget-usd <remaining>` with cwd = sandbox and these fences:
  1. `--strict-mcp-config` with an empty MCP config: no tracker MCP server.
  2. `--permission-mode dontAsk` with an allowlist (`Read`, `Write`, `Edit`, `Glob`, `Grep`,
     `Bash(node *)`, `Bash(git *)`, and the `flow` CLI): anything else, `composio`, `curl`, `gh`
     and web tools included, is denied without a prompt.
  3. An env stripped of every `*_API_KEY`, `COMPOSIO_*` and `LINEAR_*` other than the one
     credential.
  4. **Breach check** after the case: the runner scans the stream's `tool_use` events. A command
     naming `composio`, `linear`, `curl`, `wget` or `gh`, or a file path whose `realpath` is outside
     the `realpath` of the sandbox and of the flow root (macOS temp dirs live under `/private`), fails the case as `breach`, whatever the oracle says.
     A child `node` process could still reach the network; the fences make that a deliberate act a
     stage skill never takes, and the breach check catches the ordinary routes.
- **Budget:** `--max-usd` (default `selfImprovement.selftest.liveBudgetUsd`, 1.00). The runner sums
  each case's reported `total_cost_usd`, passes what is left as `--max-budget-usd`, and starts no
  case once the total reaches the ceiling;
  those cases are `skip` ("budget reached").
- **Cases and outcome oracles** (`scripts/selftest/live/cases.ts`):

| Case        | Prompt                                              | Oracle (reads the fake store and the sandbox only)                                                                           |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `capture`   | `/flow:capture <brief>`                             | exactly one new item; `origin/*` set; no `agent/ready`; title non-empty                                                      |
| `triage`    | `/flow:triage <id>` on a clear, small idea          | one `type/*`, a priority, and `agent/ready` whose item passes the readiness oracle; or `agent/needs-input` with one question |
| `decompose` | `/flow:decompose specs/fixture/02-specification.md` | `03-tasks.json` passes `tasks-schema.ts`, no forbidden summary phrase, the item carries `stage/decompose`                    |
| `done`      | `/flow:done <id>` with a follow-up in the fixture   | item `completed` with `agent/completed`; each follow-up has a type, a priority and a project and went through triage         |

A live run prints per-case pass/fail, cost and turns, and writes the same report shape.

#### Report and `--file`

- Text to stdout by default; `--json` prints `SelftestReport`
  (`{ v: 1, startedAt, flowVersion, tiers, checks: Check[], totals, credentialSource? }`).
- Every run writes `.dork/flow/selftest/latest.json` and appends it to
  `.dork/flow/selftest/history.jsonl` (tiers run, and each check's id and status, capped at 200
  lines), and
  writes one `selftest` journal event.
- `--file` files one tracker item per failing check (S1's create verb): type `task`, labels
  `origin/from-agent` and `selfImprovement.retro.labels`, never `agent/ready`, project
  `selfImprovement.retro.project` when set. The body names the check, its detail, the flow
  version, and a marker line `<!-- flow-selftest:fp=<fingerprint> -->`. Before creating, it reads
  the snapshot (S1) of open items plus items closed in the last 90 days. A fingerprint on an open
  item gets one comment with the new detail. A fingerprint on an item canceled in that window is
  not filed again (a person declined it) and the report lists it as "declined"; after 90 days it
  may be filed again, on purpose, since the evidence has outlived the decision. A fingerprint on a
  completed item is filed again only on evidence dated after the item was completed, with
  "regressed after <id>" in the body. `fingerprint = sha1(checkId + ":" + stableDetailKey)[:12]`
  where `stableDetailKey` omits counts and timestamps (for `doc-lint/words`, the file path).
- `/flow:self-test` (`commands/self-test.md`, under 150 words): run `flow selftest` with the given
  arguments, show the report, and offer `--file` for failures. It never passes `--tier live`
  unless the person asked for it in this turn.

### 2. The journal (`scripts/journal.ts`, DOR-2391)

**Location:** `<project>/.dork/flow/journal.jsonl`, where `<project>` is the main checkout (the
existing `projectKey` in `config-files.ts`), so every worktree of a project writes one file.
`config-files.ts resolve` gains `journal: { path, enabled }`.

**Line shape** (zod, `.strict()`, closed union on `kind`):

```jsonc
{ "v": 1, "ts": "<ISO-8601 UTC>", "kind": "<kind>", "flow": "<plugin version>",
  "session": "<first 8 chars of the harness session id, if known>",
  "item": "<tracker identifier, if any>", ...kind fields }
```

| `kind`          | Fields                                                                                    | Written by                                        |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `verb`          | `verb`, `ms`, `exit`                                                                      | the `flow` CLI wrapper, every verb run            |
| `oracle.error`  | `oracle`, `exit`, `errorClass` (first line of the error, redacted, ≤ 200 chars)           | the CLI when an oracle exits 2 or throws          |
| `stage`         | `stage`, `phase: start\|end`, `outcome?: ok\|failed\|parked`                              | `flow transition` (S1) and `flow done`            |
| `item.readied`  | `by: triage\|decompose\|human`                                                            | the verb that applies `agent/ready`               |
| `claim`         | `phase: claim\|release`                                                                   | `flow claim`, `flow release`                      |
| `retry`         | `rung: resume\|restart\|escalate`, `attempt`                                              | the recovery verb                                 |
| `operator.wait` | `phase: start\|end`, `waitedMs?` (on end)                                                 | `needsInput`; the inbox verb that sees the answer |
| `review`        | `round`, `sha7`, `verdict: clean\|changes`, `blocker`, `shouldFix`, `nit`, `categories[]` | `flow journal record review …` (S3 later)         |
| `ci`            | `pr`, `event: red\|ejected\|merged`, `class: own\|innocent\|flake\|infra\|unknown`        | `flow journal record ci …` (S3 later)             |
| `handoff`       | `from`, `to`, `reason: limit\|stage\|manual`                                              | `flow journal record handoff …` (S3 later)        |
| `note`          | `noteKind: friction\|workaround\|confusion`, `text`, `skill?`                             | `flow note`                                       |
| `selftest`      | `tiers`, `pass`, `fail`, `skip`, `ms`, `failing[]` (check ids)                            | `flow selftest`                                   |
| `retro`         | `window`, `proposals`, `filed`, `commented`                                               | `flow retro`                                      |

`categories[]` is a closed set: `logic`, `race`, `test`, `migration`, `security`, `docs`, `scope`,
`style`, `other`.

**Never secrets.** Only the fields above are stored; comment bodies, prompts, diffs and tracker
descriptions never are. Free text (`note.text`, `oracle.errorClass`) passes `redact()` first:
token shapes (`sk-…`, `ghp_…`, `github_pat_…`, `lin_api_…`, `xox[bap]-…`, `AKIA…`, `Bearer …`,
any run of 32+ base64 or hex characters) become `[redacted]`, email addresses become `[email]`,
and home-directory prefixes become `~`. `note.text` is capped at 1,000 characters.

**Writing.** One `appendFileSync(path, line + "\n", { flag: "a" })` per event. With the caps
above every line stays under 4 KiB, and the file is opened `O_APPEND`, so concurrent writers on a
local filesystem never interleave inside a line. A journal failure (full disk, permissions) is
reported once on stderr and never changes the verb's exit code or output.

**Rotation.** Files are `journal.jsonl`, then `journal.1.jsonl` … `journal.<keep>.jsonl`, oldest
last. Before appending, if `journal.jsonl` is at or over `journal.maxBytes` (default 5 MB):

1. Create `journal.lock` with `wx`. If it exists, skip rotation and just append (the holder is
   rotating). A lock whose mtime is over 30 s old is stale: delete it and append without rotating;
   the next append takes the lock. (Two writers clearing one stale lock at once can, rarely,
   rotate twice and drop one old file early. That is accepted for a local diagnostics log.)
2. **Holding the lock, `stat` again.** If the file is now under the cap, another writer already
   rotated: release and append.
3. Delete `journal.<keep>.jsonl`, rename each `journal.<n>.jsonl` to `journal.<n+1>.jsonl`
   from the highest down, rename `journal.jsonl` to `journal.1.jsonl`, release.

Readers read `journal.jsonl` and `journal.1..keep.jsonl`. A line appended by a writer that raced
the rename lands in `journal.1.jsonl` and is still read.

**Gitignore.** On the first write, if `git check-ignore -q .dork/flow/journal.jsonl` says it is
not ignored, add `.dork/flow/` to the repository's `info/exclude` (local, never committed).

**Off switch.** `selfImprovement.journal.enabled: false` makes every write a no-op, `flow note`
included (it says the journal is off and exits 0).

**`flow note`**: `flow note --kind friction|workaround|confusion [--item <id>] [--skill <name>] "<text>"`.
Exit 2 on a missing kind or empty text.

**When agents write a note.** One rule, in one place (the shared rules block that
flow-cli-overhaul step 5 creates; until S7 lands, `commands/flow.md` only), under 60 words:

> Write `flow note` when: you improvised a script or brief the plugin should have shipped
> (`workaround`); a skill's steps were wrong or missing (`friction`); two instructions disagreed
> or you guessed (`confusion`). One sentence, no secrets, no pasted output.

### 3. The retro (`scripts/retro.ts`, `skills/flow-retro/`, DOR-2392)

`flow retro [--since <duration>] [--json] [--file] [--input <proposals.json>]`. Default window
`selfImprovement.retro.window` (7 days). Read-only unless `--file`.

**Inputs:** journal lines in the window and the one before it (for comparison), selftest history,
and one tracker snapshot (S1).

**Measures** (pure functions in `retro.ts`, each with the previous window beside it):

| Measure                    | Definition                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `readyVsUntriaged`         | from the snapshot: open items with `agent/ready` vs open items with no `type/*` label                                                         |
| `captureToReadyDaysMedian` | for `item.readied` events in the window: event `ts` minus the item's `createdAt`. Items readied outside flow are not seen; the report says so |
| `firstReviewCleanPct`      | `review` events with `round: 1`: share with `verdict: clean`                                                                                  |
| `reviewCatchCount`         | sum of `blocker + shouldFix` over `review` events                                                                                             |
| `innocentEjections`        | `ci` events with `event: ejected` and `class: innocent`                                                                                       |
| `pluginWords`              | total words over the doc-lint file set, and the distance to the targets                                                                       |
| `oracleErrors`             | `oracle.error` count by `oracle`                                                                                                              |
| `operatorWaitHoursMedian`  | `operator.wait` end events: median `waitedMs`                                                                                                 |

A measure with no data in the window is shown as "no data", never 0.

**Proposal rules** (deterministic; each yields `{ fingerprint, rule, title, evidence[], proposal }`):

1. **Note cluster:** 2+ `note` events in the window with the same `skill` (or the same
   normalized first five content words when `skill` is absent).
2. **Repeated oracle error:** the same `oracle` + `errorClass` 2+ times.
3. **Self-test regression:** a check that has `pass` in the most recent earlier history entry
   that ran it, and `fail` now. A check the earlier run did not run is never a regression.
4. **Measure got worse:** `firstReviewCleanPct` down 15+ points, `captureToReadyDaysMedian` up
   50%+, `innocentEjections` 3+, or `pluginWords` up at all.

`fingerprint = sha1(rule + ":" + subjectKey)[:12]`. The proposal text is a template; the schedule's
agent rewrites it (below).

**Output:** `.dork/flow/retro/<YYYY-MM-DD>.json` (the full report and `proposals[]`) and `.md`
(what a person reads: measures table, then proposals).

**Filing (`--file`):** files `proposals[]` from the report just computed, or from `--input` (an
edited copy). Same item shape and dedupe as `selftest --file`, with the marker
`<!-- flow-retro:fp=<fingerprint> -->`: an open match gets one evidence comment, a match canceled in
the last 90 days is not filed again, and a completed match is filed again only when some of its
evidence is dated after the item was completed, with "regressed after <id>". At most
`selfImprovement.retro.maxItemsPerRun` (default 5) new items per run, highest evidence count first;
the rest are listed as "not filed (cap)". Every filed item and comment is signed per the
provenance rules.

**The schedule** `skills/flow-retro/SKILL.md`: `schedule: { cron: '0 9 * * 1', timezone:
America/Los_Angeles, enabled: false, max-runtime: 20m, permissions: default }`. Steps: pause check
(the same step 0 as `flow-groom`); run `flow selftest --json`; run `flow retro --json`; for each
proposal, keep, merge or drop it, and rewrite `title` and `proposal` into one concrete change to a
named file; write the edited list to a temp file; `flow retro --file --input <file>`; report the
measures and what was filed. It never edits plugin files itself.

### 4. Config (`config-schema.ts`)

A new committed section, additive with defaults (no migration); regenerate `config.schema.json`
and document it in `config/CONFIG.md`:

```jsonc
"selfImprovement": {
  "journal": { "enabled": true, "maxBytes": 5000000, "keep": 3 },
  "retro":   { "window": "7d", "maxItemsPerRun": 5, "project": null, "labels": [] },
  "selftest": { "liveBudgetUsd": 1.0 }
}
```

### 5. How DorkOS surfaces it later

One line on the Flow Board (S6, DOR-2389): "flow health: self-test <pass>/<total> · last retro
<date>, <n> filed", read from `selftest/latest.json` and the newest retro report. No UI work here.

## User Experience

- A person types `/flow:self-test` and sees, in a few seconds, a pass/fail/skip list with the one
  thing to do for each failure.
- An agent that improvised a helper writes one `flow note` line and carries on.
- Monday morning, if the person turned the schedule on, the tracker has up to five new items about
  flow itself, each with evidence, none ready until a person or triage says so.

## Testing Strategy

Every test carries a purpose comment and a plant-a-break case that fails for the stated reason.

- **`engine-tests/doc-lint.test.ts`:** per rule, a clean corpus passes and a planted break fails
  (a grown file, a copied sentence, a dead link and a dead anchor, a bad cron, `enabled: true`, a
  dated line inside a step, `INV-3` in a step passing, and the same dated line in `docs/why.md`
  passing). Plus: the shipped plugin
  passes `fast` (the allow files make today green).
- **`engine-tests/fake-tracker.test.ts`:** exclusive groups, `Closes` handling, inbox watermark,
  injected clock; passes `validate-adapter.ts` and S1's conformance suite.
- **`engine-tests/selftest-scenarios.test.ts`:** runs every scenario; one planted break per
  scenario (for example the fake leaving `agent/ready` on claim) makes it fail.
- **`engine-tests/selftest-cli.test.ts`:** exit codes 0/1/2; skip is not pass; `--strict`; the
  live gate refuses without the flag, refuses with `CI` set even with the flag, and fails every
  case with no credential; `--file` twice files once, a canceled match is not refiled, a completed
  match is refiled as a regression (fake tracker); the `engine-tests` check skips under `VITEST`.
- **`engine-tests/journal.test.ts`:** schema rejects unknown kinds and fields; redaction per token
  shape; 1,000-char cap; two child processes appending 500 lines each yield 1,000 parseable lines;
  rotation at the cap keeps `keep` files and loses nothing written during it; two writers over the
  cap rotate once, not twice; a stale lock is cleared by one writer; a read-only
  directory does not change the verb's exit code; `enabled: false` writes nothing; `info/exclude`
  gains the line once.
- **`engine-tests/retro.test.ts`:** fixture journals with known answers for each measure, "no
  data" for empty windows, each proposal rule firing and not firing at its threshold, stable
  fingerprints across runs, the cap, dedupe against open, canceled and completed items (fake
  tracker), and rule 3 ignoring a check the earlier run did not run.
- **Live tier:** not in CI. Its runner logic (gate, budget stop, env scrub, report) is unit-tested
  with a stubbed `claude` binary on `PATH`, including a stub stream with a `composio` Bash call
  that must fail the case as `breach`.

## Performance Considerations

- `fast` (without `engine-tests`, which is the ~25 s Vitest suite) + `scenarios` under 10 s on a
  laptop; scenarios use the in-memory fake.
- One append per journal event; no read on the write path except a `stat` for rotation.
- The retro reads at most `keep + 1` journal files (≤ 20 MB by default).

## Security Considerations

- The journal holds no bodies and redacts free text; it is local, gitignored, and never uploaded.
- The live tier cannot reach a real tracker: tracker config points at the fake, MCP is empty, and
  tracker credentials are stripped from the child's env.
- `--file` only creates `origin/from-agent` items that are not ready; nothing it writes can be
  dispatched without triage.

## Documentation

- `docs/self-improvement.mdx` (new, under 600 words): the three tiers, what the journal holds and
  does not, how to turn on the retro schedule.
- `config/CONFIG.md`: the `selfImprovement` section.
- `CHANGELOG.md`: one entry per shipping PR, in the house style.

## Implementation Phases

1. **Fast tier and journal core:** doc lint, the fast tier, `journal.ts`, `flow note`.
2. **Fake tracker and scenarios:** after S1's client exists.
3. **Automatic events:** hooks in S1's verbs.
4. **Retro and schedule.**
5. **Live tier.**

Tasks: [`03-tasks.json`](./03-tasks.json).

## Assumptions (decided under operator-granted autonomy)

1. **Verbs on S1's CLI.** If S1's registry or client names differ, this spec follows S1.
2. **Scenarios also run in CI** through Vitest, so CI covers tiers `fast` (minus doc lint on
   adopter files) and `scenarios` without a new workflow or required check.
3. **Engine tests skip, not fail, without dev deps,** and the skip is shown.
4. **Word budgets are a ratchet** from today's counts toward the step 5 targets; failing on
   targets now would keep `fast` red until S7.
5. **Allow files** make duplicate-rule and war-story checks green today; S7 empties them.
6. **Journal in the main checkout,** so worktrees share one file; `O_APPEND` single writes, no lock
   except for rotation.
7. **Journal on by default** (local, redacted, off switch).
8. **Live tier gate:** `FLOW_SELFTEST_LIVE=1` plus a credential, refused under `CI`; default
   ceiling $1.00; the local `claude` sign-in counts as a credential (same order as DorkOS evals).
9. **Filing goes to the project's own tracker** as not-ready `origin/from-agent` tasks, capped at
   5 per retro run; nothing goes to the plugin's public repo automatically.
10. **Dedupe by fingerprint marker** in the item body, found through a snapshot of open items and
    items closed in the last 90 days (the adapter contract has no search verb). Canceled means
    declined: not refiled for 90 days.
11. **Review, CI and handoff events** get a manual `flow journal record` entry point now; S3
    writes them automatically.
12. **No ADRs:** this repo has no `decisions/` folder.

## Open Questions

None.

## Related ADRs

None in this repo. DorkOS ADR-0294 (oracle scripts ship with the plugin) constrains where the
scripts live.

## References

- [`../flow-cli-overhaul/01-ideation.md`](../flow-cli-overhaul/01-ideation.md) §1, steps 4-6
- `plugins/flow/adapters/SPEC.md` (contract 1.3.1)
- `dorkos/packages/evals/README.md` (outcome oracles; flag beside key)
