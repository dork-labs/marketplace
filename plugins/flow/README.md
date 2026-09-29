# flow — the `/flow` engine

> One unified, PM-agnostic workflow system spanning **capture → done**. A single
> identifiable installable unit: manual stages you drive from the terminal, and
> an autonomous loop seated on DorkOS Pulse.

This README is **the manual**. [`SPEC.md`](./docs/SPEC.md) is the contract,
[`CHARTER.md`](./docs/CHARTER.md) the 15 goals flow is audited against,
[`provenance.md`](./docs/provenance.md) the signature every outward write carries,
and the [guide series](./docs/) the user-facing reference. All of them ship with the
package (charter G15).

> [!IMPORTANT]
> **Autonomous mode depends on a running DorkOS server (Pulse). Manual mode does
> not.** `/flow`, `/flow:<stage>`, and `/flow auto` (terminal draining) run
> without the server. The autonomous Pulse-seated loop (`${CLAUDE_PLUGIN_ROOT}/skills/flow-drain/`)
> requires the DorkOS server running to host the chokidar watcher + croner.

## Installing

Install the plugin from the marketplace, then run **`/flow:init`** — it picks your
tracker, generates and conformance-gates its adapter, and scaffolds the
config triad.

The engine oracles under `scripts/` run on `node --experimental-strip-types` and
need **one** npm package, `zod`. `/flow:init` offers to install
it; to do it yourself, from this directory:

```bash
npm install --omit=dev
```

Say `--omit=dev`: under `NODE_ENV=production` a bare `npm install` installs
nothing. Contributors want `--include=dev` for the tests and tools.

## The flow CLI

`flow` is one command for the tracker steps skills used to spell out in prose. It
reads your config, calls the tracker through the adapter, and checks each write:

```bash
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb> --json
```

| Verb              | What it does                                                                    |
| ----------------- | ------------------------------------------------------------------------------- |
| `snapshot`        | Pull the backlog once, for reuse with `--snapshot`.                             |
| `audit`           | Check the backlog against the groom invariants.                                 |
| `next`            | Show the next item to work on.                                                  |
| `claim`           | Start an item and record the run.                                               |
| `release`         | Let go of an item.                                                              |
| `done`            | Post the summary and close an item.                                             |
| `stage`           | Move an item to another stage.                                                  |
| `status`          | Show what is in flight, parked or out of step.                                  |
| `checkpoint`      | Write the item's `HANDOFF.md`.                                                  |
| `accounts`        | Set up, list or pick the accounts flow spends (`docs/use-all-your-accounts.mdx`). |
| `usage`           | Record each account's usage.                                                    |
| `fleet`           | Show every account and running session. Changes nothing.                        |
| `drain`           | Carry several items at once.                                                    |
| `review`          | Ship finished work at the review gate, or send it back with a note.             |
| `ask`, `answer`   | Park a question with the agent's own pick; post a person's answer.              |
| `autonomy`        | Show how much flow does on its own in this project.                             |
| `note`, `journal` | Write to or read flow's journal.                                                |

`flow <verb> --help` lists a verb's flags. Exit codes and the `--json` shape are in
[`SPEC.md`](./docs/SPEC.md#the-flow-cli).

## In the DorkOS app

In DorkOS, flow's work shows beside your chats. None of it is needed to run flow: it
reads the same files and tracker the commands do.

- **The Flow tab** follows the chat. In a flow project it shows that project: what is
  running, what is up next, and anything wrong. Anywhere else it lists only the
  projects that need a look. A dot on the tab means something waits for you.
- **Flow home** (the command palette, under Add-ons) lists every project as needs you,
  something's off, or all fine. Each project has its own page, and "Capacity this
  week" shows each account's weekly use.
- **The run chip** in a chat's status bar names the item the chat works on and where
  it stands: "DOR-2387 · Building", or "3 items · 1 needs you".
- **The Activity inbox** is where flow asks, and only when only you can help: ship
  this work, answer an agent's question (it marks its own pick), or sign in again.
  Every ask says what happens and why. What flow settled on its own shows there as
  "While you were away".
- **Pause** asks how long: until tomorrow 9am, for 1 hour, or until you resume.
- **Settings** (⚙ on a project's page, or Settings → Flow) are split by who a change
  reaches. "Shared with the repo" saves to `.agents/flow/config.json`, which reaches
  everyone once you commit it; "Just me" stays on this computer. The "How much it does
  on its own" dial and "Accounts this project may use" are here, and only a person
  can change them.

## Stages

One canonical spine — the unit of "where work is." Spec status, tracker state,
labels, and loop phase are all **projected** from the stage by the adapter, never
authored independently.

```
 manual ─▶  CAPTURE → TRIAGE → IDEATE → SPECIFY → DECOMPOSE → EXECUTE →
 PM-driven ─▶        VERIFY → ⟦HUMAN REVIEW⟧ → DONE → (MONITOR → SIGNAL)
                     ▲ adapter (PMClient): one per tracker, swappable
```

What each stage does, in plain words, is on the
[What flow is](./docs/what-flow-is.mdx) page. REVIEW is the human gate: the engine
stops there and waits for you. There is no skill and no command for it.

Match on a tracker state's **category** (`backlog | unstarted | started |
completed | canceled`), never its display **name** — that is what keeps the
system portable across teams and trackers.

## Modes

You can run one stage at a time (`/flow:specify`), drain the ready queue from your
terminal (`/flow auto`), or let a scheduled tick pick the top item and carry it to
its review gate in a fresh session. The scheduled tick needs the DorkOS server (see
below).

## Command ↔ state map

Each `/flow:<stage>` command is a **thin trigger** (≤ ~40 LOC) over the stage
skill. A PM transition into a stage and the slash command are two **triggers** for
the same skill. The mapping is generated from [`config.json`](./config/config.example.json)
`stages`:

| Stage     | Command           | Skill               | Stage label       | State category    |
| --------- | ----------------- | ------------------- | ----------------- | ----------------- |
| CAPTURE   | `/flow:capture`   | `capturing-work`    | `stage/capture`   | backlog           |
| TRIAGE    | `/flow:triage`    | `triaging-work`     | `stage/triage`    | backlog/unstarted |
| IDEATE    | `/flow:ideate`    | `ideating-features` | `stage/ideate`    | unstarted         |
| SPECIFY   | `/flow:specify`   | `specifying-work`   | `stage/specify`   | unstarted         |
| DECOMPOSE | `/flow:decompose` | `decomposing-work`  | `stage/decompose` | unstarted         |
| EXECUTE   | `/flow:execute`   | `executing-specs`   | `stage/execute`   | started           |
| VERIFY    | `/flow:verify`    | `verifying-work`    | `stage/verify`    | started           |
| REVIEW    | — (human gate)    | —                   | —                 | started           |
| DONE      | `/flow:done`      | `closing-work`      | `stage/done`      | completed         |

Two commands sit outside the stages: `/flow:pause [<item> | for <duration> | until <time>]`
halts autonomy (with a duration it ends on its own at that time), and `/flow:resume` lifts it.

`/flow` (no stage) is the orchestrator: it resolves a stage name, a work item, a
**project** (by name, spec slug, or umbrella id), or `auto`, and routes to the matching
command (`/flow auto|continue <project>` narrow the queue to one project). **With no
arguments**, it offers **Capture** new · **Work on a project** · **Continue the queue**
(one tick of `auto`: claim the next item, carry it to its gate, stop) · **Triage**.

Beside the stages sits the whole-backlog sweep: **`/flow:groom`** audits every open
item against the fifteen groom invariants, closes shipped, duplicate and junk work
with cited evidence behind a human gate, and proves the result with a before/after
run of the dispatch oracle (`/flow:groom check` is the read-only half). Run it when
the queue starves or before turning on autonomy.

Two schedules keep the ready queue fed, both shipped switched off until you
approve them: `flow-triage` (daily: readies or parks untriaged work, releases
stale claims) and `flow-groom` (weekly `/flow:groom check`). See the dials page's
Cadence section. To carry several items at once, see `docs/parallel-drain.mdx`.

## Gates

Involvement is **uncertainty-gated, not stage-gated** (the calibration ladder,
spec §5). The hard gates:

1. **Question / soft-escalation** — any stage, dynamic; driven by the calibration
   ladder. Row 0 (the floor) is always checked for irreversible/destructive,
   outward-facing, secrets/spend/prod, or material-scope-change actions, even at
   full confidence: by you, or by the reviewer agent if you choose. Never by
   nobody, and secrets or spend always wait for you (charter G12).
2. **Plan-approval gate** (after DECOMPOSE) — **off by default**
   (`gates.planApproval: false`). The engine flows DECOMPOSE → EXECUTE and
   surfaces plan assumptions at the review gate. Flip it on for a pre-code
   checkpoint.
3. **Review gate** (after VERIFY) — **always checked.** PR + evidence → review
   state → stop. The project's "Ship finished work" setting in DorkOS decides who
   answers: you, or the reviewer agent when it recorded a clean review of the
   latest commit (`flow autonomy`, `flow review`). With
   `gates.review.mergeOnApproval` on, an approval arms that commit and it merges
   once checks pass; a drain run then closes the item, otherwise run
   `/flow:done <issue>`.
4. **Circuit breaker** — stop + escalate if a unit exceeds `estimate × N`
   wall-clock or the token budget.

**Auto-merge recovery ladder** (spec §6): approval authorizes one specific state
— this diff, green, cleanly mergeable. If that state can't be reproduced at merge
time, the engine checks _mergeable? · CI green? · functionally unchanged?_ and
routes each failure through the calibration ladder (mechanical conflict → resolve
and announce; real tradeoff → bounce; behavior drift → re-request approval).

## Adapter interface

The **tracker adapter skill** owns **every** tracker call, over a config-driven
transport (`connection.transport`: an account-pinned CLI or an in-session MCP
server), and fulfils the capability verbs as a documented contract. Stage skills
and commands name a verb (_"via the adapter, transition the item …"_) and never
touch a tracker string; a grep guard enforces it.

Which adapter is a **config value, not a code path**: `tracker` in `config.json` is
an adapter slug. flow ships **`linear-adapter`** (`skills/linear-adapter/SKILL.md`),
the default. `/flow:init` generates an adapter for any other tracker into
`.agents/flow/adapters/<tracker>/SKILL.md` (committed, so an update never touches
it) and gates it on the same conformance harness, so adopting Jira or GitHub Issues
is a setup run, not a fork. `scripts/config-files.ts` decides which adapter is read
(the project's, then the shipped one) and prints its path as `adapter.path`.

The adapter normalizes every tracker into one `WorkItem` shape and owns how a work
item is shown to a person. The verbs, including the one optional verb
(`completeProject`), are in [`adapters/SPEC.md`](./adapters/SPEC.md) and the
reference adapter's [`SKILL.md`](./skills/linear-adapter/SKILL.md).

## Autonomous mode & the server dependency

The autonomous loop is seated on **DorkOS Pulse** via a file-based schedule
(`${CLAUDE_PLUGIN_ROOT}/skills/flow-drain/SKILL.md`). Pulse already provides a contextless
code-loop (croner) that dispatches a fresh, isolated, resumable, runtime-agnostic
agent session per run — so there is no scheduler to build.

- **One tick = one issue.** Each croner fire is a fresh run-session
  (`sessionId = run.id`) that claims and works exactly one issue to its gate, then
  ends — preserving fresh-session-per-issue.
- **Activation** is install at project scope, then approve. The `schedule:` block in
  `skills/flow-drain/SKILL.md` makes the file a scheduled task; DorkOS reads it from
  the project's skills root, and it waits on the **Schedules** page until you approve
  it, so installing a package never arms its own cron. The switch and the timing you
  set there outlast updates. Without DorkOS schedule discovery, wire an external
  scheduler (`docs/bring-your-own-scheduler.mdx`). Running it needs the DorkOS server
  and the project's DorkOS agent registered.
- **Pausing** is `/flow:pause`: it writes `.agents/flow/paused.json` in the project,
  and every tick checks it first and stops. On DorkOS it also switches this project's
  flow schedules off; `/flow:resume` switches back on only those. A timed pause
  (`for 1 hour`, `until 9am`) ends on its own, even with DorkOS closed, and leaves
  schedules on.
- **Crash/stall recovery** is driven by the durable `FlowRun` record + the
  next-tick recovery ladder (spec §12): a `needs-input` item is never reclaimed;
  an orphaned `agent/claimed` item is adopted + resumed (re-attach the worktree at
  HEAD, resume the session) or restarted clean, with `attemptCount` guarding
  against runaway retries.

A `claude -p`-per-issue **watcher** seat for non-DorkOS repos is designed but not
built, so `autonomy.seat` accepts only `pulse` today.

## Configuration

Your settings live in your project, not in the plugin, so an update never erases them:
`.agents/flow/config.json` is the team's policy and is committed; `.agents/flow/config.local.json`
holds this machine's credentials and overrides and is kept out of git. An older flow kept both
inside the plugin; the first `/flow` after updating moves them over (asking first when the
plugin folder may be shared with other projects) and leaves the old files alone. Defaults live in the [`config.example.json`](./config/config.example.json) template, validated against the
Zod-generated [`config.schema.json`](./config/config.schema.json) (authored as the
`@dorkos/flow` `FlowConfigSchema`, bridged via `z.toJSONSchema`). The resolved
defaults encode the key decisions: `planApproval: false`, `subIssueThreshold: "xl"`,
`perIssue: "fresh-session"`, `seat: "pulse"`. See [`SPEC.md`](./docs/SPEC.md) →
_Config schema reference_ for the full contract.

How much flow does on its own, and which accounts a project may use, are not in
either file: they live in DorkOS, where only a person can change them (see
[In the DorkOS app](#in-the-dorkos-app)). Full detail: [`config/CONFIG.md`](./config/CONFIG.md).

A per-repo `WORKFLOW.md` override is part of the config contract (Decision #15),
but v1 reads only the two files above, so a `WORKFLOW.md` does not take effect yet.

## Templates

The system owns a template set under [`templates/`](./templates/README.md),
**loaded by skills** (not projected to any harness):

- [`templates/records/`](./templates/README.md) — tracker work-item bodies by
  type (`idea` · `research` · `hypothesis` · `task` · `project`), each with
  `## Validation criteria` + `## On Completion`.
- [`templates/docs/`](./templates/README.md) — the filesystem doc scaffolds
  (ideation · specification · `03-tasks.json` · ADR).
- [`templates/pr.md`](./templates/pr.md) — the PR template the VERIFY stage fills
  at the review gate.
