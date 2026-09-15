---
name: debugging-test-failures
description: Systematically investigates failing tests, distinguishes between test bugs and implementation bugs, and drives a fix with verification. Use when the user wants to debug failing tests.
---

# Debugging Test Failures

## Overview

Use it when tests are failing and the goal is to identify the real root cause instead of making blind changes.

## Read First

Before acting, read:

- `.claude/skills/test-driven-development/SKILL.md` when the failing test is tied to new feature work or a bugfix

## Where Tests Live

| Package              | Tests                              | Run one file (from the package dir)          | Full suite |
| -------------------- | ---------------------------------- | -------------------------------------------- | ---------- |
| `plugins/flow`       | `plugins/flow/engine-tests/`       | `npx vitest run engine-tests/<name>.test.ts` | `npm test` |
| `tools/schema-check` | `tools/schema-check/tests/`        | `npx vitest run tests/<name>.test.ts`        | `npm test` |

A red CI check named `flow plugin` may be the schema-drift step or the format check, not the tests. Read which step failed before debugging tests.

## Core Workflow

1. **Run the relevant test scope**
   - one file or one pattern when possible
   - whole-suite only when needed
   - if `node_modules` is missing (fresh worktree), run `npm ci` in the package first; a missing-module error is not a test failure
2. **Parse the failure output**
   - failing test names
   - expected vs actual behavior
   - error messages and stack traces
3. **Check load-sensitivity before diving in**
   - passes in isolation but fails in the full run
   - the assertion is about timing, throughput, or sample counts rather than
     behavior
   - the failure text names milliseconds, wall-clock boundaries, or "expected
     N samples"
   - the test depends on network: `tools/schema-check`'s `npm test` fetches
     the pinned upstream DorkOS schemas first, so an offline or rate-limited
     run fails before any assertion
   - a load-starved guard refusing to conclude is not a defect in your branch
     — re-run once before spending a cycle, and if it repeats, record it as a
     flake rather than bending the assertion
4. **Read the failing test first**
   - understand arrange / act / assert
   - explain what the test is trying to prove
5. **Read the implementation under test**
   - trace inputs, transformations, and outputs
6. **Decide where the bug lives**
   - implementation
   - test logic
   - mock/setup
   - broader shared root cause
7. **Apply a minimal fix**
   - fix the real problem, not just the symptom
8. **Re-run verification**
   - the failing test
   - nearby tests when relevant

## Decision Heuristics

- Prefer implementation fixes when the test encodes correct expected behavior.
- Prefer test fixes when the implementation is correct and the test is asserting the wrong thing.
- If multiple failures share one cause, fix the root cause before touching individual assertions.
- If the test never demonstrated a correct RED state, repair the test before trusting it.

## Cross-Agent Rules

- Keep a short execution plan, but do not depend on a tool-specific todo API.
- Ask bounded clarification only if multiple failure scopes or fix strategies are materially different.
- Always end with real verification, not reasoning alone.
