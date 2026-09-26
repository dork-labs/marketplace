---
description: Check this flow install, its prose and how its commands behave, and report what is broken
category: flow
allowed-tools: Bash(node:*), Read
argument-hint: '[--tier fast|scenarios] [--strict] [--json] [--file]'
---

# /flow:self-test

Run flow's own checks: $ARGUMENTS

```bash
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" selftest $ARGUMENTS
```

It runs two free, offline tiers: `fast` (adapter conformance, the config and its schema, the
engine tests when the contributor toolchain is installed, the doc lint) and `scenarios` (the
flow commands against a fake tracker). It writes the result to `.dork/flow/selftest/`.

Show the report as it prints. For each failure, say the one thing to do about it. A skipped
check did not pass: say why. Exit 1 means something failed; exit 2 means the arguments were
wrong. When something failed, offer to run it again with `--file`, which notes each failure on
the tracker once.
