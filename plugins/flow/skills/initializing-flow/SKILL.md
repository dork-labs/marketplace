---
name: initializing-flow
description: First-run setup for the /flow engine in a new repo - detect or reconfigure an existing install, gather setup choices (tracker + connection, identity mode, project routing, adversarial review, model tiers) via the calibration ladder, generate and verify the concrete tracker adapter, scaffold the committed config.json plus the gitignored config.local.json and a review rubric, and confirm the install with a dry dispatch. Use when running /flow:init, configuring flow for the first time, adopting a new tracker, or reconfiguring an existing flow install.
---

# Initializing Flow - first-run setup

> **Flow root.** This skill lives at `<flow-root>/skills/initializing-flow/SKILL.md`. If you reached it via a symlink (`.claude/skills/flow__*` or `.agents/skills/flow__*`), resolve the real path first (`realpath <path>`): the flow root is two directories above the skill directory. Every `<flow-root>/...` reference below is relative to that root.

> **What this is.** The one-time setup procedure an adopter (or `/flow:init`)
> follows to make `/flow` runnable in a repo: pick a tracker, generate the
> concrete **adapter** that lets the generic engine speak to it, scaffold the
> config triad, and confirm the install. After this runs clean, every
> `/flow:<stage>` command and the autonomous loop work against your tracker with
> no further wiring.
>
> **This is a prose procedure, not code.** The agent reads this skill and follows
> it. `/flow:init` is a thin trigger over it.

## The one rule: stay tracker-neutral until the adapter exists

Setup never names a tracker API, a tool string, or a tracker-specific field. The
**only** tracker-aware artifact this procedure produces is the generated adapter
under `<flow-root>/skills/<tracker>-adapter/`. Everything else you touch (the
config triad, the dispatch check) stays generic. When you need adapter-generation
detail, read the `building-adapters` skill
(`<flow-root>/skills/building-adapters/SKILL.md`); it owns the generate-and-verify
contract. This skill owns the **setup orchestration** around it.

## Calibration: ask when a human is present, default when headless

Setup choices are gathered by the calibration ladder. When a human is at the
terminal, ask with `AskUserQuestion` (one question per choice, with the safe
option pre-marked). When running headless (no interactive terminal, or a
non-interactive trigger), do **not** block: apply the sane default for each
choice, record the assumption in your setup report, and proceed. Setup is
reversible (re-run with `/flow:init` to change anything), so headless defaults are
safe to apply silently. The one exception is Step 4's clobber guard, which always
confirms before overwriting committed config.

---

## Process

```
  1 DETECT     does a valid config.json already exist?  (fresh vs re-run)
  2 GATHER     tracker + connection · identity · routing · review · model tiers
  3 ADAPTER    generate the concrete adapter, then validate until green (the gate)
  4 CONFIG     write config.json + config.local.json (secrets) + the review rubric
  5 CONFIRM    dry dispatch on an empty queue → "/flow is ready"
```

### Step 1 - Detect: fresh install or re-run

Check whether `<flow-root>/config/config.json` exists and parses as valid JSON
(`node -e "require('<flow-root>/config/config.json')"` exits `0`).

- **No file, or invalid JSON → fresh install.** This is the _expected_ state of a
  clean install: the plugin ships `config.example.json` (the committed template),
  never a `config.json` (that file is gitignored and generated right here, so it
  cannot leak a host's config back into the plugin when dogfooded via
  `--plugin-dir`). Proceed to Step 2 with defaults seeded from
  `config.example.json` if present, otherwise from schema defaults.
- **Valid file exists → re-run (reconfigure).** Do **not** clobber it silently.
  Tell the operator `/flow` is already configured (name the current `tracker` and
  `identity.agent`), and ask whether to **reconfigure** (re-gather choices and
  rewrite), **regenerate the adapter only** (skip Steps 2 and 4, jump to Step 3),
  or **cancel**. Headless re-run defaults to **cancel** (never rewrite committed
  config without a human), and reports that it stopped because a valid config
  already exists.

Also confirm the toolchain is present: `node` is on PATH and
`<flow-root>/scripts/validate-adapter.ts` exists (it is the Step 3 gate). If either is
missing, stop and say so plainly rather than proceeding to a setup that cannot be
verified.

### Step 2 - Gather setup choices (the calibration ladder)

Five choices drive the rest of setup. Gather them with `AskUserQuestion`
interactively, or apply the headless default.

1. **Tracker + connection.** Which tracker, and how the adapter reaches it. Offer:
   - your tracker via an **in-session MCP server** (an authenticated MCP server
     exposes tracker tools the agent calls directly),
   - your tracker via an **external CLI** (a CLI bridges to the tracker when no
     in-session MCP server is available),
   - a different tracker (for example a generic issue tracker) via **MCP**,
   - a different tracker via **CLI or REST**,
   - **other / from scratch**.

   This choice picks the adapter's **transport** and its closest reference
   starting point in Step 3 (an MCP transport resembles the MCP reference
   adapter; a CLI or REST transport resembles the CLI/REST reference adapter;
   see `<flow-root>/adapters/SPEC.md` and the reference adapters under
   `<flow-root>/adapters/reference/`). Capture, into the config the adapter reads:
   - the tracker's short name → the `tracker` config field (and `<tracker>` in the
     adapter path),
   - the transport → `connection.transport`, one of `cli` (an account-pinned
     external CLI — the **safe default**, since the acting identity is fixed by the
     account handle) or `mcp` (an in-session MCP server),
   - the connection/account handle the adapter authenticates through →
     `secrets.trackerAccount`,
   - the **team** the engine reads and writes → `connection.team` (`key` + `id`);
     the adapter can discover the id from the key with a "list teams" read during
     Step 3,
   - the **workspace/org** slug → `connection.workspace.slug`.

   **If the operator picks the `mcp` transport, warn about the identity footgun:**
   an MCP server acts as whoever authenticated (OAuth'd) it, with no per-call
   account flag, so it must be authenticated as the **same identity** as
   `secrets.trackerAccount` or the engine silently writes as the OAuth identity.
   The `cli` transport has no such hazard (every call carries the account handle),
   which is why it is the default.
   _Headless default: keep the template's `tracker` value and its matching
   reference transport (`connection.transport: "cli"`), and leave
   `connection.team` / `connection.workspace` at their `null` placeholders for the
   operator to fill in a later `/flow:init`._

2. **Identity mode.** Whether the agent shares the human's tracker account or has
   its own (charter G10). Offer:
   - **Shared account**: the agent acts as the human's account. Set
     `identity.agent` to `"auto"` (resolved at runtime via the adapter's
     current-user read) and rely on the identity `marker` so the agent never
     answers its own comments.
   - **Two-account**: the agent has its own tracker account. Set `identity.agent`
     to the agent's account handle.

   In both modes, capture the human **reviewer** handle for the review-gate
   handoff (it lands in `config.local.json`, since a real handle is machine/account
   specific). _Headless default: shared account (`identity.agent: "auto"`),
   reviewer left unset (the review gate falls back to a comment that mentions the
   human)._

3. **Project routing.** What the engine claims and routes by default. This maps to
   `ownership.scope`. Offer:
   - **Issues only**: claim and run individual work items (`["issues"]`).
   - **Issues and projects**: also treat a project as a claimable/dispatchable
     unit (`["issues", "projects"]`).

   Project-scoped narrowing at runtime (for example `/flow auto <project>`) works
   regardless of this default via the adapter's project-resolution read; this
   choice only sets what the loop sweeps by default. _Headless default:
   `["issues", "projects"]` (the template default)._

4. **Adversarial review.** Whether a branch faces an independent machine review
   before its PR opens, and how hard. This maps to the `review` block. Offer:
   - **On** (recommended): VERIFY dispatches a separate reviewer agent that reads
     the diff against a rubric file and blocks the PR until the findings converge.
     It spends more tokens per item and buys materially higher output quality —
     the implementing agent is the worst reviewer of its own branch, because it
     reviews the change it remembers intending rather than the diff it produced.
     Sets `review.adversarial: true`.
   - **Off**: VERIFY opens the PR straight from the evidence bundle. Cheaper and
     faster; the first eye on the diff is the human's. Sets
     `review.adversarial: false`.

   When it is on, also capture **how many reviewers run** (`review.reviewers`,
   default `1`) — raise it only for changes with a wide blast radius, since every
   extra reviewer is another full read of the diff — and **which rubric file**
   they read (`review.rubric`, default `REVIEW.md`, resolved from the repo root).
   _Headless default: on, one reviewer, `REVIEW.md`._

   **Recommend one tracker setting while you are here:** most trackers close a
   work item when a branch carrying its identifier merges, on top of any closing
   keyword in the PR body. Since flow puts the identifier in every branch name,
   that setting closes items on partial PRs that deliberately used a non-closing
   reference. Tell the operator to disable branch-name-based auto-close in their
   tracker's git-integration settings, so the PR body stays the only closing
   signal. It is a one-time change flow cannot make for them, and without it
   VERIFY has to re-check the item's state after every partial merge.

5. **Model tiers.** Which models this machine's harness can actually reach, so
   every delegated worker is dispatched on purpose rather than by accident. Ask
   the operator to rank the models available to them and name two:
   - **Workhorse** — the strong general-purpose model. Implementation, review,
     and analysis work run here by default.
   - **Fast** — the cheap quick one. Mechanical work (searches, scaffolds,
     renames, log triage) runs here by default.

   Two, deliberately. The model the orchestrating session is itself running on is
   **not** a delegate tier: flow never names it, never binds it, and never routes
   a worker onto it, so setup does not ask for it.

   Write both answers to `models.bindings` in `config.local.json`. A model name is
   machine-specific, so it never goes in the committed file — that one carries
   only `models.tiers`, the class-to-tier policy, which names no model at all.
   Explain the split while you ask; it is the same split as the tracker
   coordinates. Two special cases, both fine:
   - **Only one model available** → bind both tiers to it. The policy becomes a
     no-op, which is a valid configuration and not a failure.
   - **The operator does not know** → leave the bindings out. Each unbound tier
     falls back to the harness's own default model, and every run that does so
     says it did.

   _Headless default: write no bindings, and record the assumption — delegates
   fall back to the harness default until someone runs `/flow:init` again._

Record each chosen value and each headless assumption; they feed Steps 3 and 4
and the final report.

### Step 3 - Generate and verify the adapter (the gate)

Hand off to the `building-adapters` skill and follow it to produce the concrete
adapter for the chosen tracker. In brief:

1. Read `<flow-root>/adapters/SPEC.md` (the contract) and pick the closest
   reference adapter for the transport chosen in Step 2 (or from-scratch for a
   tracker no reference fits).
2. Generate the adapter as a skill into
   `<flow-root>/skills/<tracker>-adapter/SKILL.md`, mapping the tracker onto the
   generic `WorkItem` model and all 16 required capability verbs, with the
   durability and graceful-degradation notes the SPEC requires, and a
   supported/not-supported line for each optional verb.
3. Build a representative fixture and run the conformance gate until it is green:

   ```bash
   node --experimental-strip-types "<flow-root>/scripts/validate-adapter.ts" --fixture <path-to-your-fixture.json>
   ```

   > Node < 22.6 lacks `--experimental-strip-types`; on those runtimes invoke any
   > `<flow-root>/scripts/*.ts` oracle with `tsx` instead (e.g.
   > `tsx "<flow-root>/scripts/validate-adapter.ts" --fixture <fixture.json>`).

   Exit code `0` with `{ "ok": true }` is the pass. A nonzero exit names the
   failed invariant (`INV-1 .. INV-5`); fix the **mapping** that produced it in the
   adapter and re-run. **Do not advance to Step 4 until the verdict is green**: an
   unverified adapter is the failure mode `building-adapters` exists to prevent.

If the chosen tracker already has a conforming adapter (the "regenerate" or
re-run path), re-validate it against the current contract version rather than
regenerating from scratch, and only regenerate if validation fails.

### Step 4 - Scaffold the config triad and the review rubric

Write the two config files, confirm the ignore, then scaffold the review rubric.
The triad and its precedence are documented in `<flow-root>/config/CONFIG.md`;
honor it.

1. **`config.json`** (committed, no secrets). Set the resolved behavioral policy
   from Step 2: `tracker` (the chosen tracker's short name), `connection.transport`
   (the transport choice — `cli` or `mcp`), `identity.agent` (`"auto"` for shared,
   the agent handle for two-account), `ownership.scope` (the project-routing
   choice), and the `review` block (`adversarial`, `reviewers`, `rubric` — the
   adversarial-review choice). **Leave `models.bindings` empty here** — the tier
   policy in `models.tiers` is shared and stays, but the models it binds to are
   per-machine and go in the local file, for the same reason no credential does.
   **Leave `connection.team` and
   `connection.workspace` at their `null`
   placeholders here** — a concrete team key/id or workspace slug is
   deployment-specific and goes in the gitignored local file, never the shared
   committed one (see CONFIG.md). Leave every other field at its template/schema
   default. **Never write a token, API key, or account handle into this file**:
   the schema is strict and credential-free by design. On a re-run, only rewrite
   this file after the Step 1 confirmation; never overwrite committed config
   silently.

2. **`config.local.json`** (gitignored, secrets + per-machine overrides). Create
   it from the template if it does not already exist:

   ```bash
   test -f <flow-root>/config/config.local.json || cp <flow-root>/config/config.local.example.json <flow-root>/config/config.local.json
   ```

   Fill in `secrets.trackerAccount` (the connection/account handle from Step 2)
   and, when the host does not already supply tracker auth, `secrets.trackerToken`.
   Put the resolved **team** coordinates from Step 2 under `connection.team`
   (`key` + `id`) and the **workspace** slug under `connection.workspace.slug` —
   these deep-merge over the committed file's `null` placeholders. Put the human
   reviewer handle under `identity.reviewer` here, and the two model answers from
   Step 2 under `models.bindings` (`workhorse` + `fast`) — a model name is
   per-machine and belongs here, never in the committed file. Delete any template
   block you do not need. If an existing `config.local.json` is present, merge the new values in
   rather than overwriting the operator's other overrides.

3. **Confirm the ignore.** Verify the repo `.gitignore` already ignores the local
   file (`grep -q 'config.local.json' .gitignore`). It does in this repo; if a
   future adopter's `.gitignore` lacks it, surface that loudly: a committed
   credential file is the one outcome setup must never allow.

4. **The review rubric** (only when `review.adversarial` resolves true). If no
   file exists at the repo-root-relative path in `review.rubric` (default
   `REVIEW.md`), copy the scaffold there:

   ```bash
   TARGET="$(git rev-parse --show-toplevel)/REVIEW.md"
   mkdir -p "$(dirname "$TARGET")"
   test -f "$TARGET" || cp <flow-root>/templates/review-rubric.md "$TARGET"
   ```

   The `mkdir -p` matters because `review.rubric` may be a nested path (for
   example `docs/code-review.md`) whose directory does not exist yet; `cp` into a
   missing directory fails, and a setup step that fails here would leave the
   adversarial gate pointed at nothing. Your harness may prompt for approval on
   the `git rev-parse` call even though the command only reads — approve it; there
   is no other tracker-neutral way to resolve the repo root.

   Substitute the configured `review.rubric` path for `REVIEW.md` if the operator
   chose a different one. **Never overwrite an existing rubric** — an adopter who
   already has one has already calibrated it. When you create the file, tell the
   operator to fill in its two **FILL IN** sections (the repo's hard rules and its
   always-check list): the scaffold reviews generically until those are written,
   which is the difference between a reviewer that knows the codebase and one
   guessing at severity. This file is committed, not gitignored — a rubric is
   shared policy, and it holds no secrets.

### Step 5 - Confirm the install

Prove the wiring end to end with a dry dispatch against an empty queue:

```bash
node --experimental-strip-types "<flow-root>/scripts/dispatch.ts"
```

A clean, no-work outcome (the dispatcher reaches the adapter, finds nothing
eligible, and returns a no-work result without error) confirms the adapter,
config, and credentials all resolve. A throw or an auth error here means a
connection or credential gap: point the operator at the specific file
(`config.local.json` for credentials, the generated adapter for transport) rather
than reporting success.

On a green dry dispatch, tell the operator `/flow` is ready: name the configured
tracker, the identity mode, the project-routing scope, the adversarial-review
posture (and the rubric path, flagging it if you just scaffolded one that still
needs filling in), the model bound to each delegate tier (or that a tier is
unbound and will fall back to the harness default), and the entry points
(`/flow` to orchestrate, `/flow:<stage>` for a single stage, `/flow auto` for the
autonomous drain). Surface any headless assumptions you applied so the operator
can change them with another `/flow:init`.

---

## Idempotency and safety

- **Re-runnable.** Running `/flow:init` again never clobbers committed config
  without the Step 1 confirmation; a headless re-run defaults to cancel.
- **The verify gate is non-negotiable.** Step 3 does not complete until
  `validate-adapter.ts` returns green. Setup that skips the gate ships an adapter
  that "looks right" but may not conform.
- **No secret ever lands in a committed file.** Credentials live only in
  `config.local.json` (gitignored) or a `FLOW_`-prefixed environment variable.
- **Honest failure.** If the toolchain is missing (Step 1), the adapter cannot be
  verified (Step 3), or the dry dispatch errors (Step 5), stop and say exactly
  what is wrong and which file to fix. Never report `/flow` as ready on an
  unverified or unreachable setup.

## References

- `<flow-root>/config/CONFIG.md` - the config triad, precedence, and the secrets/policy
  split.
- `<flow-root>/skills/building-adapters/SKILL.md` - the generate-and-verify
  procedure Step 3 invokes.
- `<flow-root>/adapters/SPEC.md` - the tracker-neutral adapter contract the
  generated adapter conforms to.
- `<flow-root>/config/config.json` / `<flow-root>/config/config.local.example.json` - the
  committed policy template and the local-secrets template Step 4 scaffolds from.
- `<flow-root>/templates/review-rubric.md` - the review-rubric scaffold Step 4
  copies to the repo root when `review.adversarial` is on.
