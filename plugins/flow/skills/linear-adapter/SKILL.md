---
name: linear-adapter
description: The /flow engine's tracker adapter — the single skill that owns EVERY Linear MCP / Composio call and normalizes Linear into the generic WorkItem shape. Use whenever a /flow stage skill or the loop engine needs to read or write the tracker (claim, transition, comment, inbox, relations, evidence, sub-issues). All flow tracker I/O routes through here; no other flow skill or command may touch a tracker string.
---

# Linear adapter

> **Is this the adapter to use?** Run `node --experimental-strip-types "<flow-root>/scripts/config-files.ts"`. If the `adapter.path` it prints is not this file, stop reading this one and read that file. If the check cannot run or its output cannot be read, stop.

> **Flow root:** the folder two levels above this skill's real path (`realpath` a `.claude/skills/flow__*` or `.agents/skills/flow__*` link first). `<flow-root>/...` paths start there. `flow <verb>` means `node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

Contract: [`../../adapters/SPEC.md`](../../adapters/SPEC.md) 2.2.0. `adapter.ts` beside this file is the code `flow` runs.

## The one rule

**The tracker is reached only through a `flow` verb or this adapter.** No other flow skill or command may name a `mcp__linear__*` / `mcp__plugin_linear_linear__*` tool, a `composio` call or a `LINEAR_*` slug; they name a verb from the table below. One audit surface for every write. `engine-tests/tracker-confinement.test.ts` enforces it.

## Connection (config, never hardcoded)

`connection.team.key` (the identifier prefix), `connection.team.id`, `connection.workspace.slug` and the secret `secrets.trackerAccount` live in `config.local.json`; `connection.transport` (`cli` by default, or `mcp`) in the committed `config.json`.

- Both files are the project's; `config-files.ts` prints their paths (`committed`, `local`); local wins. Never inline a team, slug or account.
- **`cli`:** every call is `composio execute <SLUG> --account "<trackerAccount>" -d '<json>'`. The flag is the only thing keeping another connected account (a personal login, unrelated `artblocks` work) from receiving flow's writes. Lost a slug: `composio search "<intent>" --toolkits linear`.
- **`mcp`:** the server acts as whoever OAuth'd it, not as `trackerAccount`. Before any write, `get_authenticated_user` must be the same identity; unauthenticated, authenticate as that account; a different identity, use `cli`. Pass `includeArchived: false` on `list_issues`; never `includeMembers: true` on `list_projects` (complexity errors).

## The verbs

SPEC section 3's 16 required verbs, the groom-only `getBacklogSnapshot`, and the optional `completeProject` (**supported**). Use the `flow` verb where one exists; it reads back and records.

| Verb                                                                      | Do this                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`getCurrentUser()`**                                                    | Code. By hand: `LINEAR_GET_CURRENT_USER` (never `LINEAR_GET_AUTHENTICATED_USER`, which does not exist), or `viewer { id name }`.                                                                                                                                                                               |
| **`getBacklogSnapshot()`**                                                | `flow snapshot --json` (`--include-closed`, `--out <file>`). Never script it.                                                                                                                                                                                                                                  |
| **`getEligibleWork()`**, **`getProjectWork(projectId)`**                  | `flow next --json` (`--for-project`). Returns candidates; the policy applies the `agent/ready` gate.                                                                                                                                                                                                           |
| **`getProjects()`**, **`resolveProject(nameOrId)`**, **`getProject(id)`** | GraphQL `projects` / `team { issues(filter: { project }) }`. `resolveProject` returns every case-insensitive match; an umbrella identifier resolves to its project.                                                                                                                                            |
| **`getRelations(item)`**                                                  | GraphQL only, see below.                                                                                                                                                                                                                                                                                       |
| **`getInbox(agent)`**                                                     | Assigned-to-me, @mentions and new comments since the last tick, as `InboxEntry` below.                                                                                                                                                                                                                         |
| **`claim(item)`**                                                         | `flow claim <id> --session <session id> --json`. Swaps `agent/ready` for `agent/claimed` (one exclusive `agent/*` group), removes every `stage/*` label, moves the item to started, confirms on read-back, records the run.                                                                                    |
| **`transition(item, stage)`**                                             | `flow stage <id> <stage> --json`. Release is `flow release`; finishing is `flow done`.                                                                                                                                                                                                                         |
| **`comment(item, body)`**                                                 | GraphQL `commentCreate`. Ends with `identity.marker` and the `agent:provenance` line.                                                                                                                                                                                                                          |
| **`assignToHuman(item)`**                                                 | `issueUpdate` `assigneeId` = the reviewer. Used at the review gate and on handoff.                                                                                                                                                                                                                             |
| **`attachEvidence(item, evidence)`**                                      | Link the proof (recording, test summary, PR) per `evidence.attachTo`.                                                                                                                                                                                                                                          |
| **`needsInput(item, question)`**                                          | Four effects: post the question (multiple choice when possible, with the marker and the `agent:provenance` line), apply `agent/needs-input` leaving the state alone, `assignToHuman`, **stop**. `flow triage <id> --park` does the first two. Resumes only on a non-agent reply.                               |
| **`link(a, b, type)`**                                                    | A typed relation (`blocks`, `related`, `duplicate`). Never in description prose.                                                                                                                                                                                                                               |
| **`createSubIssue(parent, spec)`**                                        | `flow create --parent <id> --key <key>`. Only when `sizeOrdinal(size) >= sizeOrdinal(decomposition.subIssueThreshold)`. The task's `issue` field in `03-tasks.json` is its home. Its description ends with the `agent:provenance` signature; a rewrite replaces it.                                            |
| **`completeProject(project, outcome)`**                                   | `projectUpdate` to `completed` or `canceled`. List its issues live first; any open one: **refuse** and name it (dispatch drops a closed project's issues). Read its state from GraphQL `projects`; unreadable: refuse. Already there: no-op. On `mcp`, use `save_project` or `update_project`; neither: `cli`. |

## Calls by hand

- Use `LINEAR_RUN_QUERY_OR_MUTATION`: input key `query_or_mutation` (not `query`), plus `variables`; the answer is under `.data.data`.
- Pass every value as a GraphQL variable: a literal `$word` in the query text fails the call.
- **Scope every read to the team:** `team(id: "<teamId>") { issues(…) }`, never a top-level `issues`. The list slug `LINEAR_LIST_LINEAR_ISSUES` has no team filter and is WORKSPACE-wide, not team-scoped: post-filter by identifier prefix (`<teamKey>-`) before any policy or write pass. `--account` is not a team filter.
- `searchIssues(term:, includeArchived: false)` is cross-team too: post-filter by identifier prefix.
- Relations: read `relations` and `inverseRelations` through the team node. Any other path's answer (the get slug returns `null`) means unknown, never "no blockers". Read cross-team edges; never write their far end.
- A large answer spills to `outputFilePath`; read it with `jq`. Paginate with `first` and `after` only.
- Read one issue's comments as `issue(id:) { comments { nodes { id body } } }`.
- "Entity not found" on a comment to an id that reads fine: the issue is archived; check `archivedAt`.

**Bulk writes** (the groom):

- A label write replaces the whole set; state, `agent/*` and `stage/*` go through `flow claim|release|done|stage|triage`; any other label write reads fresh first.
- A description write replaces the whole field: strip any `agent:provenance` / `flow:provenance` line, write exactly one as the last line.
- Aliased mutations partially apply: 5-10 per call, check each `success`, re-read a sample.
- Project `state` takes only `backlog | planned | started | completed | canceled`; use `backlog` for "real, not active".
- A project description is capped at 255 characters: one sentence there, the long prose (`<flow-root>/templates/records/project.md`) on the umbrella `type/meta` issue.
- Never close a project by hand; use `completeProject`.

## The `WorkItem` shape

```
WorkItem {
  id, identifier, title, description,
  type,            // idea|research|hypothesis|task|monitor|signal|meta, from type/* (exactly one)
  stateCategory,   // backlog|unstarted|started|completed|canceled
  stateName,       // display only, never matched on
  priority,        // native 0 none · 1 urgent · 2 high · 3 medium · 4 low, never a label
  size,            // native estimate number, never a label or t-shirt conversion
  project, parent,
  relations { blocks[], blockedBy[], children[], relatedTo[], duplicateOf? },
  labels[],        // all labels, re-namespaced group/leaf
  assignee,        // raw; classifyOwnership decides mine|reviewer|other|unassigned
  agentDisposition // ready|claimed|completed|needs-input, from agent/*
}
```

- `stateCategory` is matched on category, never on display name. State `type` maps to itself; `triage` maps to `backlog`; `duplicate` cannot be represented, so `flow snapshot` drops and warns on it. A groom routes both out of those states.
- An untriaged item is held out of dispatch by its missing `agent/ready`, not its category. TRIAGE and DECOMPOSE apply `agent/ready`.
- Labels arrive as bare leaves with a `parent` group; re-namespace to `parent/name` (`ready` → `agent/ready`), or dispatch silently misses them.
- Compare `size` by ordinal only, never to the threshold word: `sizeOrdinal(8)` and `sizeOrdinal("xl")` are both `4`. Missing is neutral and never promotes.
- Graceful degradation: a missing field is `undefined` (neutral), never `0`, `null` or `""`; never fabricate one. SPEC section 2 has the full rules.

## The state machine

- The `agent/*` labels are the durable state machine, not the plan field: `agent/ready`, `agent/claimed`, `agent/completed`, `agent/needs-input`, one at a time.
- State, `agent/*` and `stage/*` agree; the `flow` verbs keep them so (`scripts/work-state.ts`). A claimed started item without `agent/needs-input` is orphaned work.
- A merged PR whose body says `Closes <identifier>` closes the item at merge; use a non-closing reference to keep it open.
- `agent/needs-input` is parked on a person: the stall sweep never reclaims it.

## Showing an item to a person

Write `PROJ-157 - Title` (or a 3-6 word summary), never a bare key. Link only the identifier (`[PROJ-157](<url>) - Title`, never a wikilink); do not re-link a key the surface auto-links. Comments inside the tracker are exempt.

## Provenance

The canonical spec is [`../../docs/provenance.md`](../../docs/provenance.md); do not redefine it here. Linear keeps HTML comments byte-for-byte in descriptions and comments. A person in the rich-text editor can strip the line without noticing; readers treat that as unsigned.

## `InboxEntry`

```
InboxEntry { item, occurredAt /* ISO-8601 Z */, comment: { author, mentions[], body } }
```

The comment-response rules that read it live in `<flow-root>/skills/tending-tracker/SKILL.md`.
