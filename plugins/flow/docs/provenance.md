# Agent Provenance — signing outward writes

> **Signature version: 2.** Emitters write version 2; readers accept version 1
> and version 2. This is the **generic, tracker-neutral** spec for the
> provenance signature. It names no tracker, no API, and no slug. Every adapter,
> every stage skill, and every reader references this document; none of them
> redefines it.

---

## 1. Why

Without a signature, a reply to an agent's comment cannot say _which session_ could
answer it, so it waits for a human or a fresh session rebuilds the context.

One machine-readable line fixes that: a later reader can **route a follow-up back
to the session that wrote the thing they are replying to**.

The convention is **runtime-agnostic on purpose**. Any harness can emit it —
inside DorkOS or not, running `/flow` or not — and any reader can parse it without
knowing `/flow` exists. That is why the marker is named `agent:`, not `flow:`.

## 2. The marker line

Append **one line, as the LAST line** of any body the agent writes outward. Version
2 looks like this:

```
<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"work","agent":"dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J","chat":"dork:chat:7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6","space":"dork:space:01JD3F1W2KQ8Z0YV9N6B5T4RMA","host":"dork:host:3c594f448c55cbfade7fd79a1915dab8","turn":"dork:turn:01JD3F2Z7P1Q4R8S9T0U2V3W4X","address":"dork:acme/owl"} -->
```

Version 1, which flow wrote before 0.104.0, looks like this:

```
<!-- agent:provenance {"v":1,"harness":"claude-code","sessionId":"7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6","account":"work","host":"dork:host:3c594f448c55cbfade7fd79a1915dab8","surface":"dorkos"} -->
```

It is an HTML comment, so a human reading the thread never sees it while a machine
reads it back without parsing prose. It stays **one line of JSON** in that fixed
comment, so a script can read it with `grep` and `jq`.

**Version 2 names the writer by `dork:` references; version 1 named it by a session
id and, before flow 0.99.2, a hostname.** Emit version 2; accept both forever.
**Flow's emitters write version 2 from 0.104.0**, field for field as DorkOS's own
builder writes it (`buildProvenanceV2` in DorkOS's `@dorkos/shared/provenance`).

The fields go in one fixed order: `v`, `harness`, `surface`, `account`, `agent`,
`chat`, `space`, `host`, `turn`, `address`. A field that would not read back
(section 11) is left out, never repaired.

**Emit `agent:provenance`. Accept `flow:provenance` on READ.** The prefix is
`agent:` because non-`/flow` sessions emit this too; `flow:provenance` is the
**legacy name** an earlier revision emitted (same field shape, **no `v` field**).
A reader must accept both names and treat a missing `v` as `v: 1`. Never emit the
legacy name.

## 3. Cadence — every outward write, every time

**The signature is PER-WRITE. Every body the agent writes outward carries its own
line, every time.** This is not a once-per-run stamp: routing works only if the
message a human is replying to is itself signed, and the message they reply to is
usually the most recent comment, not the PR body.

One cadence rule sits on top of that, and it is about the PR body alone: the
**PR-body stamp is written once per run**, at VERIFY, and not re-written on every
later push. That is a statement about one artifact, never a licence to leave a
comment unsigned.

## 4. Fields

A `dork:` **reference** is `dork:<kind>:<id>`: a kind word (`agent`, `chat`,
`space`, `host`, `turn`) and an opaque id of 1 to 64 letters, digits, `-` or `_`.
An **address** is `dork:<space>/<handle>[/<name>]`, all lowercase: the org's slug,
the agent's handle, and optionally a named conversation. The grammar is DorkOS's
(ADR `261122-124821` in the DorkOS repository).

### Version 2

| Field     | What it is                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`       | Signature schema version: `2`. A reader that does not know a higher version reads the fields it recognizes and ignores the rest.                                                                                                        |
| `harness` | The agent harness, as one of `claude-code` \| `codex` \| `opencode` \| `other:<name>`. The `other:` form keeps the vocabulary open without letting a new harness masquerade as a known one.                                              |
| `surface` | Where the run was driven from: `dorkos` inside a DorkOS turn, `ci` when `CI` is `true`, else `bare-cli`. **Always emitted**, on every surface — it is what selects the resume _mechanism_, and the `bare-cli` path needs it exactly as much as the `dorkos` one. |
| `account` | A short, **non-PII** handle for the harness account the run authenticated as, so a reader can tell "same machine, different account" from "same session". **NEVER an email address** (section 7).                                        |
| `agent`   | The agent that wrote it, as `dork:agent:<id>`, from `DORKOS_AGENT_ID`. An opaque id: a ULID reveals only when the agent was made.                                                                                                       |
| `chat`    | The chat that wrote it, as `dork:chat:<id>`: `DORKOS_SESSION_ID` in a DorkOS turn, else the harness's own session id. Derive it, never guess. A reader that can open the chat builds the link itself: `<its own origin>/r/dork:chat:<id>`. |
| `space`   | The space the chat belongs to, as `dork:space:<id>`, from `DORKOS_SPACE_ID` (a bare id or the whole reference).                                                                                                                         |
| `host`    | The DorkOS install holding the chat, as `"dork:host:" + hex(sha256("dork:host:v1:" + lowercase(install id)))[0:32]`. Omitted without a DorkOS install, and in public. A mismatch rules local resume out.                                 |
| `turn`    | The turn that wrote it, as `dork:turn:<id>`. Optional. Only in signatures, never a link. Omitted in public.                                                                                                                              |
| `address` | The agent's address, as `dork:<space>/<handle>`, when it has one. Optional. It is the agent's public name.                                                                                                                               |

`host` is a reference to the install, a one-way hash, never a hostname and never
the raw install id. Version 2 drops `resumeUrl` (any reader builds the `/r/` link
from its own origin) and `instanceId` (the only install UUID DorkOS has is its
anonymous usage id, which never leaves the machine).

### Version 1

| Field        | What it is                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`          | `1`, or missing on a legacy `flow:provenance` line.                                                                                                                                              |
| `harness`    | As in version 2, like `account` and `surface`.                                                                                                                                                   |
| `sessionId`  | The harness's own session id, the chat a later reader resumes with. Version 2's `chat` carries the same id as a reference.                                                                     |
| `account`    | As in version 2.                                                                                                                                                                                 |
| `host`       | The install reference, as in version 2. A line written before flow 0.99.2 may hold a hostname here instead; readers ignore it (section 11).                                                    |
| `surface`    | As in version 2.                                                                                                                                                                                 |
| `instanceId` | **Omit it.** The only install UUID DorkOS has is its anonymous usage id. `host` names the install instead.                                                                                     |
| `resumeUrl`  | A URL that opened the session, only when it was resumable. Omitted in public repositories (section 8). Readers ignore it. |

**These fields are the whole wire format.** A run records more about itself
locally — the worktree path, the branch, the delegated worker id — and those stay
in `flow-state.json`. An absolute worktree path is `/Users/<real name>/…` on most
machines, which is the one thing this format must never put on a public forge; a
branch and a worker id route nothing a reader cannot already see. Local run record
and wire format are different things, and only the wire format is public.

## 5. Omit, never fabricate

**Emit only what the run actually has.** An omitted field is a fact; an invented
one is a lie a later reader acts on — it will chase a session that never existed
and then report a resume it did not perform. If nothing survives, write no line at
all and say so in the run report rather than shipping an empty blob that looks
like a stamp.

**Any session can sign, not just one that ran EXECUTE.** When no provenance was
recorded for this item — a session triggered straight into a later stage, or a
reply on a thread this machine never started — **stamp what _this_ session can
determine about itself** and omit the rest. Partial provenance from the writing
session is a real trail; inventing an earlier session that never happened is not.

## 6. Valid JSON or no line at all

**This is the one artifact a machine parses, so it has to be valid JSON.**
JSON-escape every value — quotes, backslashes, newlines, control characters — and
drop any field whose value you cannot escape safely. A missing field costs one
lookup; an unescaped quote invalidates the whole blob, and a parser that silently
gets nothing back is exactly the failure this line exists to prevent.

## 7. `account` is never an email address

`account` is the **harness account** — the sign-in the agent runtime itself is
using. It is **not** the tracker account, and never what a tracker's
"authenticated user" read returns: those are different identities, and the tracker
one is usually a real person.

Derive it, never guess:

- **claude-code** — the basename of `CLAUDE_CONFIG_DIR`, less its leading dot
  (`claude-work`); `claude` when unset.
- **codex**, **opencode** — the same idea applied to the profile or home directory
  that harness resolves for itself.
- **Anything else** — if you cannot derive it, **omit it**.

**Never put an email address in `account`, or in any other field.** These bodies
land in trackers and on **public forges**, where a comment is world-readable and
permanent. `account` exists to _distinguish_ accounts, not to identify a person: a
stable short handle (`claude`, `work`, `alt`) does the whole job. **If the value
you derived contains an `@`, omit `account` entirely** rather than trying to clean
it up — a truncated address is still an address.

Nothing here carries a real name, an email or a token.
**`host` is never the machine's hostname**: a stock macOS hostname is
`Firstname-Lastname-MacBook-Pro.local`. Nor the raw install id, which anonymous
usage data carries. Signers drop either, and readers ignore either.

## 8. Public repositories

A public repository makes every signed body world-readable and permanent, so some
fields change.

**Version 2:**

- **`chat`** — cut the id (not the whole reference) to its **first 8 characters**:
  `"chat":"dork:chat:7c1e4b2a"`.
- **`host`** and **`turn`** — **omit them.** They are for private trackers.
- **`agent`**, **`space`** and **`address`** — emit them. The ids are opaque, and
  the address is the agent's public name by design.

```
<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"work","agent":"dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J","chat":"dork:chat:7c1e4b2a","space":"dork:space:01JD3F1W2KQ8Z0YV9N6B5T4RMA","address":"dork:acme/owl"} -->
```

**Version 1**, for an emitter that still writes it:

- **`sessionId`** — an emitter MAY ship only its **first 8 characters** instead of
  omitting it.
- **`resumeUrl`** — **omit it.** Truncating `sessionId` while shipping a full
  resume URL that contains the same id is not privacy, it is theatre.
- **`host`** — **omit it.** It is for private trackers.

In both versions readers treat the chat id as an **opaque token matched locally**,
against the chats this install holds. An id of 8 characters or more is
prefix-matched: exactly one match is the chat, ambiguous or no match degrades like
a missing one. **An id shorter than 8 characters matches only a chat with exactly
that id**, never by prefix: a one-character token would otherwise match a large
share of every install's chats.

A public repository's issues count as public too.

**Decide it, do not assume it.** Read the repository's visibility rather than
guessing — `gh repo view --json visibility` is the one-command answer on GitHub,
and the equivalent read on another forge. **When visibility cannot be determined,
treat the repository as public.** That is the fail-safe direction: the cost of
being wrong toward "public" is one degraded resume, and the cost of being wrong
toward "private" is a permanent leak.

Flow signs PR text as public. Tracker text follows the tracker adapter's declared
`visibility`: `private` keeps the whole chat id and `host`; `public`, or nothing
declared, gets the public cut.

## 9. Which writes carry it

| Write                                                        | Carries the line                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `comment(item, body)`                                        | **Yes** — every agent-authored comment, beside the identity marker.                    |
| `needsInput(item, question)` (its comment)                   | **Yes** — the write whose entire purpose is to be replied to.                          |
| `createSubIssue(parent, spec)` (the description it writes)   | **Yes** — appended as the last line of the description it authors.                     |
| Any **item description the agent authors or rewrites**       | **Yes** — including a backlog sweep's description rewrite. See the replace rule below. |
| A **PR body**                                                | **Yes** — the once-per-run stamp VERIFY writes.                                        |
| A **PR comment**                                             | **Yes**.                                                                               |
| `claim`, `transition`, `assignToHuman`, `link`               | **No** — a label, state, or assignee write has no body to sign.                        |
| `attachEvidence`                                             | **No** — it writes links, not prose. The PR body it links to is signed.                |
| A human's text the agent relays **verbatim** on their behalf | **No** — signing someone else's words as the agent's own is a lie.                     |

**A description write REPLACES any signature already in that description; it never
appends a second one.** A comment thread is ordered, so "newest signature" is
well-defined across comments — but there is no ordering rule _inside_ a single
body, and two lines in one description leave a reader picking arbitrarily. Read
the existing description, drop any `agent:provenance` or `flow:provenance` line it
carries, then append yours.

## 10. Provenance and the identity marker are different things

Write both; neither replaces the other. **The identity marker** (`identity.marker`,
e.g. `— 🤖 /flow`) is visible and human- and self-facing. **`agent:provenance`** is
invisible and machine-facing: it routes, naming the runtime, session, account and
install. Strip the marker and self-recognition breaks; strip the line and routing
breaks.

Neither proves authorship alone: anyone can type or paste them. On a shared
account, the agent's own comment is that account plus its signature
(`authoredByAgent`); any other comment from it never grants. Any marker also
silences.

## 11. Reading it back

Scan the body's last line for **either** accepted marker name and parse the JSON. A
blob that fails to parse is treated as absent, never as partially trusted: half a
parsed line is how a reader ends up resuming the wrong session. Flow's reader is
`scripts/signature-line.ts` (`readSignature`): every flow reader that reads a
field goes through it, so a version 2 line routes exactly as a version 1 line does.
Two read no field, so they match only the marker name: `cli/pr.ts` checks whether a
PR body is already signed, and `unsignedBody` in `cli/provenance.ts` strips a
trailing line. The check that silences the agent's own comment on a shared account
counts any JSON object, even with a bad `v`: a comment wrongly silenced beats flow
answering itself.

How a line is read:

- **Absent as a whole** when the last line is not a signature, the JSON does not
  parse or is not an object, or `v` is there but is not a whole number of 1 or more.
  A missing `v` is 1.
- **By version.** The chat's bare id comes from `sessionId` on a version 1 line and
  from `chat` on a version 2 line; each version's other fields are ignored.
- **A newer version reads as version 2.** A `v` of 3 or more is read with version
  2's fields, and anything else on it is ignored. The `dork:` scheme adds kinds and
  never reinterprets one, so the known fields keep their meaning.
- **One malformed field is dropped, not the line.** A known field with the wrong
  type, or a `dork:` field that is not a well-formed reference of its own kind, is
  read as missing, and the rest of the line stands. Every field lost this way moves
  a router toward its safe path: no chat routes as unsigned, and no `host` never
  matches.
- **`host` only as an install reference.** A `host` that is not
  `dork:host:<32 hex>`, such as the hostname an older version 1 line carried, is
  read as missing. It is never copied, shown or matched.
- **Unknown fields are ignored**, and `resumeUrl` and `instanceId` are never read.

Five reader rules:

- **Newest wins, excluding your own.** In a thread with several signed comments,
  the newest signature is the one to route on — but a loop that signs its own
  replies will otherwise find _itself_ at the top of the thread. Skip any signature
  whose chat id is this session's own before taking the newest. An id of 8
  characters or more also counts as your own when it is the start of your id (a
  public body's cut id); a shorter one only when it is your whole id.
- **A local run record outranks a thread signature.** When the reader holds a
  durable run record for the item (`flow-state.json`), the record's `chat`, else its
  `sessionId`, is authoritative and the thread signature is the fallback for items
  with no record.
- **A chat id that matches no local chat, or more than one, degrades like a missing
  one.** A reader that holds a re-key alias table checks it before giving up;
  flow's reader holds none yet.
- **A missing `host` never matches.**
- **Absence is normal, not evidence.** An unsigned thread, a human-authored
  comment, or a signature a person removed while editing in a rich-text editor all
  read the same way: no signature (rich-text editors strip HTML comments). A missing
  line means "route as unsigned", never "that session is dead".

What to _do_ with a parsed signature — deliver into that session, start a fresh
one, or handle it here and say so — is the router's decision, specified in the
team-member loop (`skills/tending-tracker/SKILL.md`, "Routing a reply back to its
originating session"). This document defines the signature; that one defines the
routing.

## 12. Verified mechanics

The design only works because the hidden line survives a round trip:

- A tracker that preserves HTML comments **byte-for-byte** in both item
  descriptions and comment bodies. Verified by API round-trip on the reference
  tracker; an adapter for a tracker that mangles or strips them must say so, and
  its `comment` verb degrades to unsigned rather than shipping a broken line.
- A forge that preserves them in PR bodies and PR comments — long established.

## 13. Routing is advice

A signature tells a router where a reply might go. **It never grants a right to
deliver.** Anyone can type or paste the line, so a router:

- delivers only into chats its own install holds, found by matching the chat id
  against its own local chats, never against ids it has only seen in threads;
- treats the body it delivers as an outsider's words, whatever the signature says;
- prefers its local run record over any line in a thread.

That keeps a forged line from doing much: at most it points a reply at a chat whose
public id it copied, which the router delivers to only if its own install holds
that chat, and the outsider-words rule still applies to what it delivers. A
cryptographic signature over the line is designed for but not built.
