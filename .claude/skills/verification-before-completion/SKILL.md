---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Marketplace Verification Commands

This repo has no root `package.json`. Run code gates inside the package that has them (`plugins/flow`, `tools/schema-check`).

| Claim                     | Command (working directory)                                                                  | What to check                    |
| ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------- |
| Flow tests pass           | `npm test` (`plugins/flow`)                                                                  | 0 failures, exit 0               |
| Single test file          | `npx vitest run engine-tests/<file>.test.ts` (`plugins/flow`)                                | 0 failures, exit 0               |
| Types check               | `npm run typecheck` (`plugins/flow`)                                                         | 0 errors                         |
| Formatting clean          | `npm run format:check` (`plugins/flow`)                                                      | "All matched files use Prettier" |
| Config schema in sync     | `npm run generate:schema && git diff --exit-code -- config/config.schema.json` (`plugins/flow`) | empty diff, exit 0            |
| Skills and manifests      | `npm run check` (`tools/schema-check`)                                                       | exit 0                           |
| Marketplace manifest      | `claude plugin validate .` (repo root)                                                       | no errors                        |
| One package's manifest    | `claude plugin validate ./plugins/<name>` (repo root)                                        | no errors                        |

There is no lint step and no build step. CI (`.github/workflows/flow-tests.yml`, `schema-check.yml`) runs exactly these, so a local pass is the same evidence the required `flow plugin` check will ask for.

## Common Failures

| Claim                 | Requires                        | Not Sufficient                 |
| --------------------- | ------------------------------- | ------------------------------ |
| Tests pass            | Test command output: 0 failures | Previous run, "should pass"    |
| Types check           | Typecheck output: 0 errors      | Tests passing, extrapolation   |
| Manifest valid        | `claude plugin validate`: clean | JSON parses, looks right       |
| Bug fixed             | Test original symptom: passes   | Code changed, assumed fixed    |
| Regression test works | Red-green cycle verified        | Test passes once               |
| Agent completed       | VCS diff shows changes          | Agent reports "success"        |
| Requirements met      | Line-by-line checklist          | Tests passing                  |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse                                  | Reality                    |
| --------------------------------------- | -------------------------- |
| "Should work now"                       | RUN the verification       |
| "I'm confident"                         | Confidence is not evidence |
| "Just this once"                        | No exceptions              |
| "Tests passed"                          | Tests are not the compiler |
| "Agent said success"                    | Verify independently       |
| "I'm tired"                             | Exhaustion is not excuse   |
| "Partial check is enough"               | Partial proves nothing     |
| "Different words so rule doesn't apply" | Spirit over letter         |

## Key Patterns

**Tests:**

```
cd plugins/flow && npm test
cd plugins/flow && npx vitest run engine-tests/dispatch.test.ts

Result: "Tests  34 passed (34)" "Test Files  1 passed (1)"
Only THEN: "All tests pass"
```

**Regression tests (TDD Red-Green):**

```
Write test -> Run (pass) -> Revert fix -> Run (MUST FAIL) -> Restore -> Run (pass)
Not: "I've written a regression test" (without red-green verification)
```

**Manifests:**

```
claude plugin validate .
claude plugin validate ./plugins/<name>
cd tools/schema-check && npm run check
Result: no errors from any of the three
Only THEN: "Manifests are valid"
Not: "The JSON parses" (a parse is not the schema, and DorkOS silently drops bad schedule blocks)
```

**Types:**

```
cd plugins/flow && npm run typecheck
Result: 0 errors
Only THEN: "Types check"
Not: "Tests passed" (Vitest strips types and does not check them)
```

**Requirements:**

```
Re-read plan -> Create checklist -> Verify each -> Report gaps or completion
Not: "Tests pass, phase complete"
```

**Agent delegation:**

```
Agent reports success -> Check VCS diff -> Verify changes -> Report actual state
Not: Trust agent report
```

## Why This Matters

From 24 failure memories:

- the user said "I don't believe you" - trust broken
- Undefined functions shipped - would crash
- Missing requirements shipped - incomplete features
- Time wasted on false completion, then redirect, then rework
- Violates: "Honesty is a core value. If you lie, you'll be replaced."

## When To Apply

**ALWAYS before:**

- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**

- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. THEN claim the result.

This is non-negotiable.
