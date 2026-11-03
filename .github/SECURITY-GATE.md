# Security gate

Status: **not enforced.** The checks run on every pull request and merge-queue
run, but no ruleset requires them until the steps below are done. The arming rule
(`scripts/should-arm-automerge.sh`) reads a failed `security-review` as a failing
check, but nothing enforces that yet: `gh pr merge --auto` consults nothing, and
flow's arm guard ignores a red check that isn't required.

Packages in this repo install into every user's DorkOS: hooks, commands,
skills, extensions and scripts agents run. A change to any of them needs
DorkOS Security's approval for that exact commit. The gate is ported from
dork-labs/dorkos at `dc0d70b316`, with Security's path list for this repo.
`security-gate.mjs` and `security-label-at-head.mjs` are verbatim, and
`security-review-initialize.yml` is too. `security-verdict.mjs` differs in two
places: one function adds the manifest rule below, and `runVerdict` fails closed when
that rule can't load this repo's lists. `security-gate.test.mjs` swaps
dorkos's path-list tests for this repo's, and `security-marketplace.test.mjs` is
this repo's own. Take later changes from dorkos rather than forking them here.

## What counts as a security path

`SECURITY_PATH_PATTERN` in `workflows/security-gate.yml` is the only list. In
short: everything inside `plugins/<name>/` (including docs and templates, which
agents read at run time, and any folder merely named `docs`, `tests` or
`fixtures`), except a plugin's root `tests/`, a skill's own `tests/`, and a plugin's root README.md, CHANGELOG.md, LICENSE and NOTICE.
Also: the catalog files; every `SKILL.md`; `.github`, `.agents`,
`.dork`, `scripts`, `tools`; the root `REVIEW.md` and `.mcp.json`; and
`package.json`, lockfiles and npm config anywhere. Agent config counts at any
depth, inside `specs/` and past the test-folder exemptions too: `.claude`,
`.codex` and `.opencode` (as a folder, or a symlink with that name), `opencode.json`,
`CLAUDE.md`, `AGENTS.md` and `GEMINI.md`. Only the whole name matches, so
`MY-AGENTS.md` and `.claude-plugin/` under `specs/` don't. A path with a `.`, `..`
or empty segment always counts. Both sides of a rename count.

A plugin that names a test folder anywhere in what it ships loses its test-folder
exemptions: if any string in its `.claude-plugin/plugin.json`,
`hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `.dork/manifest.json`, its entry in
`.claude-plugin/marketplace.json`, or any JSON file those name, or any other file in
the plugin read as plain text, contains `tests` or `engine-tests` as a whole word,
all of that plugin's test folders count (`.github/scripts/security-manifest-paths.mjs`,
run by the verifier and by main's verdict; it fails the check if a manifest doesn't
parse or a file can't be read). The scan skips a test folder's own files, `node_modules`
and the plugin's root README, CHANGELOG, LICENSE and NOTICE. A word in prose counts,
so today **flow and visual-companion, the only plugins with test folders, have no
exemption left**, and an edit to their tests needs the label. A plugin that mentions
one and also leaves its own folder, with `..` or a path through `plugins/`, counts for
every plugin: anywhere in those strings, or on the same line in any other file. So does
any catalog entry whose `source` isn't a plugin folder here, mention or not.

**Why `engine-tests/` isn't exempt.** `/flow:self-test` runs it through vitest when
dev dependencies are installed, and a self-test scenario reads its fixtures, so an
edit there is code that runs on a machine (Security, 2026-11-03).

**Accepted residual risk.** A test folder nothing in its plugin names stays exempt,
and it runs only if something starts naming it, in a file that is a security path, so
the pointer itself gets reviewed. These still aren't seen: a name built at run time
(`te*/x.sh`), though the file's reviewer sees it; a flag glued to the name
(`-rtests/x.js`); a climb split across two lines of a non-JSON file, which counts for
its own plugin only; and a symlink, which the scan doesn't follow. A pointer queued
together with a test edit is judged from the same base list, so the edit stays exempt
for that one merge.

**What backs this rule up.** The `skills and manifests` check refuses a hook or MCP
server beyond the package's own scripts and any local `source` other than
`./plugins/<name>`, which stops most of those spellings before they land. Loosening
that check reopens them, so have Security read any such change.

## How approval works

**While `SECURITY_APPROVAL_BOT_USER_ID` is `'0'` the gate runs label-at-head**
(Security and the PM, 2026-10-30). No App exists for this repo yet. Security
approves a head by adding `security-reviewed`. It counts only if a person added
it after the last push; a new push voids it, and so does a `hold` label. Any
other id switches to App mode, where only a `security-review` status from that
bot passes. Garbage refuses. The job summary names the mode.

Two checks read that, and they are not the same:

- **`security-review`, a commit status, is the verdict.**
  `security-review-initialize.yml` (`pull_request_target`, checks out
  `refs/heads/main`, runs no PR code) writes it from main's lists on every push
  and label change: `success` for no security paths or a label that covers the
  head, `failure` otherwise, naming why. It also posts one on each merge group.
  A PR into any branch but main isn't judged: the workflow doesn't run, so it gets
  no new status. One retargeted from main keeps its old one.
- **`security-gate`, a workflow check, is what the queue enforces.** Its scripts
  come from the base commit and it never writes. Its YAML, with the lists and the
  mode, comes from the merge commit until the ruleset below pins it to main. On an
  open PR with nothing wrong except a
  label not yet added it **waits**: the check is green and the log says "Waiting
  for Security". A stale label, a bot's label, `hold` or a refusal from main's
  verdict still fail it. In the merge queue it never waits, and every queued PR
  needs its label at its exact head.

So a green `security-gate` on an open PR doesn't mean reviewed. Read
`security-review`.

**`security-deep-reviewed`** is the second label dorkos's code asks for, added
the same way. A PR that adds, changes, renames or removes any workflow file, or
edits the gate's own files, needs it: a workflow with `statuses: write` can post
`security-review` itself, and in the queue the workflow file comes from the merge
commit. `SECURITY_DEEP_PATH_PATTERN` is this repo's P0 list (Security, 2026-11-03):
`.github/workflows/`, `.github/scripts/security-*` and `scripts/security-*`. So both
checks ask for the label: `security-review` won't say `success` without it, and
`security-gate` waits for it on an open PR and refuses without it in the queue,
whatever that status says. **The label doesn't exist in this repo yet**, so those
PRs can't pass until Security creates it.

**Known gaps:**

- Anyone with push can forge `security-review` from a workflow with
  `statuses: write`, and every agent here acts through one GitHub account, so a
  person-only label says who clicked, not who reviewed. Only the Security App
  closes this. **Never make `security-review` a required check while its source
  is GitHub Actions.** The check to require, after the live proof below, is
  `security-gate`.
- The P0 list is only as firm as the YAML it lives in. Until the ruleset below pins
  the workflow to main, a PR can edit its own copy of the list and so drop out of
  the deep label in the queue, as with every other list here.
- `security-gate` can read `security-review` just before main's verdict writes
  it, and fail a PR Security has just labelled, until someone reruns it. dorkos
  tracks this as DOR-3710, and the fix isn't in this copy yet.

## Turning it on (Dorian)

This makes `security-gate` required, not `security-review`: anyone with write access
can forge that status.

1. Create `security-deep-reviewed` in this repo (Security). Only Security adds it.
2. Confirm the organization can use the ruleset rule **Require workflows to pass
   before merging**, and stop here if it can't. Add it for this repo's `main`, on
   both `pull_request` and `merge_group`: source `dork-labs/marketplace`, path
   `.github/workflows/security-gate.yml`, ref `refs/heads/main`. Not a named
   status check: a PR could edit its own YAML to emit a passing job with that
   name. Start in Evaluate mode.
3. Remove any bypass from the `main` ruleset.
4. Prove it on GitHub (Security), in Evaluate mode:
   - one real security-path PR passes and one refuses, which shows the read-only
     token can read the timeline and the activity feed;
   - a throwaway PR whose YAML and script both `exit 0` still fails;
   - a real merge group with more than one entry is judged entry by entry.

   Dorkos's promotion doc also lists binding approvals to the original queued
   source SHA as unproven, and treats that as blocking. Carry that over.
5. Switch the rule to Active.
6. **Later, for App mode:** install the Security App on this repo and put its
   numeric bot user id in `SECURITY_APPROVAL_BOT_USER_ID`. dorkos's approval
   helper (`tools/security-approve/` there) is hard-wired to dork-labs/dorkos and
   its path list, so it needs a reviewed change first, or a tool of its own.

## Bootstrap

The PR that adds the gate fails its own `security-gate` run, and a label can't
clear it: its base commit has no gate script yet, so the verifier fails closed.
`security-review-initialize.yml` doesn't run on it either, because
`pull_request_target` reads the workflow from the base, so it gets no
`security-review` status. That is expected. Its fixtures run on the PR head in
`script fixtures`. Don't add a head-source fallback to clear it.
