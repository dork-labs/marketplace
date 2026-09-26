---
name: fake-adapter
description: A test-only tracker adapter for the flow CLI tests. Its tracker is an in-memory backlog; it reaches no real tracker.
---

# Fake adapter (tests only)

This folder is a fixture. The flow CLI tests link it into a temp project at
`.agents/flow/adapters/fake/`, set `tracker` to `fake`, and let the real loader
find `adapter.ts` beside this file. It is not a tracker adapter anyone should
use; it has no prose verbs.
