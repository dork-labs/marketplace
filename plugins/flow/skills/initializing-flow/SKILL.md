---
name: initializing-flow
description: First-run setup for the /flow engine in a new repo - detect or reconfigure an existing install, gather setup choices (tracker + connection, identity mode, project routing, adversarial review, model tiers) via the calibration ladder, generate and verify the concrete tracker adapter, scaffold the committed config.json plus the gitignored config.local.json and a review rubric, and confirm the install with a real adapter read plus a policy self-check. Use when running /flow:init, configuring flow for the first time, adopting a new tracker, or reconfiguring an existing flow install.
---

# Initializing Flow

`<flow-root>` is two folders above this file's `realpath`. `cf` means
`node --experimental-strip-types "<flow-root>/scripts/config-files.ts"`; `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

Setup makes `/flow` runnable in a repo: pick a tracker, generate and verify its adapter,
write the settings, confirm the install. It stays tracker-neutral: the only
tracker-aware thing it makes is the adapter, at `.agents/flow/adapters/<tracker>/SKILL.md`
in the project (committed; never in the plugin folder, which an update replaces).
`<flow-root>/skills/building-adapters/SKILL.md` owns how to generate one; the settings
and their precedence are in `<flow-root>/config/CONFIG.md`.

**Calibration.** A person present: ask each choice with `AskUserQuestion`, the safe
option marked. Headless: apply each default, record it as an assumption, carry on.
Setup is reversible by re-running `/flow:init`; the one exception is overwriting
committed config, which always needs a person.

## Step 1 — Detect

1. Run `cf migrate` exactly as the `/flow` guard does
   (`<flow-root>/commands/flow.md`), except that a decline continues here as a fresh
   install (flow records it, so nobody asks this project again).
2. Run `cf`. `"origin": "none"`, or a `committed` file that is not valid JSON → **fresh
   install**, seeded from `<flow-root>/config/config.example.json`.
3. A `committed` file that parses → **re-run**. Name the current `tracker` and
   `identity.agent`; ask: reconfigure, regenerate the adapter only (Step 3), or cancel.
   Headless: cancel, and say a valid config exists. `adapter.origin` `"none"`:
   recommend regenerating the adapter.
4. **Toolchain.** `node` on PATH and `<flow-root>/scripts/validate-adapter.ts` present,
   else stop. Then probe the oracles' one dependency:
   `echo '{"items":[],"config":{},"ownershipOf":{}}' | node --experimental-strip-types "<flow-root>/scripts/dispatch.ts"`.
   Any JSON passes. `ERR_MODULE_NOT_FOUND` naming `zod`: install with
   `npm install --omit=dev --prefix "<flow-root>"` (the flag makes it work under
   `NODE_ENV=production`), asking first when a person is present; re-check. Still
   failing: stop, naming the command and its error.

## Step 2 — Gather the choices

1. **Tracker and connection.** The transport picks the closest reference adapter
   (`<flow-root>/adapters/SPEC.md`, `<flow-root>/adapters/reference/`). Capture:
   `tracker` (a slug, `^[a-z][a-z0-9-]*$`; it names the adapter to generate, not a
   supported list); `connection.transport`, `cli` (safe default: the account is fixed
   per call) or `mcp`; `secrets.trackerAccount`; `connection.team` (`key` + `id`);
   `connection.workspace.slug`. **With `mcp`, warn:** the server writes as whoever
   authenticated it, so that must be the same identity as `secrets.trackerAccount`.
   Headless: the template's tracker, `cli`, team and workspace left `null`.
2. **Identity mode.** Shared (`identity.agent: "auto"`, resolved at runtime; the marker
   keeps the agent off its own comments) or two-account (the agent's own handle). Also
   the human reviewer handle. Headless: shared, no reviewer (the gate then mentions the
   human in a comment).
3. **Project routing:** `ownership.scope` `["issues"]` or `["issues", "projects"]`
   (headless default).
4. **Adversarial review.** On (recommended: `review.adversarial: true`; a separate
   reviewer blocks the PR until findings converge) or off (cheaper; the first eye is the
   human's). When on: `review.reviewers` (default 1; raise only for a wide blast radius)
   and `review.rubric` (default `REVIEW.md`). Headless: on, 1, `REVIEW.md`. Also tell the
   operator to turn off branch-name auto-close in the tracker's git integration, so the
   PR body is the only closing signal.
5. **Model tiers.** Ask for two models: **workhorse** (implementation, review, analysis)
   and **fast** (mechanical work). The orchestrating model is never a delegate tier, so
   do not ask for it. One model: bind both to it. Unknown: leave them unbound (each run
   falls back to the harness default and says so). Headless: no bindings.

## Step 3 — Generate and verify the adapter (the gate)

Follow `building-adapters`: read the SPEC, start from the closest reference, write the
adapter to `<committedDir>/adapters/<tracker>/SKILL.md` (`adapter.target` on a re-run),
mapping the `WorkItem` model and all 16 required verbs. Then loop:

```bash
node --experimental-strip-types "<flow-root>/scripts/validate-adapter.ts" --fixture <fixture.json>
```

Exit `0` with `{ "ok": true }` passes; otherwise fix the mapping behind the named
invariant (`INV-1 .. INV-5`). **Never go to Step 4 until it is green.** On Node before
22.6, run the scripts with `tsx`. An existing adapter: re-validate first, regenerate
only if it fails. A tracker flow ships an adapter for (`adapter.origin: "shipped"`)
needs none generated unless overriding it on purpose: validate it and move on.

## Step 4 — Write the settings and the rubric

0. `cf prepare` prints `{ ok, committed, local, ignoreFiles }`; write to exactly those
   paths. `"ok": false`: **stop**, show `reason`; git would commit the credentials file.
1. **`config.json`** (committed): from `config.example.json`, keeping `$schema`; set
   `tracker`, `connection.transport`, `identity.agent`, `ownership.scope` and the `review`
   block. Leave `models.bindings` empty and `connection.team` / `connection.workspace`
   `null`. **Never a token, key or account handle here.** On a re-run, rewrite only after
   Step 1's confirmation.
2. **`config.local.json`** (ignored): create it only if absent,
   `test -f "$LOCAL" || (umask 077 && cp <flow-root>/config/config.local.example.json "$LOCAL")`.
   Fill `secrets.trackerAccount` (and `secrets.trackerToken` if the host gives no auth),
   `connection.team`, `connection.workspace.slug`, `identity.reviewer`, and
   `models.bindings`. Merge into an existing file; never overwrite it.
3. Tell the operator to commit `.agents/flow/config.json` and `.agents/flow/.gitignore`,
   never `config.local.json`.
4. **Rubric**, only when `review.adversarial` is true. Resolve `review.rubric`: absolute →
   as is; relative → the repo root, or the current folder outside a repo. Then:

   ```bash
   RUBRIC="REVIEW.md"   # set to the configured review.rubric
   ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
   case "$RUBRIC" in /*) TARGET="$RUBRIC" ;; *) TARGET="$ROOT/$RUBRIC" ;; esac
   mkdir -p "$(dirname "$TARGET")"
   test -f "$TARGET" || cp <flow-root>/templates/review-rubric.md "$TARGET"
   echo "rubric: $TARGET"
   ```

   **Never overwrite an existing rubric.** Print the resolved path; for a new one, ask the
   operator to fill its two **FILL IN** sections. The rubric is committed.

## Step 4b — Accounts

`flow accounts setup --json` proposes; ask which are work or client accounts (never
assume); apply with `--yes`. Headless: skip.

## Step 5 — Confirm

Two checks answering different questions; report each by name.

- **5a Connectivity**, the only tracker call: through the adapter, `getCurrentUser()`
  (show the account flow will act as) and the team and workspace lookup. Any error or
  empty team: name the file to fix (`config.local.json` for credentials and coordinates,
  the adapter at `adapter.path` for transport) and **stop**; `/flow` is not ready.
- **5b Policy self-check**: pipe `getEligibleWork()`'s candidates into
  `<flow-root>/scripts/dispatch.ts`. Label it "policy oracle only — no tracker call"; an
  empty queue says "the oracle ran on zero candidates". **5b alone is never a green light.**

Only after 5a passes, report ready: the tracker, the account 5a resolved, the identity
mode, the routing scope, the review posture and rubric path, each tier's model (or
unbound), the entry points, a reminder to commit a generated adapter, and every headless
assumption.

**Honest failure.** A missing toolchain, a red adapter gate or a failed read stops setup
with what is wrong and which file to fix. Credentials live only in `config.local.json`
or a `FLOW_`-prefixed environment variable.
