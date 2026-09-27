# Why flow works the way it does

Flow's skills and commands say what to do. This page keeps the stories of why: the
mistakes that taught each rule. Grouped by topic, one short paragraph each.

## Where each shared rule lives

A rule shared by many files is written in one file only. Every other file points at it.

| Rule                                                                        | Its one home                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------ |
| The stage table, routing, the guard, the pause rule, one tick, `/flow auto` | `commands/flow.md`                                     |
| Stopping one item at a stage boundary (`agent/paused`)                      | `commands/flow.md`, section "One tick"                 |
| Picking this project's flow schedules, and loading DorkOS's deferred tools  | `commands/status.md`, step 2                           |
| The tracker is reached only through the `flow` command or the adapter       | `skills/linear-adapter/SKILL.md` (the shipped adapter) |
| Provenance lines on tracker and pull request text                           | `docs/provenance.md`                                   |
| Showing an item to a person (`PROJ-157 - Title`)                            | `skills/linear-adapter/SKILL.md`                       |
| The comment-response rules (never answer your own comment, and the rest)    | `skills/tending-tracker/SKILL.md`                      |
| The stories behind the rules                                                | this page                                              |

## The `/flow auto` sentinel

A drain writes `.dork/flow/auto-run.json` so the Stop hook knows to keep the session
going. For a long time the hook recorded the owner's process id but never checked it
(DOR-1679). When a drain died without cleaning up, the file still said "active", and
every later session in that repo was pushed back into the drain, forever. Now the hook
checks the owner is alive, treats a file older than 24 hours as abandoned (a process id
can be reused by an unrelated program), and deletes an abandoned file. That is a safety
net, not a reason to skip cleanup: a drain still deletes its own file when it ends.

The file also records which session started the drain. Before that, every session in
the repo saw the drain's "keep going" message while a drain ran, and wasted a turn on
it. Now only the starting session is held; the rest stop quietly. A file with no session
id holds nobody, so the drain ends after one item rather than trapping a stranger.

## Settings that may belong to another project

Older flow kept its settings inside the plugin folder, which several projects can
share. Copying those settings into a project without asking could hand one project
another project's tracker and credentials, and then flow would claim that project's
work. So flow asks a person first, and a run with nobody to ask stops.

## The pause

`/flow:pause` used to switch off the shipped `flow-drain` schedule by editing its file.
Both halves of that failed: DorkOS ignores a schedule file's on/off switch once you
approve the schedule, and a plugin update replaces the file anyway (DOR-2285). The pause
is now a file in your project, `.agents/flow/paused.json`, which no update touches and
every tick checks first.

Pause switches off DorkOS schedules too, but only this project's. A review found that
matching folders as plain text let `/work/app` claim `/work/app-2`'s schedules, so one
project's pause could switch off another's (DOR-2300). The match now needs a `/` after
the project folder.

## The tracker adapter

Flow reaches Linear through Composio, and Composio's answers do not always match its
own schema. The facts in the adapter were checked by hand against `composio` v0.2.31 in
September 2026. The GraphQL tool rejects a `query` key with "Unknown key" before Linear
ever sees the call, because the key is `query_or_mutation`. The tool named
`LINEAR_GET_AUTHENTICATED_USER` does not exist (it is the MCP name with a prefix added);
the real one is `LINEAR_GET_CURRENT_USER` (2026-09-15). The single-issue read returns
its relations as `null`, so only a GraphQL read through the team can say an item is
unblocked.

The adapter once said an unfiltered issue list was "already team-correct" because the
account connects to one workspace. A workspace holds many teams. The reference one had
five, one of them an intake team whose issues are live conversations with real people
(2026-09-10). A groom that read that list could have closed them. Every read is now
scoped to the team, and every identifier is checked against the team's prefix.

The first groom of the DorkOS tracker (2026-08-03) lost a batch to each bulk-write trap:
a `$` in a description broke the whole mutation, a failed alias did not roll back its
siblings, and `paused` was refused as a project state. It also found six items stranded
in Linear's Duplicate state, which flow cannot represent, so nothing saw them. A
project description longer than 255 characters fails the whole create (2026-09-10).

A comment on an archived issue fails with "Entity not found", while reads and updates of
the same issue still work, so it looks like a bad id or a missing permission. It is
neither (2026-07-13, DOR-306).

Sub-issue promotion once compared a size to the threshold directly. On a numeric
estimate that compares `8` to `"xl"`, which has no answer (DOR-515). Sizes are now
compared by ordinal, on one scale for both kinds.
