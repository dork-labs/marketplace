---
slug: flow-fleet
issue: null
created: 2026-09-26
status: ideation
builds-on: flow-cli-overhaul
---

# Flow knows your accounts, spends each one fully, and moves work before an account runs dry

**Slug:** flow-fleet
**Date:** 2026-09-26
**Builds on:** [`specs/flow-cli-overhaul/01-ideation.md`](../flow-cli-overhaul/01-ideation.md). This is the same programme: the `flow` CLI is the foundation both plans stand on.

---

## 1) The problem

The operator runs several Claude Code subscription accounts. Each one runs out within a couple of days, and usage resets weekly. When an account runs dry mid-task, the work stops, and moving it to another account is manual. Across several accounts, that is hard to manage.

Today two partial tools exist, and they don't talk to each other:

- **cmux-control** (a separate repo) keeps an account list and reads usage by scraping the status line off the terminal screen. Reset times are typed in by hand. It detects limits and can migrate a transcript by hand. It is cmux-only and has no tests. It also has these bugs:
  - One account's usage is never read.
  - It misses the 5-hour limit.
  - The account list is copied into 5 scripts that disagree.
- **DorkOS** already runs sessions on different accounts at the same time, and it gets live usage and reset times from the SDK on every turn. But it keeps usage per session only, has no per-account view, cannot start a session on a chosen account from an agent or a schedule, and cannot move work between accounts.

## 2) What the research found (facts the design rests on)

| Fact                                                                                                                                                                                                                                        | Source                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Accounts are separate `CLAUDE_CONFIG_DIR`s (for example `~/.claude`, `~/.claude2`, …). Credentials live in the macOS Keychain, one entry per dir.                                                                                           | the machine, `~/.zshrc` aliases              |
| The **statusLine JSON** carries `rate_limits.five_hour` and `seven_day`, each as `{used_percentage, resets_at}`. It is documented and stable. It is only present in an interactive session, after the first response.                       | Claude Code 2.1.282                          |
| The **SDK** pushes `rate_limit_event` with `status` (allowed, allowed_warning or rejected), `rateLimitType` (five_hour, seven_day, seven_day_opus, seven_day_sonnet, overage), `utilization` and `resetsAt`. It is typed and fairly stable. | `@anthropic-ai/claude-agent-sdk` 0.3.280     |
| The SDK also has `query.usage_EXPERIMENTAL…()`, which returns every window, per-model buckets and reset times **without a model turn**. It is explicitly unstable.                                                                          | same                                         |
| **Transcripts** record every limit hit as a structured error (`"error":"rate_limit"`), and the text includes the reset. There are 245 weekly and 50 session-limit hits on disk.                                                             | `<dir>/projects/**/*.jsonl`                  |
| Live CLI sessions are listed in `<dir>/sessions/<pid>.json`, with `sessionId`, `cwd`, `status` (busy or idle) and `startedAt`.                                                                                                              | Claude Code                                  |
| **Subagents run on their parent's account.** Spreading work across accounts needs separate top-level sessions.                                                                                                                              | how Claude Code works                        |
| Moving a transcript to another account is unreliable: thinking-block signatures may be rejected, side files are left behind, the prompt cache goes cold, and DorkOS derives a session's account from the dir it's found in.                 | research, DorkOS spec `claude-code-accounts` |

## 3) Compliance: read this first (operator decision)

`dorkos/research/anthropic-tos-compliance.md` (re-verified 2026-06-25) sets these hard lines:

- **Never extract** a subscription OAuth token from the Keychain and use it outside the official binary. That rules out polling the undocumented `/api/oauth/usage` endpoint with a stolen token, even though it would be the easiest way to read an idle account.
- **Never advertise** "Max rate limits" or "use your subscriptions to the max" as a feature. flow is a public plugin.
- Pro/Max limits "assume ordinary, individual usage".

The design below stays inside the lines by construction:

- Usage is read only from data the **official binary hands us**: the status line, SDK events, the SDK usage call made inside the official process, and transcripts.
- Every session is a real, official Claude Code session.
- It serves one operator's own accounts, never other people's.
- The public wording is "account-aware scheduling": route work to accounts with room, and hand work off when one hits its limit.

**Not settled by the research:** whether one person rotating work across several personal subscriptions fits "ordinary, individual usage". That is the operator's risk call, not an engineering one. The design works the same with 1 account or 5.

**Also:** One of the operator's accounts is org-managed by a client. Its scope policy must keep DorkOS work off it. It is excluded from the rotation by default.

## 4) The design

Six parts. Each one is host-agnostic: it works the same in the bare CLI, in DorkOS and in cmux.

### 4.1 One account registry

- **Home:** the DorkOS config's `runtimes.claudeCode.accounts[]` (it already has `{id, path, label}`). It is a plain file that the CLI, cmux-control and DorkOS can all read, so there is one list and no more copies.
- **New fields:**
  - `role` (general, reserve or org)
  - `rotation` (in or out)
  - `scope.repos` (an allowlist, so an org account only gets its client's repos)
  - `reserve` (the percentage kept back for the operator's own interactive use)
- **Without DorkOS installed:** the same schema lives at `~/.dork/config.json`. `flow accounts add` writes it.

### 4.2 A usage ledger per account

- **Store:** one small file per account, `~/.dork/usage/<account-id>.json`. Each file holds the latest reading per window (`5h`, `7d`, `7d-opus`, `7d-sonnet`, and model buckets), with `usedPct`, `resetsAt`, `observedAt` and `source`.
- **Fed by every source we're allowed to read:**
  - **CLI:** a 2-line addition to the status line script: `flow usage record` pipes the status line JSON in. This is the one that finally keeps `resets_at`.
  - **DorkOS:** `rate_limit_event` and the per-turn usage call write to the same ledger, via a new server-side per-account store.
  - **Backfill and limit detection:** `flow usage scan` reads the structured `rate_limit` errors from transcripts.
- **Idle accounts:** we can't poll them, and we don't need to. Once we have seen a window's `resetsAt`, we know it is empty after that time. The last reading plus its reset time is enough to plan. For an account never seen, `flow usage probe <account>` starts a tiny official session (DorkOS: the SDK usage call, with no model turn).

### 4.3 A session registry

- Built from Claude Code's own `<dir>/sessions/*.json` (CLI) plus DorkOS's session list and status stream.
- It is joined with flow's `FlowRun` records, so every session is known by its account, host (CLI, DorkOS or cmux), state (busy, idle, parked or limited) and **which tracker item it serves**.
- `flow fleet` shows it all on one screen: accounts with their 5h and 7d bars and reset times, and sessions with their item and state.

### 4.4 Account-aware dispatch (the "use it before you lose it" rule)

When flow picks the next item (`flow next`), it also picks the account. The ranking:

1. **Eligible:**
   - The item's repo is in the account's scope, and the account is in the rotation.
   - The account is under its reserve on the 7-day window and has room on the 5-hour window.
   - The item's model has room (per-model weekly limits).
2. **Prefer the headroom that expires soonest:** score = remaining % ÷ hours until the weekly reset. An account resetting tomorrow with 40% left beats one resetting in 6 days with 60% left. This is what spends ~100% of each account without starving any of them.
3. **Keep work warm:** a follow-up step on an item stays on the account that has its prompt cache, unless that account is near a limit.
4. **Match the model to the work** (flow's existing `models.tiers`): mechanical work runs on a smaller model and saves Opus-class limits for judgment. This stretches every account further than routing alone.

### 4.5 Launchers: where a session actually starts

This is one interface with three implementations. It is how work reaches a different account.

| Launcher  | How it starts a session on account X                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| DorkOS    | `POST /api/sessions/<new>/messages` with `{account, cwd, runtime, seedContext}` today, and a new MCP tool later (§6) |
| cmux      | `workspace create --command 'CLAUDE_CONFIG_DIR=… claude'`, then send a pointer to the brief (as cmux-control does)   |
| Plain CLI | `CLAUDE_CONFIG_DIR=… claude -p` headless in the item's worktree, or tmux if it's installed                           |

`flow drain --parallel N` (from the CLI-overhaul plan) uses the launcher to put each worker on its own account. Subagents are only used for work that should share the parent's account, such as reviewers.

### 4.6 Handoff that doesn't depend on moving transcripts

- **Resumable by design:** flow work is already resumable from artifacts: the worktree, the branch, the spec, `flow-state.json` and the assumption log. The last missing piece is a **checkpoint**: a short, structured `HANDOFF.md` in the worktree covering what is done, what is next, open questions and the exact next command.
- **When a checkpoint is written:**
  - at every stage boundary
  - after each task in EXECUTE
  - **immediately when the account reports `allowed_warning`** (for example 90%)
- **After the warning:** the worker finishes its current step, checkpoints, and takes no new big step on that account.
- **On `rejected` (a hard limit):** the run is marked `limited` with `resetsAt`. Dispatch reassigns it: a new session on another eligible account, in the same worktree, with the prompt "resume from `HANDOFF.md`".
- **Transcript migration** (cmux-control's method) stays as an opt-in fallback for non-flow sessions, with its risks written down. It is never automatic.

### 4.7 Who runs the loop

- **DorkOS:** the `flow-drain` scheduled skill, plus a server-side "flow dispatcher" that reacts to `rate_limit_event` right away instead of waiting for the next tick.
- **CLI / cmux:** a supervisor session running `flow dispatch --watch`. This is cmux-control's role, rebuilt on the same engine.
- **Same engine and ledger either way.** Only the launcher differs.

## 5) Fills in gaps in the original ask

- **"100% of each account" should mean "no usage expires unused, and no work waits".** Keep a reserve on at least one account for the operator's own interactive use, so a long drain never leaves the operator locked out.
- **The 5-hour window matters as much as the weekly one.** A worker that burns an account's 5-hour window stalls, even with weekly room. Dispatch rotates on both.
- **Per-model limits:** weekly Opus, Sonnet and other model buckets can run out before the total does. Routing has to see them.
- **Efficiency is the cheapest capacity.**
  - Smaller models for mechanical work, and long-lived workers that keep a warm cache (a handoff re-bills the whole context).
  - Load caps. The 2026-09-25 drain hit a machine load of about 500, and time-outs waste usage on reruns.
- **Proactive beats reactive.** Checkpointing at the warning is what makes handoff cheap. Waiting for the hard stop loses the in-flight step.
- **The org account is a boundary, not capacity.** Scope rules prevent client/work accounts from being spent on personal projects.

## 6) What DorkOS needs to add

1. **A per-account usage store:** fed by every session's `rate_limit_event` and usage call, persisted, and exposed as `GET /api/runtimes/claude-code/accounts/usage`, an MCP resource/tool, and an `/api/events` event. It also writes the shared `~/.dork/usage/` ledger.
2. **Account probe:** the SDK usage call with no model turn, for an account with no running session.
3. **Limit as a lifecycle reason:** surface `rejected` as `limited` (with `resetsAt`) on the session. Today the `rate_limit` error is suppressed. Also notify the operator.
4. **An MCP tool to start a session** with `{account, runtime, model, cwd, prompt/seedContext}`. Today only HTTP can do it.
5. **`account` on schedules and relay dispatch** (the schedule schema has no `account` field).
6. **Session list carries status and account usage**, so callers don't have to follow the SSE stream.
7. **A tracker link on sessions:** move FlowRun into server SQLite (flow SPEC v2) or add session tags.
8. **An Accounts / Fleet view:** each account's 5h and 7d bars, reset countdowns, running sessions, and a "continue on another account" action (checkpoint, then a new session with `seedContext`).
9. **Account policy fields** in the registry UI: role, rotation, scope, reserve.

## 7) Build order

This merges with `flow-cli-overhaul`.

| #   | Step                                                                                                 | Where                       |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | `flow` CLI core: snapshot, next, claim/release/done, audit, status                                   | flow                        |
| 2   | Account registry fields plus `flow accounts`                                                         | DorkOS config schema + flow |
| 3   | Usage ledger: `flow usage record/scan/probe`, the status line hook, and the DorkOS per-account store | flow + DorkOS               |
| 4   | `flow fleet` view (CLI), then the DorkOS Accounts view                                               | flow + DorkOS               |
| 5   | Checkpoints (`HANDOFF.md`) at stage boundaries and on the warning                                    | flow                        |
| 6   | Launchers (DorkOS, cmux, CLI) and the DorkOS start-session MCP tool                                  | flow + DorkOS               |
| 7   | Account-aware dispatch, plus `flow drain --parallel` with the built-in review loop                   | flow                        |
| 8   | Auto-handoff on `rejected`, and the DorkOS dispatcher reacting to events                             | flow + DorkOS               |
| 9   | Retire cmux-control's duplicate logic: it calls `flow` instead                                       | cmux-control                |
| 10  | The prose trim from `flow-cli-overhaul` §5                                                           | flow                        |

- **Tracker split:** DorkOS work is DOR issues in the DorkOS repo, landed contract-first. Anything touching DorkOS Cloud is separate, but none of this does.
- **Rough size:** 3–4 weeks of agent work. Steps 1–5 are useful on their own, before any automatic routing exists.

## 8) Decisions for the operator

1. **Compliance:** is rotating work across your own subscriptions an acceptable risk? The design is identical either way; the answer changes only whether the rotation is on by default.
2. **Registry home:** use the DorkOS config (recommended, one list for all tools) or a flow-owned file?
3. **Auto-handoff:** fully automatic on a limit (recommended for flow items only), or ask first?
4. **Reserve:** how much of the weekly window to keep back for your own interactive use? Suggestion: 10–15% on your main account, 0% on the rest.
5. **The org-managed client account:** confirm it stays out of rotation, and name the repos it may be used for.
