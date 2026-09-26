/**
 * `flow claim <identifier>` (spec `flow-cli-core` §6): an agent starts working
 * an item.
 *
 * Refuses (exit 5) unless the item is open, carries `agent/ready`, is not
 * `agent/claimed`, and its ownership class is claimable; refuses (exit 7) while
 * flow is paused unless `--manual`. Then it writes the `claim` projection
 * (started, `agent/claimed`, no `stage/*` label), confirms it on read-back, and
 * records a `FlowRun` whose `stage` is the one the removed `stage/*` label named.
 * It posts no comment: the label is the signal.
 *
 * The claim lock (`flow-state.json.claim.lock`) is held from the tracker read
 * that checks the item through the run record, so two claims on one machine run
 * one after the other: the second reads `agent/claimed` and exits 5. The run
 * store's own lock is taken only for the short run write, so other verbs'
 * writes never wait out a claim's tracker calls.
 *
 * The run records the session id and the runtime. A claim with no session id
 * (no `--session`, no `FLOW_SESSION_ID`, and a runtime that gives none) is
 * refused (exit 5): recovery cannot resume a session it cannot name. The
 * runtime is `--runtime`, else the one `./session-id.ts` finds, else left
 * out.
 *
 * @module @dorkos/flow/cli/claim
 */

import { classifyOwnership, type Identity } from '../identity.ts';
import { isClaimable } from '../dispatch-policy.ts';
import { PausedError, PreconditionError, UsageError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import type { FlowConfig } from '../config-schema.ts';
import { requireCapabilities } from '../tracker/load.ts';
import type { CodeAdapter, WorkItem } from '../tracker/types.ts';
import { AGENT_CLAIMED, AGENT_READY, projectionFor } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { LAUNCHERS } from './provenance.ts';
import { RUNTIMES } from '../fleet/usage-ledger.ts';
import type { Runtime } from '../runtime-detect.ts';
import { recordEvent } from './auto-journal.ts';
import { runtimeSession } from './session-id.ts';
import {
  applyAndVerify,
  currentStageLabel,
  requireOpen,
  requireStored,
  runFor,
  sessionProvenance,
  setupWrite,
  stageForLabel,
} from './work-write.ts';

/**
 * The item's ownership class under the configured scopes: the issue's assignee
 * when `issues` is in scope, else its project's lead.
 */
function ownershipClass(item: WorkItem, identity: Identity, config: FlowConfig) {
  const scope = config.ownership.scope.includes('issues') ? 'issues' : 'projects';
  return classifyOwnership(item, identity, scope);
}

/** Resolve `identity.agent: "auto"` to the account the adapter acts as. */
async function resolveIdentity(adapter: CodeAdapter, config: FlowConfig): Promise<Identity> {
  const agent =
    config.identity.agent === 'auto' ? (await adapter.getCurrentUser()).id : config.identity.agent;
  return { agent, reviewer: config.identity.reviewer, marker: config.identity.marker };
}

/**
 * How long a claim waits for another claim on this machine to finish. Longer
 * than the shared writers' 2 s: the holder is waiting on the tracker, and a
 * claim that waits is better than one that gives up.
 */
const CLAIM_LOCK_WAIT_MS = 60_000;

/** `--pid`, else the parent of the shell that ran flow (the harness). */
async function workerPid(ctx: VerbContext): Promise<number> {
  const flag = ctx.args.flags.pid;
  if (typeof flag === 'string') {
    const pid = Number(flag);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new UsageError(`--pid must be a positive whole number, not "${flag}"`);
    }
    return pid;
  }
  const fail = () =>
    new PreconditionError(
      'could not find the process that runs this session; pass --pid <the harness process id>'
    );
  let result;
  try {
    result = await ctx.runProcess('ps', ['-o', 'ppid=', '-p', String(process.ppid)]);
  } catch {
    throw fail();
  }
  const pid = Number(result.stdout.trim());
  if (result.code !== 0 || !Number.isInteger(pid) || pid <= 0) throw fail();
  return pid;
}

/** `--worktree` and `--branch`, else the `--project` checkout root and its branch. */
async function checkout(ctx: VerbContext): Promise<{ worktreePath: string; branch: string }> {
  const git = async (args: string[], flag: string): Promise<string> => {
    const given = ctx.args.flags[flag];
    if (typeof given === 'string') return given;
    try {
      const result = await ctx.runProcess('git', args, { cwd: ctx.projectDir });
      const value = result.stdout.trim();
      if (result.code === 0 && value !== '' && value !== 'HEAD') return value;
    } catch {
      // fall through to the refusal below
    }
    throw new PreconditionError(
      `could not read the ${flag} from ${ctx.projectDir}; pass --${flag}`
    );
  };
  return {
    worktreePath: await git(['rev-parse', '--show-toplevel'], 'worktree'),
    branch: await git(['rev-parse', '--abbrev-ref', 'HEAD'], 'branch'),
  };
}

/**
 * Run `flow claim`.
 *
 * @param ctx - The verb's context.
 * @returns The change written and the run recorded.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  const launcher = ctx.args.flags.host;
  if (typeof launcher === 'string' && !(LAUNCHERS as readonly string[]).includes(launcher)) {
    throw new UsageError(`--host must be one of ${LAUNCHERS.join(', ')}, not "${launcher}"`);
  }
  const runtimeFlag = ctx.args.flags.runtime;
  if (typeof runtimeFlag === 'string' && !(RUNTIMES as readonly string[]).includes(runtimeFlag)) {
    throw new UsageError(`--runtime must be one of ${RUNTIMES.join(', ')}, not "${runtimeFlag}"`);
  }
  const runtime = typeof runtimeFlag === 'string' ? runtimeFlag : runtimeSession(ctx.env).runtime;
  const sessionId = ctx.sessionId;
  if (sessionId === undefined) {
    throw new PreconditionError(
      `no session id, so recovery could not resume this session: pass --session <id> or set FLOW_SESSION_ID (Claude Code sets CLAUDE_CODE_SESSION_ID and Codex sets CODEX_THREAD_ID on their own; OpenCode sets none)`
    );
  }

  const { loaded, stages, adapter, store } = await setupWrite(ctx, ['getItem', 'applyWorkState']);
  if (loaded.paused !== null && !ctx.manual) {
    throw new PausedError(
      `flow is paused on this machine (${loaded.paused.file}); run /flow:resume, or pass --manual if a person is driving`
    );
  }
  const { config } = loaded;
  if (config.identity.agent === 'auto') requireCapabilities(adapter, ['getCurrentUser']);
  const pid = await workerPid(ctx);
  const { worktreePath, branch } = await checkout(ctx);
  const account = ctx.args.flags.account;

  const locked = await store.withClaimLock(
    async () => {
      const item = await adapter.getItem(identifier);
      requireOpen(item, 'claim');
      if (item.labels.includes(AGENT_CLAIMED)) {
        throw new PreconditionError(`${identifier} is already claimed (${AGENT_CLAIMED})`);
      }
      if (!item.labels.includes(AGENT_READY)) {
        throw new PreconditionError(
          `${identifier} does not carry ${AGENT_READY}, so it is not ready to claim`
        );
      }
      const identity = await resolveIdentity(adapter, config);
      const cls = ownershipClass(item, identity, config);
      if (!isClaimable(cls, config.ownership)) {
        throw new PreconditionError(
          `${identifier} is owned by ${cls === 'reviewer' ? 'a person' : 'someone else'} (${cls}), and the ownership settings do not let flow claim it`
        );
      }

      const removedLabel = currentStageLabel(item);
      const change = projectionFor({ type: 'claim' }, { stages, removedStageLabel: removedLabel });
      const previous = runFor(store, item);
      const record: FlowRun = {
        issueId: item.id,
        identifier: item.identifier,
        sessionId,
        worktreePath,
        branch,
        stage: stageForLabel(stages, removedLabel) ?? 'execute',
        status: 'running',
        attemptCount: previous === undefined ? 0 : previous.attemptCount + 1,
        workerPid: pid,
        startedAt: ctx.now().toISOString(),
        provenance: {
          ...sessionProvenance(ctx, typeof launcher === 'string' ? launcher : undefined),
          worktree: worktreePath,
          branch,
        },
        ...(typeof account === 'string' ? { account } : {}),
        ...(typeof launcher === 'string' ? { host: launcher } : {}),
        ...(runtime === null ? {} : { runtime }),
      };

      if (!ctx.dryRun) {
        await applyAndVerify(adapter, item, change);
        const written = await store.upsertRun(record);
        requireStored(
          written.status,
          store.path,
          `run "flow release ${identifier} --to ready" and claim it again`
        );
      }
      return { change, record };
    },
    { giveUpMs: CLAIM_LOCK_WAIT_MS }
  );
  if (!locked.held) {
    throw new PreconditionError(
      `another claim on this machine held ${store.path}.claim.lock for ${CLAIM_LOCK_WAIT_MS / 1000} s, so ${identifier} was not claimed; try again`
    );
  }
  const { change, record } = locked.value;
  const journalRuntime = (runtime ?? undefined) as Runtime | undefined;
  if (!ctx.dryRun) {
    recordEvent(ctx, { kind: 'claim', phase: 'claim', item: identifier }, journalRuntime);
  }
  return {
    runtime: journalRuntime,
    json: { ok: true, dryRun: ctx.dryRun, identifier, change, run: record },
    text: `${ctx.dryRun ? 'Would claim' : 'Claimed'} ${identifier} at stage ${record.stage} (worker ${pid}, ${branch}).`,
  };
}
