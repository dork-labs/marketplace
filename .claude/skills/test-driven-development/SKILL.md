---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code
---

# Test-Driven Development (TDD)

## Overview

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**Violating the letter of the rules is violating the spirit of the rules.**

## When to Use

**Always:** new features, bug fixes, refactoring, behavior changes.

**Exceptions (ask the user):** throwaway prototypes, generated code, configuration files.

Thinking "skip TDD just this once"? Stop. That's rationalization.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over. Don't keep it as "reference", don't "adapt" it while writing tests — delete means delete. Implement fresh from tests.

## Red-Green-Refactor

### RED — Write Failing Test

One minimal test showing what should happen: one behavior, a name that describes it, real code under test (mocks only if unavoidable — a test that only exercises `vi.fn()` chains tests the mock, not the code).

### Verify RED — Watch It Fail

**MANDATORY. Never skip.**

```bash
cd plugins/flow && npx vitest run engine-tests/<name>.test.ts
```

Confirm:

- Test **fails** (not errors)
- Failure message is the one you expected
- It fails because the feature is missing (not a typo or bad import)

**Test passes?** You're testing existing behavior — fix the test.
**Test errors?** Fix the error and re-run until it fails correctly.

### GREEN — Minimal Code

Write the simplest code that passes the test. No extra options, no speculative parameters, no refactoring other code, no "improvements" beyond what the test demands (YAGNI).

### Verify GREEN — Watch It Pass

**MANDATORY.**

```bash
cd plugins/flow && npx vitest run engine-tests/<name>.test.ts
```

Confirm: the test passes, other tests still pass, output is pristine (no errors or warnings).

**Test fails?** Fix the code, not the test. **Other tests fail?** Fix now.

### REFACTOR — Clean Up

After green only: remove duplication, improve names, extract helpers. Keep tests green. Don't add behavior. Then repeat with the next failing test.

## Why Test-First (Not Test-After)

Tests written after code pass immediately — and passing immediately proves nothing: they're biased by your implementation, test what you built rather than what's required, and you never saw them catch anything. Test-first forces you to see the failure, which is the proof the test works. Manual testing doesn't substitute: no record, can't re-run, edge cases forgotten under pressure.

## Common Rationalizations

| Excuse                                 | Reality                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| "Too simple to test"                   | Simple code breaks. Test takes 30 seconds.                    |
| "I'll test after"                      | Tests passing immediately prove nothing.                      |
| "Already manually tested"              | Ad-hoc does not equal systematic. No record, can't re-run.    |
| "Deleting X hours is wasteful"         | Sunk cost fallacy. Keeping unverified code is technical debt. |
| "Keep as reference, write tests first" | You'll adapt it. That's testing after. Delete means delete.   |
| "Need to explore first"                | Fine. Throw away exploration, start with TDD.                 |
| "Test hard = design unclear"           | Listen to the test. Hard to test = hard to use.               |
| "TDD will slow me down"                | TDD is faster than debugging. Pragmatic = test-first.         |
| "Existing code has no tests"           | You're improving it. Add tests for existing code.             |

**Red flags — stop and start over:** code before test, test passes immediately, can't explain why the test failed, "just this once", "it's about spirit not ritual", "this is different because...".

## Marketplace-Specific Patterns

Two packages in this repo have tests. Each is its own npm project; run commands from inside it.

- **`plugins/flow`**: tests live in `plugins/flow/engine-tests/` (not alongside source), named `<area>.test.ts`, against the real `scripts/*.ts` modules. Prefer driving the real script or module over mocking it; the engine tests exist to pin what the shipped runtime actually does.
- **`tools/schema-check`**: tests live in `tools/schema-check/tests/`. `npm test` first fetches the pinned upstream DorkOS schemas, so it needs network.
- **Markdown packages** (skills, commands, agents) have no unit tests. Their "failing test" is the gate that would catch the defect: `tools/schema-check` (`npm run check`) for `SKILL.md` frontmatter and manifests, `claude plugin validate` for plugin structure. When fixing a frontmatter bug the gate missed, add the fixture to `tools/schema-check/tests/` first.
- **Config schema**: a change to the flow Zod config schema is not done until `npm run generate:schema` has been run and the regenerated `config/config.schema.json` is committed.

### Commands

```bash
cd plugins/flow && npx vitest run engine-tests/<name>.test.ts   # one file — the TDD inner loop
cd plugins/flow && npm test                                      # full flow suite
cd tools/schema-check && npm test                                # schema-check's own tests
```

## Verification Checklist

Before marking work complete:

- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for the expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass, output pristine
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

Can't check all boxes? You skipped TDD. Start over.

## When Stuck

| Problem                | Solution                                                   |
| ---------------------- | ---------------------------------------------------------- |
| Don't know how to test | Write wished-for API. Write assertion first. Ask the user. |
| Test too complicated   | Design too complicated. Simplify interface.                |
| Must mock everything   | Code too coupled. Use dependency injection.                |
| Test setup huge        | Extract helpers. Still complex? Simplify design.           |

## Debugging Integration

Bug found? Write a failing test reproducing it, then follow the TDD cycle. The test proves the fix and prevents regression. Never fix bugs without a test.

## Testing Anti-Patterns

When adding mocks or test utilities, read @testing-anti-patterns.md to avoid common pitfalls: testing mock behavior instead of real behavior, adding test-only methods to production classes, mocking without understanding dependencies.

## Final Rule

```
Production code -> test exists and failed first
Otherwise -> not TDD
```

No exceptions without the user's permission.
