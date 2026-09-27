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

- Show items to people by the adapter's display convention.
- Uncertainty, not the stage, pulls a person in.
- Hit friction, a workaround or a confusion in flow itself: `flow note --kind friction|workaround|confusion "<one sentence>"`. No secrets, no pasted output.

## Guard (every invocation, before routing)

Never guess a settings path. Run `cf migrate`:

- `"migrated": true` (top level or in `adapter`): name the files it wrote; ask the operator to commit them, never `config.local.json`.
- `"needsConfirmation": true`: nothing was copied. Show `found` and `adapter.found` (never a credential), then ask with `AskUserQuestion`: **"Are these this project's settings?"** One answer covers both. Yes: `cf migrate --confirm`, report as above. No: `cf migrate --decline`, route to `/flow:init`, stop. Headless: never answer for them; stop and report "these settings may belong to another project; run /flow in this project to confirm".
- `"ok": false`: show `reason`, carry on.

Then run `cf`:

- `"ok": false`: route to `/flow:init` and stop before any stage or dispatch work. Headless: report the first error and stop.
- Show every warning with its path. A `/secrets` warning goes first and loud: move that block from `config.json` to `config.local.json` before committing.
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

Recommend 4 when `starved` and not `atWipCap`; else 3.

**With arguments**, first match wins:

1. `status`, `pause`, bare `resume` or `resume <issue-id>` → that control command.
2. A stage name → its `/flow:<stage>` command.
3. An item id or spec path → find its stage (`stage/*` label, else its run record's `stage`, else its spec artifacts); advance one stage.
4. `continue` or `auto`, optionally with a project → **Queue modes**.
5. A project name, spec slug or umbrella id (`resolveProject`; `resume <project>` lands here) → **Projects**.
6. Anything else: a description; resolve the item, advance one stage.

Several matches: ask with `AskUserQuestion`. A bare stage name is the stage; a colliding project is named by `/flow resume <project>` or its umbrella id.

**Projects.** With `agent/ready` children in a non-terminal state: rank with `flow next --for-project <project> --json`, claim the top item, carry it to its review gate, stop (no sentinel). With none: advance the umbrella issue one stage by its `stage/*` label. `continue <project>` is one such tick; `auto <project>` is **auto** ranked with `--for-project`.

## Queue modes

Both follow `${CLAUDE_PLUGIN_ROOT}/skills/flow-drain/SKILL.md`, which holds the tick.

- **`continue`**: one tick, no sentinel, then stop. Never loops.
- **`auto`**: that skill's **Auto** section: tick after tick in this terminal. No server needed.
