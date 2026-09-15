# Review instructions

Calibration for the adversarial review a change faces **before** its pull request
opens. `/flow` points every reviewer at this file (the `review.rubric` config
field), so what you write here is what a reviewer optimizes for.

The hard rules and the always-check list below are this repo's own; keep them
current as the rules change.

## How to review (process)

Work the diff like a senior engineer, not a linter:

1. Read the full diff and the changed-file list. Read the enclosing function or
   module around each hunk — a bug in an unchanged line of a touched function is
   in scope.
2. Trace outward. For every symbol the diff changes, removes, or renames, search
   the repo for its callers and references. A change is only safe once you have
   checked who depends on it.
3. Verify before posting. Every finding needs a `file:line` you actually read,
   never an inference from a name. If a quick search settles it, run the search.
4. Rank, then cap. Order findings by severity and post the top ones within the
   nit cap below. Quality over volume.

You are reviewing the diff, not the author's account of it. A summary of what was
implemented is a claim to check, never an input to trust.

## Severity

**Blocking** is reserved for findings that would break behavior, lose data, leak
secrets, or violate a hard architectural rule of this repo:

- Logic bugs, broken edge cases, and regressions in the changed code.
- Untrusted input reaching a shell, a query, or a filesystem path.
- Secrets or personal data in logs, error messages, or committed files.
- A new entry point that skips the authorization its neighbors perform.
- Any violation of the hard rules below.

Architecture, naming, refactoring, and style preferences are nits at most.

## This repo's hard rules

- **The flow engine stays tracker-neutral.** No tracker name, API slug, tool
  string or tracker-specific field outside a `*-adapter` skill or
  `adapters/reference/` — `plugins/flow/scripts/**`, `commands/**`, every other
  `skills/**` (`plugins/flow/adapters/SPEC.md`, `engine-tests/tracker-confinement.test.ts`).
- **The shipped runtime needs only `zod`.** A new value import in
  `plugins/flow/scripts/**` from any other package breaks adopters who install
  with `--omit=dev` (`engine-tests/runtime-deps.test.ts`, `plugins/flow/package.json`).
- **No secret, account handle, team id or model name in committed config.**
  Those live in the gitignored `config/config.local.json`; `config.json` and the
  `*.example.json` templates hold policy only (`plugins/flow/config/CONFIG.md`).
- **The config schema is generated, never hand-edited.** A change to the Zod
  source must ship the regenerated `config/config.schema.json`
  (`npm run generate:schema`; CI fails on drift).
- **The registry stays consistent.** Every package listed in
  `.claude-plugin/marketplace.json` has a matching `.claude-plugin/dorkos.json`
  sidecar entry and its own `plugins/<name>/.claude-plugin/plugin.json`, and
  `source` paths resolve (`CLAUDE.md`, ADR-0236).
- **Public repo.** Nothing from private repos — prices, plan
  names, hostnames, private paths — in code, docs, commit messages or PR bodies.

## Cap the nits

Report at most **five** nits per review. If you found more, write "plus N similar
items" in the summary rather than posting them all inline. If everything you
found is a nit, open with "No blocking issues."

## Do not report

- **Anything CI already enforces** — formatters, linters, type checks, dead-code
  detection. Each has its own gate; repeating it here spends the author's
  attention on a machine's job.
- **Generated, vendored, and lock files.**
- **Pure formatting opinions.**

## Always check

- Skills and commands are prose the agent executes: a changed engine behavior
  must be reflected in every `SKILL.md`, command and `docs/*.mdx` that describes
  it. Stale prose here is a behavior bug, not a docs nit.
- New or changed behavior has an engine test — and the test would fail if the
  behavior regressed. A green suite proves the assertions held, not that they
  could fail.
- Claims about a tracker or CLI ("verified against …") name the version and date
  they were checked, and nothing un-verified is stated as fact.
- A package version bump in `plugin.json` matches `package.json` and the sidecar
  where both carry one.
- Removed or renamed things leave no surviving references, in prose and config as
  well as code.

## Summary shape

Open with a one-line tally (for example `2 blocking, 3 nits`), and lead with "No
blocking issues found" when that is true. The author wants the shape of the
review before the details.
