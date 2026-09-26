---
description: Check this flow install and its prose, and report what is broken
category: flow
allowed-tools: Bash(node:*), Read
argument-hint: '[--strict] [--json]'
---

# /flow:self-test

Run flow's own checks: $ARGUMENTS

```bash
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/selftest.ts" $ARGUMENTS
```

It runs the free, offline `fast` tier: the adapter conformance harness, the config and its
schema, the engine tests (only when the contributor toolchain is installed), and the doc lint.
It takes seconds and writes the result to `.dork/flow/selftest/`.

Show the report as it prints. For each failure, say the one thing to do about it. A skipped
check did not pass: say why it was skipped. Exit 1 means something failed; exit 2 means the
arguments were wrong.
