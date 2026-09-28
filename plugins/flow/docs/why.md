# Why flow works the way it does

Flow's skills and commands say what to do. This page keeps the stories of why: the
mistakes that taught each rule. Grouped by topic, one short paragraph each.

## Where each shared rule lives

A rule shared by many files is written in one file only. Every other file points at it.

| Rule                                                                          | Its one home                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| The stage table, routing, the guard, the pause rule                           | `commands/flow.md`                                     |
| One tick, `/flow auto`, stopping an item at a stage boundary (`agent/paused`) | `skills/flow-drain/SKILL.md`                           |
| The pause check every autonomous entry point runs                             | `skills/flow-drain/SKILL.md`, step 0                   |
| Picking this project's flow schedules, and loading DorkOS's deferred tools    | `commands/status.md`, step 2                           |
| The tracker is reached only through the `flow` command or the adapter         | `skills/linear-adapter/SKILL.md` (the shipped adapter) |
| Finding `<flow-root>` from a skill's real path                                | `skills/linear-adapter/SKILL.md`                       |
| Provenance lines on tracker and pull request text                             | `docs/provenance.md`                                   |
| Showing an item to a person (`PROJ-157 - Title`)                              | `skills/linear-adapter/SKILL.md`                       |
| The comment-response rules (never answer your own comment, and the rest)      | `skills/tending-tracker/SKILL.md`                      |
| Which model a worker runs on, and the resume ladder                           | `skills/executing-specs/SKILL.md`                      |
| The six readiness rules                                                       | `skills/grooming-backlog/SKILL.md`, phase 4            |
| What each stage does, for people                                              | `docs/what-flow-is.mdx`                                |
| The stories behind the rules                                                  | this page                                              |

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

## Grooming the backlog

The first groom of the DorkOS tracker (2026-08-03) found only 21 of 276 open items
passed the dispatch check, and at least four of those 21 could not be done or had
already shipped, including the queue's top pick. About a fifth of the items already
marked ready failed when an agent checked the code instead of trusting the ticket.
That is why a groom needs evidence from the code for "shipped" and for "open", and why
readying every item in a set means the bar was not applied.

## Reports from outside the team

Path C of triage checks for duplicates before anything else. On a hand run over 12
reports, doing that first turned one "new feature" into a copy fix, and stopped
another from being filed as a regression of work that was already done.

## Reviews and their rubric

The agent that wrote a change is the worst reviewer of it: it reviews what it meant to
write, not the diff. So the review runs in a fresh context, and a model is always named
for it. A worker dispatched without a model can quietly run on the most expensive one.

Setup once found the repo root with `git rev-parse` alone. Outside a git repo that
command fails silently, so the rubric was written to `/REVIEW.md` or not at all, and
every review ran without it while looking calibrated. Setup now falls back to the
current folder, and a missing rubric is announced by path.

## Setup

A shell with `NODE_ENV=production` installs nothing from a plain `npm install`, which
left adopters with a plugin whose own checker could not run. Setup now says
`--omit=dev`. And an empty dispatch check once passed for a working install: it runs
on the items it is handed and never touches the tracker, so an install that never
connected looked green. Setup now reports the tracker read and the policy check
separately.

## Claims survive a restart

Flow keeps an item's state in `agent/*` labels, never in a plan checklist or a field
that is rewritten freely. An earlier agent loop kept its state in its plan and lost
every claim when it restarted.
