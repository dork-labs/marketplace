---
name: fake-adapter
description: The fake tracker flow's self-test runs against. An in-memory tracker in a JSON file, behind the code adapter contract. It reaches no real tracker.
---

# The fake tracker

flow's self-test drives its stages against this tracker instead of a real one.
Its state is the JSON file `FLOW_FAKE_BACKLOG` names; every write is saved
there. It behaves like the Linear adapter where flow depends on it (see
`scripts/tracker/fake.ts`), and a shared contract test holds both to that.

To point a project at it: link this folder to `.agents/flow/adapters/fake/`
(link, not copy: its code imports from the plugin), set `tracker` to `fake` and
`connection.transport` to `cli`, and set `FLOW_FAKE_BACKLOG`. Every tracker
read and write then goes through the `flow` command; this adapter has no other
verbs.
