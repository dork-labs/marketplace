/**
 * The handoff machine's I/O (spec `flow-handoff-dispatch` §5), wired to the
 * project's config, the fleet files, the worktree's checkpoint and the tracker
 * adapter. Shared by `flow drain` (the real `handoffStep` and the actions it
 * asks for) and `flow handoff` (a move by hand).
 *
 * Every account fact comes from S1's core through `gatherAssignmentInput` and
 * `rankAccounts`: the handoff never resolves an account, a reserve or an
 * implicit `default` by itself. The gather runs once per pass (keyed by the
 * pass's clock), and only for a run that is limited or whose account signals.
 *
 * Nothing here reads or writes a transcript: `transcriptFor` only resolves the
 * old session's path for the resume message.
 *
 * @module @dorkos/flow/cli/handoff-wiring
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  limitSignal,
  rankAccounts,
  type AccountRank,
  type AccountRef,
  type LimitSignal,
} from '../drain/account-rank.ts';
import {
  CHECKPOINT_DIR,
  CHECKPOINT_FILE,
  parseCheckpoint,
  synthesizeCheckpoint,
  type ParsedCheckpoint,
} from '../drain/checkpoint.ts';
import {
  accountKeyOf,
  combineSignal,
  nextHandoffAction,
  pickFallbackModel,
  type HandoffCheckpoint,
} from '../drain/handoff.ts';
import { askText, type HandoffAccount } from '../drain/handoff-exec.ts';
import type { HandoffIo, HandoffStep } from '../drain/runner.ts';
import { loadAccounts, loadFleetPolicy, resolveAccountRef } from '../fleet/accounts.ts';
import type { FlowRun } from '../flow-run.ts';
import type { RuntimeSlug } from '../fleet/usage-ledger.ts';
import { findCodexRollout } from '../launchers/codex-rollout.ts';
import { DEFAULT_START_TIMEOUT_MS, launchAccountFor, sessionHome } from '../launchers/common.ts';
import { findTranscript } from '../launchers/prove-account.ts';
import { canSwitchModel } from '../launchers/support.ts';
import {
  handleRuntime,
  type HostName,
  type RuntimeName,
  type SessionHandle,
} from '../launchers/types.ts';
import { writeCheckpoint } from './checkpoint.ts';
import type { VerbContext } from './context.ts';
import {
  gatherAssignmentInput,
  liveByAccount,
  type AssignmentInput,
  type NextConfig,
} from './next.ts';
import { signBody } from './provenance.ts';
import { sessionProvenance } from './work-write.ts';

/** Where a synthesized checkpoint's body is staged, relative to the worktree. */
const SYNTHESIZED_BODY = '.dork/flow/drain/synthesized-body.md';

/** What the wiring needs from its caller. */
export interface HandoffWiringInput {
  /** The verb's context. */
  ctx: VerbContext;
  /** The project config. */
  config: NextConfig;
  /** The resolved DorkOS home. */
  dorkHome: string;
  /** The full flow command prefix messages spell verbs with. */
  flow: string;
  /** Post a signed comment on an item (the ask-mode notice); absent for the verb. */
  comment?: (identifier: string, body: string) => Promise<void>;
}

/** The fleet as one pass sees it: S1's assignment input plus the handoff mode. */
interface FleetView {
  input: AssignmentInput;
  handoff: 'auto' | 'ask';
}

/** The wiring: the real handoff step, the pass's handoff I/O, and the candidates for a move. */
export interface HandoffWiring {
  /** The real `handoffStep` for `flow drain`. */
  step: HandoffStep;
  /** The I/O the runner and `executeHandoff` use. */
  io: HandoffIo;
  /** `rankAccounts` for moving `run`, with its account excluded and no affinity. */
  candidates(run: FlowRun): Promise<AccountRank>;
}

/** The worker model: the handle's, else the implementation binding. */
function workerModelOf(run: FlowRun, config: NextConfig): string | null {
  return (
    run.drain?.worker?.model ?? config.models.bindings[config.models.tiers.implementation] ?? null
  );
}

/**
 * The newest checkpoint in a worktree, parsed, or `null` when there is none or
 * it does not parse.
 *
 * @param worktree - The worktree's top folder.
 * @returns The parsed checkpoint, or `null`.
 */
export function readCheckpoint(worktree: string): ParsedCheckpoint | null {
  const file = path.join(worktree, CHECKPOINT_DIR, CHECKPOINT_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = parseCheckpoint(readFileSync(file, 'utf8'));
    return parsed.ok ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build the handoff wiring for one verb run.
 *
 * @param wiring - The context, config, DorkOS home, flow prefix and the comment poster.
 * @returns The step, the I/O and the candidate ranking.
 */
export function handoffWiring(wiring: HandoffWiringInput): HandoffWiring {
  const { ctx, config, dorkHome, flow } = wiring;
  let cached: { at: number; view: Promise<FleetView> } | null = null;

  /** The fleet for the current moment, gathered once per pass. */
  const fleet = (): Promise<FleetView> => {
    const at = ctx.now().getTime();
    if (cached === null || cached.at !== at) {
      cached = {
        at,
        view: (async () => {
          const input = await gatherAssignmentInput(ctx, config);
          const policy = loadFleetPolicy(
            dorkHome,
            loadAccounts(dorkHome, { home: ctx.io.osHome }).accounts
          );
          return { input, handoff: policy.handoff };
        })(),
      };
    }
    return cached.view;
  };

  /** A (runtime, account) as the fleet lists it. */
  const accountOf = (view: FleetView, runtime: string, id: string) =>
    view.input.accounts.find((a) => a.runtime === runtime && a.id === id);

  const resolveFrom = (view: FleetView, ref: AccountRef): HandoffAccount | null => {
    const found = accountOf(view, ref.runtime, ref.id);
    return found === undefined
      ? null
      : {
          runtime: found.runtime as RuntimeName,
          id: found.id,
          path: found.path,
          implicit: found.implicit,
          label: found.label,
        };
  };

  /** Rank the accounts a run could move to (§5.2: its own excluded, no affinity). */
  const rankFor = (view: FleetView, run: FlowRun): AccountRank => {
    const runtime = handleRuntime({ runtime: run.runtime as RuntimeName | undefined });
    return rankAccounts({
      now: view.input.now,
      repo: view.input.repo,
      accounts: view.input.accounts,
      runtime,
      runtimes: view.input.runtimes,
      crossRuntimeFallback: view.input.crossRuntimeFallback,
      model: workerModelOf(run, config),
      affinity: null,
      exclude: [accountKeyOf(run.runtime, run.account)],
      liveByAccount: liveByAccount(view.input.runs),
      opts: view.input.opts,
    });
  };

  /** The run's own account's ledger signal; `null` for the ambient account (no ledger). */
  const ledgerSignal = (view: FleetView, run: FlowRun, now: Date): LimitSignal | null => {
    if (run.account === undefined || run.account === null) return null;
    const runtime = handleRuntime({ runtime: run.runtime as RuntimeName | undefined });
    const account = accountOf(view, runtime, run.account);
    if (account === undefined) return null;
    return limitSignal({
      runtime: account.runtime,
      windows: account.windows,
      spend: account.spend,
      policy: account.policy,
      model: workerModelOf(run, config),
      now,
      warnMarginPct: view.input.opts.warnMarginPct,
    });
  };

  const labelFor = (view: FleetView, runtime: string, id: string | null | undefined): string => {
    if (id === null || id === undefined) return 'the ambient account';
    return accountOf(view, runtime, id)?.label ?? id;
  };

  const step: HandoffStep = async (run, facts, now) => {
    const drain = run.drain;
    if (!drain || drain.v !== 1) return { run, actions: [] };
    const reviewerLimited = facts.reviewer?.kind === 'limited';
    const workerLimited = facts.worker?.kind === 'limited';
    // The cheap path: nothing limited and no episode, so only the run's own
    // ledger is worth a look, and that needs the fleet only when an account is set.
    if (run.limit === undefined && !reviewerLimited && !workerLimited && !run.account) {
      return { run, actions: [] };
    }
    const view = await fleet();
    const signal = combineSignal(ledgerSignal(view, run, now), facts.worker, now);
    if (
      run.limit === undefined &&
      !reviewerLimited &&
      (signal.level === 'ok' || signal.level === 'unknown')
    ) {
      return { run, actions: [] };
    }
    const runtime = handleRuntime({ runtime: run.runtime as RuntimeName | undefined });
    const rank = rankFor(view, run);
    const resets = rank.ineligible
      .filter((entry) => entry.reasons.includes('limited') || entry.reasons.includes('near-limit'))
      .map((entry) => {
        const account = accountOf(view, entry.runtime, entry.id);
        if (account === undefined) return null;
        return limitSignal({
          runtime: account.runtime,
          windows: account.windows,
          spend: account.spend,
          policy: account.policy,
          model: workerModelOf(run, config),
          now,
          warnMarginPct: view.input.opts.warnMarginPct,
        }).resetsAt;
      });
    const parsed = readCheckpoint(run.worktreePath);
    const checkpoint: HandoffCheckpoint | null = parsed
      ? { trigger: parsed.header.trigger, writtenAt: parsed.header.writtenAt }
      : null;
    const own = run.account ? accountOf(view, runtime, run.account) : undefined;
    const host = (run.host ?? drain.worker?.host ?? 'cli') as HostName;
    const modelFallback =
      own === undefined
        ? null
        : pickFallbackModel({
            runtime: runtime as RuntimeSlug,
            list: config.drain.modelFallback[runtime] ?? [],
            bindings: config.models.bindings,
            current: workerModelOf(run, config),
            windows: own.windows,
            spend: own.spend,
            policy: own.policy,
            warnMarginPct: view.input.opts.warnMarginPct,
            canSwitch: canSwitchModel(host, runtime),
            now,
          });
    return nextHandoffAction({
      run,
      signal,
      session: facts.worker,
      reviewer: facts.reviewer,
      checkpoint,
      policy: { handoff: view.handoff, crossRuntimeFallback: view.input.crossRuntimeFallback },
      candidates: { pick: rank.pick, resets },
      modelFallback,
      accountLabel: labelFor(view, runtime, run.account),
      now,
      cfg: {
        windDownGraceMinutes: config.drain.windDownGraceMinutes,
        waitIfResetWithinMinutes: config.drain.waitIfResetWithinMinutes,
        startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
        flow,
      },
    });
  };

  const ensureCheckpoint: HandoffIo['ensureCheckpoint'] = async (run, since, reason) => {
    const worktree = run.worktreePath;
    const prev = readCheckpoint(worktree);
    if (prev !== null && Date.parse(prev.header.writtenAt) > Date.parse(since)) return;
    const range = prev ? [`${prev.header.headSha}..HEAD`] : ['-5'];
    const log = await ctx.runProcess('git', ['log', '--oneline', ...range], { cwd: worktree });
    const commits =
      log.code === 0 ? log.stdout.split('\n').filter((line) => line.trim() !== '') : [];
    const body = synthesizeCheckpoint(prev, {
      identifier: run.identifier,
      stage: run.stage,
      stoppedAt: ctx.now().toISOString(),
      reason,
      commits,
    });
    const file = path.join(worktree, SYNTHESIZED_BODY);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body.body);
    await writeCheckpoint(
      { ...ctx, projectDir: worktree, sessionId: run.sessionId || undefined },
      {
        identifier: run.identifier,
        trigger: 'synthesized',
        bodyFile: file,
        task: null,
        spec: prev?.header.spec ?? null,
        stage: undefined,
      }
    );
  };

  const transcriptFor: HandoffIo['transcriptFor'] = (handle: SessionHandle) => {
    const runtime = handleRuntime(handle);
    if (runtime === 'opencode') return null;
    // The account's folder from the shared resolver (a handle with no account
    // bills the machine-wide `default`), never the supervisor's own environment.
    const { accounts } = loadAccounts(dorkHome, { home: ctx.io.osHome });
    const found = resolveAccountRef(accounts, runtime, handle.account ?? 'default');
    const home =
      handle.configDir ??
      sessionHome(
        runtime,
        found === null || found.path === null ? null : launchAccountFor(found),
        ctx.env,
        ctx.io.osHome
      );
    if (!home) return null;
    return runtime === 'codex'
      ? findCodexRollout(home, handle.sessionId)
      : findTranscript(home, handle.sessionId);
  };

  const io: HandoffIo = {
    ensureCheckpoint,
    transcriptFor,
    resolveAccount: async (ref) => resolveFrom(await fleet(), ref),
    async notify(run, candidate) {
      if (wiring.comment === undefined) return;
      const view = await fleet();
      const runtime = handleRuntime({ runtime: run.runtime as RuntimeName | undefined });
      const text = askText({
        identifier: run.identifier,
        accountLabel: labelFor(view, runtime, run.account),
        window: run.limit?.window ?? null,
        resetsAt: run.limit?.resetsAt ?? null,
        candidate,
        candidateLabel: labelFor(view, candidate.runtime, candidate.id),
        flow,
      });
      await wiring.comment(
        run.identifier,
        signBody(text, config.identity.marker, sessionProvenance(ctx, undefined))
      );
    },
  };

  return {
    step,
    io,
    async candidates(run) {
      return rankFor(await fleet(), run);
    },
  };
}
