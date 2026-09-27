# /flow changelog

Installs of this plugin are pinned to a commit SHA, so a fix here does not reach
you until you **reinstall it** (Marketplace → flow → reinstall, or re-run your
`--plugin-dir` checkout's `git pull`). Each entry below says whether that matters.

## 0.47.0

**The instructions for each /flow stage are much shorter, so an agent reads less before it does the work. Nothing flow does has changed. Reinstall if you want the shorter versions; your runs work the same either way.**

- The stage instructions (setup, triage, ideate, specify, decompose, execute, verify, done, the backlog clean-up and the team-member loop) went from about 29,000 words to about 9,000. Each one is now roughly 250 to 1,200 words.
- The scheduled jobs (the drain, daily triage, weekly health check and weekly retro) are shorter too. The steps of one run of the queue now live in one place, the `flow-drain` job, and `/flow continue` and `/flow auto` follow it. `/flow` itself is down to about 700 words.
- Every scheduled job now checks the pause the same way, by running the drain's first step, so there is one copy of that check to keep right.
- The stories behind the rules (the first backlog clean-up, the review rubric that went missing outside a git folder, and others) moved to `docs/why.md`, with a table of where each shared rule lives.
- The README no longer repeats what each stage does; it points at the "What flow is" page.


## 0.46.0

**The tracker adapter's instructions are much shorter, so an agent reads less before it touches your tracker. Nothing it does has changed. Reinstall if you want the shorter versions; your runs work the same either way.**

- The Linear adapter's instructions went from about 6,600 words to about 1,400. Steps the `flow` command already does in code (claiming an item, moving it between stages, finishing it, filing new work, pulling the backlog) are now one line each: "run `flow <verb>`".
- The guide for building your own adapter went from about 2,400 words to under 1,000. It points at the adapter contract instead of repeating it, and a checklist that only restated the contract is gone.
- The stories behind the adapter's rules (the Composio quirks, the team-scope mistake, the first backlog clean-up) moved to `docs/why.md`.
- The "Build your tracker adapter" page now names the current contract version and the `createItem` method.

## 0.45.0

**The `/flow` commands are much shorter, so an agent reads less before it starts work. Nothing they do has changed. Reinstall if you want the shorter versions; your runs work the same either way.**

- `/flow` is down from about 3,900 words to about 1,200. `/flow:pause` went from about 800 to under 300, `/flow:resume` is about half its old length, and `/flow:status` is a little shorter.
- The step-by-step commands (`/flow:capture`, `/flow:triage` and the rest) now just point at the skill that does the work, without repeating its rules.
- Each rule the commands share now lives in one file. For example, how flow picks this project's schedules is written only in `/flow:status`, and `/flow:pause` points there.
- A new page, `docs/why.md`, keeps the stories behind flow's rules (what went wrong and what it taught us), so the commands can stick to what to do.
- The full "Use all your accounts" guide now lives on the DorkOS site, at dorkos.ai/docs/guides/flow/use-all-your-accounts. The plugin's copy is a short summary with a link.

## 0.44.0

**A Flow panel beside your chats shows each account's usage and what flow is working on, and lets you pause flow. Reinstall to get it; it needs DorkOS 0.88.0 or newer.**

- Open it from the Flow tab in the panel on the right of any chat, once the Flow extension is turned on.
- Each account shows two small bars, for its 5-hour and weekly limits, and says when it is out or kept in reserve. Click an account to see its plan and when each limit resets.
- Each task flow is working on shows what it is doing: building, in review, waiting on you, handing off, or parked. Click one to open its chat.
- Pause flow stops flow from starting new work in the projects the panel shows, and Resume flow starts it again. The panel updates by itself as things change.
- Flow now saves each task's title with it, so the panel can show the title, and it notes when a task is parked waiting for your answer.

## 0.43.1

**`flow accounts pick` now works from any folder. Reinstall to get it.**

- Run from a folder with no flow settings, `flow accounts pick` could be refused because of old settings left inside a shared flow plugin folder, which may belong to another project. It now ignores those, says so, and ranks with the defaults. A folder's own settings that are broken still stop it.

## 0.43.0

**New `flow accounts pick`: ask which account new work should start on, without a tracker item. Reinstall to get it.**

- `flow accounts pick` ranks your accounts the way `flow next` and `flow drain` do: room in the 5-hour, weekly and model limits, the reserve, which repos an account may serve, and the unused allowance that runs out soonest, with your main account last. It needs no tracker and no flow settings in the folder, so a tool outside flow, or you at a terminal, can use it. `--repo`, `--runtime` and `--model` say what the work is.
- `flow fleet --help` now names the address it really uses for DorkOS (`localhost`).

## 0.42.1

**The Flow tab's error messages are clearer, and a failed load has a Retry button. Reinstall to get it.**

- If the tab can't load, it says "Couldn't load Flow's settings. Try again in a moment." and offers Retry. If Retry fails too, screen readers announce the message again.
- If a change can't be saved, it says "Flow didn't respond, so nothing was changed. Try again."

## 0.42.0

**A Flow tab in DorkOS Settings lets you choose which accounts flow may use, keep part of your main account for yourself, limit an account to certain repos, and pick whether work moves automatically when an account runs out. Reinstall to get it; it needs DorkOS 0.88.0 or newer.**

- Find it under Settings, Add-ons, Flow, once the Flow extension is turned on. Every change saves as you make it.
- Each account is Main, Rotation or Kept out. The first time you open the tab, it explains the three and links to the guide.
- Under Main, choose how much of its week to keep for yourself, and how close to the weekly reset flow may use the rest.
- Under Kept out, list the repos (`owner/name`) that account may still work on.
- The tab tells you when flow has only your main account to use, or no account at all.
- On an older DorkOS, the tab says to update DorkOS instead.

## 0.41.0

**Flow can now tell DorkOS which accounts to offer when one runs out, keep your main account in reserve, move a flow run to another account itself in the background, and hold a run when you choose to wait for the reset. Reinstall to get it; it needs DorkOS 0.88.0 or newer.**

- The flow plugin now carries a DorkOS extension named Flow. Turn it on in DorkOS under Settings, Extensions. On an older DorkOS it does nothing.
- When an account runs out, DorkOS offers only the accounts flow may use for that work, best first, with a plain reason on each, such as "58% of the week left" or "Out until Tue 3pm".
- An agent, or a message from another agent, can only start work on an account you put in the rotation, or one you kept out but allowed for that repo.
- Your main account shows as kept in reserve while another account has room, until its weekly reset is close.
- For a flow run, flow decides: it moves the run to another account after a 10-second countdown when handoff is automatic, or waits when the reset is less than an hour away. When you pick an account yourself, flow does the move in the background and DorkOS shows where the work went.
- Choosing to wait, or cancelling an automatic move, holds the run on its own account, so flow does not move it behind your back.
- If you wait with "Continue automatically when it resets" turned off, flow leaves the run alone after the reset too, until you continue it, wait again with that turned on, or run `flow handoff`. With it on, the run carries on by itself at the reset, as before.
- The new session starts from the run's HANDOFF.md checkpoint.
- Only work `flow drain` runs is flow's to move. Work you picked up yourself with `flow claim` is handled by DorkOS like any other conversation.
- When you pick an account for a flow run, flow checks it the way `flow handoff` would, and says why it can't move the run right away instead of trying and failing later.

## 0.40.0

**Fixes found by running `flow drain` for real across several Claude Code accounts. Reinstall to get them.**

- `flow drain` no longer stops work on an account at half its weekly allowance. Claude Code sends an early "warning" once an account passes about half its week. flow now goes by the measured share and treats that signal as a warning only when no share is known.
- When the merge queue lands a drain's PR and the tracker closes the item on its own, the run now goes on to finish (DONE). Before, it stopped, as if someone else had closed the item.
- Starting a session in cmux now answers Claude Code's "do you trust this folder" question for the worktree flow created. Before, the session waited on that question and the start timed out.
- When a drain's PR conflicts with `main`, the worker is now told to merge `main` and push. Before, a conflicting PR ran no checks and the drain waited on it forever.
- `flow drain` and `flow fleet` now find the DorkOS app on `localhost`, where it listens, instead of `127.0.0.1`, which misses it on many Macs.
- When DorkOS refuses to start a session for its own reason, such as a folder outside the ones it serves, flow says so. Before, it told you to sign in.
- New: a live check of the three places a session can start (terminal, cmux, DorkOS) on a named account. It runs only when you set `FLOW_LAUNCHER_LIVE=1`, and only on a main or rotation account.

## 0.39.0

**The self-test's live tier no longer fails when a file in your flow checkout is deleted while it copies the plugin. Reinstall only if you run the live tier.**

- The copy skips a file or folder that disappears while it runs, and a link that leads nowhere, instead of stopping with "no such file or directory".
- It leaves out short-lived hidden temp files, such as `.something.tmp.json`.
- flow's own tests no longer write a temp file into the plugin folder.

## 0.37.3

**Two usage readings from the same moment no longer lose the one that says an account is out. Reinstall to get it.**

- When two sessions on one account see a limit in the same millisecond, flow now keeps the more serious reading: out of usage over near the limit over fine, then the higher percentage, then the later reset. Before, the second reading was dropped, so an account that had just run out could keep showing as available.
- The shared test fixture DorkOS checks itself against is now version 4.0.0, because the rule for readings from the same moment changed. The file format did not change.
- `flow usage scan` keeps the same reading the merge would, so it no longer drops an "out" reading when two sessions log a limit at the same moment.

## 0.37.2

**The self-test's live tier can no longer change your flow checkout. Reinstall only if you run the live tier.**

- Each live case now gives its agent a temporary copy of the plugin instead of your checkout. Anything the agent writes into the plugin, by whatever route, lands in the copy, which is deleted when the case ends. The check that fails a case for writing outside its folder still runs, as a second layer.

## 0.37.1

**Two small fixes. Reinstall to get them; nothing breaks if you wait.**

- With the Linear tracker, a command that writes to an item that does not exist (a label change or a comment) now says the item was not found and exits 5, as reading it already did. It used to exit 4, which means the tracker could not be reached.
- A very long usage limit name no longer goes into the flow journal at full length. A window name's part after `model:`, `credits:` or `rate_limit:` keeps at most 40 characters, ending in a short code so two long names stay apart. Usage files are unchanged.

## 0.37.0

**`flow accounts setup` sets up every account on your computer in one go, so flow can share work between them. Reinstall to get it.**

- It finds your Claude Code account folders (`~/.claude`, other `~/.claude…` folders you have used, and `CLAUDE_CONFIG_DIR`), your Codex folder and OpenCode's data folder, and shows each one's latest usage when flow has seen it.
- It suggests a role for each: the others join the rotation, and then your computer's default account stays your main one, with half its weekly limit kept for you. With nothing else in the rotation, nothing changes.
- An account you kept out stays out, even with `--rotation all`, unless you name it.
- It asks which accounts are work, organization or client accounts, and keeps those out. A folder that looks managed by an organization is marked, with the reason, and suggested for keeping out.
- It can add each account to DorkOS and add the usage recorder to its status line.
- Every change is printed first and made only after you say yes. Agents use `--yes` with `--rotation`, `--keep-out`, `--main` and `--statusline`; `--dry-run` changes nothing.
- `/flow:init` now has an accounts step that runs it.
- While you have several accounts flow could use and none in the rotation, `flow status`, `flow fleet` and `flow next` end with one line suggesting setup. Turn it off with `"fleet": { "nudge": false }`.
- New guide: `docs/use-all-your-accounts.mdx`.

## 0.36.0

**Follow-up work and triage now go through flow's own commands, so they come out the same way every time. Reinstall to get it.**

- When `/flow:done` files follow-up work, it now uses `flow create`. Each follow-up gets a type, a priority, the finished item's project and an `origin/from-agent` label, and it is never marked ready when it is filed. Running `/flow:done` again does not file the same follow-up twice.
- New command: `flow triage`. `--ready --stage <stage>` marks an item ready to work on and says where the work starts. `--park '<question>'` posts one question and marks the item as waiting on a person. It never posts the same question twice, and it refuses an item that is closed or that an agent is already working on. `--dry-run` shows what it would do. A question with quotes, a `$` or several lines can come from a file with `--question-file`; a file in `.dork/flow/tmp/` is deleted once the question is posted.
- `flow retro` now measures how long new work takes to become ready, from the items `flow triage` marks ready.
- `/flow:triage` now uses `flow triage` to mark an item ready or waiting. Setting an item's type and priority works as before.
- The self-test's live tier now checks two things it used to skip: a triage ends with the item either ready or waiting on exactly one question, and a finished item with follow-up work gets exactly one well-formed follow-up, which is marked ready only if it really is.

## 0.35.0

**`/flow:capture` now files the item with one flow command, the same way every time. Reinstall to get it.**

- `flow create` files one new item: a title, a description, and the labels you give it. It signs the description so people can see an agent wrote it and which session did.
- `/flow:capture` now uses it, so a captured idea always lands in triage as an `idea` with `origin/human`, never ready to work on and with no priority.
- Give it a `--key` and running it twice files one item, not two: the second run says the idea was already captured and shows that item's title. Once that item is closed, the same key files a new one. A key belongs to one team, so the same key in another team files its own item.
- It refuses, before it touches the tracker, an empty title, a label that would mark the item ready (`agent/*`), two labels from one group, and a priority outside 0 to 4. `--dry-run` shows what it would file and files nothing.
- A long description can come from a file. When that file is in `.dork/flow/tmp/`, flow deletes it once the item is filed, so it never ends up in your repository. Files anywhere else are left alone.
- If your tracker's adapter cannot create items, it stops and says so instead of trying another way.
- The self-test's live capture check now checks the real result: exactly one new item, with an origin, not ready.

## 0.34.0

**When an account runs out, `flow drain` moves the work to another account with room, waits for the reset, or switches models, with no one having to step in. Reinstall to get it.**

- When an account nears its limit, its worker is told to finish the step it is on, write a `HANDOFF.md` checkpoint and stop. In Claude Code this happens between tool calls; Codex and OpenCode workers hear it from the drain on its next pass.
- When an account runs out, what happens next depends on the limit:
  - If the limit resets within the hour, the work waits and continues in the same session.
  - If only one model's allowance ran out, the same session can carry on with a fallback model you list in `drain.modelFallback`.
  - Otherwise a new session starts on another account in the same worktree, and it picks up from `HANDOFF.md` and the old session's transcript. No transcript is ever copied or moved.
- With `handoff: ask` in `fleet.json`, flow posts one comment naming the account it would move to and the command to do it (`flow handoff <item> --to <account>`), and otherwise waits for the reset.
- `flow handoff <item> --wait` holds a run until its limit resets, even in `auto` mode.
- New settings: `drain.waitIfResetWithinMinutes` (default 60) and `drain.modelFallback` (off by default).

## 0.33.0

**A drain on the DorkOS host now checks that work on your main sign-in really runs there. Reinstall to get it.**

- When flow starts work on your own sign-in (`default`) through DorkOS, it now confirms the session uses that account's folder. If DorkOS was started on another account, the launch stops with a wrong-account error instead of spending that account.
- The account-folder check follows symlinks, so a `~/.claude` that is a link to another folder still matches.

## 0.32.0

**Your main Claude Code sign-in now shows up in flow, even when you have listed other accounts. Reinstall to get it.**

- flow now knows an account by its folder, not its name. `default` is this computer's main folder: for Claude Code, the one the DorkOS app is set to, else `~/.claude`; for Codex, `~/.codex`. A session running in another folder never changes what `default` means.
- If one of your listed accounts uses that folder, `default` is just another name for it. flow keeps one usage file and one set of settings for it, and `flow accounts` shows it once, as "Claude3 (default)".
- If none does, `default` is its own account, "Main (this computer's sign-in)", with its usage in `default.json`. Before this, it was hidden as soon as you listed any account.
- Next to listed accounts, that sign-in counts as your `main` account: flow keeps half of its weekly limit for you and uses it last. Give another account the `main` role, or give `default` any role, and your choice wins.
- `flow usage probe default --yes` now checks that sign-in, `flow usage install-statusline` sets up its status line, and the status line records it. A session in a folder that is neither listed nor the default still records nothing.
- `flow next` and `flow drain` can pick that sign-in, and start its sessions in its own folder, whatever folder the drain itself runs in.
- The shared test files DorkOS checks itself against are now version 3.0.0: what `default` means changed, so DorkOS must update its side too.

## 0.31.0

**flow's self-test can now try a few stage commands on a real Claude session. It costs money and only runs when you ask. Reinstall to get it.**

- `flow selftest --tier live` gives `/flow:capture`, `/flow:decompose` and `/flow:done` to a real session in a throwaway folder, against a fake tracker, and checks what changed there, not what the agent said.
- It refuses unless you set `FLOW_SELFTEST_LIVE=1`, even when a key is set, and it never runs in CI.
- It pays with `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then your `claude` sign-in, and the report says which one paid. With none, every check fails.
- It stops starting checks once it has spent `selfImprovement.selftest.liveBudgetUsd` ($1.00 by default), or the amount you give `--max-usd`. Each check reports its cost and turns.
- The session gets no tracker keys, no MCP servers and none of your own plugins, hooks or settings. A check fails if the session runs composio, curl, wget or gh, reads a file outside its folder and flow, or writes anywhere outside its folder. It also fails if the session paid with a different credential than the report names.
- A session that ends without reporting its cost counts as having spent everything it was allowed.
- Two checks are listed as skipped for now, with the reason: triage and filing a follow-up. flow has no command yet to set an item's type or priority, or to create an item.
- `--tier all` now runs all three tiers. The default is still the two free ones.

## 0.30.0

**New `flow drain --parallel N`: flow works on several ready items at once, each on the account with the most room, and opens a PR only after an independent review comes back clean. Reinstall to get it.**

- `flow drain --parallel 3` claims ready items and starts one working session per item in its own worktree. Each session goes to the account whose unused weekly allowance runs out soonest, and your main account is used last. The session can be a terminal, cmux or the DorkOS app. New sessions wait while the machine is busy.
- Each pushed commit gets a separate reviewer session. Its findings go back to the worker, and the loop repeats until the review is clean. Only then can the worker open the PR, with `flow pr`, which refuses otherwise. A push to an open PR turns auto-merge off until that push is reviewed.
- `flow watch` replaces `templates/drain/watch.sh`. It tells the worker when its PR merges, fails a check or leaves the merge queue. When the queue drops a PR over a check that also failed for other PRs, it puts the PR back once.
- `flow next` now names the account (and, with Codex or OpenCode, the tool) each item should run on.
- `flow stage --checkpoint-file` writes a `HANDOFF.md` checkpoint at every stage boundary, and the stage instructions use it.
- On DorkOS, the scheduled drain runs one `flow drain --tick` per firing once `drain.parallel` is set above 0. At 0 it does what it did before.

## 0.29.0

**New `flow retro`: flow looks back over its own week and suggests fixes to itself. Reinstall to get it.**

- `flow retro` reads flow's notebook for the last week and the week before, the self-test results and your backlog. Today it can show how many items are ready or still untyped, which flow commands failed, and how many words flow's instructions hold. Each number sits beside last week's and is split by agent: Claude Code, Codex and OpenCode. A number with nothing behind it says "no data", never 0.
- Some numbers wait on notebook lines nothing writes yet: how long new work takes to become ready, and how long agents wait on you, read "no data" for now. Review and merge-queue numbers count only what was recorded with `flow journal record`, and the verifying-work skill now asks agents to record each review.
- It also shows each account's usage over the week: where it started and ended, its peak, and how often it ran out.
- It proposes changes to flow by four fixed rules: two or more agent notes about the same thing, the same error twice, a self-test check that passed before and fails now, and a number that got clearly worse.
- It changes nothing unless you pass `--file`. Then it files each proposal as a tracker item, at most five a run (`selfImprovement.retro.maxItemsPerRun`), never marked ready. It uses the same rules as `flow selftest --file`: a comment on an item it filed before, nothing for one you declined in the last 90 days. `--input` files an edited list instead.
- Each run saves its report to `.dork/flow/retro/` and adds one line to the notebook.
- New `flow-retro` weekly schedule (Mondays at 9:00, Los Angeles time) runs the self-test and the retro, rewrites each proposal into one concrete change, and files them. It ships switched off; approve it on the DorkOS Schedules page to turn it on.
- New docs page, "How flow checks and improves itself".
- `flow selftest --file` now reports each item under `subject` instead of `checkId`.

## 0.28.0

**flow's notebook now fills itself in as flow's commands run. Reinstall to get it.**

- Every `flow` command adds one line to the notebook (`.dork/flow/journal.jsonl`) saying which command ran, how long it took and how it ended. A later review can then see which steps are slow or keep failing.
- Claiming an item, letting it go, moving it to a stage and finishing it each add a line of their own, with the item and which tool ran it (Claude Code, Codex or OpenCode).
- When a command fails because of a bug in flow, the notebook keeps the first line of the error, with tokens, email addresses and your home folder removed.
- `flow note` and `flow journal` don't add a line about themselves. The usage recorder your status line runs adds one only when it fails. Nothing is written for `--help` or a mistyped command, and running `flow done` again on a finished item doesn't count it twice.
- The notebook never changes what a command prints or how it ends. If it can't be written, the command works exactly as before, with no warning. Projects with no flow settings get no notebook.

## 0.27.0

**flow can now file new tracker items itself, and `/flow:self-test --file` does. Reinstall to get it.**

- The tracker adapter contract gains a create step (version 2.2.0). The Linear adapter implements it: it checks that every label and the project exist first, and never creates a label.
- `/flow:self-test --file` now creates an item for each new failure, after checking the tracker for one already filed with the same fingerprint. A failure that already has an open item still gets a comment instead, and one a person declined is left alone.
- New items land in your tracker's triage state and are never marked ready: triage still decides.
- Filing the same failure twice, from a retry or from two runs at once, still makes one item.
- A custom adapter without the create step keeps working: `--file` lists what it would file, as before.

## 0.26.0

**The `flow` command is documented, and the backlog audit can accept a label your team uses without a family. Reinstall to get it.**

- The README, "Driving it manually" and the contract reference (`docs/SPEC.md`) now show the `flow` command and its verbs.
- New setting `groom.unnamespacedLabels`: bare labels such as `cloud-contract` that the audit should accept without a `family/` prefix. It is empty by default, so every other bare label is still flagged.

## 0.25.0

**flow can now start a working session on a chosen account. Nothing you use changes yet, so no reinstall is needed.**

- flow can now start a session in an item's worktree on a named account, in three places: a plain terminal (`claude -p`, `codex exec` or `opencode run`), a cmux workspace (Claude Code), or the DorkOS app (Claude Code, Codex or OpenCode). It checks afterwards that the session really runs on that account, and strips API keys from the session's environment so nothing else pays for it.
- If a place cannot run a runtime (cmux and Codex, for example), flow says so and starts nothing, rather than guessing another one.
- `flow drain` will use this to spread work across your accounts; it arrives in a later release.

## 0.24.0

**flow now records usage for Codex and OpenCode too, and `flow fleet` shows every tool. Reinstall to get it.**

- `flow usage scan --runtime codex` reads the limits Codex writes into its session logs: the 5-hour and weekly windows, a model's own limit (such as GPT-5.3-Codex-Spark), the plan and prepaid credits.
- `flow usage scan --runtime opencode` reads a copy of OpenCode's message store. It adds up what you spent this month and notices when a provider answers "out of credits" or "rate limited". One provider's trouble never marks another as out.
- `flow usage record --runtime codex` and `--runtime opencode` take one reading on stdin, so a hook can keep them current.
- `flow fleet` groups accounts and sessions by tool: Claude Code and Codex with their bars, OpenCode with what it spent this month.
- `flow usage prune` now only lists what it would delete. Add `--yes` to delete. It also finds files left over from older versions of flow.
- `flow usage snapshot` adds a sampled usage line to the flow journal, so it keeps a history of your usage. `scan` and `probe` add one too.
- flow still never reads a sign-in: not Claude Code's, not Codex's `auth.json`, not OpenCode's credential tables.

## 0.23.0

**flow now tracks accounts and usage for Claude Code, Codex and OpenCode, not only Claude Code. Reinstall, then run `flow accounts` once.**

- Usage files moved to `~/.dork/runtimes/<runtime>/usage/<account>.json`, one folder per runtime (`claude-code`, `codex`, `opencode`). flow no longer reads the old `~/.dork/usage/` folder; your status line and `flow usage scan` fill the new one.
- A runtime with no accounts listed now has one account called `default`: whatever that runtime is signed in to. flow may use it, so Codex and OpenCode work without any setup. Claude Code accounts you list still start kept out until you give them a role.
- `flow accounts` shows each runtime's accounts separately, with a new ROOM column. Accounts in `fleet.json` are now named `<runtime>:<account>`, for example `codex:default`. Your existing entries keep working and are renamed the next time flow saves the file.
- When an account is no longer listed, `flow accounts` removes its leftover settings and tells you. The new `flow usage prune` deletes its usage file (`--dry-run` shows what would go). A runtime's `default` usage file stays while no account is listed for it, and `default` cannot be used as a listed account's name.
- Two new settings: `flow accounts set --runtimes codex,claude-code` sets which runtimes to prefer, and `--cross-runtime-fallback on` lets work move to another runtime when its own is used up. Until you set them, work stays on the runtime it started on.
- Usage files can now hold a plan, prepaid credits and money spent, so a pay-as-you-go account counts as usable until it hits its spending cap. A local model with no limits is always usable.
- `flow claim` records which runtime the session runs on (`--runtime` to say it yourself), and finds the session id under Codex as well as Claude Code. **A claim with no session id now stops with an error** instead of going ahead: pass `--session` (OpenCode does not provide one).
- The shared test files DorkOS checks itself against are now version 2.0.0. This version is not compatible with 1.x.

## 0.22.0

**`flow selftest` now also checks how flow's commands behave, not only its files. Reinstall to get it.**

- New `flow selftest` command (and `/flow:self-test` now runs it). Besides the quick checks of your settings and flow's own instructions, it plays whole pieces of work through the real commands against a pretend tracker in a throwaway folder: an item going from new to done, a backlog audit, recovering work whose session died, and deciding which comments to answer. It is free, needs no network and takes a few seconds. `--tier fast` or `--tier scenarios` runs just one half.
- The item-to-done check runs twice, once as a Claude Code session and once as a Codex one, and checks that flow's notebook records each as the right one.
- `--file` looks for an item it filed before for each failure. It adds a comment to an open one, leaves alone one a person closed as not wanted in the last 90 days, and files again one that was fixed but broke later. flow cannot create tracker items yet, so it lists the ones it would file (with the labels and project from `selfImprovement.retro`) instead of filing them.
- The Linear adapter now reports when each closed item was closed, which is what lets `--file` tell a recent decision from an old one. The adapter contract is now version 2.1.0; adapters written for 2.0.0 keep working.
- Each run adds one line to flow's notebook (`.dork/flow/journal.jsonl`), even with `--no-save`, unless the notebook is turned off.

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
