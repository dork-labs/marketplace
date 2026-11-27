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

A comment's `authorIsTrusted` (contract 3.0.0) comes only from the file's
`members` list, the fake's membership data: an author on it is a team member,
anyone else (a guest, an integration, no author) is not.

Since contract 3.3.0 a write's `optionalLabels` (on `createItem` and
`applyWorkState`) are added only when the team has the label, and skipped
otherwise. The fake team leaves out the bare `Bug`, `Improvement` and
`Feature` labels, so a test that wants them lists them in the file's `labels`.

Since contract 3.4.0 the file's `views` hold saved views by id, each with its
`kind` (`issues` or `projects`) and its `members` (issue identifiers or
project ids), and `positions` holds the manual order by key, shared by every
view as Linear's `sortOrder` is. `getViewOrder` reads a view lower position
first; `setPositions` writes `positions` and nothing else. The team's projects
are those in `projectInfo` and `projects`: a view drops any other project, and
a write refuses one.
