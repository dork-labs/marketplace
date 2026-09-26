/**
 * Scenario `lifecycle`: one item from capture to done, through the real `flow`
 * verbs, once per harness shape (spec `specs/flow-self-improvement` §1).
 *
 * capture, then triage-accept, then `flow next`, `flow claim`, a merged PR
 * with `Closes <id>`, and `flow done`, checking the item's state and labels on
 * the fake after every step, the signed completion comment and its provenance
 * line, and the run record.
 *
 * Capture and triage have no `flow` verb: they are judgment carried by the
 * capturing-work and triaging-work skills. So the item is SEEDED as captured,
 * and triage-accept is applied through the adapter with the same work-state
 * helper every writer uses (`projectionFor`), plus the fields the adapter
 * contract cannot write (type, priority, size, the description), which a
 * triage writer sets with the tracker's own tools.
 *
 * Runtime-parameterized: the same run as a Claude Code-shaped session
 * (`CLAUDECODE=1`) and a Codex-shaped one (`CODEX_THREAD_ID`, no `CLAUDECODE`),
 * asserting what each records (see {@link RECORDED}): `detectRuntime` must
 * read the environment as that runtime, and a `flow note` written during the
 * run must land in the journal stamped with it.
 *
 * @module @dorkos/flow/selftest/scenarios/lifecycle
 */

import { PROVENANCE_MARKER } from '../../cli/provenance.ts';
import { journalFor, read as readJournal, runtimeOf } from '../../journal.ts';
import { detectRuntime } from '../../runtime-detect.ts';
import { verifyWrite } from '../../tracker/verify-write.ts';
import { AGENT_READY, projectionFor, type StageTable } from '../../work-state.ts';
import {
  check,
  checkEqual,
  family,
  seedItem,
  type ScenarioContext,
  type ScenarioOptions,
  withScenario,
} from './harness.ts';

/** The harness shapes the lifecycle runs under. */
export type RuntimeShape = 'claude-code' | 'codex';

/** The environment each harness shape gives a `flow` command. */
export const RUNTIME_ENV: Readonly<Record<RuntimeShape, Record<string, string>>> = {
  'claude-code': {
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'claude-session-1',
    CLAUDE_CONFIG_DIR: '/home/selftest/.claude-work',
  },
  codex: { CODEX_THREAD_ID: 'codex-thread-1' },
};

/** What a run records about its session, per harness shape. */
export interface Recorded {
  /** What `detectRuntime` says the environment is, and every journal line's `runtime`. */
  runtime: RuntimeShape;
  /** Every journal line's `harness` (no cmux panel and no `FLOW_HARNESS` here). */
  journalHarness: string;
  /** The provenance line's (and the run record's) `harness`; absent = left out. */
  harness?: string;
  /** The run record's `sessionId` (`''` = unknown, never invented). */
  sessionId: string;
  /** The provenance line's `account`; absent = left out. */
  account?: string;
}

/**
 * What a run records today. The journal is runtime-aware (`runtimeOf` in
 * `journal.ts`, over `detectRuntime`), so its lines say `codex` or
 * `claude-code`. The provenance line and the run record are not yet: only
 * Claude Code's marker and session variable are read there, so a Codex run
 * signs with no harness and records its session as unknown.
 */
export const RECORDED: Readonly<Record<RuntimeShape, Recorded>> = {
  'claude-code': {
    runtime: 'claude-code',
    journalHarness: 'claude-code',
    harness: 'claude-code',
    sessionId: 'claude-session-1',
    account: '.claude-work',
  },
  codex: { runtime: 'codex', journalHarness: 'codex', sessionId: '' },
};

/** The item the scenario carries through. */
const ID = 'FAKE-1';

/** The last provenance line of a body, parsed, or `undefined`. */
function provenanceOf(body: string): Record<string, unknown> | undefined {
  const lines = body.trimEnd().split('\n');
  const match = new RegExp(`^<!-- ${PROVENANCE_MARKER} (\\{.*\\}) -->$`).exec(lines.at(-1) ?? '');
  return match === null ? undefined : (JSON.parse(match[1]) as Record<string, unknown>);
}

/** Check the item's category, display state and `agent/*` and `stage/*` labels. */
function expectItem(
  ctx: ScenarioContext,
  step: string,
  want: { category: string; state: string; agent: string[]; stage: string[] }
): void {
  const item = ctx.item(ID);
  checkEqual(item.stateCategory, want.category, `after ${step}, ${ID}'s state category`);
  checkEqual(item.stateName, want.state, `after ${step}, ${ID}'s state`);
  checkEqual(family(item, 'agent/'), want.agent, `after ${step}, ${ID}'s agent/* labels`);
  checkEqual(family(item, 'stage/'), want.stage, `after ${step}, ${ID}'s stage/* labels`);
}

/**
 * Run the lifecycle under one harness shape.
 *
 * @param runtime - The harness shape.
 * @param options - The flow root and the tracker factory.
 */
export async function lifecycle(runtime: RuntimeShape, options: ScenarioOptions): Promise<void> {
  const env = RUNTIME_ENV[runtime];
  const recorded = RECORDED[runtime];
  const detected = detectRuntime(env);
  checkEqual(
    { runtime: detected.runtime, harness: runtimeOf(env).harness },
    { runtime: recorded.runtime, harness: recorded.journalHarness },
    `detectRuntime on the ${runtime}-shaped environment`
  );

  await withScenario(options, async (ctx) => {
    // 1. Captured: in the backlog, with an origin, not ready.
    const tracker = ctx.seed({
      items: [
        seedItem(ID, {
          title: 'Let people export a report as CSV',
          description: 'Someone asked for a CSV export.',
          stateCategory: 'backlog',
          stateName: 'Triage',
          labels: ['origin/human'],
        }),
      ],
    });
    expectItem(ctx, 'capture', { category: 'backlog', state: 'Triage', agent: [], stage: [] });
    checkEqual(family(ctx.item(ID), 'origin/'), ['origin/human'], `${ID}'s origin/* labels`);

    // 2. Triage-accept. The fields the adapter cannot write are set as the
    // tracker's own tools would; the label and state change goes through the
    // projection table like every writer's. Its "hand to the ready queue at a
    // stage" row is `release` to `ready`, the state a triage-accept leaves.
    const stored = ctx.item(ID);
    stored.type = 'task';
    stored.labels.push('type/task');
    stored.priority = 2;
    stored.size = 3;
    stored.description =
      'Add a CSV export.\n\n## Validation criteria\n\n- The file opens in a spreadsheet.\n\n## On Completion\n\n- Nothing further.';
    const config = ctx.loadedConfig();
    const accept = projectionFor(
      { type: 'release', to: 'ready', stage: 'execute' },
      { stages: config.stages as StageTable }
    );
    const before = await tracker.adapter.getItem(ID);
    await tracker.adapter.applyWorkState(before, accept);
    await verifyWrite(tracker.adapter, before, accept);
    expectItem(ctx, 'triage-accept', {
      category: 'unstarted',
      state: 'Todo',
      agent: [AGENT_READY],
      stage: ['stage/execute'],
    });
    checkEqual(family(ctx.item(ID), 'type/'), ['type/task'], `${ID}'s type/* labels`);
    check(ctx.item(ID).priority !== undefined, `after triage-accept, ${ID} has no priority`);

    // 3. `flow next` picks it.
    const next = await ctx.flowOk(['next'], env);
    const picked = (next.json.picked as { identifier: string }[] | undefined) ?? [];
    checkEqual(
      picked.map((p) => p.identifier),
      [ID],
      'flow next picks'
    );

    // 4. `flow claim`: started, agent/claimed, no agent/ready, no stage/*.
    const claim = await ctx.flowOk(
      ['claim', ID, '--pid', String(process.pid), '--worktree', ctx.projectDir, '--branch', 'work'],
      env
    );
    expectItem(ctx, 'flow claim', {
      category: 'started',
      state: 'In Progress',
      agent: ['agent/claimed'],
      stage: [],
    });
    const run = ctx.runs()[`id-${ID}`];
    check(run !== undefined, `flow claim recorded no run for ${ID}`);
    checkEqual(run.status, 'running', 'the run status after flow claim');
    checkEqual(run.stage, 'execute', 'the run stage after flow claim');
    checkEqual(run.sessionId, recorded.sessionId, `the ${runtime} run's session id`);
    checkEqual(run.provenance?.harness, recorded.harness, `the ${runtime} run's harness`);
    if (recorded.sessionId === '') {
      check(
        claim.stderr.includes('no session id'),
        `flow claim under ${runtime} recorded no session id without saying so`
      );
    }

    // 5. The PR merges with a closing reference: the tracker closes the item
    // and leaves its labels.
    ctx.clock.advance(60_000);
    checkEqual(
      tracker.mergePr({ body: `Adds the export.\n\nCloses ${ID}` }),
      [ID],
      'mergePr closes'
    );
    expectItem(ctx, 'the merge', {
      category: 'completed',
      state: 'Done',
      agent: ['agent/claimed'],
      stage: [],
    });

    // 6. `flow done`: agent/completed, one signed comment with a provenance line.
    ctx.clock.advance(60_000);
    const doneArgs = [
      'done',
      ID,
      '--summary',
      'Added the CSV export.',
      '--pr',
      'https://example.test/pr/1',
    ];
    await ctx.flowOk(doneArgs, env);
    expectItem(ctx, 'flow done', {
      category: 'completed',
      state: 'Done',
      agent: ['agent/completed'],
      stage: [],
    });
    const comments = tracker.backlog.comments?.[ID] ?? [];
    checkEqual(comments.length, 1, `comments on ${ID} after flow done`);
    const [comment] = comments;
    checkEqual(comment.author, tracker.user.id, 'the completion comment author');
    check(
      comment.body.includes(config.identity.marker),
      `the completion comment lacks the identity marker ${config.identity.marker}`
    );
    const provenance = provenanceOf(comment.body);
    check(
      provenance !== undefined,
      'the completion comment has no provenance line as its last line'
    );
    checkEqual(provenance.harness, recorded.harness, `the ${runtime} provenance harness`);
    checkEqual(
      provenance.sessionId,
      recorded.sessionId === '' ? undefined : recorded.sessionId,
      `the ${runtime} provenance session id`
    );
    checkEqual(provenance.account, recorded.account, `the ${runtime} provenance account`);
    checkEqual(ctx.runs()[`id-${ID}`]?.status, 'complete', 'the run status after flow done');

    // A note written during the run is journaled as this runtime.
    await ctx.flowOk(
      ['note', '--kind', 'friction', '--item', ID, 'The export needed a guess.'],
      env
    );
    const journal = journalFor(ctx.projectDir, options.flowRoot);
    check(!('refusal' in journal), `the journal refused the scenario project`);
    const lines = readJournal(journal.settings).lines;
    check(lines.length > 0, `flow note under ${runtime} wrote no journal line`);
    for (const line of lines) {
      checkEqual(
        { kind: line.kind, runtime: line.runtime, harness: line.harness },
        { kind: line.kind, runtime: recorded.runtime, harness: recorded.journalHarness },
        `a journal line written under ${runtime}`
      );
    }

    // A retried `flow done` posts nothing new.
    const again = await ctx.flowOk(doneArgs, env);
    checkEqual(again.json.commented, false, 'a second flow done "commented"');
    checkEqual(
      (tracker.backlog.comments?.[ID] ?? []).length,
      1,
      'comments after a second flow done'
    );
  });
}
