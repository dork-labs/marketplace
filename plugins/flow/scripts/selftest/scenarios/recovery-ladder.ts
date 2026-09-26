/**
 * Scenario `recovery-ladder`: an orphaned run is resumed, then restarted, then
 * escalated; a parked item is never reclaimed (spec
 * `specs/flow-self-improvement` §1).
 *
 * There is no recovery verb yet: the next-tick ladder is the pure oracle
 * `recoverOrphan` (`scripts/flow-run.ts`, the same one `scripts/recovery.ts`
 * wraps). So the scenario sets the scene with the real verbs (`flow claim`
 * with a dead worker pid, `flow status` to see the worker is gone, `flow claim`
 * and `flow next` refusing a parked item), then calls the oracle directly with
 * facts read from the fake, the run store and the disk, and persists the
 * attempt count it returns, as the runtime would.
 *
 * `recovery.onExhausted` is not read by the oracle: every exhausted run
 * escalates with `agent/blocked`, whatever the setting.
 *
 * @module @dorkos/flow/selftest/scenarios/recovery-ladder
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  RECOVERY_BLOCKED_LABEL,
  recoverOrphan,
  type FlowRun,
  type OrphanSignal,
  type RecoveryAction,
} from '../../flow-run.ts';
import type { WorkItem } from '../../tracker/types.ts';
import {
  BASE_CONFIG,
  DEAD_PID,
  check,
  checkEqual,
  seedItem,
  type ScenarioContext,
  type ScenarioOptions,
  withScenario,
} from './harness.ts';

/** A ready, dispatchable item. */
function ready(identifier: string): WorkItem {
  return seedItem(identifier, {
    description: 'Do it.\n\n## Validation criteria\n\n- Done.\n\n## On Completion\n\n- Nothing.',
    priority: 2,
    size: 3,
    labels: ['type/task', 'agent/ready', 'stage/execute'],
  });
}

/**
 * The orphan signal the next tick derives for an item (the reconciler's input,
 * `RecoveryCandidate.signal`), from its labels, its state, its run and whether
 * `flow status` found its worker gone. `undefined`: not an orphan.
 */
function orphanSignal(
  item: WorkItem,
  run: FlowRun | undefined,
  workerGone: boolean
): OrphanSignal | undefined {
  if (item.labels.includes('agent/needs-input')) return 'needs-input';
  if (item.stateCategory !== 'started') return undefined;
  if (run === undefined) return 'no-local-record';
  return item.labels.includes('agent/claimed') && workerGone ? 'claimed-no-worker' : undefined;
}

/** One next-tick pass over one item: status, facts, the oracle; persists the attempt count. */
async function tick(ctx: ScenarioContext, identifier: string): Promise<RecoveryAction | undefined> {
  const status = await ctx.flowOk(['status']);
  const drift = (status.json.drift as { identifier: string; kind: string }[]) ?? [];
  const gone = drift.some((d) => d.identifier === identifier && d.kind === 'worker-gone');
  const item = await ctx.tracker.adapter.getItem(identifier);
  const run = ctx.runs()[item.id];
  const signal = orphanSignal(item, run, gone);
  if (signal === undefined) return undefined;
  const config = ctx.loadedConfig();
  const action = recoverOrphan(
    signal,
    run ?? null,
    { worktreeExists: run !== undefined && existsSync(run.worktreePath), sessionLogIntact: true },
    config.recovery
  );
  if (run !== undefined && (action.kind === 'resume' || action.kind === 'restart-clean')) {
    await ctx.store.upsertRun({ ...run, attemptCount: action.attemptCount });
  }
  return action;
}

/**
 * Run the recovery-ladder scenario.
 *
 * @param options - The flow root and the tracker factory.
 */
export async function recoveryLadder(options: ScenarioOptions): Promise<void> {
  await withScenario(options, async (ctx) => {
    ctx.seed({ items: [ready('FAKE-1'), ready('FAKE-2')] });
    ctx.config({ ...BASE_CONFIG, recovery: { maxRetries: 2, onExhausted: 'block' } });
    const env = { FLOW_SESSION_ID: 'session-recovery' };

    // A claimed, started item whose worker died, worktree intact: resume.
    const worktree = path.join(ctx.projectDir, 'wt-FAKE-1');
    mkdirSync(worktree);
    await ctx.flowOk(
      ['claim', 'FAKE-1', '--pid', String(DEAD_PID), '--worktree', worktree, '--branch', 'work'],
      env
    );
    checkEqual(
      await tick(ctx, 'FAKE-1'),
      { kind: 'resume', attemptCount: 1 },
      'dead worker, worktree present'
    );

    // The worktree is gone: restart clean.
    rmSync(worktree, { recursive: true, force: true });
    checkEqual(
      await tick(ctx, 'FAKE-1'),
      { kind: 'restart-clean', reason: 'no-worktree', attemptCount: 2 },
      'dead worker, worktree missing'
    );

    // Retries used up (2 of maxRetries 2): escalate with agent/blocked.
    const exhausted = await tick(ctx, 'FAKE-1');
    check(
      exhausted?.kind === 'escalate' && exhausted.label === RECOVERY_BLOCKED_LABEL,
      `retries past maxRetries: expected escalate with ${RECOVERY_BLOCKED_LABEL}, got ${JSON.stringify(exhausted)}`
    );

    // A parked item (agent/needs-input) is never reclaimed. The park is written
    // through the adapter: no verb parks an item yet.
    await ctx.flowOk(
      [
        'claim',
        'FAKE-2',
        '--pid',
        String(DEAD_PID),
        '--worktree',
        ctx.projectDir,
        '--branch',
        'work',
      ],
      env
    );
    const claimed = await ctx.tracker.adapter.getItem('FAKE-2');
    await ctx.tracker.adapter.applyWorkState(claimed, { agentLabel: 'agent/needs-input' });
    checkEqual(
      await tick(ctx, 'FAKE-2'),
      { kind: 'skip', reason: 'parked-on-human' },
      'a parked item on the next tick'
    );
    await ctx.flowOk(['claim', 'FAKE-2', '--pid', String(process.pid)], env, 5);
    const next = await ctx.flowOk(['next', '-n', '5']);
    const picked = ((next.json.picked as { identifier: string }[]) ?? []).map((p) => p.identifier);
    check(!picked.includes('FAKE-2'), `flow next offers the parked FAKE-2: ${picked.join(', ')}`);
    const status = await ctx.flowOk(['status']);
    const parked = ((status.json.parked as { identifier: string }[]) ?? []).map(
      (p) => p.identifier
    );
    check(
      parked.includes('FAKE-2'),
      `flow status does not list FAKE-2 as parked: ${parked.join(', ')}`
    );
  });
}
