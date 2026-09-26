/**
 * `flow handoff <identifier> [--to <runtime:account>] [--reason <text>]` and
 * `flow handoff <identifier> --wait [--until <iso>]` (spec
 * `flow-handoff-dispatch` §5.3, §5.2a): move a drain run to another account by
 * hand, approve the move `ask` mode is waiting for, or hold a limited run on
 * its own account.
 *
 * - `--to` must be eligible (`rankAccounts` with the run's account excluded),
 *   else exit 5 with its reasons; without it, the top candidate (none: exit 5
 *   with every account's reasons). A bare id names an account of the run's
 *   runtime.
 * - The move is `executeHandoff`, reason `manual`, limited or not.
 * - `--wait` holds a limited run on its own account (`heldBy: "person"`) until
 *   `--until`, or until the account resets: no automatic move happens while it
 *   holds. `--to` (or the time passing) releases it.
 * - Safe beside a running supervisor: the move and the hold both go through the
 *   run store's compare-and-set and the `handing-off` token. While a live `flow
 *   drain` holds the lock, a run that is not limited is refused (exit 5), so a
 *   manual move never lands in the middle of a pass's step.
 *
 * @module @dorkos/flow/cli/handoff
 */

import path from 'node:path';

import { randomBytes, randomUUID } from 'node:crypto';

import { executeHandoff, parseRef, type HandoffExecDeps } from '../drain/handoff-exec.ts';
import { liveDrainPid } from '../drain/lock.ts';
import type { DrainState } from '../drain/state.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import { resolveDorkHome } from '../fleet/accounts.ts';
import type { FlowRun } from '../flow-run.ts';
import { openFlowStateFile, resolveMainCheckout } from '../flow-state-file.ts';
import { DEFAULT_START_TIMEOUT_MS } from '../launchers/common.ts';
import { realLauncher } from '../launchers/real.ts';
import {
  handleRuntime,
  type HostName,
  type Launcher,
  type RuntimeName,
} from '../launchers/types.ts';
import { loadProjectConfig } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { parker, sessionFinder } from './drain.ts';
import { handoffWiring } from './handoff-wiring.ts';
import { setupWrite } from './work-write.ts';

/** The adapter methods a move may call (a park when the host is missing). */
const CAPABILITIES = ['getItem', 'applyWorkState', 'comment'] as const;

/** A string flag's value, if given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** The item's drain run: a queued or running one first. */
function findRun(runs: Record<string, FlowRun>, identifier: string): FlowRun | undefined {
  const matches = Object.values(runs).filter(
    (run) => run.identifier === identifier && run.drain !== undefined
  );
  return matches.find((run) => run.status === 'running' || run.status === 'queued') ?? matches[0];
}

/**
 * Run `flow handoff`.
 *
 * @param ctx - The verb's context.
 * @returns What happened, for `--json` and as one line.
 * @throws {UsageError} On a bad flag combination (exit 2).
 * @throws {PreconditionError} When the run cannot move now, with why (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const identifier = ctx.args.positionals[0];
  if (identifier === undefined) throw new UsageError('flow handoff needs the item, e.g. ACME-12');
  const wait = ctx.args.flags.wait === true;
  const until = flag(ctx, 'until');
  const to = flag(ctx, 'to');
  const reasonText = flag(ctx, 'reason');
  if (wait && to !== undefined)
    throw new UsageError('--wait and --to ask for opposite things; give one');
  if (until !== undefined && !wait) throw new UsageError('--until goes with --wait');
  if (until !== undefined && !Number.isFinite(Date.parse(until))) {
    throw new UsageError(`--until must be an ISO time, e.g. 2026-09-27T09:00:00Z, not "${until}"`);
  }

  const project = loadProjectConfig(ctx);
  const { config } = project.loaded;
  const mainCheckout = resolveMainCheckout(ctx.projectDir);
  const store = openFlowStateFile(mainCheckout);
  const found = findRun(store.read(), identifier);
  if (found === undefined || found.drain?.v !== 1) {
    throw new PreconditionError(
      `${identifier} has no drain run on this machine; flow handoff moves runs flow drain started`
    );
  }
  const live = liveDrainPid(mainCheckout, (pid) => ctx.io.pidAlive(pid));
  if (live !== null && found.limit === undefined) {
    throw new PreconditionError(
      `a flow drain (pid ${live}) is running and ${identifier} is not limited, so moving it now could land in the middle of a step. Stop the drain first, or wait until the run is limited.`
    );
  }

  if (wait) return hold(ctx, store, found, until ?? null);

  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const flowCommand = `node --experimental-strip-types ${path.join(ctx.flowRoot, 'scripts', 'flow.ts')}`;
  const wiring = handoffWiring({ ctx, config, dorkHome, flow: flowCommand });
  const rank = await wiring.candidates(found);
  const runtime = handleRuntime({ runtime: found.runtime as RuntimeName | undefined });
  let target = rank.pick;
  if (to !== undefined) {
    const ref = parseRef(to.includes(':') ? to : `${runtime}:${to}`);
    if (ref === null)
      throw new UsageError(`--to must be <runtime>:<account> or <account>, not "${to}"`);
    const ranked = rank.ranked.find((a) => a.runtime === ref.runtime && a.id === ref.id);
    if (ranked === undefined) {
      const out = rank.ineligible.find((a) => a.runtime === ref.runtime && a.id === ref.id);
      throw new PreconditionError(
        out === undefined
          ? `${ref.runtime}:${ref.id} is not an account ${identifier} may move to (not registered, or another runtime while crossRuntimeFallback is off)`
          : `${ref.runtime}:${ref.id} may not take ${identifier}: ${out.reasons.join(', ')}`
      );
    }
    target = ref;
  }
  if (target === null) {
    const reasons = rank.ineligible
      .map((a) => `${a.runtime}:${a.id} (${a.reasons.join(', ')})`)
      .join('; ');
    throw new PreconditionError(
      `no account may take ${identifier} now${reasons ? `: ${reasons}` : ''}`
    );
  }

  const setup = await setupWrite(ctx, CAPABILITIES);
  const launchers = new Map<HostName, Launcher>();
  const deps: HandoffExecDeps = {
    store,
    launcher(host) {
      let made = launchers.get(host);
      if (made === undefined) {
        made = ctx.createLauncher?.(host) ?? realLauncher(host, ctx.env, ctx.io.osHome);
        launchers.set(host, made);
      }
      return made;
    },
    now: () => ctx.now(),
    flow: flowCommand,
    startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
    permissionMode: config.drain.permissionMode,
    workerModel: config.models.bindings[config.models.tiers.implementation] ?? null,
    mintId: () => randomUUID(),
    mintToken: () => randomBytes(16).toString('hex'),
    ensureCheckpoint: wiring.io.ensureCheckpoint,
    transcriptFor: wiring.io.transcriptFor,
    resolveAccount: wiring.io.resolveAccount,
    park: parker(ctx, setup, config),
    findSession: sessionFinder(ctx, dorkHome),
    warn: (message) => ctx.warn(message),
  };
  const outcome = await executeHandoff(
    deps,
    found,
    target,
    'manual',
    reasonText ? `moved by hand: ${reasonText}` : undefined
  );
  const line = `${identifier} ${outcome.line}`;
  if (outcome.status !== 'moved') throw new PreconditionError(line);
  return {
    json: {
      identifier,
      to: `${target.runtime}:${target.id}`,
      sessionId: outcome.sessionId,
      reason: reasonText ?? null,
    },
    text: line,
  };
}

/**
 * `--wait`: hold a limited run on its own account (§5.2a). Written by
 * compare-and-set on the session the verb read, and never over a move in
 * progress.
 */
async function hold(
  ctx: VerbContext,
  store: ReturnType<typeof openFlowStateFile>,
  found: FlowRun,
  until: string | null
): Promise<VerbResult> {
  const identifier = found.identifier;
  if (found.limit === undefined) {
    throw new PreconditionError(
      `${identifier} is not limited, so there is nothing to wait for; flow handoff --wait holds a limited run on its own account`
    );
  }
  let why = '';
  await store.updateRun(found.issueId, (run) => {
    why = '';
    const drain = run.drain as DrainState | undefined;
    if (drain?.v !== 1 || run.sessionId !== found.sessionId) {
      why = 'another session took the run over since it was read';
      return run;
    }
    if (run.limit === undefined) {
      why = 'its limit cleared meanwhile';
      return run;
    }
    if (run.limit.state === 'handing-off') {
      why = 'a handoff of it is in progress';
      return run;
    }
    const wakeAfter = until ?? run.limit.resetsAt ?? null;
    return {
      ...run,
      limit: { ...run.limit, state: 'waiting-reset', heldBy: 'person', heldUntil: until },
      drain: { ...drain, wakeAfter, rev: drain.rev + 1 },
    };
  });
  if (why !== '') throw new PreconditionError(`${identifier} was not held: ${why}`);
  const when = until ?? found.limit.resetsAt;
  return {
    json: { identifier, heldUntil: until, resetsAt: found.limit.resetsAt },
    text: `${identifier} held on its own account until ${when ?? 'its limit resets'}; no automatic move happens meanwhile. flow handoff ${identifier} --to <account> releases it.`,
  };
}
