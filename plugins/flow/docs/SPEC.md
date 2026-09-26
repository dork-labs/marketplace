# flow — the contract

> The contract for the `/flow` engine. This is the **promotion surface**: the v1
> contracts documented here are what the P5 server-side Flow Engine — Extension
> (Linear DOR-88…) promotes the proven harness into. P5 is additive, not a
> rewrite. The three v1 contracts P5 promotes are the **config schema**, the
> **`PMClient` verbs**, and the **`FlowRun` record** — all defined below.

See [`README.md`](../README.md) for the operator manual, [`CHARTER.md`](./CHARTER.md)
for the goals this contract implements, and the published
[guide series](./) for the user-facing reference.

## Stage model

The canonical nine-stage spine is the unit of "where work is." Spec status,
tracker state, labels, and loop phase are all **projected** from the stage via the
adapter — never authored independently.

```
CAPTURE → TRIAGE → IDEATE → SPECIFY → DECOMPOSE → EXECUTE → VERIFY → ⟦REVIEW⟧ → DONE → (MONITOR → SIGNAL)
```

- Each stage projects to a tracker `stage/*` label and (where applicable) a state
  **category** — `backlog | unstarted | started | completed | canceled`. The
  engine matches on **category**, never on a tracker's state display **name**, so
  it is portable across teams and trackers.
- `REVIEW` is a **human gate**: no command, no skill. The engine parks there and
  resumes (in P2) only on the human's approval.
- A thin `/flow:<stage>` command and a PM transition are two **triggers** for the
  same gerund-named stage skill. The mapping is defined by
  [`config.json`](../config/config.example.json) `stages` (and rendered in the README's command↔state
  map).

| Stage     | Skill               | Command           |
| --------- | ------------------- | ----------------- |
| CAPTURE   | `capturing-work`    | `/flow:capture`   |
| TRIAGE    | `triaging-work`     | `/flow:triage`    |
| IDEATE    | `ideating-features` | `/flow:ideate`    |
| SPECIFY   | `specifying-work`   | `/flow:specify`   |
| DECOMPOSE | `decomposing-work`  | `/flow:decompose` |
| EXECUTE   | `executing-specs`   | `/flow:execute`   |
| VERIFY    | `verifying-work`    | `/flow:verify`    |
| REVIEW    | — (human gate)      | —                 |
| DONE      | `closing-work`      | `/flow:done`      |

### Orchestrator — no-args cold start

A bare `/flow` (no stage, no item, no `auto`) MUST **offer four intents** rather
than guess: **capture** · **work on a project** (via `getProjects`) · **continue
the queue** · **triage**, with an item, `auto` or a stage reachable as free text
(an `AskUserQuestion` in a terminal harness, a numbered prompt elsewhere).
**Continue the queue** is one tick of `auto`: `selectDispatch` claims the
next-ranked item and carries it to its review gate, writing no auto-drain
sentinel and never looping.

**Naming a project** (`/flow <project>`, or the aliases `start` / `resume`)
resolves it via `resolveProject`, then does project-scoped single-item dispatch
when it has `agent/ready` children (`getProjectWork` + `selectDispatch`, honoring
the `perProject` WIP cap), or advances its umbrella issue one stage when it has
none. `/flow auto <project>` and `/flow continue <project>` narrow the queue modes
to that project.

## `PMClient` interface (promotion surface, P5)

In **v1 the `PMClient` is not code.** It is the tracker adapter skill (the
project's `.agents/flow/adapters/<tracker>/SKILL.md`, or the shipped
`skills/linear-adapter/`; `config-files.ts` prints which as `adapter.path`): a
**prose** contract that owns every tracker call and fulfils the verbs below.
Stage skills name a verb and never touch a tracker string (a grep guard enforces
this). The P5 server build promotes it into this typed interface, same verbs,
same `WorkItem` normalization:

```ts
interface PMClient {
  getCurrentUser(): Promise<Account>; // resolve identity.agent: "auto"
  getProjects(): Promise<WorkItemProject[]>;
  resolveProject(nameOrId: string): Promise<WorkItemProject[]>; // fuzzy name/slug/umbrella id → matches (len > 1 = disambiguate)
  getProject(id: string): Promise<WorkItemProject & { children: WorkItem[]; umbrella?: WorkItem }>; // single project + rollup
  getProjectWork(projectId: string): Promise<WorkItem[]>; // getEligibleWork scoped to one project (project dispatch)
  getEligibleWork(): Promise<WorkItem[]>; // feeds the dispatch policy (§4)
  getInbox(): Promise<InboxComment[]>; // for resume-on-reply (§5)
  getRelations(item: WorkItem): Promise<WorkItemRelations>;
  claim(item: WorkItem): Promise<void>; // durable agent/claimed label + state
  transition(item: WorkItem, toCategory: StateCategory): Promise<void>;
  comment(item: WorkItem, body: string): Promise<void>; // carries identity.marker + the agent:provenance signature
  assignToHuman(item: WorkItem): Promise<void>;
  attachEvidence(item: WorkItem, evidence: EvidencePlan): Promise<void>;
  needsInput(item: WorkItem, question: string): Promise<void>; // park on human
  link(a: WorkItem, b: WorkItem, type: RelationType): Promise<void>;
  createSubIssue(parent: WorkItem, body: string): Promise<WorkItem>; // sizeOrdinal ≥ threshold
  // OPTIONAL (adapter contract 1.1.0) — an adapter may omit it; callers degrade
  completeProject?(project: WorkItemProject, outcome: 'completed' | 'canceled'): Promise<void>;
}
```

### The `WorkItem` normalization shape

The adapter normalizes every tracker into one `WorkItem` so the generic layer
never sees a tracker-specific field (typed in `@dorkos/flow` `work-item.ts`):

```ts
WorkItem {
  id, identifier, title, description,
  type,            // idea | research | hypothesis | task | monitor | signal | meta
  stateCategory,   // matched on CATEGORY, never name
  stateName,       // display only
  priority,        // 0–4
  size,            // number (points, native) | string (t-shirt) — promotion + ranking
  project,         // { id, name, stateCategory, lead }
  parent, relations { blocks[], blockedBy[], children[], relatedTo[], duplicateOf? },
  labels[],        // includes stage/* and agent/*
  assignee,        // → classifyOwnership(): mine | reviewer | other | unassigned
  agentDisposition // ready | claimed | completed | needs-input
}
```

**Graceful degradation:** trackers lacking `project.stateCategory` / `priority` /
`size` (e.g. GitHub Issues) supply what exists; the dispatch policy treats missing
fields as neutral.

**Presenting to humans:** any surface that shows a `WorkItem` to a person renders
`identifier` then `title` (`PROJ-157 - Title`), never the bare key; the identifier
is the link where the surface supports one. The v1 tracker adapter skill owns this
convention (its _Presenting a work item to a human_ section); the P5 `PMClient`
carries it forward.

## The flow CLI

`scripts/flow.ts` is the one command skills and people run for tracker steps:

```bash
node --experimental-strip-types <flow-root>/scripts/flow.ts <verb> [args] [flags]
```

`<flow-root>` is the `flowRoot` that `config-files.ts` prints. The
[README](../README.md#the-flow-cli) lists the verbs; `flow <verb> --help` gives
each one's flags.

- `--json` prints one JSON object with `"v": 1` on stdout, even on failure:
  `{ "v": 1, "ok": false, "error": { "code", "message" } }`. Warnings go to
  stderr.
- `--project <dir>` is the checkout to read (every verb but `accounts`).
  `--snapshot <file>` lets `next`, `audit` and `status` read a saved
  `flow snapshot --json`. `--dry-run` prints a write verb's plan and writes
  nothing. `--manual` lets `next` and `claim` run while paused. `--session <id>`
  defaults to `FLOW_SESSION_ID`, then `CLAUDE_CODE_SESSION_ID`.
- Every write is read back from the tracker; one that does not stick exits 4.

| Exit | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Success.                                                                |
| 1    | The check found problems (`audit`, `status --strict`).                  |
| 2    | Usage error: unknown verb, bad flag, missing argument.                  |
| 3    | Config error: not configured, invalid, `mcp` transport, no adapter.     |
| 4    | Tracker error: unreachable, auth failure, a write not confirmed.        |
| 5    | Precondition failed: item not found, not claimable, claimed by another. |
| 6    | Missing runtime dependency (`zod`).                                     |
| 7    | Paused (`next` or `claim` without `--manual`).                          |
| 70   | A bug in flow, kept apart from 1 so a crash never reads as findings.    |

## `FlowRun` record (promotion surface, P3)

The durable run record keys the **session↔issue** association — the bridge that
makes ephemeral sessions resumable. Written to `flow-state.json` (v1, disk) →
server SQLite (v2), following the ADR-0043 file-first write-through pattern (disk
is truth; the future DB is a derived cache). Typed in `@dorkos/flow`
`flow-run.ts`:

```ts
FlowRun {
  issueId, identifier;          // tracker id + "DOR-123" (worktree/branch key)
  sessionId;                    // Claude SDK JSONL id — the resume handle
  worktreePath, branch;         // ~/.dork/workspaces/<project>/<key>/, dork/<key>
  status;                       // queued | running | waiting_for_review | complete | failed
  attemptCount; workerPid;      // v1 single-machine liveness
  heartbeatAt?;                 // v2 (concurrent) liveness — unused in v1
  startedAt, completedAt?;
  account?;                     // account id the CURRENT session bills
  host?;                        // launcher of the current session: cli | dorkos | cmux
  provenance?;                  // v/harness/session/account/worker/host/instance/surface/resumeUrl
                                //   — where the run came from; its wire subset is the
                                //   agent:provenance signature (docs/provenance.md)
}
```

The eight-field **wire subset** of `provenance` is the `agent:provenance`
signature every outward write carries — specified, tracker-neutrally, in
[`provenance.md`](./provenance.md). `worktreePath` and the delegated worker id
stay local: they are a run record, not a wire format.

`account` and `host` describe the **current** session; a handoff rewrites them.
`host` is the launcher, not the machine (`provenance.host`), and a bare string so
a future launcher never fails the reader. `provenance.account` never changes. DorkOS
reads `flow-state.json` (never writes it) to tie its sessions to items by
`sessionId`; account ids are explained in [Account usage](./account-usage.mdx).
These shared rules, with test cases both sides run, are in
[`conformance/fleet/README.md`](../conformance/fleet/README.md).

The **checkpoint is the git commit + the JSONL session**, so the next-tick
recovery ladder **resumes** (re-attach the worktree at HEAD, `resume` the
session) rather than restarts. v2 adds heartbeat, a fencing token, atomic
multi-claim, and a stall-detector — the server residue earmarked in DOR-89.

## The typed engine — v1 promotion surface (`@dorkos/flow`)

The engine's decision logic is **already typed code** in `@dorkos/flow`, which
P5 lifts server-side unchanged. Each module is pure (config + inputs → a
decision), table-driven, and unit-tested.

### Calibration ladder — `calibration.ts` (§5)

`resolveInvolvement(descriptor, config) → InvolvementDecision`. Walks the
five-row ladder top-down and returns the first match:

| Row | Condition                                                            | Behavior             |
| --- | -------------------------------------------------------------------- | -------------------- |
| 0   | Floor (irreversible · outward-facing · secrets/spend · scope-change) | `stop-and-ask`       |
| 1   | reversible + confident                                               | `proceed-silently`   |
| 2   | sticky + not-confident                                               | `stop-and-ask`       |
| 3   | reversible + not-confident (ambiguous middle)                        | routed by stage bias |
| 4   | sticky + confident                                                   | `proceed-with-trail` |

Stage bias routes row 3: intake stages (`intake`) → `stop-and-ask`; execution
stages (`execution`) → `proceed-with-trail`. Types: `DecisionDescriptor`,
`InvolvementDecision`, `FloorTrigger`, `Reversibility`, `Confidence`,
`DecisionStage`, `InvolvementBehavior`.

### Dispatch policy — `dispatch.ts` (§4)

`selectDispatch(items, options)` = `filterEligible` → `rankEligible` →
`truncateRankedToWipCap`. Eligibility removes non-dispatchable state, missing
`agent/ready` (PM-driven), open blockers, closed projects, and items the
`ownership` policy does not permit (`isClaimable`); each check is per item, so
input order never matters. Ranking is a total order over seven tiers
(`unblockers → priority → projectStatus → type → size → age → identifier`). The
WIP cap runs last: the ladder decides _which_ items survive, the cap only _how
many_. `sizeOrdinal(size)` is the one sanctioned way to compare a `size` against a
t-shirt threshold. Types: `DispatchConfig`, `OwnershipConfig`, `WipCap`,
`WipLoad`, `RankFactor`.

### Gates + auto-merge recovery — `gates.ts` (§5, §6)

`planApprovalRequired(gates)`, `tripsCircuitBreaker(usage, gates)`, and
`evaluateAutoMerge(state, gates) → MergeDisposition` (the §6 ladder:
mergeable? · CI green? · functionally unchanged? → resolve / bounce / re-approve).
Types: `GatesConfig`, `ReviewGateConfig`, `CircuitBreakerConfig`, `MergeState`,
`MergeDisposition`, `CircuitBreakerTrip`.
`resolveProjectCompletion(pulse) → { disposition, reason }` is a post-DONE
disposition, not a gate. An empty project, an incomplete rollup, any open item or
an active spec yields `skip` (never `advise`: recommending a close that must not
happen is the same mistake). Otherwise it yields `complete` only under
`gates.projectCompletion: "auto"` with an adapter that has the OPTIONAL
`completeProject` verb, else `advise`. The `reason` names the deciding condition.
Types: `ProjectPulse`, `ProjectCompletionOutcome`, `ProjectCompletionDisposition`,
`ProjectCompletionReason`.

### Comms routing + comment-response — `comms.ts`, `comment-response.ts` (§5)

`resolveCommsChannel(trigger, involvement) → CommsRoute` (`interactive` vs
`comment-and-assign`, inferred from the trigger). `shouldRespondToComment(comment,
context) → CommentDecision` enforces the hard rules then the conservative soft
zone (never answer its own comments; always respond when addressed; resume on a
non-agent reply to a `needs-input` item; stay out of `other`-owned threads; lean
quiet). Types: `CommsRoute`, `CommsChannel`, `InboxComment`, `CommentDecision`.

### Identity & ownership — `identity.ts` (§7)

`resolveIdentityMode(identity) → "two-account" | "shared"` (detected:
`reviewer` unset or == `agent` ⇒ shared). `classifyOwnership(item, identity) →
"mine" | "reviewer" | "other" | "unassigned"` — the **one primitive, two
consumers** that drives both dispatch eligibility and comment-handling. Types:
`Identity`, `IdentityMode`, `IdentityConfig`, `OwnershipScope`.

### Crash & stall recovery — `flow-run.ts` (§12)

`recoverOrphan(context) → RecoveryAction` runs the next-tick recovery ladder
keyed by `OrphanSignal` (`needs-input` → skip; `claimed-no-worker` → resume /
restart-clean / escalate per `attemptCount` vs `maxRetries`; `no-local-record` →
re-derive). Types: `FlowRun`, `RecoveryConfig`, `RecoveryContext`, `OrphanSignal`,
`RecoveryAction`.

### Evidence selection — `evidence.ts` (§13)

`selectEvidence(config, trigger) → EvidencePlan` chooses the proof-of-completion
capture per class (`ui` → GIF/WebM/none by interactive-vs-unattended trigger;
`temporal` → video; `logic` → test summary) and the `attachTo` targets. Types:
`EvidenceConfig`, `EvidencePlan`, `EvidenceCapture`, `EvidenceTrigger`.

### Task decomposition schema — `tasks-schema.ts` (§8)

`TasksFileSchema` / `TaskSchema` extend `03-tasks.json` with optional per-task
`issue` / `parentIssue` fields and the PM-agnostic `ProvenanceSchema` block (one
issue **or** project). `isPromotableToSubIssue` fires only at
`size ≥ subIssueThreshold` (default `"xl"`); a `WorkItem.size` is compared through
`sizeOrdinal`, since points and t-shirt words are not directly comparable. Types:
`TasksFile`, `Task`, `TaskSize`, `Provenance`.

### Backlog-groom invariants — `audit-backlog.ts` (the GROOM oracle)

The whole-tracker health oracle behind `/flow:groom` (`grooming-backlog`).
Where `validate-adapter.ts` asserts one adapter's normalization is well-formed
(INV-1..5, per-item shape), `audit-backlog.ts` asserts the **backlog itself**
is honestly dispatchable: fifteen invariants (GRM-1..15) over a full
`getBacklogSnapshot()` — exactly one `type/*` label, a project, and a real
priority on every open item; size, both engine-read description sections, no
open blocker, no foreign assignee, a live project, and a `stage/*` label on
every READY item; no dead project holding open work; namespaced labels; a
single-valued `agent/*` state machine; no live item with an unresolved
`duplicateOf`; and state and labels agreeing.

**GRM-15** reports each `STATE-n` breach from `work-state.ts`, the one rule for
how state and labels fit together: at most one `stage/*` label; none while
started; `agent/claimed` only while started; no `agent/ready` while started; no
`agent/completed` on an open item. `flow status` reports the same breaches on
in-flight items as drift. Same contract as the conformance script (stdin or
`--fixture`, `{ ok, failures }`, exit 0/1/2, dependency-free); the
engine-tests seed a violation per invariant and prove the verdict goes red.

## Config schema reference

The configuration contract is the Zod `FlowConfigSchema` (`@dorkos/flow`
`config-schema.ts`), generated to [`config.schema.json`](../config/config.schema.json) via
`z.toJSONSchema` (`buildConfigJsonSchema`) and referenced from
[`config.json`](../config/config.example.json) via `$schema`. The resolved defaults encode the
spec's load-bearing decisions:

| Block                             | Default                                      | Decision |
| --------------------------------- | -------------------------------------------- | -------- |
| `gates.planApproval`              | `false` — flow DECOMPOSE → EXECUTE           | §7.4     |
| `decomposition.subIssueThreshold` | `"xl"` — XL-only sub-issue promotion         | §7.6     |
| `context.perIssue`                | `"fresh-session"` — fresh session/issue      | §7.7     |
| `autonomy.seat`                   | `"pulse"` — sole v1 seat (`watcher` planned) | §10      |
| `identity.agent` / `.reviewer`    | `"auto"` / `null` — resolved at runtime      | §7       |
| `gates.review.mergeOnApproval`    | `true` + the §6 recovery ladder              | §6       |
| `gates.projectCompletion`         | `"advisory"` — recommend, never auto-close   | 1.1.0†   |

† The adapter contract's version, not a spec section: this dial exists to drive
the optional `completeProject` verb added in `adapters/SPEC.md` 1.1.0.

Top-level blocks: `tracker`, `connection`, `identity`, `ownership`, `comments`,
`stages`, `autonomy`, `loops`, `ingestion`, `involvement`, `dispatch`, `gates`,
`review`, `context`, `models`, `workspace`, `recovery`, `decomposition`,
`evidence`. The full annotated default set is in spec §9; the authoritative
shape is the Zod schema.

## P5 — the Flow Engine — Extension (NOT built here)

Phase 5 (Linear DOR-88…) is out of scope here. It is **additive**, not a rewrite:
it promotes the three v1 contracts above plus the typed engine into one server-side
DorkOS extension. For context only, it adds the typed server `PMClient`, a
webhook relay with Linear Agent Accounts, a server `WorkspaceManager`, the
unattended evidence pipeline (**DOR-95**), heartbeat and fencing concurrency
(**DOR-89**), and a second tracker adapter to prove the seam. None of that is
built in this spec.
