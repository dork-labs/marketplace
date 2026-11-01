# /flow changelog

Installs of this plugin are pinned to a commit SHA, so a fix here does not reach
you until you **reinstall it** (Marketplace → flow → reinstall, or re-run your
`--plugin-dir` checkout's `git pull`). Each entry below says whether that matters.

## 0.69.0

**Flow's parts in the DorkOS app now need DorkOS 0.116.0 or newer. Update DorkOS first, then reinstall flow to get it.**

- On DorkOS 0.116.0 or newer, the Flow tab, Flow home, pausing and the settings pages work as before. Only a person, never an agent, can pause a project or change a setting, as before.
- On an older DorkOS, DorkOS doesn't load flow's extension, so the Flow tab, Flow home and the run chip don't show. `/flow` in a chat works as before.
- Flow no longer has notes for a DorkOS too old for it: "Update DorkOS to choose how flow uses your accounts", "Update DorkOS to change flow's settings here", "Pause from a chat in this project" and the read-only settings page are gone.
- Under the hood, flow's 15 app routes are now served by a Hono fetch handler instead of the Express router DorkOS is retiring. Answers and who may call each route are unchanged. Two small differences: paths now match case-sensitively (`/PAUSE` no longer reaches `/pause`; the Flow tab only sends lower case), and a path flow doesn't serve answers a JSON 404.

## 0.68.0

**In the DorkOS app, the Flow tab now says when a drain run stopped because a DorkOS chat it needs is gone (DOR-2490). Before, the run showed as Building forever. Reinstall to get it.**

- When `flow drain` runs work in DorkOS chats and one of those chats is deleted, the drain waits on it forever. The Flow tab now marks that run **Stopped** and says why in one sentence under it, such as "Its chat is gone, so nothing is working on it. Run flow release DOR-1 to put it back in the queue." When it's the reviewer's chat that's gone, the sentence says the review is stuck.
- It says so only when the DorkOS that started the chat answers that the chat no longer exists, in two answers at least 5 minutes apart. A DorkOS that is down, restarting, too old to say, or a different DorkOS on the same computer is never read as a gone chat.
- It says so only while the drain is really waiting on that chat. That means the worker while it builds or fixes with nothing new to review, or the reviewer while it reviews the latest push with no verdict yet. A run the drain can carry on without that chat (a push to review, a verdict to route, a PR to watch) is left alone, as is a limited or parked run.
- Flow now records which DorkOS started each chat, so this works for drain runs started after you reinstall. Older runs are never marked Stopped.
- `flow status` lists such a run under **Ended, not cleared**, with `reason` set to `session-gone` and `chat` set to `worker` or `reviewer` in its JSON, plus a `session-gone` drift line. It reports what DorkOS answered on that one read. The stopped run still holds its drain slot until `flow release` clears it, as the drain counts it.

## 0.67.1

**Fix: flow installs again. On current DorkOS, installing 0.66.1 or 0.67.0 failed with "Extension 'flow' failed to compile: Compilation failed for flow" (the detail says an import "resolves to …, outside this plugin's folder") and rolled back. Install 0.67.1.**

- DorkOS builds the Flow extension's page half while installing, and holds that build to the extension's own folder. The page half imported two engine modules from `scripts/`, so the build was refused and the install rolled back.
- The page half now uses its own copies of those two modules, `autonomy-dial.ts` and `config-names.ts`, in the extension folder. A test keeps each copy byte for byte the same as the engine's.
- A new test builds the page half the way that install step does and fails if it reaches outside the extension folder.

## 0.67.0

**A run whose item closed, or whose worker died, no longer shows as in flight or waiting at review, and `flow release` clears it (DOR-2924, DOR-2706). Reinstall to get it.**

- `flow status` lists such a run under **Ended, not cleared**, not under In flight. In its JSON it's in a new `ended` list, with `reason` set to `item-closed` or `worker-gone`, and a drift line says `flow release <id>` clears it. A real tracker's backlog holds only open items. So for a run whose item isn't in the backlog, status asks the tracker about that item once, through the adapter, and only when a close would end the run.
- A run that may still be live stays in flight. That covers a running run whose worker may be alive, a `flow drain` run the drain hasn't parked (the drain closes the item itself), and an item the tracker can't find or doesn't answer for.
- `flow release` now clears the run of a closed item. It deletes the run record and leaves the item exactly as the tracker has it, never reopened or relabelled. With `--reason` it still posts the comment. A closed item with no run is still refused.
- In the DorkOS app, the Flow tab no longer shows such a run as waiting at review or counts it as busy, and its ship or question ask in the Inbox clears by itself. For a project with an active run, the tab's tracker read now also runs `flow status`, and keeps the answer across restarts. A closed item that's reopened and claimed again is a new run and shows again. That covers projects flow reads on its own (the `cli` transport); over MCP, release the run by hand.

## 0.66.1

**Security fix: before flow arms a PR, its `security-reviewed` label must have been added after the PR's current head arrived. Reinstall to get it.**

- A PR that needs the label (it touches a security path, or flow can't read its whole file list) now arms only if the label was added after its head arrived. Before, a label added for an older head still counted after later pushes.
- "Arrived" means the last force-push that left the head there. With no such push, it means the first check suite a push made for the head. Both times are GitHub's own, and a commit's dates can't move them. These are the same reads `flow sweep` already used.
- A label added before the head arrived refuses as `security-label-stale`. The message says the label predates the head, so Security looks at the new commits and adds it again.
- If flow can't tell when the head arrived or when the label was added, it refuses as `security-label-unverified`. In a repo where a push starts no check suite, flow can tell only after a force-push.
- A PR that doesn't need the label arms as before, whatever its labels say.
- `config/CONFIG.md` and `docs/landing.mdx` no longer say the label carries over to later pushes.

## 0.66.0

**Flow's schedules now belong to the projects that use flow, even when flow is installed globally. Reinstall to get it; it needs a DorkOS that reads `scope: project` and `projectFile`.**

- `flow-drain`, `flow-groom`, `flow-triage` and `flow-retro` each say `scope: project` and `projectFile: .agents/flow/config.json` in their `schedule:` block. Each needs a project to work in. From a global install, DorkOS used to list them as global schedules with no project, waiting for an approval that should never be given.
- Now each project that has flow set up (it holds `.agents/flow/config.json`, which `/flow:init` writes) gets its own copy of each schedule, switched off, on that project's **Schedules** page, and a person approves it there, project by project. Other projects get no copies. A project you set flow up in later gets its copies at DorkOS's next sync. None of them shows or asks for approval as a global schedule.
- With a global install, a project still on the old in-plugin settings gets no copies until `/flow` or `/flow:init` moves them into `.agents/flow/`.
- `/flow:status`, `/flow:pause` and `/flow:resume` now find those per-project copies too (they share the global file's path, so the folder test alone missed them), and they now include `flow-retro`.
- Nothing is switched on for you.
- A DorkOS older than this setting ignores it, so a global install still lists the four as global schedules there, as before. Leave those off, and update DorkOS.
- The README's activation section and `docs/bring-your-own-scheduler.mdx` say so.

## 0.65.1

**Security fix: a flow command can no longer be pointed at another project's folder. Reinstall now.**

- `--project` chooses whose settings and tracker adapter code a flow command uses, and the adapter code is code flow runs. Until now it could name any folder, so a scheduled run allowed to call flow could have run another project's adapter code. Flow now refuses a `--project` outside the checkout it runs in, with exit 2, before it reads or writes anything there. The message ends with the folder to run flow from instead: "Run flow from inside" that project's checkout. Symlinks are followed first, so a link to another checkout is refused too, and so are a linked worktree and a submodule, which count as checkouts of their own. A subfolder of the same checkout still works.
- Outside git, `--project` must be the folder flow runs in or a folder inside it, and not inside a git checkout.
- Flow checks again just before it loads a project's adapter code, on the checkout it is about to load from. When it asks git which checkout a folder is in, it now leaves out the variables that point git somewhere else (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG*` and the like), so they can't point it at another checkout. `GIT_CEILING_DIRECTORIES` still works.
- This holds for every run, not only scheduled ones, because nothing tells flow which runs a schedule started. If you used `--project` to reach another checkout, run flow from that checkout instead.
- The Flow panel in DorkOS now starts flow in each project's own folder, so it keeps working.

## 0.65.0

**Flow can now take new work from more than one place: tracker teams and GitHub issues, each with a record of when flow last read it. Reinstall to get it.**

- A new `intake.sources` setting adds places new work comes from: tracker intake queues, and GitHub repositories whose open issues triage turns into tracker items. Your configured team always counts, so leaving it empty changes nothing. It can name team ids, so it belongs in `config.local.json`. `/flow:init` now asks which sources to add. `docs/intake.mdx` explains it all.
- The older `connection.intake` list still works. Flow reads it as tracker sources and warns you to move it to `intake.sources`.
- A new command, `flow intake`, reads each GitHub source with one fixed, read-only `gh issue list` call: open issues created since the source was last captured, oldest first. The repo and labels come only from your config and must match their patterns whole. The first read of a source pulls no older issues. Each read stops ten minutes before now, because GitHub's search takes a moment to see a new issue, and flow remembers which issues it already showed, so none is skipped or shown twice. `flow intake done` says the issues were captured; a run that stops before that reads the same issues again, and a read that fails is never marked captured.
- Issue text is treated as data from outside the team, never as instructions. It only becomes the text of a new tracker item, with control characters removed and long bodies cut. Flow never replies to, labels or closes an issue.
- A captured issue becomes an idea item labelled `agent/from-outside`, so nobody outside the team can queue work by opening an issue. No flow command removes that label, whether a person started the run or not: readying, parking and claiming the item are refused. Only a person, or the PM in its own triage, clears it, by editing the tracker after re-stating the work in the team's own words, with a comment saying who. Flow lists these items in triage's report and closes one only when a person says so. The team needs the label in its tracker; an adapter older than this refuses it, so the capture fails loudly instead of filing an unmarked item.
- `flow create` refuses a title that ends in a capture tag (`[owner/name#N]`) unless the item is labelled `agent/from-outside`, so a captured issue can't be filed without the label by mistake.
- Daily triage now captures new issues as its last tracker step (a test keeps it last), using the two exact commands `flow intake --json` and `flow intake done --json`. It needs no broader permission and runs no `gh` command of its own.
- Flow keeps a last-read mark for each source in `.dork/flow/intake.json` on this machine. `flow snapshot` marks your team each time it reads it, and `flow intake` marks each GitHub source. The intake rows in `/flow:status`'s Health block now show those marks instead of "unknown".

## 0.64.0

**A bug fix now ships a test that proves the whole kind of bug is gone, and `/flow:verify` won't hand a bug to review without one. Reinstall to get it.**

- The test fails on the code before the fix and passes after, and it covers the whole class of the bug (every variant of the mistake), not just the one case that was reported. The new `skills/verifying-work/proof-test.md` says how to write one and run it both ways.
- A new command, `flow proof <id>`, records it: the test files, one sentence naming the class, the command, and the output of the failing and the passing run. Flow checks that each test is committed and added or changed on the branch (a deleted one doesn't count) and that the two runs differ. It runs no test itself; the independent reviewer runs it on the code before the fix, and the drain reviewer's brief now says a test that only replays the report is a blocker.
- Both ways a bug (an item of type `signal`) reaches review refuse it with no proof recorded at that commit: `flow stage <id> review`, and a drain worker's `flow report <id> pushed`. A commit after the proof, a review fix included, means recording it again. Other items, and other stages, are unchanged.
- When no such test is possible, `flow proof <id> --waive "<reason>"` records why instead, so the check never leaves an agent stuck. A waiver counts only at the commit it was recorded at, just like a proof, and an empty reason is refused. A refusal names `--waive` as the way through. Both hand-offs report what let the bug through (the proof, or the waiver and its reason), and the reviewer's brief now shows it: the tests, the class, the command and the failing output, or the waiver's reason, which a reviewer blocks when it doesn't hold.
- `flow claim` now records the item's type on its run, which is how the drain knows a bug without asking the tracker. A run claimed before this version has no type, so it isn't asked for a proof.

## 0.63.0

**`/flow:status` now ends with a Health block: are this project's flow schedules running, and when was each intake source last read? Reinstall to get it.**

- One row per flow schedule (drain, groom, triage, retro, and any you made that runs `/flow continue`), with its cron and timezone: fresh, stale ("stale: last successful run started 3d ago, runs daily"), never ran, disabled, or pending approval. Stale means a firing came and went with no successful run after it, allowing the schedule's max runtime (at least an hour), so a long run still going isn't stale.
- Flow keeps no record of its own scheduled runs, so it reads DorkOS's: the schedule list, and each schedule's last completed run, from the DorkOS on this machine only, following no redirect. It needs no new permission. Without DorkOS, or with an answer flow can't read, the row says unknown and why, never healthy.
- One row per intake source (`connection.intake`, else the plain tracker intake). Flow doesn't record when it reads one yet, so these say unknown for now, ready for a last-read mark per source.
- `flow status --no-health` skips the block. The new page [Is flow healthy?](/docs/guides/flow/health) explains each state.

## 0.62.0

**A scheduled flow run that is refused a tool no longer ends quietly as done. Reinstall to get it.**

- Nobody is there to approve a tool during a scheduled run, so a tool that asks is refused on the spot. Before, the daily triage, the weekly groom check and the weekly retro (all on the careful `default` setting) could meet a refusal, skip the work behind it and still report done.
- Each scheduled skill (`flow-triage`, `flow-groom`, `flow-retro`, `flow-drain`) now lists the read tools it needs under `metadata.flow-needs` in its `SKILL.md`: flow's own read commands, one git read (`git worktree list`), flow's own folders and your tracker adapter's reads (`tracker:read`), plus `flow note` so a run can write a refusal down. Listing them grants nothing. The new page [Scheduled runs and refused tools](/docs/guides/flow/refused-tools) says how to allow them for your project until DorkOS lets a schedule carry its own allow list, and where each run still stops for a write.
- When a tool is still refused, the run starts no new step, tries to park the item it was working on with one question (allow the tool, or a person does the step; parking is a tracker write, so it happens only if you allowed it), notes the refusal in flow's journal, and ends with a first line of `FLOW RUN NEEDS YOU: refused <tool> at step <n>`, never "done". Outside triage, which parks without a pick, the agent's own pick on that question is always "a person does it", so a pick that stands by default never grants a tool, and that answer releases the item and hands it to a person rather than resuming the work. A DorkOS release after 0.125.4 shows such a run as needing attention; with another scheduler, treat that line as a failed run.
- No schedule's permission setting changed, and flow never raises one to get past a refusal.
- No scheduled run talks to your git remote. The daily triage no longer runs `git ls-remote` to look for pushed branches before releasing a stale claim; it checks open pull requests through `flow prs` instead, and leaves any branch alone. `flow snapshot` is listed only in the exact forms the schedules run (`--json`, and groom's one fixed file in `.dork/flow/tmp/groom/`), because `--out` writes wherever it's pointed.
- The scheduled skills no longer mention other schedulers in their opening lines; [Bring your own scheduler](/docs/guides/flow/bring-your-own-scheduler) still covers them.

## 0.61.0

**Flow stops opening pull requests faster than people can land them. Reinstall to get it.**

- An item with an open PR now counts as work in progress until that PR merges or closes, whatever its tracker state or claim. Before, an item stopped counting once it reached review or its claim dropped, so `flow next` and the drain kept handing out new work while open PRs piled up. Flow finds an item's PR by its identifier in the PR's branch name or title, from one fixed, read-only `gh pr list` call.
- New `pr.maxOpen` (default 8): at that many open PRs, `flow pr` and `/flow:verify` open no new one unless the item is urgent (P0), and say which PRs hold the slots. `flow next` reports `atPrCap` and `prCap`, and picks only urgent work while at the cap. If flow can't count the open PRs, it treats that as the cap.
- `flow next` names `land`: your oldest open PR that isn't armed. The drain tick (`/flow continue`, the scheduled tick) lands it (rebase, re-gate, answer review) before it claims new work. `flow drain` can't land a PR itself: each pass sweeps before it starts anything, and says which PR to land.
- New `flow prs`: the open PRs with their age, author and how far behind their base they are. PRs older than `pr.staleDays` (3) or more than `pr.maxBehind` (20) commits behind are listed as stuck, with a ship / split / close prompt naming the owner. Groom and the daily triage report them. `flow prs --for <id>` is the cap check `/flow:verify` runs.
- The review route: every PR gets Security. A PR that only touches dependency manifests and lockfiles, docs, copy (`review.lightPaths`), tests or CI is `light` and skips QA, but a lockfile or manifest still needs the security label to arm. Agent prose (skills, commands, `AGENTS.md`) is never light. The design read runs only when a PR touches `review.designPaths`, at PR open alongside Security. `flow pr` reports the route.
- New `flow sweep`: arms each open PR that is cleared but unarmed (required checks green, and the security label, plus `review.qaLabel` and `review.designLabel` where its route needs them, added after its current head last arrived, a force-push back to an older commit included) through the arm guard, and says why every other unarmed PR isn't armed. A label from before a push doesn't count: the reviewer adds it again after reading what changed. Like `flow pr`, it arms only when `drain.armAutoMerge` is on or you pass `--arm`; otherwise it says what it would arm. The drain runs it every pass. The sweep leaves `land.preArm` checks to the drain's own runs, so a PR they apply to is reported `pre-arm-deferred`.
- A drain worker refused at the cap reports itself blocked with the refusal, so a person sees which PRs to land.
- New page: [Keeping open PRs few](/docs/guides/flow/open-prs).

## 0.60.2

**Flow arms one dependency PR at a time, and its pre-arm checks run more tightly sandboxed. Reinstall to get it.**

- Flow refuses to arm a PR that changes a dependency file (any built-in security path except `.agents/flow/config.json`: lockfiles, manifests, `patches/`, build wrappers and the like) while another such PR is in the merge queue or armed: "another dependency PR is in the queue: #N; arm this after it lands". Two such PRs conflict once the first merges, and the queue ejects the second. The drain asks again on later passes, so the PR arms once the other lands. If flow can't read the queue, it refuses. This replaces the team's manual "one lockfile PR at a time" rule. Only PRs into `main` count. A queued or armed PR with more than 100 changed files counts as a dependency PR, because flow can't see all its files, and two arms at the same moment can still both see an empty queue.
- Scratch copies for `run:` checks and the squash check now live in a folder only you can use (`dorkos-flow-<uid>` in your temp folder, mode 700). Flow refuses one that is a link, or that belongs to someone else.
- A `run:` command runs in a process group of its own. When it times out or exits, everything still in that group is stopped, though a process that starts its own session (`setsid`) is not. If flow exits, or is stopped with SIGTERM or SIGHUP (a scheduler, a closed terminal), mid-check, it stops the group on its way out. A SIGKILL can't be caught, and a Ctrl-C leaves the check running: a continuous `flow drain` waits for it to finish or time out, and `flow drain --tick` exits and leaves it behind.
- `run:` commands get a fixed PATH: the folder of the node running flow, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin` and `/sbin`, never the agent's PATH. A tool installed anywhere else (`~/.bun/bin`, `~/Library/pnpm`, a Volta or mise shim) won't be found: call it by its absolute path, or from a committed script that does. Flow's own git calls use only the system folders that only root can write to, so on a Mac they use `/usr/bin/git`, not Homebrew's. If that Apple git is older than 2.44 (older Command Line Tools), the squash check reports it can't run until you update them.
- The docs now say a check that couldn't run is unverified, never a pass, rather than that it fails.

## 0.60.1

**Security paths and `land.preArm` paths now match the way a case-insensitive Mac disk opens a file. Reinstall to get it.**

- macOS's APFS opens `pacKage.json` (a Kelvin sign for the k), `PACKAGE.JSON` and `styles.cß` (for `styles.css`) as the same files as their plain spellings. The built-in security paths only matched plain ASCII case, so those spellings slipped past the security label. Flow now counts a path as matching when its spelling as written, its full case fold (`ß` as `ss`, ligatures as their letters) or its NFKC form does. To be safe that also covers fullwidth letters, which APFS itself keeps apart.
- `land.preArm` entries match their paths the same way, so a PR that touches `SRC/App.ts` runs the entry for `src/**`.
- Folding only ever adds matches; everything that matched before still does.
- `patches/` and `.yarn/patches/` folders, at any depth (pnpm, patch-package per workspace, Yarn), where patches to installed dependencies live, are now built-in security paths.
- Your own `land.securityPaths.globs` and `pattern` match the same way, so `APPS/Server/src/auth/x.ts` counts for `apps/server/src/auth/**`. The pattern also matches with the `i` and `u` flags (just `i` when it isn't valid with `u`) against all three spellings, on top of matching as written. Write it in plain ASCII: its own text isn't folded. A pattern that relied on case, such as `^[A-Z]`, now matches more, so recheck it.

## 0.60.0

**Flow now checks a pull request before it turns on auto-merge, and names the reviewer on the PRs it opens (DOR-3262). Reinstall to get it.**

- Before every arm (`flow pr --arm`, `flow review --approve` with `gates.review.mergeOnApproval`, and the drain's re-arm), flow refuses if a required check failed or was cancelled, or the PR's head isn't the commit that was reviewed. It also refuses if the PR merges into anything but `main`, comes from a fork, or touches a security path without the `security-reviewed` label. So does a closed or draft PR, one labelled `hold`, `do-not-merge`, `wip` or `blocked`, or one where a reviewer asked for changes. A check that is still running doesn't stop it, because GitHub waits for it. The refusal says why in one sentence.
- Package manifests, lockfiles, build wrappers (`gradlew`, `mvnw` and their folders), toolchain files (`.cargo/config`, `rust-toolchain`) and `.agents/flow/config.json` always count as security paths, matched in any case, since macOS's disk ignores case. Your repo adds its own in the new `land.securityPaths` setting.
- New `land.preArm` setting: checks to run before arming, each only when the PR touches its paths. An entry either dispatches a workflow on GitHub and waits for that one run (preferred wherever a repo has CI), or runs a command. The command form is the fallback for repos without CI. It runs with no shell, in a fresh, clean checkout of the reviewed commit that's removed afterwards. The checkout is made in a scratch repository: a blob-less copy of your repo's commits made through git's fetch protocol, which re-hashes every object. So the worker's git settings (sparse checkout, filters, replace refs, hooks) and an overwritten object can't change it. The environment is minimal, with an empty HOME and no tokens. The checkout has no installed dependencies. Flow reads `land.preArm` and `land.securityPaths` only from the committed config on `main`, so a PR can't change which checks run. A `run` entry still runs the PR's own files, so list the scripts it calls as security paths. After the checks pass, flow reads the PR and the freeze again before it arms.
- New `flow freeze on --reason <text>` and `flow freeze off`: while a freeze is on, flow arms nothing in the project. Have your release process run `flow freeze on` before it cuts a release and `flow freeze off` after; flow ships no release step of its own. It's kept on this computer only, never committed.
- After a PR merges, flow checks that the squash commit on `main` is what a clean review saw. It always uses the commit recorded at review, never the PR's last head. It passes only when merging that commit into the squash's parent gives the squash's tree. A matching patch-id is noted but never passes on its own, because it ignores whitespace and where a change sits. A conflict, any other difference, or a merge with no clean review fails, and flow comments on the PR, naming its author and `land.securityPaths.reviewer`, with both trees and the files that differ. The check also runs in such a scratch repository, so merge drivers, `merge.default`, attributes in your repo's config or an overwritten object can't turn a conflict into a pass. A shallow clone can't be squash-checked, and says so; `git fetch --unshallow` fixes it. A check that couldn't run (a missing commit) is retried on later drain passes, then reported; a git too old to merge safely fails. It reverts nothing and touches no status. The drain runs it on every merge. `flow squash-check <id>` runs it by hand (exit 1 unless it passes).
- `flow pr` names the reviewer in a comment on the new PR: `land.securityPaths.reviewer` when the PR touches a security path, else `land.reviewer`. Both are account handles, so set them in `config.local.json`.
- `land.preArm` checks run only in the drain, never inside `flow pr` or `flow review`, which are stopped long before a browser suite finishes. When one applies, `flow pr --arm` opens the PR and leaves the arm to the drain, which runs the checks and arms it. A person's `flow review --approve` on a drain run does the same. Outside the drain, a person merges it.
- A refused `flow pr --arm` still opens the PR, unarmed, and the drain asks the guard again on later passes, so it arms once a freeze lifts or a check reruns green. A refused `flow review --approve` still posts the approval, and DorkOS says why nothing was armed. Both exit 0 and say why in `armRefused`. A failed `land.preArm` check, a fork or a base other than `main` is asked about again only for a new reviewed commit.
- These checks are a guard rail for flow's own arms, not the gate. Flow runs inside the agent. The rules that hold for everyone belong on GitHub, as required checks and rulesets. Flow never sets a security status or the `security-reviewed` label.
- Breaking: flow arms only into `main`. A repo whose default branch has another name keeps its PRs unarmed. And because package manifests always count as security paths, a PR that bumps a `package.json` version needs the `security-reviewed` label before flow arms it.
- Known limits: a `land.preArm` check blocks a drain pass until it finishes or times out (up to its `timeout`). The `security-reviewed` label is a person's signal, not tied to a commit: it carries over to later pushes. A per-commit security approval belongs on GitHub. The drain squash-checks a merge it sees; a run outside the drain, or one closed by hand before the drain saw the merge, needs `flow squash-check` run by hand. The squash check runs `git merge-tree` with its merge settings pinned and its attributes read from the empty tree, so a `.gitattributes` merge driver can't turn a conflict into a clean merge. `run:` entries and the squash check need git 2.44 or later; with an older git the `run:` check refuses and the squash check reports it could not run, never a pass. Both work on copies in your temp folder, which another process running as you could still write to while a check runs. A merge GitHub resolves differently from that is reported as a false alarm, never passed.

## 0.59.0

**Security fix: flow's unattended sessions start with every approval bypassed only if a person allowed it in DorkOS. Reinstall now, on DorkOS 0.98.0 or later.**

- `drain.permissionMode: bypassPermissions` used to be enough on its own, and three flow commands may edit the file it lives in without asking. So an agent steered in one turn could have switched every later unattended run to bypass. Now a person also allows it in DorkOS by approving Flow's **Allow unattended bypass** card for that project; ask an agent to "allow unattended bypass" for it. The approval lasts 30 days, or until `config.json` or `config.local.json` changes. Without it, sessions start in `acceptEdits` and say why in one line. There is no way to allow it outside DorkOS.
- Any mode other than `default`, `acceptEdits` or `plan` needs that approval, so modes added later are covered too.
- `flow drain`, `flow handoff` and the reviewer `flow report … review-launch` starts now stop, naming the file, if `config.json` or your project's own tracker adapter isn't committed or has changes. That includes a new or ignored file in the adapter's folder, or a link out of the project. The adapters flow ships are recognised by where they really are, not by their name.
- A worker that was started in bypass doesn't stay in bypass once the approval lapses or is taken back. Resuming it, or handing it to another account, starts it at the lower of its old mode and what's allowed now. A continuous `flow drain` checks the approval, the settings and the adapter again before every pass.
- Unattended bypass needs flow installed globally. A per-agent install, which lives inside the project at `<project>/.dork/plugins/flow`, never gets it. Bypass is never honoured when flow itself, or DorkOS's data folder, is inside the project, because the agent could then edit the code that checks the approval. If you run flow from a checkout inside your project (`--plugin-dir`, as when working on flow itself), unattended runs never get bypass there, and flow's own adapter files must be committed and unchanged before a drain starts. Settings still inside the plugin get a message to run `config-files.ts migrate` before unattended runs.
- Flow's DorkOS extension needs DorkOS 0.98.0 or later. It adds two tools: **Allow unattended bypass for a project** (a person must approve it) and **Check unattended bypass for a project**.
- Known limit: this stops an agent steered inside flow's commands. An agent with a full shell as your user can reach anything on your computer, and with DorkOS login off any local program can approve the card (DOR-505). Turn on DorkOS login if this matters to you.
## 0.58.0

**`/flow:decompose` no longer writes a task list flow then rejects, and `/flow:done` reads the item before it files follow-ups. Reinstall to get it.**

- `03-tasks.json` files written the way the DECOMPOSE skill and its template show, with `"issue": null` for a task not promoted to a sub-issue, failed flow's own task-list check. They pass now.
- New `flow show <id>`: one item, with its description and latest comments. `/flow:done` reads the item with it first, because its `## On Completion` section says which follow-ups to file. Before, nothing read it, so follow-ups were often missed.
- `/flow:decompose` now names how to hand the item on: `flow release <id> --stage execute` if it claimed the item, else `flow triage <id> --ready --stage execute`. Both leave it ready at `stage/execute`, where the next session starts. Before, the skill said to "add `agent/ready`" with no command that does only that.
- `/flow:done` readies a follow-up only if it has a size and an `## On Completion` section, otherwise it asks.
- Each command now says to run each `flow` call on its own Bash line. Chained commands, pipes and shell variables are refused, and agents used to give up after one refusal.
- The self-test's live tier no longer fails a case for a command Claude Code refused, since a refused command never ran. Its default budget is now $2.00, because five cases cost about $1.30. It runs weekly in CI, never on pull requests, once a person adds a `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` secret.

## 0.56.0

**Security fix: flow's commands no longer let the agent write files anywhere on your computer, or run `node` and shell commands of its choosing, without asking you. Reinstall now.**

- Several commands let the agent write files anywhere on your computer without asking, not just in your project. Each now writes without asking only where it needs to: `/flow:ideate`, `/flow:specify` and `/flow:decompose` in `specs/` (and `decisions/` for specify), `/flow:pause` in its one switch file, `/flow:capture`, `/flow:triage`, `/flow:done`, `/flow:groom`, specify and decompose in flow's scratch folder `.dork/flow/tmp/`, and `/flow:init`, `/flow:execute` and `/flow:verify` inside your project. `/flow:resume` writes nothing itself. Git's own folder and Claude's settings are never among them.
- Nine commands let the agent run any `node` program, and `/flow:groom` any shell command at all, without asking. Each now runs only flow's own scripts that way. Anything else asks you.
- `/flow:init` no longer needs `cp`, `npm install` with any arguments, or other shell commands. A new `config-files.ts scaffold` creates your private settings file (readable by you alone) and the review rubric, and never overwrites either. It only puts the rubric inside your project.
- `/flow:execute` and `/flow:decompose` dropped `jq`, `grep`, `cat`, `echo`, `date`, `hostname`, `basename` and `mkdir`, which nothing used. They, `/flow:done` and `/flow:verify` can now run flow's own commands without asking. They used to ask every time.
- The live tier of `/flow:self-test` gives its test sessions the same limits you get: no blanket `node`, and writes only inside the test project.
- `flow drain --permission-mode` can lower the mode your settings give its sessions, never raise it. An agent could otherwise have started sessions with every approval switched off just by passing the flag.
- Outside a git checkout, flow no longer runs a project's own tracker adapter code, only the adapters it ships. Otherwise any folder the agent may write to could pose as a project and run code it wrote there.
- Still true, and worth knowing: flow runs your project's own tracker adapter code. `/flow:init`, `/flow:execute` and `/flow:verify` may change files anywhere in your project without asking, that code included.
- `flow snapshot --out` only replaces an earlier snapshot. It refuses a symlink, a file that isn't `.json`, or an existing file that isn't a flow snapshot. When it writes inside `.dork/flow/`, it keeps that folder out of git.

## 0.55.2

**Security fix: `/flow:execute` could be steered into running any command on your computer without asking you. Reinstall now.**

- `/flow:execute` let the agent create a git worktree in any folder without asking. A worktree made in the right folder (your global git settings, for one) could change those settings so that your next git command ran something else. It now creates a worktree only through a small script that always puts it beside your project as `spec-<name>` and checks the name first. Anything else asks you.
- It no longer runs `git branch` or `git status` without asking (nothing in the stage needed them), and its one remaining git command is an exact spelling.
- The script also tells git to skip your project's git hooks and any program your git settings name for file watching or signatures, so those can't make it run something either. If your project relies on a post-checkout hook, run it yourself in the new worktree.
- If the script refuses a name, or the folder already exists, flow asks you what to do.

## 0.55.1

**Security fix: `/flow:verify` could be steered into writing any file or running any command without asking you. Reinstall now.**

- `/flow:verify` let the agent run `git diff` and `git log` with any options, without asking. Some of those options write a file anywhere you can write (`--output`), so text the agent read, in a ticket or a diff, could have turned that into a way to change files or run commands on your computer. It now runs only a short list of exact git commands without asking, the ones it needs to read your branch. Anything else asks you first.
- `/flow:ideate` and `/flow:specify` let the agent run any git command at all, and `npx` and `python3`, without asking. They now run one, `git rev-parse --show-toplevel`, without asking; nothing in either stage used the rest.
- The live tier of `/flow:self-test` gave its test session the same any-git-command rule. It now gets three exact read-only ones.

## 0.55.0

**On Flow home and a project's page, the link for shipping work or answering a question now opens the Inbox right on that ask. Reinstall to get it.**

- The link used to say "Review in Activity" and open the Activity page, which lists what already happened but not open questions, so there was nothing there to answer. It now says "Answer in Inbox" and opens DorkOS's Inbox with that ask highlighted, on a phone too. If the ask was already answered, the Inbox still opens.
- On a DorkOS too old to open the Inbox from a link, it still opens Activity, as before. Answer from the Inbox there.
- The message for an answer flow can't take from its own page now points to the Inbox too.

## 0.54.0

**The reviewer agent can now ship work in a project where auto-merge is off, including a repo with no CI. Reinstall to get it.**

- With "Merge when I approve" off (`gates.review.mergeOnApproval: false`), the reviewer agent ships only after every check has passed. It used to wait for them in one command that could run for two hours, longer than an agent may run one command, so the command was cut off and the work went to you anyway. Now, while checks are still running, it ships nothing, notes that it is waiting, and checks again on the drain's next run. Default projects, with auto-merge on, work as before.
- A repo with no CI never runs any checks, so the reviewer agent could never ship there. Now, when a pull request has no checks at all and the main branch requires none, it waits 10 minutes in case CI is just slow to start, then ships and says "No checks ran". The new `gates.review.noChecksPassAfterMinutes` setting changes the wait; set it to `null` to always leave such work for you. If flow can't tell whether checks are required, it keeps waiting rather than guess.
- With auto-merge off, the reviewer agent also waits for a required check that hasn't started yet, even when other checks have passed, and it never ships a commit pushed after its review.
- A check that couldn't start (GitHub's "startup failure") or went stale now counts as failing everywhere flow reads checks, including the drain. It used to count as neither failing nor passed.
- `flow review --approve --by reviewer-agent --wait` still works for a person at a terminal. Without `--wait`, a check that isn't finished now exits 5 with `"verdict": "pending"`, and a refusal is still a plain error.

## 0.53.0

**Flow's parts in the DorkOS app now load and stay out of the way, and the guides cover them. Reinstall to get it.**

- On DorkOS, flow's server side failed to start since 0.49.0, so the Flow tab, Flow home, pausing and the inbox asks had nothing behind them. It starts now.
- "Flow: Pause this project" and "Flow: Pause all projects" in the command palette drew their menus across the bottom of every page, even when closed, which pushed the rest of the app out of place. They now open only when you run the command, one at a time, as a proper dialog: it takes the keyboard focus, keeps Tab inside, closes on Escape or a click outside, and gives the focus back.
- Work waiting at the review gate outside a drain showed as "Building". It now shows "In review".
- A check of all of this on a separate DorkOS, with four projects, is written up in the flow-multiproject spec's live-check folder, with what could not be checked there.
- The README has a new "In the DorkOS app" section: the Flow tab, Flow home, the run chip, the Activity inbox, pausing for a set time, and settings split by who a change reaches.
- "Turning on the automatic loop" and "The dials" explain the "How much it does on its own" setting in plain words, including that a new project starts at Tell me after while a project flow already worked in stays at Ask me first, what "While you were away" shows, and that a pause with an end time ends on its own, even with DorkOS closed.
- "The dials" says which settings are shared with the repo, which stay on this computer, and which live in DorkOS, with the real file names.
- "Use all your accounts" explains "Accounts this project may use", what **Move it** and **Switch to DorkOS's rule** each change for an old "Only for these repos" list, and how to undo them. While flow waits for every project to update, Settings → Flow now says a button will appear.
- A few pages still said you always merge approved work yourself. They now say when flow arms it for you, and "Driving it manually" shows how to answer the review gate with `flow review`.

## 0.52.0

**Each project now has Flow settings you can change in DorkOS, including how much flow does on its own and which accounts it may use. Reinstall to get it.**

- One settings view, in two places: each project's settings page (⚙ in its Flow view) and Settings → Flow, where a switcher picks the project. The heading always names the project you are editing.
- Settings are split by who a change reaches. "Shared with the repo" saves to the project's `.agents/flow/config.json`, so it reaches everyone once you commit it; the page says so before and after you save. "Just me" stays on this computer.
- "How much it does on its own" is now yours to choose: Ask me first, Tell me after or Just do it, with a line for each kind of ask saying what happens, and Customize to set each kind apart. Only a person can change it, from DorkOS; flow and its agents can only read it. When Require login is off, the setting says that anyone on this computer can change it.
- "Accounts this project may use" lists every Claude account with a checkbox. DorkOS enforces it for every chat, schedule and handoff in the project. An account kept to other projects says so, and checking it asks first. Unchecking the last one warns you first.
- "Only for these repos" can move into DorkOS: an account's row in Settings → Flow says what DorkOS would do and moves it only when you press **Move it**. It never widens where the account may work, and it leaves alone an account DorkOS already limits. Until every project runs flow 0.52 or newer, flow keeps its own repo list too.
- `flow next` and `flow drain` in the terminal now obey the same account rules as DorkOS, so a terminal run never uses an account DorkOS would refuse in that project. The shared contract with DorkOS is now 4.2.0.
- On a DorkOS without these features, the settings page shows what it can and says what needs an update; nothing breaks.

## 0.51.0

**Flow now asks in the Activity inbox, but only when only you can help, and each project can do more on its own. Reinstall to get it.**

- Every ask says what will happen and why, in plain words: "Ship the new out-of-usage banner?" with 👍 Ship it and 👎 Send it back (which asks what should change), an agent's question with its own pick marked, "Sign in to Linear again", and "12 new ideas haven't been sorted". No ask shows a command or an item number as its headline.
- Shipping from the inbox approves exactly the version you saw. If more work was pushed since, flow says so and ships nothing.
- A slow or unreachable tracker never reaches your inbox. Flow keeps trying and shows a quiet line on the project's page. Only a sign-in that is really gone asks you, because only you can sign in.
- Each project's setting for how much flow does on its own decides who answers: you, the reviewer agent, or the agent's own pick at a deadline. A new project starts at "Tell me after". A project flow already knew keeps asking you until you choose, and its page says you can. You can't change this setting from flow yet; that comes next.
- After you answer, flow offers once to do that kind of thing on its own next time. Saying yes changes only that kind, for that project.
- Things flow settled without asking leave a short "While you were away" note in Activity: work the reviewer agent shipped, failing checks flow went back to fix, and new ideas it started sorting.
- Buttons that need an agent ("Sign in", "Sort them", "Connect a tracker", "Set up flow here") start the work in a new chat with a plain title, and the row then offers "Watch". On a DorkOS that can't start a chat yet, the button says what to type instead.
- Where "Sort new ideas" is set to happen on its own, flow sorts each project's new ideas once each morning from 9:00, one project at a time, leaving room for your own clicks.
- A project that reads its tracker with an adapter of its own now asks once before flow runs that code, and asks again if any file in the adapter's folder changes. Flow won't run an adapter that loads code from outside its folder.
- On a DorkOS without the inbox, flow's pages answer each ask in place instead.

## 0.50.0

**Flow now has a page of its own, a dot on its tab when something needs you, and a chip in each chat's status bar. Reinstall to get it.**

- Flow home lists every project in three groups: what needs you, what's off, and what's fine. A filter narrows it to one project and stays in the page's address, so you can bookmark it. "Pause all projects" asks how long, as every pause does. With one project, Flow home shows that project.
- Each project has its own page, the Flow tab's view of it at full width. On a phone, which has no side panel, that is where you see a project. In the Flow tab, each project in the all-projects list now opens its page, and ⚙ opens the project's settings page. That page doesn't let you change anything yet; it says where the settings live and who a change reaches.
- "Capacity this week" shows each account's use of its weekly limit, and each project's hours of agent work, items finished and handoffs since Monday. It never forecasts. It keeps accounts and projects apart, because flow doesn't record which account paid for which project's work.
- The Flow tab gets a small dot when something waits for you, or when every project is paused.
- A chip in the chat's status bar says which item the chat is working on and where it stands, such as "DOR-2387 · Building", or "3 items · 1 needs you". Press it for the list; an item worked on in its own chat has "Open its chat". When an item hasn't moved for an hour, it says when it last did.
- On a DorkOS without pages, the status bar or tab dots, flow leaves that part out and the rest works as in 0.49.0.

## 0.49.0

**The Flow tab beside each chat now follows the chat's project, and every pause asks how long. Reinstall to get it.**

- In a chat inside a flow project, the Flow tab shows just that project: what is running and in what state, what is up next, and anything wrong, such as a tracker that stopped answering or a sign-in that needs you. Anywhere else it lists only the projects that need a look, and says how many are fine.
- Pause now asks for how long: until tomorrow 9am, for 1 hour, or until you resume. The button then says when the pause ends, with Resume beside it. It pauses one project, not every project at once.
- The command palette can pause or resume the chat's project, or every project.
- When a pause ends, flow switches back on any DorkOS schedules the pause had switched off, as soon as a DorkOS page is open: only a page open in your browser can do it. Until then the Flow tab says those schedules are still off.
- Flow finds every project it runs in, not only the ones you opened a chat in since DorkOS started, and says when a project runs an older flow that works differently.
- Accounts left the Flow tab: the account chip and Settings already show them.
- On a DorkOS that can tell a person from an agent, only a person can pause, resume or change flow's account settings from DorkOS; an agent calling the same address is turned away. On an older DorkOS that can't, the Flow tab can't pause or resume and says to do it from a chat, and flow's account settings can still be changed from there by anything that can reach it, as before.
- `flow fleet` no longer counts an item a chat only handed to another chat as that chat's own work.

## 0.48.0

**A pause can now end on its own, and flow is ready for DorkOS to answer its questions for you. Reinstall to get it.**

- `/flow:pause for 1 hour` or `/flow:pause until 9am` ends the pause at that time by itself, even with DorkOS closed. A timed pause leaves your schedules on; each run just stops at its first step until the end. `/flow:status` says "Paused until …". A pause that switched schedules off has to be resumed before it can be given an end.
- New `flow review` ships finished work at the review gate, or sends it back with a note. Shipping comments on the item, approves the pull request (unless you wrote it) and arms exactly the commit you approved, refusing if the pull request moved since; sending it back never closes anything.
- New `flow ask` is how an agent parks a question now: it always offers its own pick and says why, so you can answer with one click. New `flow answer` posts your answer; whoever answers first wins.
- Each project can now say how much flow does on its own: ask you first, tell you after, or just do it. You choose it in the project's Flow settings in DorkOS once DorkOS ships that page; `flow autonomy` shows what is in force. Until you choose, nothing changes.
- When you let the reviewer agent ship, VERIFY starts it as a session of its own, in its own copy of the code, so its verdict can be trusted as independent. If the checks are still running, it waits for them instead of handing the work back to you.
- The safety floor now means "someone always checks", not "only a person answers". You can let the reviewer agent ship work it reviewed clean, or let an agent go with its own pick after a deadline. A decision about secrets or spending always waits for you, and nothing on the floor is ever settled by nobody.
- For DorkOS: each run now records when it last changed and which chat launched it, so a chat can show every item it handed off (the shared contract with DorkOS is now 4.1.0). When Linear stops accepting flow's sign-in, flow now says so apart from a slow connection, so only the sign-in ever needs you.

## 0.47.3

**Nothing flow does has changed, and there is no need to reinstall.** The usage file flow shares with DorkOS now spells out one more rule: a usage reading above 100% counts as 100%, and one below 0% counts as 0%.

- flow already read it that way. DorkOS used to throw away the reading, and with it the account's whole usage file, so the account showed as unknown. Pinning the rule in the shared test cases lets both sides prove they agree.

## 0.47.2

**The Flow panel and the Flow tab call this computer's own Claude sign-in "Main (this computer's sign-in)", as DorkOS does. Reinstall to get it.**

- That account's dot now has the colour DorkOS gives it, like your other accounts.
- The panel also marks an account whose usage it can't read yet: its bars are dashed outlines, and it says "unknown" after the name.

## 0.47.1

**If pausing or resuming flow from the Flow panel fails, the panel now says so in one plain sentence. Reinstall to get it.**

- A failed Pause flow or Resume flow now shows "Flow didn't respond, so nothing was changed. Try again." instead of a technical message.

## 0.47.0

**The instructions for each /flow stage are much shorter, so an agent reads less before it does the work. Nothing flow does has changed. Reinstall if you want the shorter versions; your runs work the same either way.**

- The stage instructions (setup, triage, ideate, specify, decompose, execute, verify, done, the backlog clean-up and the team-member loop) went from about 26,000 words to about 9,000. Each one is now roughly 250 to 1,200 words.
- The scheduled jobs (the drain, daily triage, weekly health check and weekly retro) are shorter too. The steps of one run of the queue now live in one place, the `flow-drain` job, and `/flow continue` and `/flow auto` follow it. `/flow` itself is down to about 700 words.
- Every scheduled job now checks the pause the same way, by running the drain's first step, so there is one copy of that check to keep right.
- The stories behind the rules (the first backlog clean-up, the review rubric that went missing outside a git folder, and others) moved to `docs/why.md`, with a table of where each shared rule lives.
- The README no longer repeats what each stage does; it points at the "What flow is" page.
- The guide for building an adapter for a new tracker is about half as long. It points at the adapter rules instead of copying them, and keeps the steps: fill in the tables, build a test file, run the checker until it passes.

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
