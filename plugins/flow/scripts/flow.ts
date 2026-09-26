/**
 * The `flow` CLI entry point (spec `flow-cli-core` §2).
 *
 * Run it as `node --experimental-strip-types <flow-root>/scripts/flow.ts <verb>
 * [args] [flags]`. It owns four things and nothing else:
 *
 * - the verb table ({@link VERBS}), which the parser and `--help` read without
 *   loading any verb module;
 * - the run: parse argv, `import()` the one verb asked for, print its result;
 * - the one mapping from a thrown error to an exit code ({@link classifyError});
 * - the journal line every verb run gets once its arguments parse (`verb`, and
 *   `oracle.error` on exit 70), which never changes the run's output or exit.
 *
 * Every top-level import is dependency-free, so `--help`, a usage error and the
 * "run npm install" hint all work before `npm install`. Verbs that need `zod`
 * load it through their own module, and a failed load exits 6 naming the fix.
 *
 * @module @dorkos/flow/flow
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { invokedDirectly } from './_shared.ts';
import { locateVerb, parseVerbArgs, wantsHelp, wantsJson } from './cli/args.ts';
import {
  createVerbContext,
  realProcessRunner,
  type AdapterFactory,
  type CliDeps,
  type VerbContext,
  type VerbDefinition,
} from './cli/context.ts';
import { recordEvent, recordsVerbRun } from './cli/auto-journal.ts';
import { journalVerb, noteVerb } from './cli/journal-verbs.ts';
import { Output, renderTopHelp, renderVerbHelp } from './cli/output.ts';
import { EXIT, FlowError, UsageError, type ExitCode } from './errors.ts';
import type { Runtime } from './runtime-detect.ts';

/**
 * The verb table. Add a verb with one module under `scripts/cli/` and one entry
 * here whose `load` is `() => import('./cli/<verb>.ts')`. An unregistered verb
 * is a usage error, so no placeholder entry ever ships.
 */
export const VERBS: readonly VerbDefinition[] = [
  {
    name: 'snapshot',
    summary: "Pull the team's backlog once, for reuse with --snapshot.",
    description:
      'Pull every open item of the configured team through the adapter. Prints counts by state and label family, or the whole snapshot with --json. --out also saves it to a file that next, audit and status read with --snapshot.',
    common: ['project'],
    flags: [
      {
        name: 'include-closed',
        kind: 'boolean',
        description: 'Also pull closed items, as titles.',
      },
      {
        name: 'out',
        kind: 'string',
        value: 'file',
        description: 'Also write the snapshot JSON to this file.',
      },
    ],
    load: () => import('./cli/snapshot.ts'),
  },
  {
    name: 'audit',
    summary: 'Check the backlog against the groom invariants.',
    description:
      'Run the groom invariants (audit-backlog.ts) over the backlog and print each one that fails, with the items that break it. Exits 1 when any invariant fails.',
    common: ['project', 'snapshot'],
    load: () => import('./cli/audit.ts'),
  },
  {
    name: 'next',
    summary: 'Show the next item to work on, ranked by the dispatch policy.',
    description:
      'Rank the ready queue with the dispatch policy (the same one dispatch.ts runs), with ownership and work in progress worked out from the backlog. Each pick also gets the account its session should run on (see flow accounts), spreading -n picks across accounts. Nothing eligible still exits 0; "atWipCap" says the cap is what blocks; else "starved" says whether a triage pass would help. Exits 7 while flow is paused, unless --manual.',
    common: ['project', 'snapshot', 'manual'],
    flags: [
      {
        name: 'count',
        kind: 'string',
        short: 'n',
        value: 'N',
        description: 'How many picks to show. Default 1.',
      },
      {
        name: 'for-project',
        kind: 'string',
        value: 'name|id',
        description: 'Only consider items in this project (its id, or its name in any case).',
      },
      {
        name: 'no-account',
        kind: 'boolean',
        description: 'Do not pick the account each item should run on.',
      },
    ],
    load: () => import('./cli/next.ts'),
  },
  {
    name: 'accounts',
    summary: 'List the accounts flow may spend, add one, or set how flow routes work to them.',
    description: [
      'flow accounts [list]: every account of each runtime with its role, reserve and room, and the fleet settings. Drops the policy of an account no longer registered.',
      'flow accounts add --path <dir> [--label <text>] [--color <#rrggbb>]: register a Claude Code account. It starts kept out.',
      'flow accounts set <id> [--role] [--reserve] [--spend-down-hours] [--repos]: set one account\'s policy. <id> is a Claude Code id, or <runtime>:<id> (codex:default). "default" clears a field.',
      'flow accounts set --handoff auto|ask | --runtimes <runtime,...> | --cross-runtime-fallback off|on: set one fleet-wide setting ("default" clears it).',
      'Reads and writes <dorkHome> (DORK_HOME, else ~/.dork); needs no tracker and no project config.',
    ].join('\n'),
    common: ['dry-run'],
    positionals: [
      { name: 'action', description: 'list (default), add or set.' },
      { name: 'id', description: 'The account, for set: <id> or <runtime>:<id>.' },
    ],
    flags: [
      {
        name: 'path',
        kind: 'string',
        value: 'dir',
        description: "add: the account's CLAUDE_CONFIG_DIR.",
      },
      {
        name: 'label',
        kind: 'string',
        value: 'text',
        description: 'add: your name for the account.',
      },
      { name: 'color', kind: 'string', value: '#rrggbb', description: 'add: its display color.' },
      {
        name: 'role',
        kind: 'string',
        value: 'main|rotation|kept-out',
        description: 'set: how flow may spend it.',
      },
      {
        name: 'reserve',
        kind: 'string',
        value: '0-100',
        description: 'set: share of the 7-day window kept for you.',
      },
      {
        name: 'spend-down-hours',
        kind: 'string',
        value: 'n',
        description: 'set: hours before the 7-day reset when the reserve drops to 0.',
      },
      {
        name: 'repos',
        kind: 'string',
        value: 'owner/name,...|none',
        description: 'set: the only repos a kept-out account may serve.',
      },
      {
        name: 'handoff',
        kind: 'string',
        value: 'auto|ask',
        description: 'set (no id): move work off a spent account on its own, or ask first.',
      },
      {
        name: 'runtimes',
        kind: 'string',
        value: 'runtime,...',
        description:
          'set (no id): runtimes in order of preference. Default: the one each item started on.',
      },
      {
        name: 'cross-runtime-fallback',
        kind: 'string',
        value: 'off|on',
        description: 'set (no id): let work move to another runtime when its own is out.',
      },
    ],
    load: () => import('./cli/accounts.ts'),
  },
  {
    name: 'status',
    summary: 'Show what is in flight, what is parked, the drain, the pause and any drift.',
    description:
      'Joins the run records, the drain sentinel, the pause and the backlog. Drift is a running run whose item is not started, a claimed item with no run, a run whose worker is gone, or a STATE-n breach on an in-flight item. With an identifier: that item only, plus its last parked question.',
    common: ['project', 'snapshot'],
    positionals: [{ name: 'identifier', description: 'Show only this item.' }],
    flags: [{ name: 'strict', kind: 'boolean', description: 'Exit 1 when there is drift.' }],
    load: () => import('./cli/status.ts'),
  },
  {
    name: 'claim',
    summary: 'Start working an item: mark it claimed and record the run.',
    description:
      "Start working an item. It must be open, carry agent/ready, not be claimed, and be claimable under the ownership settings. Moves it to started with agent/claimed and no stage/* label, then records the run in flow-state.json. Posts no comment. Needs a session id: --session, FLOW_SESSION_ID, or the runtime's own.",
    common: ['project', 'dry-run', 'session', 'manual'],
    positionals: [{ name: 'identifier', required: true, description: 'The item, e.g. DOR-123.' }],
    flags: [
      {
        name: 'pid',
        kind: 'string',
        value: 'N',
        description: 'The worker process id. Default: the parent of the calling shell.',
      },
      {
        name: 'worktree',
        kind: 'string',
        value: 'path',
        description: 'The worktree the run works in. Default: the checkout root.',
      },
      {
        name: 'branch',
        kind: 'string',
        value: 'name',
        description: 'The branch the run works on. Default: the checkout branch.',
      },
      {
        name: 'account',
        kind: 'string',
        value: 'id',
        description: 'The account this session bills.',
      },
      {
        name: 'host',
        kind: 'string',
        value: 'cli|dorkos|cmux',
        description: 'The launcher this session runs under.',
      },
      {
        name: 'runtime',
        kind: 'string',
        value: 'claude-code|codex|opencode',
        description: 'The runtime this session runs on. Default: the one running this command.',
      },
    ],
    load: () => import('./cli/claim.ts'),
  },
  {
    name: 'release',
    summary: 'Let go of an item: back to the ready queue, or unowned.',
    description:
      'Let go of an item. --to ready (the default) makes it unstarted with agent/ready and a stage/* label to resume at; --to none leaves it unowned. Deletes the run record. Posts a signed comment only with --reason.',
    common: ['project', 'dry-run', 'session'],
    positionals: [{ name: 'identifier', required: true, description: 'The item, e.g. DOR-123.' }],
    flags: [
      {
        name: 'to',
        kind: 'string',
        value: 'ready|none',
        description: 'Where the item goes. Default: ready.',
      },
      {
        name: 'stage',
        kind: 'string',
        value: 'stage',
        description: 'The stage to resume at. Default: the run record, else the item.',
      },
      {
        name: 'reason',
        kind: 'string',
        value: 'text',
        description: 'Post this as a signed comment.',
      },
    ],
    load: () => import('./cli/release.ts'),
  },
  {
    name: 'done',
    summary: 'Finish an item: post the summary and close it.',
    description:
      'Finish an item. Posts the summary as a signed comment (skipped when one of the last 10 comments already says the same), moves it to completed with agent/completed and no stage/* label, and marks the run complete.',
    common: ['project', 'dry-run', 'session'],
    positionals: [{ name: 'identifier', required: true, description: 'The item, e.g. DOR-123.' }],
    flags: [
      { name: 'summary', kind: 'string', value: 'text', description: 'The completion summary.' },
      {
        name: 'summary-file',
        kind: 'string',
        value: 'path',
        description: 'Read the summary from this file.',
      },
      {
        name: 'pr',
        kind: 'string',
        value: 'url',
        description: 'The pull request, added to the summary.',
      },
    ],
    load: () => import('./cli/done.ts'),
  },
  {
    name: 'stage',
    summary: 'Move an item to another stage.',
    description:
      'Move an item to a stage from config. A started or completed stage removes every stage/* label; any other stage sets its label. Updates the run record when there is one. With --checkpoint-file, first writes the HANDOFF.md checkpoint for the new stage; a drain run must pass it.',
    common: ['project', 'dry-run', 'session'],
    positionals: [
      { name: 'identifier', required: true, description: 'The item, e.g. DOR-123.' },
      { name: 'stage', required: true, description: 'A key of stages in config.' },
    ],
    flags: [
      {
        name: 'checkpoint-file',
        kind: 'string',
        value: 'file',
        description:
          'The checkpoint body (Done, Next, Open questions, Next command), relative to --project.',
      },
    ],
    load: () => import('./cli/stage.ts'),
  },
  {
    name: 'checkpoint',
    summary: "Write the item's HANDOFF.md checkpoint in this worktree.",
    description:
      "Write .dork/flow/HANDOFF.md in the item's worktree, keeping the last one as HANDOFF.prev.md. The body file holds four ## sections: Done, Next, Open questions, Next command. flow measures the header (branch, commits, what is pushed) and records the checkpoint on the item's run.",
    common: ['project', 'session'],
    positionals: [
      { name: 'identifier', required: true, description: 'The work item, e.g. ACME-12.' },
    ],
    flags: [
      {
        name: 'trigger',
        kind: 'string',
        value: 'trigger',
        description:
          'Why it is written: stage, task, fix, limit-warning, limit-rejected, manual or synthesized.',
      },
      {
        name: 'body-file',
        kind: 'string',
        value: 'file',
        description: 'The body: Done, Next, Open questions, Next command. Relative to --project.',
      },
      {
        name: 'task',
        kind: 'string',
        value: 'id',
        description: 'The task this checkpoint follows. Required with --trigger task.',
      },
      {
        name: 'spec',
        kind: 'string',
        value: 'path',
        description: 'The spec the work follows, relative to the repository.',
      },
      {
        name: 'stage',
        kind: 'string',
        value: 'stage',
        description:
          "Where the next session resumes. Default: the run's stage; required when the item has no run.",
      },
    ],
    load: () => import('./cli/checkpoint.ts'),
  },
  {
    name: 'report',
    summary: 'Tell the drain a push, a review verdict or a question (drain workers and reviewers).',
    description: [
      'Record what happened on a drain run. flow checks each claim before recording it.',
      '  pushed [--sha <sha>]   The commit (default HEAD) is on origin and has a checkpoint. Disarms an armed PR until it is reviewed.',
      '  verdict --sha <sha> --token <t> (--clean | --changes --findings-file <f>)',
      "                         The reviewer's verdict. The token comes from the reviewer's brief. A verdict on an older push is ignored.",
      '  blocked --question-file <f>',
      '                         Post the question on the item, mark it needs-input, and park the run.',
    ].join('\n'),
    common: ['project', 'session'],
    positionals: [
      { name: 'identifier', required: true, description: 'The work item, e.g. ACME-12.' },
      { name: 'kind', required: true, description: 'pushed, verdict or blocked.' },
    ],
    flags: [
      { name: 'sha', kind: 'string', value: 'sha', description: 'The commit pushed or reviewed.' },
      {
        name: 'token',
        kind: 'string',
        value: 'token',
        description: "The review token from the reviewer's brief.",
      },
      { name: 'clean', kind: 'boolean', description: 'The review found nothing to change.' },
      { name: 'changes', kind: 'boolean', description: 'The review asks for changes.' },
      {
        name: 'findings-file',
        kind: 'string',
        value: 'file',
        description: 'The findings, with --changes.',
      },
      {
        name: 'question-file',
        kind: 'string',
        value: 'file',
        description: 'The question for a person, with blocked.',
      },
    ],
    load: () => import('./cli/report.ts'),
  },
  {
    name: 'pr',
    summary: "Open a drain run's pull request after a clean review.",
    description:
      "Open the run's pull request into origin's default branch. Refuses unless the latest review is CLEAN at the branch head on origin. Adds a provenance line to the body. If a PR is already open for the branch, records it and exits 5.",
    common: ['project', 'session'],
    positionals: [
      { name: 'identifier', required: true, description: 'The work item, e.g. ACME-12.' },
    ],
    flags: [
      { name: 'title', kind: 'string', value: 'text', description: 'The PR title.' },
      { name: 'body-file', kind: 'string', value: 'file', description: 'The PR body.' },
      { name: 'arm', kind: 'boolean', description: 'Arm auto-merge on the new PR.' },
      {
        name: 'no-arm',
        kind: 'boolean',
        description: 'Leave auto-merge off. Default: drain.armAutoMerge (off).',
      },
    ],
    load: () => import('./cli/pr.ts'),
  },
  {
    name: 'drain',
    summary:
      'Carry several ready items at once: a worker per item on its own account, and a review before any PR.',
    description: [
      'Each pass checks every drain run (sessions, reports, the PR, the tracker item), sends each worker its next message, starts a reviewer for each push, and fills free slots with the next ready items, each on the account with the most room.',
      'A PR opens only after a clean review at the branch head (flow pr enforces it). No new session starts while the machine is busy.',
      '--tick runs one pass and exits (for a scheduler); otherwise it passes every drain.pollSeconds until nothing is active or eligible, or Ctrl-C, which leaves every session running. One drain per project (exit 5 while another runs). Exits 7 while flow is paused, unless --manual.',
    ].join('\n'),
    common: ['project', 'manual', 'dry-run'],
    flags: [
      {
        name: 'parallel',
        kind: 'string',
        value: 'N',
        description: 'Sessions at once. Default drain.parallel.',
      },
      {
        name: 'host',
        kind: 'string',
        value: 'auto|cli|cmux|dorkos',
        description: 'Where sessions run. Default drain.host, else auto.',
      },
      {
        name: 'items',
        kind: 'string',
        value: 'id,...',
        description: 'Only these items, in this order.',
      },
      {
        name: 'permission-mode',
        kind: 'string',
        value: 'mode',
        description: 'default, acceptEdits or bypassPermissions. Default drain.permissionMode.',
      },
      { name: 'tick', kind: 'boolean', description: 'Run one pass, then exit.' },
    ],
    load: () => import('./cli/drain.ts'),
  },
  {
    name: 'handoff',
    summary: 'Move a drain run to another account now, or hold a limited one where it is.',
    description: [
      "Stops the run's session, makes sure HANDOFF.md is current, and starts a new session on the other account in the same worktree, told to read HANDOFF.md and the old session's transcript. This is how you approve the move flow asks for in ask mode.",
      '--to must be an account that may take the item (else exit 5 with its reasons); without --to, the best one. --wait keeps a limited run on its own account until --until, or until the account resets. While a flow drain is running, only a limited run can be moved (exit 5).',
    ].join('\n'),
    common: ['project'],
    positionals: [
      { name: 'identifier', required: true, description: 'The work item, e.g. ACME-12.' },
    ],
    flags: [
      {
        name: 'to',
        kind: 'string',
        value: 'runtime:account',
        description: "The account to move to. A bare id means one of the run's runtime.",
      },
      {
        name: 'wait',
        kind: 'boolean',
        description: 'Hold a limited run on its own account instead of moving it.',
      },
      {
        name: 'until',
        kind: 'string',
        value: 'iso',
        description: 'With --wait: hold until then. Default: until the account resets.',
      },
      {
        name: 'reason',
        kind: 'string',
        value: 'text',
        description: 'Why, in a few words, for the checkpoint flow writes.',
      },
    ],
    load: () => import('./cli/handoff.ts'),
  },
  {
    name: 'limit-check',
    summary: "Say whether a run's account is near a usage limit.",
    description: [
      "With an item: print its account's usage signal (ok, warning, exhausted or unknown).",
      'With --hook: the Claude Code PostToolUse hook. It tells a drain worker, once per limit, to finish its step, checkpoint and stop. It prints nothing for any other session and always exits 0.',
    ].join('\n'),
    common: ['project'],
    positionals: [{ name: 'identifier', description: 'The work item, e.g. ACME-12.' }],
    flags: [
      {
        name: 'hook',
        kind: 'boolean',
        description: "Run as the PostToolUse hook: read the hook's JSON on stdin.",
      },
    ],
    load: () => import('./cli/limit-check.ts'),
  },
  {
    name: 'watch',
    summary: 'Wait until a watched pull request merges, closes, goes red or leaves the queue.',
    description:
      "Watch the named runs' pull requests (default: every run with one), plus any --pr. Prints one line per event: MERGED, CLOSED, FAILING: <checks>, EJECTED (innocent|suspect|unknown) or NOT-ARMED-NOT-QUEUED. Exits 0 on the first event unless --follow. Five failed reads in a row for one PR exit 4.",
    common: ['project'],
    positionals: [
      {
        name: 'identifier',
        variadic: true,
        description: 'Work items whose PRs to watch. Default: every run with a PR.',
      },
    ],
    flags: [
      {
        name: 'pr',
        kind: 'string',
        value: 'owner/repo#n',
        repeatable: true,
        description: 'Also watch this pull request. Repeatable; needs no flow project.',
      },
      {
        name: 'follow',
        kind: 'boolean',
        description: 'Keep watching after an event, until every PR merged or closed.',
      },
      {
        name: 'interval',
        kind: 'string',
        value: 's',
        description: 'Seconds between rounds. Default 90.',
      },
    ],
    load: () => import('./cli/watch.ts'),
  },
  {
    name: 'usage',
    summary: "Record each account's usage, clear out stale usage files, or set up the status line.",
    description: [
      'Sub-verbs:',
      '  record              Read usage on stdin and save it: the status-line JSON, or with --runtime codex a',
      '                      Codex rate_limits object or session-log line.',
      '  scan                Recover past usage from saved conversations (Codex: its session logs).',
      '  probe <id>          Run one short official turn on an account to read its usage (needs --yes).',
      "  install-statusline  Add the two recorder lines to each account's status-line script (needs --yes).",
      '  prune               List usage files nobody needs (unregistered accounts, old leftovers); --yes deletes them.',
      '  snapshot            Add a sampled usage line to the flow journal for each account (a drain runs this).',
    ].join('\n'),
    common: ['dry-run'],
    flags: [
      {
        name: 'account',
        kind: 'string',
        value: 'id',
        description: 'Only this account (record, scan, install-statusline).',
      },
      {
        name: 'runtime',
        kind: 'string',
        value: 'runtime',
        description: 'record, scan: claude-code (default), codex or opencode.',
      },
      { name: 'verbose', kind: 'boolean', description: 'record: say on stderr what happened.' },
      {
        name: 'days',
        kind: 'string',
        value: 'n',
        description: 'scan: read files changed in the last n days. Default 8.',
      },
      { name: 'all', kind: 'boolean', description: 'scan: read every file.' },
      {
        name: 'yes',
        kind: 'boolean',
        description:
          'probe, install-statusline, prune: go ahead. Without it nothing runs or changes.',
      },
      {
        name: 'remove',
        kind: 'boolean',
        description: 'install-statusline: take the recorder lines out again.',
      },
      {
        name: 'model',
        kind: 'string',
        value: 'alias',
        description: 'probe: the model for the turn. Default haiku.',
      },
      {
        name: 'timeout',
        kind: 'string',
        value: 's',
        description: 'probe: give up after this many seconds. Default 90.',
      },
      {
        name: 'claude',
        kind: 'string',
        value: 'path',
        description: 'probe: the claude binary. Default FLOW_CLAUDE_BIN, else claude on PATH.',
      },
    ],
    positionals: [
      {
        name: 'sub-verb',
        description: 'record, scan, probe, install-statusline, prune or snapshot.',
      },
      { name: 'id', description: 'probe: the account id.' },
    ],
    load: () => import('./cli/usage.ts'),
  },
  {
    name: 'fleet',
    summary: 'Show every account and every running session on one screen. Changes nothing.',
    description: [
      "Show each account's 5-hour and weekly usage, and each running session with its",
      'account, item, state and host. Reads only; the one request it may make goes to',
      'a DorkOS on this machine.',
    ].join('\n'),
    common: ['project'],
    flags: [
      {
        name: 'dorkos-url',
        kind: 'string',
        value: 'url',
        description:
          'The DorkOS to ask. Default FLOW_DORKOS_URL, else http://127.0.0.1:<DORKOS_PORT or 4242>.',
      },
      { name: 'no-dorkos', kind: 'boolean', description: 'Do not ask DorkOS at all.' },
    ],
    load: () => import('./cli/fleet.ts'),
  },
  noteVerb,
  journalVerb,
  {
    name: 'selftest',
    summary: 'Check this flow install, its prose, and how its commands behave.',
    description:
      'Runs the fast checks (config, adapter conformance, the prose rules) and the scenarios (the flow commands against a fake tracker, in a temp folder). Saves the report to .dork/flow/selftest/. Exits 1 when a check fails, or with --strict when one is skipped.',
    common: ['project'],
    flags: [
      {
        name: 'tier',
        kind: 'string',
        value: 'fast|scenarios|live|all',
        description:
          'The tier to run. Default: fast and scenarios. live runs a real model and costs money: it needs FLOW_SELFTEST_LIVE=1 and never runs in CI.',
      },
      {
        name: 'max-usd',
        kind: 'string',
        value: 'amount',
        description:
          'The most the live tier may spend, in US dollars. Default: selfImprovement.selftest.liveBudgetUsd.',
      },
      { name: 'strict', kind: 'boolean', description: 'A skipped check fails the run.' },
      {
        name: 'file',
        kind: 'boolean',
        description: 'Turn each failure into tracker work, once; the report says what it did.',
      },
      { name: 'no-save', kind: 'boolean', description: 'Do not write .dork/flow/selftest/.' },
      {
        name: 'rebaseline',
        kind: 'boolean',
        description: "Lower the prose word budgets to today's counts, then stop.",
      },
    ],
    load: () => import('./cli/selftest.ts'),
  },
  {
    name: 'retro',
    summary: "Look back over flow's own runs, report the measures, and propose changes.",
    description:
      'Reads the journal for the window and the one before, the self-test history, the backlog and the prose word counts. Writes .dork/flow/retro/<date>.json and .md and one journal line. Changes nothing in the tracker unless --file. Proposals over maxItemsPerRun wait for a later run and do not fail it; exits 1 when --file cannot act on a proposal (no create capability, or a tracker error).',
    common: ['project', 'snapshot', 'session'],
    flags: [
      {
        name: 'since',
        kind: 'string',
        value: 'duration',
        description: 'How far back to look: 7d, 48h, 2w. Default selfImprovement.retro.window.',
      },
      {
        name: 'file',
        kind: 'boolean',
        description: 'File the proposals as tracker items, once each, up to maxItemsPerRun.',
      },
      {
        name: 'input',
        kind: 'string',
        value: 'proposals.json',
        description: 'With --file: file this edited list of proposals instead.',
      },
    ],
    load: () => import('./cli/retro.ts'),
  },
];

/** The plugin folder, `<flow-root>`: the parent of `scripts/`. */
const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** {@link CliDeps} plus the entry's own seams, which tests override. */
export interface MainDeps extends CliDeps {
  /** The verb table. Default {@link VERBS}; tests register test-only verbs here. */
  verbs?: readonly VerbDefinition[];
  /** The plugin folder named in the install hint. Default: this file's `..`. */
  flowRoot?: string;
  /**
   * A monotonic clock in milliseconds that times a verb run for its journal
   * line. Default `performance.now`. Kept apart from `now` so timing a run
   * never reads the clock a verb (or a test's scripted clock) counts on.
   */
  elapsedMs?: () => number;
}

/** An exit code and the plain sentence printed with it. */
export interface ClassifiedError {
  /** The exit code the run ends with. */
  code: ExitCode;
  /** The message for stderr and the JSON envelope. */
  message: string;
}

/**
 * Whether an error is Node failing to find the `zod` package (or a subpath of
 * it), as opposed to any other missing module.
 */
function isMissingZod(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ERR_MODULE_NOT_FOUND' && /'zod(\/[^']*)?'/.test(error.message);
}

/**
 * The one place a thrown error becomes an exit code.
 *
 * - A missing `zod` is exit 6 with the install line.
 * - A typed error from `scripts/errors.ts` carries its own code (2, 3, 4, 5, 7).
 * - Anything else is a bug in flow: exit 70, labelled as an internal error.
 *
 * @param error - What was thrown.
 * @param flowRoot - The plugin folder, named in the install hint.
 * @returns The exit code and the message to print.
 */
export function classifyError(error: unknown, flowRoot: string): ClassifiedError {
  if (isMissingZod(error)) {
    return { code: EXIT.dependency, message: `run "npm install --omit=dev" in ${flowRoot}` };
  }
  if (error instanceof FlowError) return { code: error.exitCode, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { code: EXIT.internal, message: `internal error: ${message}` };
}

/**
 * Run one `flow` invocation.
 *
 * Never throws and never exits the process: every outcome, errors included, is
 * printed through the injected streams and returned as the exit code.
 *
 * @param argv - The arguments after the script path.
 * @param deps - The injected world (env, cwd, clock, streams, adapter factory,
 *   process runner) plus optional test seams.
 * @returns The exit code.
 */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const verbs = deps.verbs ?? VERBS;
  const flowRoot = deps.flowRoot ?? FLOW_ROOT;
  const output = new Output(wantsJson(argv), deps.stdout, deps.stderr);
  const elapsed = deps.elapsedMs ?? (() => performance.now());
  let run: VerbRun | undefined;

  try {
    const location = locateVerb(argv);
    if (location === undefined) {
      if (!wantsHelp(argv)) throw new UsageError('no verb given; run "flow --help" for the list');
      output.help(renderTopHelp(verbs));
      return EXIT.ok;
    }

    const verb = verbs.find((candidate) => candidate.name === location.verb);
    if (verb === undefined) {
      throw new UsageError(`unknown verb "${location.verb}"; run "flow --help" for the list`);
    }
    if (wantsHelp(argv)) {
      output.help(renderVerbHelp(verb), verb.name);
      return EXIT.ok;
    }

    const args = parseVerbArgs(argv, location, verb);
    const ctx = createVerbContext(args, deps, flowRoot, (message) => output.warn(message));
    // From here the run is a verb run, and it is journaled however it ends.
    run = { ctx, verb, startedMs: elapsed() };
    const module = await verb.load();
    const result = await module.run(ctx);
    output.result(result);
    const code = result.exitCode ?? EXIT.ok;
    journalRun(run, elapsed, code, { runtime: result.runtime });
    return code;
  } catch (error) {
    const { code, message } = classifyError(error, flowRoot);
    output.error(code, message);
    if (run !== undefined) journalRun(run, elapsed, code, { error });
    return code;
  }
}

/** A verb run in progress: what {@link journalRun} records once it ends. */
interface VerbRun {
  /** The verb's context. */
  ctx: VerbContext;
  /** The verb. */
  verb: VerbDefinition;
  /** When the run started, from the monotonic clock. */
  startedMs: number;
}

/**
 * Journal a finished verb run: a `verb` line with its time and exit code and,
 * when it failed with an internal error (a bug in flow or in an oracle it
 * runs), an `oracle.error` line with the error's first line, whatever the
 * verb. `note` and `journal` (which write their own lines) get no `verb` line,
 * and `usage record` gets one only when it fails: see {@link recordsVerbRun}.
 * The `verb` line's runtime is the one the verb reported (`VerbResult.runtime`),
 * else the environment's; a verb that threw reports none, so a refused
 * `flow claim --runtime x` is recorded under the runtime that ran it.
 * Never throws and never prints: see `cli/auto-journal.ts`.
 */
function journalRun(
  run: VerbRun,
  elapsed: () => number,
  code: number,
  outcome: { error?: unknown; runtime?: Runtime } = {}
): void {
  const { ctx, verb } = run;
  const { error, runtime } = outcome;
  try {
    const identifier =
      verb.positionals?.[0]?.name === 'identifier' ? ctx.args.positionals[0] : undefined;
    const item = identifier === undefined ? {} : { item: identifier };
    const ms = Math.max(0, Math.round(elapsed() - run.startedMs));
    if (recordsVerbRun(verb.name, ctx.args.positionals, code)) {
      recordEvent(ctx, { kind: 'verb', verb: verb.name, ms, exit: code, ...item }, runtime);
    }
    if (code === EXIT.internal) {
      const message = error instanceof Error ? error.message : String(error);
      recordEvent(ctx, {
        kind: 'oracle.error',
        oracle: verb.name,
        exit: code,
        errorClass: message.split(/\r?\n/, 1)[0] ?? '',
        ...item,
      });
    }
  } catch {
    // The clock or the error itself misbehaved; the run's outcome stands.
  }
}

/**
 * The adapter factory the script wires (spec §4). `tracker/load.ts` needs zod
 * (through config loading), so it is imported only when a verb asks for the
 * tracker; a missing install then exits 6 through {@link classifyError}.
 */
const createCodeAdapter: AdapterFactory = async (request) => {
  const load = await import('./tracker/load.ts');
  return load.createCodeAdapter(request);
};

// Not a top-level await: `flow selftest` runs scenarios that import this module
// for `main`, and a module still awaiting its own evaluation would make that
// import wait forever (Node exits 13).
if (invokedDirectly(import.meta.url)) {
  void main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    stdout: process.stdout,
    stderr: process.stderr,
    createAdapter: createCodeAdapter,
    runProcess: realProcessRunner,
  }).then((code) => {
    process.exitCode = code;
  });
}
