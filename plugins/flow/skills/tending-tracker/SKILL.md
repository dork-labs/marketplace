---
name: tending-tracker
description: The /flow engine's agent-as-team-member loop — the agent participates in a shared tracker like a teammate. Each tick it polls its inbox (assigned-to-me + @mentions + new comments), decides respond/act/ignore per the five comment-response rules, claims work with durable agent/* labels, asks the human via comment+assign when genuinely stuck (soft-escalation), and writes answers back as durable memory so the same question is never asked twice. Use when the agent is operating continuously inside a shared tracker. PM-agnostic; all tracker I/O routes through the adapter skill.
---

# Tending the Tracker

`<flow-root>` is two folders above this file's `realpath`.

How the agent behaves in a tracker it shares with people: watch its inbox, speak only
when it should, claim durably, ask when stuck, remember answers. Every tracker read and
write is an adapter verb (`getInbox`, `claim`, `comment`, `assignToHuman`, `needsInput`,
`transition`, `link`); the adapter is at `adapter.path`. The rules below are prose; the
tested truth is the oracles `classifyOwnership` (`identity.ts`), `shouldRespondToComment`
(`comment-response.ts`), `resolveCommsChannel` (`comms.ts`) and `resolveInvolvement`
(`node --experimental-strip-types "<flow-root>/scripts/involvement.ts"`, JSON in and out).

## The tick

- **Pause check.** Run step 0 of `<flow-root>/skills/flow-drain/SKILL.md` on every
  poll. Stop whenever it says to stop.
- **Tracker unavailable:** say so and stop; never fabricate inbox state.

0. **Resolve identity** once per tick, not per item: `getCurrentUser` resolves
   `identity.agent: "auto"` to a real account id (never pass `"auto"` to an oracle).
   Build `Identity { agent, reviewer, marker }` from it and `config.identity`; the mode
   comes from `resolveIdentityMode`: no distinct reviewer is **shared**, one is
   **two-account**. Detected, never configured.
1. **Poll** `getInbox(agent)`: assigned-to-me, @mentions, and new comments since a
   durable watermark (gap-free across restarts).
2. **Decide** respond / act / ignore per the comment-response rules below.
3. **Act** on what you own (claim, advance through the stage skills, resume).
4. **When stuck, ask** (soft-escalation, below).
5. **Remember the answer** (below).

## The comment-response rules

Classify ownership first: `mine` / `reviewer` / `other` / `unassigned`, from the item's
assignee (a project's lead) against the resolved identity. In shared mode a
self-assignment is still `mine`; own authorship is known by `identity.marker`. Then,
first match wins:

1. **Never answer your own comment:** author is `identity.agent`, or the body carries
   `identity.marker` (in shared mode the marker is the only signal). → ignore.
2. **Always respond when addressed:** an @mention, or in shared mode a `/flow` or
   `@flow` token. Overrides ownership. → respond.
3. **A non-agent comment on an `agent/needs-input` item is the answer.** → resume:
   re-attach the worktree at HEAD and `--resume <sessionId>` from the item's `FlowRun`.
   **When the item has no `FlowRun`**, route as below.
4. **Stay out of `other`-owned threads** unless addressed. → ignore.
5. **The rest leans quiet:** ignore unless `comments.ambiguousBias` is `"engage"`.
   Over-responding is the worse failure.

Chattiness is config (`comments.respondWhen`, `comments.ambiguousBias`), never code.

#### Routing a reply back to its originating session

This decides where a respond or resume lands, and it runs **before** you act on the
thread.

##### Which session is "the originating session"

1. **A durable run record for this item is authoritative.** A `FlowRun` in
   `flow-state.json` names the session; nothing in a thread overrides it.
2. **Otherwise, read the thread's signature** (format: `<flow-root>/docs/provenance.md`).
   **Take the newest signature that is NOT your own.** This loop signs its own replies,
   so the newest is often itself: a self-delivery cycle. **Compare each signature's
   `sessionId` against this session's own id and skip the matches.** In shared-account
   mode this comparison is the only discriminator. A blob that fails to parse counts as
   absent, and so does a signature a human stripped.

##### Where the follow-up goes

| Newest not-your-own signature says                             | Where it goes                                                                                                                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** Same `host` and `harness`, session **still resumable** | **Deliver the follow-up INTO that session:** `bare-cli` → `--resume <sessionId>`; `dorkos` with an `instanceId` matching this install → `POST /api/sessions/<id>/messages`. |
| **(b)** Same `host`, session **gone**                          | **Start a fresh session seeded with the thread** (item, comments, provenance).                                                                                              |
| **(c)** A different `host`, or a different DorkOS `instanceId` | **Handle it in the current session, and say so** in the reply: cross-machine routing is a recorded future step, not something to fake.                                      |
| No signature (unsigned, human, or all your own)                | As (b). Never claim you resumed a session.                                                                                                                                  |

**Anything that does not clearly match (a) is (b).** (b) is always safe.

##### Deciding "still resumable"

Derive it, never assume; if the probe itself fails, that is (b), not (a).

- **claude-code:** `~/.claude/projects/<project-slug>/<sessionId>.jsonl` (honour
  `CLAUDE_CONFIG_DIR`); `claude --resume <sessionId>` is the authoritative probe.
- **codex**, **opencode:** that harness's thread store and its sidecar session store,
  located the way the harness locates them.
- **`dorkos`:** resumable when the `instanceId` matches and the server answers for the id.

A truncated `sessionId` is prefix-matched against that local store; exactly one match
is the session, else (b). Never match against ids you have only seen in tracker threads.
This install's own `instanceId` comes from the DorkOS install itself, not from anything
in the thread; for a reader that cannot determine its own `instanceId`, a `dorkos` signature
falls to (c).

**Silence about which path you took is not allowed.** The tick report **names the
path**: (a) delivered into `<id>`, (b) fresh session, (c) handled here, origin on `<host>`.

> **One product-specific name, deliberately.** `POST /api/sessions/<id>/messages` is a
> DorkOS mechanism, and it is not a tracker string; non-DorkOS readers never match that row.

## Claiming

- `claim(item)` writes `agent/claimed` and a `started`-category state, so it survives a
  restart. The `agent/*` labels are the state machine, never the plan field.
- In shared mode, `mine` is yours to act on only with `agent/claimed` too
  (`SHARED_MODE_CLAIM_LABEL`).
- Never take over an `other`-owned item; `link` only for real typed relations.

## Writing and escalating

- Every `comment` carries `identity.marker` (so rule 1 sees it) and will always carry
  the provenance signature, never an email address. Both, every reply.
- `needsInput(item, question)`: comment the question (multiple choice when possible),
  add `agent/needs-input`, `assignToHuman`, stop. Parked is durable; the stall sweep
  never reclaims it; only a non-agent reply (rule 3) resumes it.
- **Stuck means stop and ask, never guess.** Walk the calibration ladder; a
  `stop-and-ask` (a floor row, sticky and not confident, or the ambiguous middle routed to `ask`) is the
  trigger. `resolveCommsChannel(trigger, identityMode, involvement)` picks:
  `interactive` (ask inline, never park), `comment-and-assign` (two-account:
  `needsInput`), or `comment-and-nudge` (shared: `needsInput` plus the out-of-band nudge
  as the primary channel, since assigning notifies no one).
- `proceed-with-trail`: act on the best default with an `agent/assumption` trail.
  `proceed-silently`: act.
- Ask a real question with options, and say what you would do absent an answer.

## Answers become memory

Write each answer where the next evidence test finds it, so it is never asked twice: a
reusable decision → an ADR; a preference or threshold → the project's
`.agents/flow/config.json`; a point answer → a marked `comment` on the item plus the
label change. The repo holds the answer; the tracker holds pointers and state.

A first live run against a shared tracker is a human step, read-only first.
