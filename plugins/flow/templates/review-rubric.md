# Review instructions

Calibration for the adversarial review a change faces **before** its pull request
opens. `/flow` points every reviewer at this file (the `review.rubric` config
field), so what you write here is what a reviewer optimizes for.

This is a scaffold. The sections marked **FILL IN** are the ones that make the
review yours; a rubric that leaves them empty still works, it is just generic.

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

## Your repo's hard rules — **FILL IN**

The rules that are non-negotiable here, each with the paths it governs and, where
one exists, the document that states it. This section is what turns a generic
reviewer into one that knows your codebase. The shape to aim for:

- `<rule>` — `<paths it applies to>` (`<the doc that defines it>`)
- a layering or import-direction rule, and the barrel/entry point it requires
- a dependency confinement rule, and the boundary it may not cross
- the internal helper that must be used in place of some raw platform call

Leave this list empty and almost every finding degrades to a nit. That is the
tradeoff, and it is worth ten minutes to avoid.

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

## Always check — **FILL IN**

The few things that are cheap to check and repeatedly wrong here. Keep the list
short enough that a reviewer actually does all of it. Candidates to start from:

- Comments and documentation that still describe the pre-change behavior.
- New or changed behavior has a test — and the test would fail if the behavior
  regressed. A green suite proves the assertions held, not that they could fail.
- Removed or renamed things leave no surviving references, in prose and config as
  well as code.
- `<the convention this repo keeps getting wrong>`

## Summary shape

Open with a one-line tally (for example `2 blocking, 3 nits`), and lead with "No
blocking issues found" when that is true. The author wants the shape of the
review before the details.
