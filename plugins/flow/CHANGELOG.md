# /flow changelog

Installs of this plugin are pinned to a commit SHA, so a fix here does not reach
you until you **reinstall it** (Marketplace → flow → reinstall, or re-run your
`--plugin-dir` checkout's `git pull`). Each entry below says whether that matters.

## 0.22.0

**`flow selftest` now also checks how flow's commands behave, not only its files. Reinstall to get it.**

- New `flow selftest` command (and `/flow:self-test` now runs it). Besides the quick checks of your settings and flow's own instructions, it plays whole pieces of work through the real commands against a pretend tracker in a throwaway folder: an item going from new to done, a backlog audit, recovering work whose session died, and deciding which comments to answer. It is free, needs no network and takes a few seconds. `--tier fast` or `--tier scenarios` runs just one half.
- The item-to-done check runs twice, once as a Claude Code session and once as a Codex one, and checks what flow records about each. Today a Codex session is recorded without its session id; that will change when flow learns to recognize Codex.
- `--file` looks for an item it filed before for each failure. It adds a comment to an open one, and leaves alone one a person closed as not wanted in the last 90 days. flow cannot create tracker items yet, so it lists the ones it would file instead of filing them.
- Each run adds one line to flow's notebook (`.dork/flow/journal.jsonl`).

## 0.21.0

**flow's journal now records which agent wrote each entry: Claude Code, Codex or OpenCode. Reinstall to get it.**

- Every journal entry says which runtime ran it, so a later review can compare them. It also says what hosted the session when flow can tell: cmux, the runtime's own terminal, a plain shell, or whatever a launcher names with `FLOW_HARNESS` (DorkOS will name itself this way).
- flow works this out from the markers each runtime leaves in its shell. A launcher can say it outright with `FLOW_RUNTIME` and `FLOW_HARNESS`; a launcher that starts one runtime from inside another (flow's own, or DorkOS) names the new one, so it is recorded as itself.
- Entries written by earlier versions read as runtime "unknown".
- The journal can now hold occasional readings of each account's usage, so a review can show how usage moved over a week. A reading is kept only when something changed enough to matter, so the file stays small.
- `flow journal tail` shows the runtime beside each entry.

## 0.20.0

**flow now keeps a small notebook of how its runs go, and agents can add notes to it. Reinstall to get it.**

- New `flow note`: when an agent had to improvise a script, found a skill's steps wrong, or had to guess between two instructions, it writes one sentence about it. `/flow` now tells agents when to do this.
- New `flow journal record`: add a review verdict, a CI failure or a handoff to the notebook by hand. It checks what you typed and tells you which field is wrong.
- New `flow journal tail`: print the newest entries, or only one kind.
- The notebook is `.dork/flow/journal.jsonl` in your project, shared by every worktree and kept out of git. It never holds comment bodies, prompts or code, and it removes tokens, email addresses and your home folder from any text before saving it. It keeps its size in check by starting a new file at 5 MB and keeping the last three.
- It is on by default. Turn it off with `selfImprovement.journal.enabled: false` in your settings (see `config/CONFIG.md`). If it cannot be written, you get one warning and the command still works.

## 0.19.0

**New `flow` command: agents and people run flow's routine steps as one tested command instead of following long instructions. Reinstall to get it.**

Run it as `node --experimental-strip-types <flow-root>/scripts/flow.ts <command>`. Add `--json` for output a script can read.

- `flow next` shows the next item to work on. It reads your settings itself, so nobody builds the ranking's input by hand.
- `flow claim`, `flow release`, `flow done` and `flow stage` move an item along: they change its labels and state, check that the change landed, and keep the run record up to date.
- `flow snapshot` pulls the backlog once. `flow audit` checks it and exits with an error when something is wrong, and `flow status` shows what is in flight, what is parked, and anything that disagrees.
- In Claude Code, `flow claim` records which session is working an item without being told. Elsewhere, pass `--session`; without one the claim still goes ahead and says the session is unknown.
- `flow accounts` lists your Claude Code accounts with the share of each one flow may spend, and lets you add one or change that share.
- A new audit rule: an item's state, its `agent/*` label and its `stage/*` label must agree, and a `stage/*` label now appears only on work nobody has started. Items that break this show up in `flow audit`.
- The Linear adapter now carries the code these commands use. The adapter contract is now version 2.0.0; a custom adapter that still sets `stage/*` labels on started work should be regenerated.
- The instructions these commands replace are gone from the skills.
- The reserve you keep on an account now comes back after its weekly reset. Before, it stayed at 0 after the reset, which has affected how accounts were ranked since 0.16.0.

## 0.18.1

**A guide to `flow usage` and `flow fleet`. Reinstall to get the page locally; the status-line lines point to it.**

- New page, "Account usage and the fleet view" (`docs/account-usage.mdx`): what flow records and from where, how to add the status-line lines and take them out again, what a probe costs, and how to read the fleet screen.

## 0.18.0

**Two new commands, `flow usage` and `flow fleet`, show how much of each Claude Code account you have left. Reinstall to get them.**

- `flow fleet` shows every account you registered, with its 5-hour and weekly use as bars and how long until each resets. Below that it lists every running session: its account, the item it works on, what it is doing (busy, idle, waiting on you, out of usage), and where it runs (terminal, DorkOS or cmux). It only reads; it changes nothing.
- `flow usage install-statusline` adds two lines to each account's status-line script, so every session you use keeps that account's numbers up to date in the background. It shows you the change first and makes it only with `--yes`. It keeps a backup, and `--remove` takes the lines out again.
- `flow usage scan` recovers the times an account ran out during the last week, from your saved conversations.
- `flow usage probe <account> --yes` sends one short message on an account nobody has used lately, to read its numbers. It uses a small part of that account's 5-hour limit, and says so before it runs.
- flow reads these numbers only from what Claude Code itself shows. It never reads your login or asks Anthropic's servers directly. Whether using several of your own accounts this way fits Anthropic's terms is your call.

## 0.17.0

**flow now ships a fake tracker, the first piece of its self-test that runs stages without a real tracker. Nothing changes for your project; reinstall when you want it.**

- The fake tracker keeps its items in one JSON file and behaves like the Linear adapter where flow depends on it. A claim changes only flow's own labels and keeps every other label. Moving an item picks a real state name. A label your team doesn't have is refused. A merged pull request that says `Closes <id>` closes the item.
- One shared test runs the fake and the Linear adapter through the same cases, and the Linear side is checked against answers recorded from Linear, so a difference in any of those cases fails a test.
- `/flow:self-test` also checks that the fake tracker's sample backlog is well formed.

## 0.16.0

**Groundwork for running several items at once across your Claude Code accounts. One new command; nothing else you use changes, so no reinstall is needed.**

- New `flow checkpoint`: it writes a short `HANDOFF.md` in the item's worktree saying what is done, what is next, open questions and the exact next command. flow fills in the facts itself (the branch, the last commit, whether it was pushed), so a fresh session, even on another account, can pick the work up from that file. The file is kept out of git automatically.
- flow can now decide which of your accounts should take the next piece of work: one with room in its 5-hour and weekly limits, preferring the account whose unused weekly allowance runs out soonest, and keeping your main account for last. Nothing uses it yet; `flow next` and `flow drain` will.
- A run record has room for a parallel drain's progress and for an account that hit its limit, and the settings gain a `drain` block (listed in `config/CONFIG.md`). Nothing reads them yet.
- The shared account test fixtures are now version 1.0.1: one new case proves a run record keeps these new fields when another run is written.

## 0.15.0

**More groundwork for tracking several Claude Code accounts. Nothing you use changes yet, so no reinstall is needed.**

- flow can now read an account's usage from what Claude Code already shows: the 5-hour and weekly numbers on the status line, the limit messages saved in past conversations, and the usage report of a short check-in turn. The commands that record them arrive in the next release.
- flow can now tell which account a Claude Code session belongs to, and list every running session with the item it serves and what it is doing. It combines Claude Code's own session list, a DorkOS app running on this computer, and flow's run records.

## 0.14.0

**More groundwork for the `flow` command. Nothing you use changes yet, so no reinstall is needed.**

- A tracker adapter can now ship code beside its instructions, so the `flow` command can read and update the tracker itself. The adapter contract is now version 1.4.0 and explains how (`docs/building-your-adapter.mdx`).
- The Linear adapter ships that code. It reads the backlog, one item and the signed-in account, and writes labels, state and comments, all through the Composio CLI account set in your local config.

## 0.13.0

**Groundwork for the `flow` command. Nothing you use changes yet, so no reinstall is needed.**

- The file formats for tracking several Claude Code accounts are now fixed: which accounts flow may use and how much of each to keep for yourself (`~/.dork/flow/fleet.json`), and how much of each account's limits has been used (`~/.dork/usage/`). A shared test fixture set lets DorkOS prove it reads them the same way once its side is built.
- A run record now has room for the account and the launcher (terminal, DorkOS or cmux), so a session can later be matched to the item it is working on. Nothing fills them in yet.
- One written rule now says what a tracker item's state, its `agent/*` label and its `stage/*` label each mean. The audit that enforces it arrives with the commands that follow it.
- The first piece of the `flow` command itself: how it reads its settings, its flags, and its exit codes. Its commands arrive in the next releases.

## 0.12.0

**New `/flow:self-test`: flow checks itself in a few seconds and tells you what is broken. Reinstall to get it.**

- It checks that the tracker adapter checker still catches a bad adapter, that the shipped example settings and your project's settings are valid, and that the settings schema matches the code it is built from.
- It also checks flow's own instructions: no file grows past its word budget, the same rule is not copied into two files, every link and heading it points to exists, every scheduled skill ships switched off with a valid schedule, and no step carries a dated story or a ticket number.
- If you work on flow itself with its test tools installed, it runs the full test suite too. Without them that check is shown as skipped, never as passed.
- It is free and needs no network. Each run is saved to `.dork/flow/selftest/` in your project, which flow keeps out of git.
- The same check runs as `node --experimental-strip-types <flow-root>/scripts/selftest.ts`, and will become `flow selftest` when the flow command line lands.

## 0.11.0

**Work flow files for itself now reaches the ready queue, and two schedules keep it there. Reinstall, then approve the schedules you want.**

- A follow-up filed when an item closes gets a type, a priority and a project, and goes through triage right away. It is marked ready only if it passes the six readiness rules; otherwise it is parked with one question.
- New `flow-triage` schedule, daily: readies or parks every untriaged item. It also releases a claim nobody has touched for 7 days, but never one that a flow run, the review gate, a person, a PR, a branch or a worktree still holds.
- `flow-groom` now runs weekly instead of monthly, and stays a read-only check. The full groom still runs only when you start it.
- Both ship switched off. On DorkOS, approve them on the Schedules page.
- Triage and groom check the code before calling an item open or shipped.
- The Linear adapter now says that claiming swaps `agent/ready` for `agent/claimed`, and that `Closes <id>` in a PR closes the item when it merges.
- New page, Draining in parallel: a hand-run recipe with worker and reviewer briefs and a PR watcher, for carrying several items at once.

## 0.10.2

**One badly dated comment can no longer make flow stop hearing new comments for good. Reinstall to get the fix.**

- Flow keeps a bookmark of the newest comment it has read, and only looks at
  comments after it. If a tracker connection handed over a comment whose date
  was not a real date, that text became the bookmark, and it sorted after every
  real date. From then on flow heard nothing, with no error anywhere.
- Now a comment whose date is not a full date and time, or is more than an hour
  in the future, is skipped, and flow says so in a warning that names the item.
  The bookmark only ever holds a real, past date, so the next good comment still
  gets through.
- If your saved bookmark was already broken this way, flow notices, warns, and
  reads the whole inbox again instead of staying silent.
- Dates are now compared as moments in time, so a comment written with a
  different time zone or precision is no longer missed or put in the wrong order.
- An inbox entry with no comment attached is skipped with a warning instead of
  crashing the run.
- A question flow parked for you is only picked back up by a reply that has an
  author or some text. An empty reply can no longer wake it with no answer, and
  a real reply that arrives with no author (one synced in from Slack or email,
  say) still does, with a warning.

## 0.10.1

**On DorkOS, you can now change when flow's scheduled runs fire right on the Schedules page. Nothing to do after updating.**

- The dials page and the README now say so. Open `flow-drain` (or `flow-groom`) on
  the Schedules page, choose Edit, and set a new time or timezone. DorkOS keeps
  your timing for this install, so a flow update never undoes it, and the
  schedule stays approved because you made the change. "Reset to the package's
  default" puts flow's own timing back.
- On DorkOS 0.82 and earlier, a package's schedule can only be switched on or
  off, so the dials page keeps the old way for those releases: make your own
  `/flow continue` schedule and switch `flow-drain` off.
- Docs only. Reinstalling is not needed.

## 0.10.0

**How often flow's scheduled runs fire is now set where they are scheduled, not in a file inside the plugin. Nothing to do after updating, and DorkOS does not ask you to approve anything again.**

- The docs used to tell you to change how often the `flow-drain` tick runs by
  editing the `cron` line in the plugin's own `flow-drain` file. An update
  replaces that file, so your change was lost, and on DorkOS every edit (and the
  update that undid it) made you approve the schedule again.
- If you start the tick from your own scheduler (a `cron` line, a CI job), that
  scheduler's own entry decides how often it runs. It never read flow's file, and
  a flow update never touches it.
- On DorkOS, flow's own tick runs at flow's default, the top of every hour, and
  the monthly check at 09:00 on the 1st. DorkOS lets you switch a package's
  schedule on or off on the Schedules page, but not change when it runs.
- To run the tick on DorkOS at a cadence you choose, make the schedule your own:
  on the Schedules page, create one for this project's agent whose prompt is
  `Run one /flow continue tick in this project, then stop.`, and leave
  `flow-drain` switched off. You can change its timing there whenever you like,
  and a flow update never touches it. The dials page has the details.
- `/flow:status` now shows this project's flow schedules on DorkOS, your own
  `/flow continue` one included: when each runs, whether it is on, and whether it
  is waiting for your approval. It only looks; it never changes a schedule.
- `/flow:pause` now also switches off your own `/flow continue` schedule. And it
  only ever touches this project's schedules: before, a project in a folder like
  `app` could switch off a schedule belonging to a neighbouring folder like
  `app-2`, because it only checked how the path started.
- The scheduled runs themselves did not change, so DorkOS keeps your approval.

## 0.9.0

**A tracker adapter `/flow:init` made for you, and `/flow:pause`, now live in your project, so updating flow can't undo them. Update, then run `/flow` once. If you rely on `/flow:pause`, pause again after updating.**

- If you use a tracker flow has no built-in adapter for (anything but Linear),
  `/flow:init` wrote the adapter it made for you into the plugin's own folder. An
  update could erase it. It now goes into your project, in
  `.agents/flow/adapters/<tracker>/`. It is your team's code, so commit it.
- The first `/flow` after updating moves an adapter from the old place, with the
  same rules as your settings in 0.8.0. It moves it without asking when flow is
  installed inside your project. When flow is installed somewhere several
  projects share, it asks first, with one question that covers both your settings
  and the adapter, and shows you the adapter's name and first lines. It never
  overwrites a file and never deletes the old copy. An adapter holds no tokens, so
  unlike your settings it stays available to every other project using the same
  install: each one is asked for itself.
- `/flow:pause` used to switch off the `flow-drain` schedule by editing a file
  inside the plugin. On DorkOS that did not stop a schedule you had already
  approved, because DorkOS keeps an approved schedule's on/off switch itself, on
  the Schedules page. So a pause there may never have stopped anything. And an
  update replaced the file.
- `/flow:pause` now writes `.agents/flow/paused.json` in your project. Every
  scheduled run, the tracker check-in, `/flow continue` and `/flow auto` check it
  first and stop, with any scheduler. It stays out of git, and it applies to every
  worktree of the project. `/flow:resume` removes it. Stage commands like
  `/flow:specify` still work while flow is paused. A run already going when you
  pause finishes the item it is on first.
- On DorkOS, `/flow:pause` also switches off this project's `flow-drain` and
  `flow-groom` schedules, when it can reach DorkOS's schedule tools, and
  `/flow:resume` switches back on only the ones it switched off. Anywhere else, a
  scheduler still starts each scheduled run on time while flow is paused, and the
  run stops at its first step. To stop it starting them, switch the schedule off
  where it runs.
- To turn the scheduled run on in DorkOS, approve `flow-drain` on the Schedules
  page. Approving switches it on, so there is no need to edit the file first.
- The instructions inside the `flow-drain` and `flow-groom` scheduled runs
  changed, so DorkOS will ask you to approve them again after this update. That is
  expected.

## 0.8.0

**Your flow settings now live in your project, so updating flow can never erase them again. Update, then run `/flow` once.**

- flow used to keep its settings inside the plugin's own folder. Some tools, Claude
  Code among them, replace that folder when the plugin updates, so every update
  could lose your settings and send you back to `/flow:init`.
- Your settings now live in your project, in `.agents/flow/`. `config.json` holds
  your team's settings and is meant to be committed. `config.local.json` holds this
  computer's tokens and overrides, and flow adds a `.agents/flow/.gitignore` so it
  is never committed. flow checks that git really ignores it before writing
  anything secret there.
- The first `/flow` after updating moves your old settings over, even when Claude
  Code has already moved flow to a new folder. It tells you which files it wrote.
  Commit `.agents/flow/config.json` and `.agents/flow/.gitignore`.
- If flow is installed inside your project, it moves them without asking. If it is
  installed somewhere several projects can share, the settings there might belong
  to another project, tokens included. flow shows you the tracker, team and folder
  it found and asks whether they are this project's before it moves anything. If
  you say no, it remembers that and sets this project up fresh. Until someone
  answers, flow does not use those settings at all, so a scheduled run stops and
  asks for you instead of working on another project's tasks.
- After a move, flow leaves a note in the old folder saying which project the
  settings went to, so another project using the same install is never handed
  them.
- The move never overwrites a file that is already there and never deletes the old
  files. Once your project has its own settings, flow stops reading the old ones.
- In a git worktree, flow finds your machine's settings in your main checkout, so a
  new worktree needs nothing copied into it. flow keeps them out of git there
  without adding any file to your main checkout, so merging the branch stays easy.

## 0.7.4

**Updating flow no longer makes a working config "invalid". Reinstall if `/flow` keeps sending you back to `/flow:init`.**

- When a new version of flow added a setting, flow's config check said your
  existing `config.json` was broken because the new setting was missing, and
  `/flow` sent you back to `/flow:init` to set everything up again. But the new
  setting always had a default, and flow would have read your file fine. The
  check now accepts any setting left out that has a default, the same way flow
  itself does. A config written by flow 0.5 passes again.
- A setting flow does not know, such as a misspelling like `planAproval` or a
  setting a later flow removed, no longer makes your config invalid either.
  Flow ignores it and shows you a warning that names it, so you can fix the
  spelling or delete it. A setting with a wrong value, like a word where a
  number belongs, is still an error.
- If your shared `config.json` holds a `secrets` block, flow now says so
  plainly and asks you to move it to `config.local.json`, the file that is
  never committed. Before, it just called the whole config invalid.
- Your editor, if it checks `config.json` against flow's schema, now agrees too:
  it stops underlining settings you left out on purpose.

## 0.7.3

**DorkOS now shows the right version for this plugin. Reinstall if you want DorkOS and Claude Code to agree.**

- This plugin states its version in three files, and they disagreed: one said
  0.6.0 while the plugin itself was 0.7.2. So DorkOS listed flow as 0.6.0 while
  Claude Code was running 0.7.2. All three files now say 0.7.3.
- Nothing about how flow works has changed. Reinstalling just moves you onto a
  version that DorkOS and Claude Code both report the same way.

## 0.7.2

**Other sessions no longer get pulled into a `/flow auto` drain. Reinstall is recommended.**

- While a `/flow auto` drain was running, every other session open in the same
  folder hit the "DRAINING THE READY QUEUE" banner each time it tried to stop,
  and spent a turn working out what to do about a drain it had nothing to do
  with. The drain now records which session started it, and only that session
  is held. Every other session stops as normal and never sees the banner.
- Another session can no longer end your drain by printing
  `<promise>ABORT</promise>`. Only the session that started it can.
- A drain started before this update has no owner on record, so it now ends
  after its current item. Start it again with `/flow auto`.

## 0.7.1

**Fixes a bug that could trap every session in a repo. Reinstall is recommended.**

- A `/flow auto` drain that died without cleaning up left its `auto-run.json`
  behind still saying `active: true`. The Stop hook trusted it, so every later
  session in that repo — doing entirely unrelated work — got the "DRAINING THE
  READY QUEUE" banner on every single Stop, forever. The hook now checks whether
  the drain's process is actually still running, and deletes the leftover file
  when it is not. A drain that has claimed to be running for more than 24 hours
  is treated the same way, because by then its process number may belong to
  something else entirely.
- The banner told you to output `<promise>ABORT</promise>` to stop, but that was
  a message to the agent while the hook was reading the file, so the banner came
  straight back. `ABORT` (and `PHASE_COMPLETE`) now delete the file too. The
  advertised way out is the real way out.
- A drain you paused on purpose (`/flow:pause`) is never deleted, so
  `/flow:resume` still finds it.

DOR-1679.
