---
name: debugging-typescript-errors
description: Systematically investigates TypeScript compiler errors, traces the real type mismatch, and applies a minimal verified fix. Use when the user wants to debug TypeScript type errors.
---

# Debugging TypeScript Errors

## Overview

Use it when TypeScript errors need real diagnosis rather than cargo-cult assertions or broad type loosening.

## Read First

Before acting, read:

- `CLAUDE.md`
- the package's `tsconfig.json` (`plugins/flow/tsconfig.json` or `tools/schema-check/tsconfig.json`)

## This Repo's TypeScript

- Typecheck is `npm run typecheck` (`tsc --noEmit`), run from inside `plugins/flow` or `tools/schema-check`. There is no root typecheck.
- Flow's shipped `scripts/*.ts` run under `node --experimental-strip-types`, which **erases types without checking them** and rejects TypeScript-only syntax that needs a transform (`enum`, `namespace`, parameter properties). Code can run fine and still fail `tsc`, and a fix that uses those constructs will typecheck but break at runtime. Use `import type` for type-only imports.
- A missing-module error in a fresh worktree usually means `npm ci` has not run in that package, not a real type error.

## Core Workflow

1. **Collect the error**
   - use the provided error text when available
   - otherwise run the narrowest useful typecheck scope
2. **Parse the compiler signal**
   - error code
   - file and location
   - expected vs actual type
3. **Read the surrounding code**
   - never propose a fix before reading the file
4. **Trace the type source**
   - where the actual type comes from
   - where the expected type is defined
   - where inference or narrowing goes wrong
5. **Classify the problem**
   - wrong data
   - wrong type definition
   - missing narrowing
   - generic inference failure
   - invalid assertion
6. **Apply the smallest correct fix**
   - fix data before widening types
   - fix definitions before forcing assertions
   - use assertions only as a last resort
7. **Re-run typecheck**
   - confirm the original error is gone
   - check that no new related errors were introduced

## Cross-Agent Rules

- Keep a short execution plan, but do not depend on a tool-specific todo API.
- Ask bounded clarification only when the repair strategy changes system behavior or type contracts materially.
- Prefer preserving strictness over silencing the compiler.
