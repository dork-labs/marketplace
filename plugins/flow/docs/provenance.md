# Agent Provenance — signing outward writes

> **Signature version: 1.** This is the **generic, tracker-neutral** spec for the
> provenance signature. It names no tracker, no API, and no slug. Every adapter,
> every stage skill, and every reader references this document; none of them
> redefines it.

---

## 1. Why

An outward write is a dead end today. A human reads an agent's comment, replies
with a question, and nothing in the thread says _which session_ could answer it —
so the reply either waits for a human, or a fresh session picks it up and rebuilds
the context from scratch.

One machine-readable line fixes that: a later reader can **route a follow-up back
to the session that wrote the thing they are replying to**.

The convention is **runtime-agnostic on purpose**. Any harness can emit it —
inside DorkOS or not, running `/flow` or not — and any reader can parse it without
knowing `/flow` exists. That is why the marker is named `agent:`, not `flow:`.

## 2. The marker line

Append **one line, as the LAST line** of any body the agent writes outward:

```
<!-- agent:provenance {"v":1,"harness":"claude-code","sessionId":"…","account":"work","host":"build-box.local","surface":"dorkos","instanceId":"…","resumeUrl":"…"} -->
```

It is an HTML comment, so a human reading the thread never sees it while a machine
reads it back without parsing prose.

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

| Field        | What it is                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`          | Signature schema version. `1` today. A reader that does not know a higher version reads the fields it recognizes and ignores the rest.                                                                                  |
| `harness`    | The agent harness, as one of `claude-code` \| `codex` \| `opencode` \| `other:<name>`. The `other:` form keeps the vocabulary open without letting a new harness masquerade as a known one.                              |
| `sessionId`  | The harness's own session id — the handle a later reader resumes with. Derive it (some harnesses expose it; on others the transcript path encodes it); never guess.                                                     |
| `account`    | A short, **non-PII** handle for the harness account the run authenticated as, so a reader can tell "same machine, different account" from "same session". **NEVER an email address** (section 7).                        |
| `host`       | This machine's hostname. Load-bearing: a retained transcript is only reachable from the machine holding it, so a host mismatch is what rules local resume out.                                                           |
| `surface`    | Where the run was driven from: `dorkos` \| `bare-cli` \| `ci`. **Always emitted when determinable**, on every surface — it is what selects the resume _mechanism_, and the `bare-cli` path needs it exactly as much as the `dorkos` one. |
| `instanceId` | The DorkOS install's UUID, when the run is under DorkOS. **Omit it outside DorkOS** — it is what tells a reader "this session lives in the install I am talking to" rather than an identically-named one elsewhere.      |
| `resumeUrl`  | A URL that actually opens the session, when one exists **and the session is meaningfully resumable**. A link that resolves to nothing is worse than no link — omit it instead. Omitted in public repositories (section 8). |

**These eight fields are the whole wire format.** A run records more about itself
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

- **claude-code** — the basename of `CLAUDE_CONFIG_DIR`, defaulting to `claude`
  when the variable is unset.
- **codex**, **opencode** — the same idea applied to the profile or home directory
  that harness resolves for itself.
- **Anything else** — if you cannot derive it, **omit it**.

**Never put an email address in `account`, or in any other field.** These bodies
land in trackers and on **public forges**, where a comment is world-readable and
permanent. `account` exists to _distinguish_ accounts, not to identify a person: a
stable short handle (`claude`, `work`, `alt`) does the whole job. **If the value
you derived contains an `@`, omit `account` entirely** rather than trying to clean
it up — a truncated address is still an address.

The same restraint applies to the rest of the block. Nothing here carries a real
name, an email, or a token **by design** — but `host` is the field that can betray
that by accident: a stock macOS hostname is `Firstname-Lastname-MacBook-Pro.local`.
In a public repository, **consider omitting `host`** too; routing degrades to "not
this machine", which is the same answer a mismatched host would have given.

## 8. Public repositories

A public repository makes every signed body world-readable and permanent, so two
fields change:

- **`sessionId`** — an emitter MAY ship only its **first 8 characters** instead of
  omitting it. Readers treat any `sessionId` as an **opaque token matched
  locally**: prefix-match it against the sessions this machine holds; exactly one
  match is the session, ambiguous or no match degrades like a missing one.
- **`resumeUrl`** — **omit it.** Truncating `sessionId` while shipping a full
  resume URL that contains the same id is not privacy, it is theatre. The URL is
  reconstructible locally by anyone who can actually resume the session, which is
  the only person it helps.

**Decide it, do not assume it.** Read the repository's visibility rather than
guessing — `gh repo view --json visibility` is the one-command answer on GitHub,
and the equivalent read on another forge. **When visibility cannot be determined,
treat the repository as public.** That is the fail-safe direction: the cost of
being wrong toward "public" is one degraded resume, and the cost of being wrong
toward "private" is a permanent leak.

## 9. Which writes carry it

| Write                                                        | Carries the line                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `comment(item, body)`                                        | **Yes** — every agent-authored comment, beside the identity marker.                                   |
| `needsInput(item, question)` (its comment)                   | **Yes** — the write whose entire purpose is to be replied to.                                         |
| `createSubIssue(parent, spec)` (the description it writes)   | **Yes** — appended as the last line of the description it authors.                                    |
| Any **item description the agent authors or rewrites**       | **Yes** — including a backlog sweep's description rewrite. See the replace rule below.                |
| A **PR body**                                                | **Yes** — the once-per-run stamp VERIFY writes.                                                       |
| A **PR comment**                                             | **Yes**.                                                                                              |
| `claim`, `transition`, `assignToHuman`, `link`               | **No** — a label, state, or assignee write has no body to sign.                                       |
| `attachEvidence`                                             | **No** — it writes links, not prose. The PR body it links to is signed.                               |
| A human's text the agent relays **verbatim** on their behalf | **No** — signing someone else's words as the agent's own is a lie.                                    |

**A description write REPLACES any signature already in that description; it never
appends a second one.** A comment thread is ordered, so "newest signature" is
well-defined across comments — but there is no ordering rule _inside_ a single
body, and two lines in one description leave a reader picking arbitrarily. Read
the existing description, drop any `agent:provenance` or `flow:provenance` line it
carries, then append yours.

## 10. Provenance and the identity marker are different things

They coexist on the same comment and neither replaces the other:

- **The identity marker** (`identity.marker`, e.g. `— 🤖 /flow`) is **human- and
  self-facing**: it is visible, and it is how the comment-response rules recognize
  the agent's own writes in shared-account mode.
- **`agent:provenance`** is **machine-facing**: invisible, structured, and about
  _routing_ — which runtime, which session, which account, which machine.

A comment stripped of its marker breaks self-recognition; a comment stripped of
its provenance breaks routing. Write both.

## 11. Reading it back

Scan the body for **either** accepted marker name and parse the JSON. A blob that
fails to parse is treated as absent, never as partially trusted: half a parsed
line is how a reader ends up resuming the wrong session.

Three reader rules:

- **Newest wins, excluding your own.** In a thread with several signed comments,
  the newest signature is the one to route on — but a loop that signs its own
  replies will otherwise find _itself_ at the top of the thread. Skip any signature
  whose `sessionId` is this session's own before taking the newest.
- **A local run record outranks a thread signature.** When the reader holds a
  durable run record for the item (`flow-state.json`), that record's `sessionId` is
  authoritative and the thread signature is the fallback for items with no record.
- **Absence is normal, not evidence.** An unsigned thread, a human-authored
  comment, or a signature a person removed while editing in a rich-text editor all
  read the same way: no signature. Trackers with rich-text editors do sometimes
  strip HTML comments a human edits around, so a missing line means "route as
  unsigned", never "that session is dead".

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
