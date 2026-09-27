---
description: The /flow engine — one PM-agnostic workflow from capture to done. Routes to a stage, advances a work item or project, or drains the ready queue.
category: flow
allowed-tools: Read, Glob, Grep, SlashCommand, Task, TaskList, TaskGet, AskUserQuestion
argument-hint: '[stage | work-item | project | continue | auto]'
---

# /flow — the workflow engine

Resolve and route: $ARGUMENTS

`flow <verb>` below means `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" <verb>`;
`cf` means `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/config-files.ts"`.

## Stages

| Stage     | Command           | Skill               |
| --------- | ----------------- | ------------------- |
| CAPTURE   | `/flow:capture`   | `capturing-work`    |
| TRIAGE    | `/flow:triage`    | `triaging-work`     |
| IDEATE    | `/flow:ideate`    | `ideating-features` |
| SPECIFY   | `/flow:specify`   | `specifying-work`   |
| DECOMPOSE | `/flow:decompose` | `decomposing-work`  |
| EXECUTE   | `/flow:execute`   | `executing-specs`   |
| VERIFY    | `/flow:verify`    | `verifying-work`    |
| REVIEW    | — (human gate)    | —                   |
| DONE      | `/flow:done`      | `closing-work`      |

`/flow:status`, `/flow:pause` and `/flow:resume` observe or steer; they never advance a stage.

- Name an item as `PROJ-157 - Title` (the adapter's display convention), never a bare key.
- Uncertainty, not the stage, pulls a person in.
- Hit friction, a workaround or a confusion in flow itself: `flow note --kind friction|workaround|confusion "<one sentence>"`. No secrets, no pasted output.

## Guard (every invocation, before routing)

Never guess a settings path. Run `cf migrate`:

- `"migrated": true` (top level or in `adapter`): name the files it wrote; ask the operator to commit `.agents/flow/config.json`, `.agents/flow/.gitignore` and any `.agents/flow/adapters/` it wrote, never `config.local.json`.
- `"needsConfirmation": true`: nothing was copied. Show `found` and `adapter.found` (never a credential), then ask with `AskUserQuestion`: **"Are these this project's settings?"** One answer covers both. Yes: `cf migrate --confirm`, report as above. No: `cf migrate --decline`, route to `/flow:init`, stop. Headless: never answer for them; stop and report "these settings may belong to another project; run /flow in this project to confirm".
- `"ok": false`: show `reason`, carry on.

Then run `cf`:

- `"ok": false`: route to `/flow:init` and stop before any stage or dispatch work. Headless: report the first error and stop.
- Show every warning with its path, then carry on. A `/secrets` warning goes first and loud: credentials sit in the committed `config.json`; move that block to `config.local.json` before committing.
- `config.local.json` overrides `config.json`; a field in neither takes its `default` from `config/config.schema.json`.
- Read the tracker adapter from `adapter.path` only; `<flow-root>` inside it means `flowRoot`.

**The pause.** When `paused` is not `null`, never
start `continue` or `auto`, and never run a scheduled tick or a tracker tick: say "flow is paused (since `<pausedAt>`); `/flow:resume` lifts it" and stop. Everything else runs: a pause stops the loop, never
the operator. With a valid config present, route as below.

## Routing

**No arguments.** Do not guess. Run `flow next --json`, then offer five intents with `AskUserQuestion`:

1. Capture a new thought → `/flow:capture`.
2. Work on a project → list active projects (adapter `getProjects`), let them pick, go to **Projects**; none active: take a typed name via `resolveProject`.
3. Continue the queue → `continue`.
4. Triage the backlog → `/flow:triage`.
5. Check loop status → `/flow:status`.

Recommend 4 when `starved` and not `atWipCap` ("0 ready, <N> shapeable: run a triage pass?"); else recommend 3.

**With arguments**, first match wins:

1. `status`, `pause`, bare `resume` or `resume <issue-id>` → that control command.
2. A stage name → its `/flow:<stage>` command.
3. An item id or spec path → find its stage (`stage/*` label, else its run record's `stage`, else its spec artifacts); advance one stage.
4. `continue` or `auto`, optionally with a project.
5. A project name, spec slug or umbrella id (`resolveProject`; `resume <project>` lands here) → **Projects**.
6. Anything else: a description; resolve the item, advance one stage.

Several matches: list them with `AskUserQuestion`. A bare stage name is the stage; name a colliding project with `/flow resume <project>` or its umbrella id. Still ambiguous: ask.

**Projects.** With `agent/ready` children in a non-terminal state: rank with `flow next --for-project <project> --json`, claim the top item, carry it to its review gate, stop (no sentinel). With none: advance the umbrella issue one stage by its `stage/*` label. `continue <project>` is one such tick; `auto <project>` is **auto** ranked with `--for-project`.

## Queue modes

- **`continue`**: one **tick** (below), no sentinel, then stop. Never loops. **Pause check** first: if the guard's `paused` is not `null`, do not start. If the check cannot run or its output cannot be read, stop before claiming.
- **`auto`**: drain the ready queue in this terminal, one tick after another. No server needed.

**Auto.**

0. **Pause check.** If the guard's `paused` is not `null`, do not start. If the check cannot run or its output cannot be read, stop before claiming.
1. **Start.** Write `.dork/flow/auto-run.json` (not `flow-state.json`) = `{ "active": true, "ready": <eligibleCount>, "shapeable": <shapeableCount>, "startedAt": "<ISO>", "pid": <pid>, "sessionId": "${CLAUDE_SESSION_ID}" }`, counts from `flow next --json`. If `sessionId` still reads as a `${…}` placeholder, say the drain will stop after each item.
2. **Pause check** each iteration by running `cf` again. When `paused` is not `null`, claim nothing more and stop; keep the sentinel (set `active` to `false` if it is not); if the check cannot run or its output cannot be read, stop too.
   **Then it runs one tick.** After it, write the new `ready` and `shapeable` counts.
3. End early with `<promise>ABORT</promise>`, cleanly with `<promise>PHASE_COMPLETE:auto</promise>`.
4. **Stop.** Drained or aborted: delete the sentinel. Never leave a stale one.

## One tick (continue, auto, and the `flow-drain` schedule)

Resolve identity once per tick with the adapter's `getCurrentUser`; never hand an oracle the literal `"auto"`. Re-read an item's state through the adapter before acting on it. In order:

1. **Recovery.** Read `.dork/flow/flow-state.json`, drop records whose item is closed. For each `agent/claimed`, started, not `agent/needs-input` item, probe its worker and worktree and run `scripts/recovery.ts`. `resume`: re-attach the worktree at HEAD and resume its `sessionId`. Otherwise act on `restart-clean`, `escalate` (`agent/blocked`) or `re-derive`. Skip runs with `drain` set.
2. **Inbox.** Un-park answered `agent/needs-input` items before claiming anything new: poll the adapter's `getInbox`, apply the comment-response rules in `skills/tending-tracker/SKILL.md` (never answer your own comment), resume with `--resume <sessionId>`. Skip runs with `drain` set.
3. **Dispatch.** Take `flow next --json`. Empty `picked`: at `atWipCap`, offer no triage; `starved`, write `ready: 0, shapeable: <M>`, report "Queue starved: 0 ready, <M> shapeable: run a triage pass?" and offer `/flow:triage` or stop; else the queue is drained, go to **Stop**. Otherwise provision `picked[0]`'s worktree and claim it: `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" claim <id> --session <session id> --worktree <path> --branch <branch> --json`. Move stages with `flow stage <id> <stage> --json`, carrying the item to its human-review gate (REVIEW), never past it; DONE is `flow done`, after a human approves. At each decision, run `scripts/involvement.ts`; a live terminal asks inline with `AskUserQuestion`, never a parked tracker comment.

**At each stage boundary**, if the item carries `agent/paused`: advance it no further, run `flow release <id> --to none --json`, leave the worktree, move on. Reassigning an item on the tracker hands it to a person or another agent.

Tracker rules: see the adapter at `adapter.path`.
