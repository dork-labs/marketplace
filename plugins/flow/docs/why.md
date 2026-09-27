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
