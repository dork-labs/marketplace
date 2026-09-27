/**
 * Flow's account advisor (spec `claude-account-ui` §8.4; DorkOS
 * `claude-account-fleet` §X3): flow's routing policy applied to DorkOS's
 * account decisions, and the single writer for flow runs.
 *
 * - `rank` hides the accounts flow may not use and orders the rest with flow's
 *   own `rankAccounts`. Agents and relay messages get flow's opt-in policy in
 *   full; a person's own session hides only what the operator explicitly kept
 *   out of its repo.
 * - `onLimited` hands a flow run off by itself (`handoff: auto`), waits when the
 *   reset is under an hour away, and otherwise asks.
 * - `claims`, `move`, `wait` and `cancelAuto` make flow the only mover of a flow
 *   run. `move` accepts at once and runs `flow handoff` in the background; the
 *   result reaches DorkOS through `accounts.markContinued`.
 * - `carryOver` seeds the new session from the run's `HANDOFF.md`.
 *
 * `modelFallback` is not implemented: DorkOS's default applies.
 *
 * @module @dorkos/flow/extension/advisor
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  itemRuntime,
  limitSignal,
  rankAccounts,
  type AccountRank,
  type IneligibleReason,
  type RankableAccount,
} from '../../../../scripts/drain/account-rank.ts';
import {
  CHECKPOINT_DIR,
  CHECKPOINT_FILE,
  parseCheckpoint,
} from '../../../../scripts/drain/checkpoint.ts';
import { render } from '../../../../scripts/drain/messages.ts';
import { PreconditionError } from '../../../../scripts/errors.ts';
import {
  accountKey,
  effectiveReservePct,
  parseOriginRepo,
  type ResolvedAccountPolicy,
  type ResolvedFleetPolicy,
} from '../../../../scripts/fleet/accounts.ts';
import {
  IMPLICIT_ACCOUNT_ID,
  isRuntimeSlug,
  type RuntimeSlug,
} from '../../../../scripts/fleet/usage-ledger.ts';
import { fleetSubjects, ledgerFor, readPolicy, storedEntry, type FleetSubject } from './fleet.ts';
import type {
  AccountAdvisor,
  AccountCandidate,
  AccountsApi,
  AdvisorContext,
  AdvisorRanking,
  AdvisorRankingRow,
  CarryOverSeed,
  LimitedPlan,
  LimitedSessionInfo,
  SessionInfo,
} from './host-types.ts';
import { SEED_CONTEXT_MAX_LENGTH } from './host-types.ts';
import { findFlowRun, holdRun, readRuns, type FoundRun } from './run-store.ts';
import { ineligibleReason, reserveReason, roomReason } from './reasons.ts';
import type { ContinuedWatcher } from './continued-watcher.ts';

/** What `move` says when `node` is missing or too old. */
export const NODE_MESSAGE = 'Flow needs Node 22.6 or newer on your PATH to move this work.';

/** How long `flow handoff` may run in the background. */
export const HANDOFF_TIMEOUT_MS = 120_000;

/** Seconds before an automatic handoff (the mockup's "in 10s"). */
export const AUTO_HANDOFF_DELAY_SECONDS = 10;

/** A reset closer than this waits instead of moving. */
const WAIT_IF_RESET_WITHIN_MS = 60 * 60 * 1000;

/** Flow's default `drain.warnMarginPct`. */
const WARN_MARGIN_PCT = 10;

/** Reasons that hide an account from a strict (flow-policy) ranking. */
const HIDING_REASONS: readonly IneligibleReason[] = ['not-routable', 'excluded', 'out-of-scope'];

/** The error `execFile` reports. */
export interface ExecError extends Error {
  /** `ENOENT` when the command is missing, or the exit code. */
  code?: string | number | null;
  /** True when the timeout killed it. */
  killed?: boolean;
}

/** `child_process.execFile` with string output, as this module calls it. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; shell: false; encoding: 'utf8' },
  callback: (error: ExecError | null, stdout: string, stderr: string) => void
) => unknown;

/** What the advisor needs from its host and machine. */
export interface AdvisorDeps {
  /** The DorkOS home (`ctx.dorkHome`). */
  dorkHome: string;
  /** The flow plugin's root folder. */
  flowRoot: string;
  /** DorkOS's accounts API. */
  accounts: Pick<AccountsApi, 'list' | 'markContinued'>;
  /** The clock. */
  now: () => Date;
  /** Runs a command with no shell. */
  execFile: ExecFileLike;
  /** The `origin` URL of the checkout at a folder, or `null`. */
  originOf: (cwd: string) => string | null;
  /** The watcher that reports moves flow made on its own. */
  watcher: ContinuedWatcher;
  /** Where to log. */
  log: (message: string) => void;
}

/** The advisor, plus hooks tests and the server use. */
export interface FlowAdvisor extends AccountAdvisor {
  /** Background handoffs still running, by source session id. */
  readonly inFlight: ReadonlyMap<string, Promise<void>>;
}

/** The ranking of one decision, with what built it. */
interface RankedDecision {
  rank: AccountRank;
  accounts: RankableAccount[];
  policy: ResolvedFleetPolicy;
}

/** A policy read as rotation, for ranking a person's own session. */
function asRotation(policy: ResolvedAccountPolicy): ResolvedAccountPolicy {
  return { ...policy, role: 'rotation', reservePct: 0 };
}

/**
 * Create flow's advisor.
 *
 * @param deps - The host, machine and watcher.
 * @returns The advisor.
 */
export function createAdvisor(deps: AdvisorDeps): FlowAdvisor {
  const inFlight = new Map<string, Promise<void>>();
  let nodeReady: Promise<void> | null = null;
  const flowCommand = `node --experimental-strip-types ${path.join(deps.flowRoot, 'scripts', 'flow.ts')}`;

  /** Run a command, resolving with its output and rejecting with its error. */
  function exec(args: readonly string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      deps.execFile('node', args, { timeout, shell: false, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }

  /** Check `node --version` once; a failure is checked again next time. */
  function checkNode(): Promise<void> {
    nodeReady ??= exec(['--version'], 1_500).then(
      (out) => {
        const match = /^v(\d+)\.(\d+)/.exec(out.trim());
        const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
        if (major < 22 || (major === 22 && minor < 6)) throw new Error(NODE_MESSAGE);
      },
      () => {
        throw new Error(NODE_MESSAGE);
      }
    );
    return nodeReady.catch((error: unknown) => {
      nodeReady = null;
      throw error;
    });
  }

  /**
   * Rank the accounts for one decision with flow's `rankAccounts`. `strict`
   * uses flow's policy as it is; otherwise an account with no stored role
   * (kept out only by the contract's opt-in default) ranks as rotation.
   */
  async function decide(opts: {
    runtime: RuntimeSlug;
    cwd: string;
    exclude: string[];
    model: string | null;
    strict: boolean;
    only?: ReadonlySet<string>;
  }): Promise<RankedDecision & { subjects: FleetSubject[]; raw: unknown; repo: string | null }> {
    const subjects = fleetSubjects(await deps.accounts.list());
    const { policy, raw } = readPolicy(deps.dorkHome, subjects);
    const repo = parseOriginRepo(deps.originOf(opts.cwd));
    const accounts: RankableAccount[] = [];
    subjects.forEach((subject, index) => {
      const own = subject.runtime === opts.runtime;
      if (own && opts.only !== undefined && !opts.only.has(subject.id)) return;
      let resolved = policy.accounts[index];
      if (
        !opts.strict &&
        resolved.role === 'kept-out' &&
        storedEntry(raw, subject.runtime, subject.id)?.role !== 'kept-out'
      ) {
        resolved = asRotation(resolved);
      }
      const ledger = subject.routable
        ? ledgerFor(deps.dorkHome, subject.runtime, subject.id)
        : null;
      accounts.push({
        runtime: subject.runtime,
        id: subject.id,
        path: null,
        implicit: subject.implicit,
        routable: subject.routable,
        policy: resolved,
        windows: ledger === null ? null : (ledger.windows as Record<string, unknown>),
        spend: ledger?.spend,
      });
    });
    const rank = rankAccounts({
      now: deps.now(),
      repo,
      accounts,
      runtime: opts.runtime,
      runtimes: policy.runtimes,
      crossRuntimeFallback: policy.crossRuntimeFallback,
      model: opts.model,
      affinity: null,
      exclude: opts.exclude,
      liveByAccount: {},
      opts: { warnMarginPct: WARN_MARGIN_PCT, maxLivePerAccount: Number.MAX_SAFE_INTEGER },
    });
    return { rank, accounts, policy, subjects, raw, repo };
  }

  /** The runtime a string names, or a thrown error flow's words explain. */
  function runtimeOf(value: string): RuntimeSlug {
    if (!isRuntimeSlug(value))
      throw new PreconditionError(`flow does not know the runtime "${value}"`);
    return value;
  }

  /** The key of the account a session is on. */
  function sessionKey(runtime: RuntimeSlug, accountId: string | null): string {
    return accountKey(runtime, accountId ?? IMPLICIT_ACCOUNT_ID);
  }

  /** The flow run a session is on, or a refusal in flow's words. */
  function requireFlowRun(info: SessionInfo): FoundRun {
    const found = findFlowRun(info.cwd, info.sessionId);
    if (found === null) {
      throw new PreconditionError(
        'This session is not a flow run on this machine, so flow cannot change it.'
      );
    }
    return found;
  }

  /** Run `flow handoff` in the background and report the new session. */
  async function handOff(
    info: SessionInfo,
    found: FoundRun,
    target: { runtime: string; accountId: string }
  ): Promise<void> {
    const { run, mainCheckout } = found;
    try {
      await exec(
        [
          '--experimental-strip-types',
          path.join(deps.flowRoot, 'scripts', 'flow.ts'),
          'handoff',
          run.identifier,
          '--to',
          `${target.runtime}:${target.accountId}`,
          '--project',
          mainCheckout,
          '--json',
        ],
        HANDOFF_TIMEOUT_MS
      );
    } catch (error) {
      const e = error as ExecError & { stderr?: string };
      deps.log(
        `[flow] could not move ${run.identifier} to ${target.runtime}:${target.accountId}: ${
          e.killed ? 'flow handoff took longer than 2 minutes' : e.message
        }`
      );
      return;
    }
    const now = readRuns(mainCheckout)[run.issueId];
    const next = now?.sessionId;
    if (next === undefined || next === '' || next === info.sessionId) {
      deps.log(`[flow] flow handoff moved ${run.identifier} but the run names no new session`);
      return;
    }
    if (!(await deps.watcher.markReported(info.sessionId, next))) return;
    try {
      await deps.accounts.markContinued(info.sessionId, {
        sessionId: next,
        runtime: target.runtime,
        accountId: target.accountId,
      });
    } catch (error) {
      deps.log(`[flow] DorkOS did not take the move of ${run.identifier}: ${String(error)}`);
    }
  }

  const advisor: FlowAdvisor = {
    inFlight,

    async rank(candidates: AccountCandidate[], ctx: AdvisorContext): Promise<AdvisorRanking> {
      const runtime = runtimeOf(ctx.runtime);
      const flowRun = findFlowRun(ctx.cwd, ctx.sessionId);
      const strict = ctx.caller === 'agent' || ctx.caller === 'relay' || flowRun !== null;
      const exclude =
        ctx.excludeAccountId === undefined ? [] : [accountKey(runtime, ctx.excludeAccountId)];
      const decision = await decide({
        runtime,
        cwd: ctx.cwd,
        exclude,
        model: null,
        strict,
        only: new Set(candidates.map((c) => c.id)),
      });
      const now = deps.now();
      const byKey = new Map(decision.accounts.map((a) => [accountKey(a.runtime, a.id), a]));
      const reserveOf = (a: RankableAccount) => effectiveReservePct(a.policy, a.windows, now);

      const eligible: AdvisorRankingRow[] = [];
      const reserved: AdvisorRankingRow[] = [];
      const ineligible: AdvisorRankingRow[] = [];
      const row = (a: RankableAccount, fields: Omit<AdvisorRankingRow, 'id' | 'runtime'>) => ({
        ...(a.runtime === runtime ? {} : { runtime: a.runtime }),
        id: a.id,
        ...fields,
      });
      const anyUnreserved = decision.rank.ranked.some((r) => r.tier !== 2);
      for (const ranked of decision.rank.ranked) {
        const account = byKey.get(accountKey(ranked.runtime, ranked.id));
        if (account === undefined) continue;
        if (ranked.tier === 2 && anyUnreserved) {
          reserved.push(
            row(account, {
              eligible: false,
              reason: reserveReason(reserveOf(account)),
              badge: 'reserved',
            })
          );
        } else {
          eligible.push(row(account, { eligible: true, reason: roomReason(account.windows, now) }));
        }
      }
      for (const out of decision.rank.ineligible) {
        const account = byKey.get(accountKey(out.runtime, out.id));
        if (account === undefined || out.reasons.includes('excluded')) continue;
        if (strict && out.reasons.some((r) => HIDING_REASONS.includes(r))) continue;
        // A person's own session hides only what the operator explicitly kept out.
        if (!strict && out.reasons.includes('out-of-scope')) continue;
        const signal = limitSignal({
          runtime: account.runtime,
          windows: account.windows,
          spend: account.spend,
          policy: account.policy,
          model: null,
          now,
          warnMarginPct: WARN_MARGIN_PCT,
        });
        ineligible.push(
          row(account, {
            eligible: false,
            reason: ineligibleReason(out.reasons, signal, reserveOf(account)),
          })
        );
      }
      const own = (rows: AdvisorRankingRow[]) => rows.filter((r) => r.runtime === undefined);
      const other = (rows: AdvisorRankingRow[]) => rows.filter((r) => r.runtime !== undefined);
      const ordered = [
        ...own(eligible),
        ...own(reserved),
        ...own(ineligible),
        ...other(eligible),
        ...other(reserved),
        ...other(ineligible),
      ];
      const top = ordered.find((r) => r.eligible);
      if (top !== undefined) top.badge = 'recommended';
      return { accounts: ordered, recommendedId: top?.id ?? null };
    },

    async onLimited(info: LimitedSessionInfo): Promise<LimitedPlan> {
      const found = findFlowRun(info.cwd, info.sessionId);
      if (found === null) return { mode: 'ask' };
      const subjects = fleetSubjects(await deps.accounts.list());
      const { policy } = readPolicy(deps.dorkHome, subjects);
      const runtime = itemRuntime(found.run.runtime, policy.runtimes);
      const decision = await decide({
        runtime,
        cwd: info.cwd,
        exclude: [sessionKey(runtime, info.accountId)],
        model: info.model,
        strict: true,
      });
      const pick = decision.rank.pick;
      if (decision.policy.handoff === 'auto' && pick !== null && pick.runtime === runtime) {
        return { mode: 'auto', target: pick.id, delaySeconds: AUTO_HANDOFF_DELAY_SECONDS };
      }
      if (info.resetsAt !== null) {
        const inMs = Date.parse(info.resetsAt) - deps.now().getTime();
        if (inMs > 0 && inMs <= WAIT_IF_RESET_WITHIN_MS) return { mode: 'wait' };
      }
      return { mode: 'ask' };
    },

    async claims(info: SessionInfo): Promise<boolean> {
      const found = findFlowRun(info.cwd, info.sessionId);
      if (found === null) return false;
      await deps.watcher.noteClaimed(info.sessionId, found);
      return true;
    },

    async move(info: SessionInfo, target: { runtime: string; accountId: string }): Promise<void> {
      await checkNode();
      const found = requireFlowRun(info);
      const { run } = found;
      if (run.drain?.v !== 1) {
        throw new PreconditionError(
          `${run.identifier} has no drain run on this machine; flow handoff moves runs flow drain started`
        );
      }
      if (inFlight.has(info.sessionId)) {
        throw new PreconditionError(`flow is already moving ${run.identifier}`);
      }
      const runtime = runtimeOf(info.runtime);
      const targetRuntime = runtimeOf(target.runtime);
      const decision = await decide({
        runtime,
        cwd: info.cwd,
        exclude: [sessionKey(runtime, info.accountId)],
        model: null,
        strict: true,
      });
      const ref = `${targetRuntime}:${target.accountId}`;
      const ranked = decision.rank.ranked.some(
        (a) => a.runtime === targetRuntime && a.id === target.accountId
      );
      if (!ranked) {
        const out = decision.rank.ineligible.find(
          (a) => a.runtime === targetRuntime && a.id === target.accountId
        );
        throw new PreconditionError(
          out === undefined
            ? `${ref} is not an account ${run.identifier} may move to (not registered, or another runtime while crossRuntimeFallback is off)`
            : `${ref} may not take ${run.identifier}: ${out.reasons.join(', ')}`
        );
      }
      await deps.watcher.noteClaimed(info.sessionId, found);
      const job = handOff(info, found, target).finally(() => inFlight.delete(info.sessionId));
      inFlight.set(info.sessionId, job);
    },

    async cancelAuto(info: SessionInfo): Promise<void> {
      const found = requireFlowRun(info);
      await holdRun(found, { heldUntil: null, resumeOnReset: false }, deps.now());
    },

    async wait(info: SessionInfo, resumeAt: string | null, autoResume: boolean): Promise<void> {
      const found = requireFlowRun(info);
      await holdRun(found, { heldUntil: resumeAt, resumeOnReset: autoResume }, deps.now());
    },

    carryOver(info: LimitedSessionInfo): CarryOverSeed {
      const found = findFlowRun(info.cwd, info.sessionId);
      if (found === null) throw new Error('not a flow run, so flow has no checkpoint to seed it');
      const { run } = found;
      const file = path.join(run.worktreePath, CHECKPOINT_DIR, CHECKPOINT_FILE);
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        throw new Error(`${run.identifier} has no checkpoint at ${file}`);
      }
      const parsed = parseCheckpoint(text);
      const title = parsed.ok ? parsed.title : null;
      const head = `Flow item ${run.identifier}${title ? `: ${title}` : ''}. Its checkpoint, ${path.join(CHECKPOINT_DIR, CHECKPOINT_FILE)}, follows.\n\n`;
      let seedContext = head + text;
      if (seedContext.length > SEED_CONTEXT_MAX_LENGTH) {
        seedContext = `${seedContext.slice(0, SEED_CONTEXT_MAX_LENGTH - 1)}…`;
      }
      const prompt = render('resume-from-handoff', {
        flow: flowCommand,
        identifier: run.identifier,
        worktree: run.worktreePath,
        branch: run.branch,
        transcript: null,
        previousRuntime: null,
      });
      return { seedContext, prompt };
    },
  };
  return advisor;
}
