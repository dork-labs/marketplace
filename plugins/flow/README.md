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
tracker, generates and conformance-gates the adapter for it, and scaffolds the
config triad.

The engine oracles under `scripts/` run on `node --experimental-strip-types` and
need **one** npm package, `zod`. `/flow:init` checks for it and offers to install
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

| Verb              | What it does                                             |
| ----------------- | -------------------------------------------------------- |
| `snapshot`        | Pull the backlog once, for reuse with `--snapshot`.      |
| `audit`           | Check the backlog against the groom invariants.          |
| `next`            | Show the next item to work on.                           |
| `claim`           | Start an item and record the run.                        |
| `release`         | Let go of an item.                                       |
| `done`            | Post the summary and close an item.                      |
| `stage`           | Move an item to another stage.                           |
| `status`          | Show what is in flight, parked or out of step.           |
| `checkpoint`      | Write the item's `HANDOFF.md`.                           |
| `accounts`        | List, add or set the accounts flow may spend.            |
| `usage`           | Record each account's usage.                             |
| `fleet`           | Show every account and running session. Changes nothing. |
| `note`, `journal` | Write to or read flow's journal.                         |

`flow <verb> --help` lists a verb's flags. Exit codes and the `--json` shape are in
[`SPEC.md`](./docs/SPEC.md#the-flow-cli).

## Stages

One canonical spine — the unit of "where work is." Spec status, tracker state,
labels, and loop phase are all **projected** from the stage by the adapter, never
authored independently.

```
 manual ─▶  CAPTURE → TRIAGE → IDEATE → SPECIFY → DECOMPOSE → EXECUTE →
 PM-driven ─▶        VERIFY → ⟦HUMAN REVIEW⟧ → DONE → (MONITOR → SIGNAL)
                     ▲ adapter (PMClient): one per tracker, swappable
```

- **CAPTURE** — quick, low-commitment intake of a raw thought as an `idea`. Does
  not evaluate or classify. (`capturing-work`)
- **TRIAGE** — classify freeform input into a type, or evaluate a captured item
  (accept / reject / needs-research / needs-refinement) and make the
  **simple-vs-complex** routing call. (`triaging-work`)
- **IDEATE** — shape a complex brief into a structured ideation artifact.
  (`ideating-features`)
- **SPECIFY** — turn ideation into a frozen specification + draft ADRs.
  (`specifying-work`)
- **DECOMPOSE** — break the spec into `03-tasks.json` tasks (mirrored to the
  tracker as a checklist; promote a sub-issue only at `size ≥ "xl"`).
  (`decomposing-work`)
- **EXECUTE** — implement the tasks across dependency-aware batches in an
  isolated worktree. (`executing-specs`)
- **VERIFY** — run the touched surface, capture proof-of-completion evidence,
  open the PR, and hand off to review. (`verifying-work`)
- **REVIEW** — the **human gate**. The engine parks here; there is no skill and
  no command. On approval + green CI it resumes into DONE.
- **DONE** — close the work, create follow-ups, run the project-pulse check, and
  tear down the worktree. (`closing-work`)
- **MONITOR / SIGNAL** — the optional tail that keeps the loop spinning.

Match on a tracker state's **category** (`backlog | unstarted | started |
completed | canceled`), never its display **name** — that is what keeps the
system portable across teams and trackers.

## Modes

The **trigger source** is orthogonal to the **execution mode** — a 2×2, not a
single axis:

|                        | **Step** (run one stage, stop)      | **Autonomous** (run to a gate)                                |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------- |
| **Manual** (CLI/slash) | `/flow:specify`, `/flow:execute`    | `/flow auto` — drain the ready queue from the terminal        |
| **PM-driven**          | rare; explicit single-stage advance | default — a Pulse tick claims an item, carries it to its gate |

The default seat is PM-driven + Autonomous: a **Pulse** tick carries the top-ranked
item to its gate in a fresh session, which needs the DorkOS server (see below).

Every stage is autonomous-capable. The human is pulled in by **uncertainty** (the
calibration ladder), not by stage — which is why IDEATE asks freely while EXECUTE
asks rarely, as an emergent property of one rule.

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

`/flow` (no stage) is the orchestrator: it resolves a stage name, a work item, a
**project** (by name, spec slug, or umbrella id), or `auto`, then routes to the matching
command. Naming a project routes by its state: project-scoped single-item dispatch when it
has `agent/ready` children, or advancing its umbrella one stage when it has none yet
(`/flow auto|continue <project>` narrow the queue modes to that one project). **With no
arguments at all**, it offers four intents: **Capture** new · **Work on a project** (pick
from the active projects) · **Continue the queue** (claim the next-ranked item, carry it to
its gate, then stop) · **Triage** the backlog, with a specific item or `auto` (drain the
whole queue) reachable as free text. "Continue the queue" is one tick of `auto`.

Beside the stages sits the whole-backlog sweep: **`/flow:groom`**
(`grooming-backlog`) audits every open item against the fifteen groom
invariants (`scripts/audit-backlog.ts`), closes shipped/duplicate/junk work
with cited evidence behind a human gate, reconciles projects with reality, and
applies the readiness gate honestly — then proves the result with a
before/after run of the dispatch oracle. `/flow:groom check` is the read-only
audit half. Run it when the queue starves, after a large programme lands, or
before turning on autonomy: the dispatch policy is only as truthful as the
labels it reads, and a ready label nobody audits decays into noise.

Two schedules keep the ready queue fed, both shipped switched off until you
approve them: `flow-triage` (daily: readies or parks untriaged work, releases
stale claims) and `flow-groom` (weekly `/flow:groom check`). See the dials page's
Cadence section. To carry several items at once by hand, see
`docs/parallel-drain.mdx`.

## Gates

Involvement is **uncertainty-gated, not stage-gated** (the calibration ladder,
spec §5). The hard gates:

1. **Question / soft-escalation** — any stage, dynamic; driven by the calibration
   ladder. Row 0 (the floor) always stops for irreversible/destructive,
   outward-facing, secrets/spend/prod, or material-scope-change actions, even at
   full confidence.
2. **Plan-approval gate** (after DECOMPOSE) — **off by default**
   (`gates.planApproval: false`). The engine flows DECOMPOSE → EXECUTE and
   surfaces plan assumptions at the review gate. Flip it on for a pre-code
   checkpoint.
3. **Human-review gate** (after VERIFY) — **always on.** PR + evidence → review
   state → assign the human → stop. On approval + green CI → auto-merge + close +
   teardown. **v1 caveat:** the engine parks here and does **not** detect approval
   — merge the approved PR yourself, then run `/flow:done <issue>` to close the
   item and tear down the worktree. The merge-_decision_ logic (`evaluateAutoMerge`,
   §6 below) is built + tested; the _detection + execution_ that fires it
   unattended (poll/webhook-driven resume-on-approval) is the P2 server Extension.
4. **Circuit breaker** — stop + escalate if a unit exceeds `estimate × N`
   wall-clock or the token budget.

**Auto-merge recovery ladder** (spec §6): approval authorizes one specific state
— this diff, green, cleanly mergeable. If that state can't be reproduced at merge
time, the engine checks _mergeable? · CI green? · functionally unchanged?_ and
routes each failure through the calibration ladder (mechanical conflict → resolve
and announce; real tradeoff → bounce; behavior drift → re-request approval).

## Adapter interface

The **tracker adapter skill** is the v1 **`PMClient`**: it owns **every** tracker
call over a config-driven transport (`connection.transport`: an account-pinned
CLI or an in-session MCP server) and fulfils the capability verbs as a
**documented prose contract**. Generic stage skills and commands call it by naming
a verb (e.g. _"via the adapter, transition the item …"_) and never touch a tracker
string — a grep guard enforces zero tracker API strings outside the adapter.

Which adapter is a **config value, not a code path**. `tracker` in `config.json`
is an adapter slug. This repo ships **`linear-adapter`** as the reference adapter
(`skills/linear-adapter/SKILL.md`), and `linear` is the default; `/flow:init`
generates the adapter for any other tracker you pick into your project, at
`.agents/flow/adapters/<tracker>/SKILL.md` (committed, so a plugin update never
touches it), and gates it on the same conformance harness, so adopting Jira or
GitHub Issues is a setup run, not a fork. `scripts/config-files.ts` decides which
adapter is read (the project's, then the shipped one) and prints its path as
`adapter.path`; every command and skill reads it from there.

The verbs: `getCurrentUser`, `getProjects`, `resolveProject`, `getProject`,
`getProjectWork`, `getEligibleWork`, `getInbox`, `getRelations`, `claim`,
`transition`, `comment`, `assignToHuman`, `attachEvidence`, `needsInput`, `link`,
`createSubIssue`, plus the contract's one **optional** verb, `completeProject`
(this adapter supports it; another tracker's adapter may not, and callers
degrade rather than fail when it is absent). The adapter normalizes
every tracker into one `WorkItem` shape so the dispatch policy and stage skills
never see a tracker-specific field. Full verb contract: the reference adapter's
[`SKILL.md`](./skills/linear-adapter/SKILL.md) and the tracker-neutral
[`adapters/SPEC.md`](./adapters/SPEC.md); the typed `interface PMClient`
the P5 server build promotes it into is in [`SPEC.md`](./docs/SPEC.md).

The adapter also owns the **display convention**: every work item shown to a human
is rendered as `PROJ-157 - Title` (identifier first, the identifier linked where the
surface supports it), never a bare key.

## Autonomous mode & the server dependency

The autonomous loop is seated on **DorkOS Pulse** via a file-based schedule
(`${CLAUDE_PLUGIN_ROOT}/skills/flow-drain/SKILL.md`). Pulse already provides a contextless
code-loop (croner) that dispatches a fresh, isolated, resumable, runtime-agnostic
agent session per run — so there is no scheduler to build.

- **One tick = one issue.** Each croner fire is a fresh run-session
  (`sessionId = run.id`) that claims and works exactly one issue to its gate, then
  ends — preserving fresh-session-per-issue.
- **Activation** is install at project scope, then approve. The `schedule:` block
  in `skills/flow-drain/SKILL.md` is what makes the file a scheduled task; a
  DorkOS release that has schedule discovery reads it straight out of the skills
  roots it watches, with nothing copied by hand, and the tick waits on the
  **Schedules** page until you approve it — installing a package can never arm its
  own cron. On a DorkOS build without schedule discovery, or on any other harness,
  wire an external scheduler instead (see `docs/bring-your-own-scheduler.mdx`).
  Running it still needs the DorkOS server (it hosts the watcher + croner) and the
  project's DorkOS agent registered. The on/off switch and the timing are both set
  on the Schedules page (Edit changes when it runs; "Reset to the package's
  default" goes back), and both outlast updates; the file is the package's and an
  update replaces it.
- **Pausing** is `/flow:pause`: it writes `.agents/flow/paused.json` in the project,
  and every tick checks it first and stops, so an update cannot undo it and it works
  under any scheduler. On DorkOS it also switches this project's flow schedules off
  when it can reach them. `/flow:resume` removes the flag and switches back on only
  the schedules the pause switched off.
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

`tracker` is an **adapter slug**, not a fixed list: it names the adapter the engine
reads (`.agents/flow/adapters/<tracker>/`, or the shipped `skills/<tracker>-adapter/`),
so it accepts any lowercase slug
(`^[a-z][a-z0-9-]*$`) `/flow:init` has generated a conforming adapter for. It
defaults to `linear`, the reference adapter shipped here. Full detail:
[`config/CONFIG.md`](./config/CONFIG.md).

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
