# Security gate

Status: **not enforced.** The check runs on every pull request and merge-queue
run, but nothing requires it until the steps below are done.

Packages in this repo install into every user's DorkOS: hooks, commands,
skills, extensions and scripts agents run. A change to any of them needs
DorkOS Security's approval for that exact commit. The gate is ported from
dork-labs/dorkos (`.github/workflows/security-gate.yml` there), with
Security's path list for this repo.

## What counts as a security path

`SECURITY_PATH_PATTERN` in `workflows/security-gate.yml` is the only list. In
short: everything inside `plugins/<name>/` (including docs and templates, which
agents read at run time, and any folder merely named `docs`, `tests` or
`fixtures`), except a plugin's root `tests/` and `engine-tests/`, a skill's own
`tests/`, and a plugin's root README.md, CHANGELOG.md, LICENSE and NOTICE.
Also: the catalog files; every `SKILL.md`; `.github`, `.claude`, `.agents`,
`.dork`, `scripts`, `tools`; the root `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`
and `.mcp.json`; and `package.json`, lockfiles and npm config anywhere. A path
with a `.`, `..` or empty segment always counts. Both sides of a rename count.

A plugin whose manifests mention a test folder loses its test-folder
exemptions: if any string in its `.claude-plugin/plugin.json`,
`hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `.dork/manifest.json`, or any
JSON file those name, contains `tests` or `engine-tests` as a path segment, all
of that plugin's test folders count (`scripts/security-manifest-paths.mjs`,
run by the verifier from the base commit; it fails the check if a manifest
doesn't parse). A mention that climbs out with `..` counts for every plugin.

**Accepted residual risk.** Test folders are exempt because they change too
often to gate, but two of them can run on a machine: `/flow:self-test` runs
flow's `engine-tests/` through vitest when dev dependencies are installed (and
reads its fixtures), and visual-companion's `npm test` runs its skill's
`tests/`. A test folder a manifest mentions is covered (above). One reached
another way (a `package.json` script, `hooks:` in a skill's or command's
frontmatter, a `!` line in a command) needs that file changed first, and it is
a security path, so the pointer itself gets reviewed.

**Known mismatch.** The initializer reads only the workflow's list, not the
manifest rule, so for a PR that edits only a manifest-mentioned test file it
posts "no security paths" while the verifier refuses the PR. That fails
closed: an automatic success never counts for a security-path diff. Security
will still need to look at the PR.

## How approval works

- `security-review-initialize.yml` (`pull_request_target`, runs code from the
  base commit only) sets the `security-review` status on each PR head:
  `success` with "no security paths", or `pending`.
- Security approves by setting `security-review` to `success` on the exact head
  **through the Security GitHub App**. A new push needs a new approval.
- `security-gate.yml` (read-only, base-commit code) passes only when that
  status came from the App, whose bot user id is
  `SECURITY_APPROVAL_BOT_USER_ID`. The `security-reviewed` label is a human
  signal only: every agent here acts through one GitHub account, so anyone
  could add it.
- In the merge queue, every queued PR that touches a security path needs that
  approval on its exact head, and its queued diff is compared on its own.

## Turning it on (Dorian)

1. Install the Security App on this repo (the one dorkos uses, or a new one),
   and put its numeric bot user id in `SECURITY_APPROVAL_BOT_USER_ID`. While it
   is `'0'`, no security-path PR can pass. **Blocked today:** dorkos's approval
   helper (`tools/security-approve/` there) is hard-wired to dork-labs/dorkos
   and its path list, so nothing can post a marketplace approval yet. It needs a
   reviewed change to take the repository and pattern, or a tool of its own.
2. Add an organization ruleset rule **Require workflows to pass before
   merging** for this repo's `main`: source `dork-labs/marketplace`, path
   `.github/workflows/security-gate.yml`, ref `refs/heads/main`. Not a named
   status check: a PR could edit its own YAML to emit a passing job with that
   name. Start in Evaluate mode, then Active.
3. Remove any bypass from the `main` ruleset.

## Bootstrap

The PR that adds the gate fails its own `security-gate` run: its base commit
has no gate script yet, so the verifier fails closed. That is expected. Its
fixtures run on the PR head in `script fixtures`. Don't add a head-source
fallback to clear it.
