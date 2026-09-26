/**
 * `flow drain [--parallel N] [--host auto|cli|cmux|dorkos] [--items <id,...>]
 * [--project <dir>] [--permission-mode <mode>] [--tick] [--manual] [--dry-run]`
 * (spec `flow-handoff-dispatch` §4.1): carry several ready items at once, one
 * worker per item on its own account and worktree, each push reviewed by a
 * separate session before any pull request opens.
 *
 * - `--parallel` defaults to `drain.parallel`; 0 with no flag exits 2.
 * - `--tick` runs one pass and exits (what a scheduler runs). Without it the
 *   verb passes every `drain.pollSeconds` until no run is active and nothing is
 *   eligible, or until SIGINT, which leaves every session running for the next
 *   `flow drain` to adopt.
 * - One supervisor per project: `<main checkout>/.dork/flow/drain.lock` (exit 5
 *   while a live drain holds it). `--tick` holds it for its pass only.
 * - Paused exits 7 unless `--manual`. `--dry-run` prints what a pass would do
 *   and writes nothing, not even the lock.
 * - The host is resolved once per runtime and printed with its reason on stderr.
 *
 * The pass itself is `scripts/drain/runner.ts`; this module wires it to the
 * project's config, the code adapter, the forge and the launchers.
 *
 * @module @dorkos/flow/cli/drain
 */

import path from 'node:path';

import { chooseAccount, rankAccounts } from '../drain/account-rank.ts';
import { acquireDrainLock } from '../drain/lock.ts';
import {
  findMintedSession,
  runPass,
  type HandoffStep,
  type PassDeps,
  type PassEvent,
  type PlannedAccount,
} from '../drain/runner.ts';
import { ingestStreamLog } from '../drain/stream-log.ts';
import { ConfigError, PausedError, UsageError } from '../errors.ts';
import {
  loadAccounts,
  loadFleetPolicy,
  parseOriginRepo,
  resolveDorkHome,
} from '../fleet/accounts.ts';
import { openFlowStateFile, resolveMainCheckout } from '../flow-state-file.ts';
import { forgeTargetFor } from '../forge/types.ts';
import { dorkosBaseUrl } from '../launchers/dorkos.ts';
import { realLauncher } from '../launchers/real.ts';
import { hostPreference, resolveHost } from '../launchers/resolve.ts';
import { DEFAULT_START_TIMEOUT_MS, sessionHome } from '../launchers/common.ts';
import {
  HOST_NAMES,
  type HostName,
  type LaunchPermissionMode,
  type Launcher,
  type ProbeResult,
  type RuntimeName,
} from '../launchers/types.ts';
import { AGENT_CLAIMED, projectionFor } from '../work-state.ts';
import { loadProjectConfig } from './backlog.ts';
import { claimItem } from './claim.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { gatherAssignmentInput, liveByAccount, noAccountMessage, planNext } from './next.ts';
import { signBody, unsignedBody } from './provenance.ts';
import { releaseItem } from './release.ts';
import { journalUsage } from './usage-journal.ts';
import { applyAndVerify, isOpenItem, sessionProvenance, setupWrite } from './work-write.ts';

/** The permission modes a drain session may start in. */
const PERMISSION_MODES: readonly LaunchPermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
];

/** How many recent comments are checked before a park posts its reason. */
const RECENT_COMMENTS = 10;

/** The adapter methods a drain calls. */
const CAPABILITIES = ['getItem', 'applyWorkState', 'comment', 'getBacklogSnapshot'] as const;

/** Options the tests (and only the tests) pass to {@link drain}. */
export interface DrainOptions {
  /** The handoff reducer (default: none until the handoff phase ships). */
  handoffStep?: HandoffStep;
  /** Mint session ids. */
  mintId?: () => string;
  /** Mint reviewer tokens. */
  mintToken?: () => string;
  /** Look for a session a stopped pass started (default: this machine's files, or DorkOS). */
  findSession?: PassDeps['findSession'];
}

/** A string flag's value, if given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** `--parallel`, or the configured default; 0 with no flag is a usage error. */
function parallelOf(ctx: VerbContext, configured: number): number {
  const given = flag(ctx, 'parallel');
  if (given === undefined) {
    if (configured < 1) throw new UsageError('set --parallel or drain.parallel');
    return configured;
  }
  if (!/^\d+$/.test(given) || Number(given) < 1) {
    throw new UsageError(`--parallel must be a whole number of at least 1, not "${given}"`);
  }
  return Number(given);
}

/** The human line for one event. */
function line(event: PassEvent): string {
  const where = [event.account, event.host].filter(Boolean).join(', ');
  return `${event.identifier} ${event.event}${where ? ` [${where}]` : ''}`;
}

/**
 * Run `flow drain`, with test seams.
 *
 * @param ctx - The verb's context.
 * @param options - Test-only seams.
 * @returns Every run event of every pass.
 */
export async function drain(ctx: VerbContext, options: DrainOptions = {}): Promise<VerbResult> {
  const project = loadProjectConfig(ctx);
  const { config, paused } = project.loaded;
  if (paused !== null && !ctx.manual) {
    project.flushWarnings();
    throw new PausedError(
      `flow is paused${paused.pausedAt ? ` (since ${paused.pausedAt})` : ''}; /flow:resume lifts it, or pass --manual when a person is driving`
    );
  }
  const parallel = parallelOf(ctx, config.drain.parallel);
  const pref = hostPreference(flag(ctx, 'host'), config.drain.host);
  const modeFlag = flag(ctx, 'permission-mode');
  if (modeFlag !== undefined && !(PERMISSION_MODES as readonly string[]).includes(modeFlag)) {
    throw new UsageError(
      `--permission-mode must be one of ${PERMISSION_MODES.join(', ')}, not "${modeFlag}"`
    );
  }
  const permissionMode = (modeFlag ?? config.drain.permissionMode) as LaunchPermissionMode;
  const items = flag(ctx, 'items')
    ?.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  const tick = ctx.args.flags.tick === true;

  const mainCheckout = resolveMainCheckout(ctx.projectDir);
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const origin = await ctx.runProcess('git', ['remote', 'get-url', 'origin'], {
    cwd: mainCheckout,
  });
  if (origin.code !== 0 || origin.stdout.trim() === '') {
    throw new ConfigError(`${mainCheckout} has no origin remote; flow drain pushes branches there`);
  }
  const forge = ctx.forge(forgeTargetFor(origin.stdout.trim(), ctx.env));
  const repo = parseOriginRepo(origin.stdout);
  const repoName = repo?.split('/').pop() ?? path.basename(mainCheckout);

  const setup = await setupWrite(ctx, CAPABILITIES);
  const { adapter, store, stages } = setup;

  const launchers = new Map<HostName, Launcher>();
  const launcher = (host: HostName): Launcher => {
    let made = launchers.get(host);
    if (made === undefined) {
      made = ctx.createLauncher?.(host) ?? realLauncher(host, ctx.env, ctx.io.osHome);
      launchers.set(host, made);
    }
    return made;
  };

  // The host, resolved once per runtime (probing only the hosts that can run
  // it), and printed once with its reason.
  const hosts = new Map<RuntimeName, HostName>();
  const hostFor = async (runtime: RuntimeName): Promise<HostName> => {
    let host = hosts.get(runtime);
    if (host === undefined) {
      const results = {} as Record<HostName, ProbeResult>;
      for (const name of HOST_NAMES) {
        const made = launcher(name);
        const support = made.supports(runtime);
        results[name] = support.ok ? await made.probe(runtime) : support;
      }
      const choice = resolveHost(pref, ctx.env, results, runtime);
      ctx.stderr.write(`flow drain: ${runtime} sessions run on ${choice.host} (${choice.why}).\n`);
      host = choice.host;
      hosts.set(runtime, host);
    }
    return host;
  };
  // Resolve the first runtime now, so a missing host fails before anything is claimed.
  const runtimes = loadFleetPolicy(dorkHome, loadAccounts(dorkHome).accounts).runtimes;
  await hostFor((runtimes[0] ?? 'claude-code') as RuntimeName);

  const model = (tier: 'implementation' | 'review'): string | null =>
    config.models.bindings[config.models.tiers[tier]] ?? null;
  const flowCommand = `node --experimental-strip-types ${path.join(ctx.flowRoot, 'scripts', 'flow.ts')}`;

  const plannedAccount = (
    accounts: Awaited<ReturnType<typeof gatherAssignmentInput>>['accounts'],
    ref: { runtime: string; id: string }
  ): PlannedAccount | null => {
    const found = accounts.find((a) => a.runtime === ref.runtime && a.id === ref.id);
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

  const deps: PassDeps = {
    store,
    mainCheckout,
    dorkHome,
    repoName,
    flowRoot: ctx.flowRoot,
    flow: flowCommand,
    settings: {
      parallel,
      maxLoadPerCpu: config.drain.maxLoadPerCpu,
      maxReviewRounds: config.drain.maxReviewRounds,
      startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
      permissionMode,
      workerModel: model('implementation'),
      reviewerModel: model('review'),
      rubric: config.review.rubric,
    },
    dryRun: ctx.dryRun,
    now: () => ctx.now(),
    load: () => ctx.io.load(),
    runProcess: ctx.runProcess,
    launcher,
    hostFor,
    forge,
    async item(identifier) {
      const item = await adapter.getItem(identifier);
      return {
        closed: !isOpenItem(item),
        claimed: item.labels.includes(AGENT_CLAIMED),
        title: item.title,
      };
    },
    async plan(slots) {
      const plan = await planNext(ctx, project, { count: slots, items, accounts: true });
      const accounts = plan.assignment?.accounts ?? [];
      const picks = plan.picked.map((item, i) => {
        const pick = plan.accounts?.[i]?.pick ?? null;
        return {
          identifier: item.identifier,
          title: item.title,
          account: pick === null ? null : plannedAccount(accounts, pick),
        };
      });
      const blocked = plan.accounts?.find((account) => account.pick === null);
      return {
        picks,
        noAccount: blocked === undefined ? null : noAccountMessage(plan.repo, blocked),
        considered: accounts.map((a) => `${a.runtime}:${a.id}`),
      };
    },
    async reviewerAccount(runtime) {
      const input = await gatherAssignmentInput(ctx, config);
      const rank = rankAccounts({
        now: input.now,
        repo: input.repo,
        accounts: input.accounts,
        runtime,
        runtimes: input.runtimes,
        crossRuntimeFallback: input.crossRuntimeFallback,
        model: model('review'),
        affinity: null,
        exclude: [],
        liveByAccount: liveByAccount(input.runs),
        opts: input.opts,
      });
      const choice = chooseAccount({ accounts: input.accounts, rank });
      return choice.account === 'none' ? null : plannedAccount(input.accounts, choice.account);
    },
    async claim(input) {
      await claimItem(ctx, setup, {
        identifier: input.identifier,
        sessionId: input.sessionId,
        workerPid: -1,
        worktreePath: input.worktreePath,
        branch: input.branch,
        status: 'queued',
        provenance: {
          ...sessionProvenance(ctx, input.host),
          sessionId: input.sessionId,
        },
        ...(input.account === undefined ? {} : { account: input.account }),
        host: input.host,
        runtime: input.runtime,
        drain: input.drain,
      });
    },
    async release(identifier) {
      await releaseItem(ctx, setup, { identifier, to: 'ready' });
    },
    async park(identifier, reason) {
      const item = await adapter.getItem(identifier, { comments: RECENT_COMMENTS });
      const body = signBody(
        `flow drain parked this item: ${reason}.`,
        config.identity.marker,
        sessionProvenance(ctx, undefined)
      );
      const unsigned = unsignedBody(body);
      const posted = (item.comments ?? [])
        .slice(-RECENT_COMMENTS)
        .some((comment) => unsignedBody(comment.body) === unsigned);
      if (!posted) await adapter.comment(item, body);
      await applyAndVerify(adapter, item, projectionFor({ type: 'needs-input' }, { stages }));
    },
    findSession:
      options.findSession ??
      ((probe) => {
        const configDir =
          probe.configDir ??
          sessionHome(
            probe.runtime ?? 'claude-code',
            probe.account === null
              ? null
              : {
                  runtime: probe.runtime ?? 'claude-code',
                  id: probe.account,
                  path:
                    loadAccounts(dorkHome).accounts.find(
                      (a) =>
                        a.runtime === (probe.runtime ?? 'claude-code') && a.id === probe.account
                    )?.path ?? null,
                },
            ctx.env,
            ctx.io.osHome
          ) ??
          undefined;
        return findMintedSession(
          { ...probe, ...(configDir === undefined ? {} : { configDir }) },
          { dorkosUrl: dorkosBaseUrl(ctx.env), fetch: ctx.io.fetch }
        );
      }),
    async ingest(handle) {
      const result = await ingestStreamLog(handle, { dorkHome, now: () => ctx.now() });
      for (const warning of result.warnings) ctx.warn(warning.message);
      return result.offset;
    },
    journalUsage(keys) {
      journalUsage(
        ctx,
        dorkHome,
        keys.map((key) => {
          const [runtime, ...rest] = key.split(':');
          return { runtime: runtime as RuntimeName, id: rest.join(':') };
        })
      );
    },
    handoffStep: options.handoffStep,
    mintId: options.mintId,
    mintToken: options.mintToken,
    warn: (message) => ctx.warn(message),
  };

  const lock = ctx.dryRun
    ? null
    : acquireDrainLock(mainCheckout, {
        pid: process.pid,
        now: ctx.now(),
        pidAlive: (pid) => ctx.io.pidAlive(pid),
      });
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  if (!tick) process.once('SIGINT', onSigint);
  const events: PassEvent[] = [];
  const lines: string[] = [];
  try {
    for (;;) {
      const report = await runPass(deps);
      events.push(...report.events);
      const passLines = report.events.map(line);
      if (report.held === 'machine-busy') {
        passLines.push('The machine is busy, so no new session started this pass.');
      }
      lines.push(...passLines);
      if (tick || ctx.dryRun) break;
      if (!ctx.json && passLines.length > 0) ctx.stdout.write(`${passLines.join('\n')}\n`);
      if (interrupted || (report.active === 0 && report.nothingEligible)) break;
      await ctx.io.sleep(config.drain.pollSeconds * 1000);
      if (interrupted) break;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    lock?.release();
  }
  const text =
    tick || ctx.dryRun
      ? lines.join('\n') || 'Nothing changed this pass.'
      : interrupted
        ? 'Stopped; every session keeps running, and the next flow drain adopts them.'
        : 'Nothing is active and nothing is eligible; the drain is done.';
  return {
    json: {
      runs: events.map(({ identifier, phase, account, host, event }) => ({
        identifier,
        phase,
        account,
        host,
        event,
      })),
    },
    text,
  };
}

/**
 * Run `flow drain`.
 *
 * @param ctx - The verb's context.
 * @returns Every run event of the pass (or passes).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  return drain(ctx);
}
