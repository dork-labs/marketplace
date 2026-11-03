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
`security-review-initialize.yml` is too. `security-verdict.mjs` differs in one
function, `runVerdict`, which fails closed when its lists won't load. `security-gate.test.mjs` swaps
dorkos's path-list tests for this repo's, and `security-marketplace.test.mjs` is
this repo's own. Take later changes from dorkos rather than forking them here.

## What counts as a security path

`SECURITY_PATH_PATTERN` in `workflows/security-gate.yml` is the only list. In
short: **everything under `plugins/`, with no exemptions**: code, test folders, docs,
a plugin's README, CHANGELOG, LICENSE and NOTICE, and a file or symlink directly under
`plugins/`. A plugin PR that changes only a doc needs the label too.
Also: the catalog files; `.github`, `.agents`, `.dork`, `scripts`, `tools`; the root
`REVIEW.md` and `.mcp.json`; and `package.json`, lockfiles and npm config anywhere.
Agent config counts at any depth, inside `specs/` too: `.claude`, `.codex` and
`.opencode` (as a folder, or a symlink with that name), `opencode.json`, `CLAUDE.md`,
`AGENTS.md` and `GEMINI.md`. Only the whole name matches, so `MY-AGENTS.md` and
`.claude-plugin/` under `specs/` don't. A path with a `.`, `..` or empty segment always
counts. Both sides of a rename count.

**Don't bring back the test-folder exemption or the scan that guarded it.** This list
used to exempt test folders and root docs, and `security-manifest-paths.mjs` read each
plugin's files to take the exemption away from any test folder something pointed at.
Security's review of DOR-3713 (2026-11-03) replaced both, for three reasons:

- **It saved no labels.** `skills and manifests` makes every change to a package that
  already declares a version raise it in `plugin.json`, which is a security path, so a
  plugin PR needed the label anyway. All seven packages here declare one, and none of the
  last 60 commits touching `plugins/` changed exempt paths alone. A brand-new package skips
  the bump, so one that adds only exempt files is the case that now costs a label.
- **It needed new spellings at every review.** Each adversarial pass found another way to
  reach a test folder or a root doc: symlinks, `${ROOT%/*}`, `dirname`, `"commands": "./"`,
  `;plugins/w`, a nested `node_modules`, a name that starts like another plugin's. The list
  of what it couldn't see kept growing.
- **It could wedge the gate.** It parsed any JSON a manifest named, from the base commit.
  A merged manifest that names a commented `tsconfig.json` would make it refuse every later
  PR, including the one that fixes it. That never happened on main, but nothing stopped it.

`/flow:self-test` also runs flow's `engine-tests/` through vitest when dev dependencies are
installed, so those were never only tests.

**What backs this up.** The `skills and manifests` check refuses a hook or MCP server
beyond the package's own scripts, any local `source` other than `./plugins/<name>`, and
every symlink under `plugins/`. It's what keeps a package inside its own folder, and this
list no longer reads manifests, so have Security read any loosening of it.

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
whatever that status says. Only Security adds it.

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

1. Confirm the organization can use the ruleset rule **Require workflows to pass
   before merging**, and stop here if it can't. Add it for this repo's `main`, on
   both `pull_request` and `merge_group`: source `dork-labs/marketplace`, path
   `.github/workflows/security-gate.yml`, ref `refs/heads/main`. Not a named
   status check: a PR could edit its own YAML to emit a passing job with that
   name. Start in Evaluate mode.
2. Remove any bypass from the `main` ruleset.
3. Prove it on GitHub (Security), in Evaluate mode:
   - one real security-path PR passes and one refuses, which shows the read-only
     token can read the timeline and the activity feed;
   - a throwaway PR whose YAML and script both `exit 0` still fails;
   - a real merge group with more than one entry is judged entry by entry.

   Dorkos's promotion doc also lists binding approvals to the original queued
   source SHA as unproven, and treats that as blocking. Carry that over.
4. Switch the rule to Active.
5. **Later, for App mode:** install the Security App on this repo and put its
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
