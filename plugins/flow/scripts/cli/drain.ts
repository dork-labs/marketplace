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

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chooseAccount, rankAccounts } from '../drain/account-rank.ts';
import { answerPointer, findAnswer } from '../drain/answer.ts';
import type { RunQuestion } from '../flow-run.ts';
import { belongsToPark, checkBrief, parkedAnswer, personOnly, pickComment } from '../question.ts';
import {
  claimAnswer,
  claimCheck,
  clearQuestion,
  recordChecker,
  releaseAnswer,
  releaseCheck,
} from './question-write.ts';
import { tokenHash } from './report.ts';
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
import { ConfigError, FlowError, PausedError, PreconditionError, UsageError } from '../errors.ts';
import { removeWorktree, workspacesDir } from '../drain/worktree.ts';
import {
  loadAccounts,
  loadFleetPolicy,
  parseOriginRepo,
  resolveAccountRef,
  resolveDorkHome,
} from '../fleet/accounts.ts';
import { openFlowStateFile, resolveMainCheckout } from '../flow-state-file.ts';
import { forgeTargetFor } from '../forge/types.ts';
import { dorkosBaseUrl } from '../launchers/dorkos.ts';
import { classifyOwnership } from '../identity.ts';
import { realLauncher } from '../launchers/real.ts';
import { hostPreference, resolveHost } from '../launchers/resolve.ts';
import { DEFAULT_START_TIMEOUT_MS, launchAccountFor, sessionHome } from '../launchers/common.ts';
import {
  HOST_NAMES,
  LaunchError,
  type HostName,
  type LaunchAccount,
  type LaunchPermissionMode,
  type Launcher,
  type ProbeResult,
  type RuntimeName,
} from '../launchers/types.ts';
import { AGENT_CLAIMED, AGENT_NEEDS_INPUT, projectionFor } from '../work-state.ts';
import { loadProjectConfig } from './backlog.ts';
import { claimItem } from './claim.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { handoffWiring } from './handoff-wiring.ts';
import {
  gatherAssignmentInput,
  liveByAccount,
  noAccountMessage,
  planNext,
  type NextConfig,
} from './next.ts';
import { signBody, unsignedBody } from './provenance.ts';
import { releaseItem } from './release.ts';
import { journalUsage } from './usage-journal.ts';
import { stopInForce, type AutonomyRead } from '../autonomy.ts';
import { retireChecker } from './checker.ts';
import { runtimeSession } from './session-id.ts';
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
  /** The handoff reducer (default: the real one, `handoffWiring(...).step`). */
  handoffStep?: HandoffStep;
  /** Mint session ids. */
  mintId?: () => string;
  /** Mint reviewer tokens. */
  mintToken?: () => string;
  /** Look for a session a stopped pass started (default: this machine's files, or DorkOS). */
  findSession?: PassDeps['findSession'];
}

/**
 * A detached worktree of `branch` (else `HEAD`) at `target`, for a session that
 * must not work in the worker's tree. Reuses one that exists.
 *
 * @param ctx - The verb's context.
 * @param mainCheckout - The project's main checkout.
 * @param branch - The run's branch.
 * @param target - Where to put it.
 * @throws {PreconditionError} When git cannot add it.
 */
async function addDetachedWorktree(
  ctx: VerbContext,
  mainCheckout: string,
  branch: string,
  target: string
): Promise<void> {
  if (existsSync(target)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  for (const ref of [branch, 'HEAD']) {
    const result = await ctx.runProcess('git', ['worktree', 'add', '-q', '--detach', target, ref], {
      cwd: mainCheckout,
    });
    if (result.code === 0) return;
  }
  throw new PreconditionError(`could not add a worktree at ${target} for the pick check`);
}

/**
 * A pointer to an answer `flow answer` recorded on the run, for the worker's
 * `continue` message.
 *
 * @param question - The answered question.
 * @param identifier - The item.
 * @returns The pointer, with the answer's words.
 */
export function recordedAnswerPointer(question: RunQuestion, identifier: string): string {
  const answer = question.answer;
  if (answer === undefined) return `the latest comment on ${identifier}`;
  const who =
    answer.by === 'person'
      ? 'a person, from DorkOS'
      : answer.by === 'reviewer-agent'
        ? 'the reviewer agent'
        : 'your own pick, at the deadline';
  return `the answer recorded on ${identifier} at ${answer.at} by ${who}: "${answer.text}"`;
}

/**
 * Whether the project's dial says Ask me first for "Retry and fix problems".
 * With no copy of the dial at all, flow fixes failing checks as it always has.
 *
 * @param read - What reading the dial found (`null`: not read).
 * @returns `true` when the drain must park on red checks instead of fixing them.
 */
export function asksBeforeFixing(read: AutonomyRead | null): boolean {
  return read !== null && stopInForce(read, 'retry') === 'ask';
}

/**
 * The tracker half of a park (shared with `flow handoff`): one signed comment
 * naming the reason, then the needs-input projection.
 *
 * @param ctx - The verb's context.
 * @param setup - The write setup (adapter and stages).
 * @param config - The project config.
 * @returns The park function.
 */
export function parker(
  ctx: VerbContext,
  setup: Awaited<ReturnType<typeof setupWrite>>,
  config: NextConfig
): PassDeps['park'] {
  const { adapter, stages } = setup;
  return async (identifier, reason) => {
    const item = await adapter.getItem(identifier, { comments: RECENT_COMMENTS });
    const body = signBody(
      `flow drain parked this item: ${reason}. Reply to this comment to resume the work.`,
      config.identity.marker,
      sessionProvenance(ctx, undefined)
    );
    const unsigned = unsignedBody(body);
    // Skip only a retry of this same park: the identical comment is still the
    // item's latest. After anyone has replied, a new park posts a new comment,
    // which is what findAnswer anchors the next answer on.
    const last = (item.comments ?? []).at(-1);
    const posted = last !== undefined && unsignedBody(last.body) === unsigned;
    if (!posted) await adapter.comment(item, body);
    await applyAndVerify(adapter, item, projectionFor({ type: 'needs-input' }, { stages }));
  };
}

/**
 * Look for a session a stopped pass or mover started (shared with `flow
 * handoff`): this machine's files for cli and cmux, `GET /api/sessions/<id>`
 * for DorkOS.
 *
 * @param ctx - The verb's context.
 * @param dorkHome - The resolved DorkOS home.
 * @returns The finder.
 */
export function sessionFinder(ctx: VerbContext, dorkHome: string): PassDeps['findSession'] {
  /** The launch account a session probe names (`null`: `default`), from the shared resolver. */
  const probeLaunchAccount = (runtime: RuntimeName, id: string | null): LaunchAccount | null => {
    const { accounts } = loadAccounts(dorkHome, { home: ctx.io.osHome });
    const found = resolveAccountRef(accounts, runtime, id ?? 'default');
    return found === null || found.path === null ? null : launchAccountFor(found);
  };
  return (probe) => {
    const configDir =
      probe.configDir ??
      sessionHome(
        probe.runtime ?? 'claude-code',
        // A handle with no account bills `default`, which is machine-wide
        // (rev 6d): its folder, never the supervisor's own environment.
        probeLaunchAccount(probe.runtime ?? 'claude-code', probe.account),
        ctx.env,
        ctx.io.osHome
      ) ??
      undefined;
    return findMintedSession(
      { ...probe, ...(configDir === undefined ? {} : { configDir }) },
      { dorkosUrl: dorkosBaseUrl(ctx.env), fetch: ctx.io.fetch }
    );
  };
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
      `flow is paused${paused.until ? ` until ${paused.until}` : paused.pausedAt ? ` (since ${paused.pausedAt})` : ''}; /flow:resume lifts it${paused.until ? ' sooner' : ''}, or pass --manual when a person is driving`
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
  /** The chat running this drain: every run it starts records it as `dispatchedBy`. */
  const launchedBy = runtimeSession(ctx.env).sessionId;
  let agent: string | undefined;
  /** The agent's account id, resolved once (`identity.agent`, or the tracker's current user for `auto`). */
  const agentId = async (): Promise<string> =>
    (agent ??=
      config.identity.agent === 'auto'
        ? (await adapter.getCurrentUser()).id
        : config.identity.agent);

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
  const runtimes = loadFleetPolicy(
    dorkHome,
    loadAccounts(dorkHome, { home: ctx.io.osHome }).accounts
  ).runtimes;
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

  const handoff = handoffWiring({
    ctx,
    config,
    dorkHome,
    flow: flowCommand,
    async comment(identifier, body) {
      const item = await adapter.getItem(identifier, { comments: RECENT_COMMENTS });
      // A retry of the same notice (the same words are the latest comment) posts nothing.
      const last = (item.comments ?? []).at(-1);
      if (last !== undefined && unsignedBody(last.body) === unsignedBody(body)) return;
      await adapter.comment(item, body);
    },
  });

  /**
   * Hand a floor question's pick to the reviewer agent (spec flow-multiproject
   * §7.5): mint the check's token once, under the lock, then start an
   * independent reviewer session with the brief. A spend never gets here
   * (`parkedAnswer` refuses it); the session is a fresh one, never the worker's.
   */
  const handToReviewer = async (
    issueId: string,
    identifier: string,
    question: RunQuestion
  ): Promise<void> => {
    const run = store.read()[issueId];
    if (run === undefined || personOnly(question)) return;
    const runtime = (run.runtime ?? 'claude-code') as RuntimeName;
    const account = await deps.reviewerAccount(runtime);
    if (account === null) {
      ctx.warn(`no account may check the pick on ${identifier} now; the next pass tries again`);
      return;
    }
    const token = randomBytes(16).toString('hex');
    const hash = tokenHash(token);
    if (!(await claimCheck(store, issueId, question.askedAt, hash))) return;
    // Its own session and its own worktree, like the drain's code reviewer:
    // never the worker's, and the token-bearing brief never in the worker's tree.
    const sessionId = randomUUID();
    const target = path.join(
      workspacesDir(dorkHome, repoName),
      `check-${identifier}-${Date.parse(question.askedAt)}`
    );
    try {
      await addDetachedWorktree(ctx, mainCheckout, run.branch, target);
      const promptFile = path.join(target, '.dork', 'flow', 'drain', 'briefs', 'question-check.md');
      mkdirSync(path.dirname(promptFile), { recursive: true });
      writeFileSync(promptFile, checkBrief(question, identifier, flowCommand, token, sessionId));
      const host = await hostFor(account.runtime);
      const handle = await launcher(host).start({
        role: 'reviewer',
        runtime: account.runtime,
        identifier,
        account: account.path === null ? null : launchAccountFor(account),
        cwd: target,
        promptFile,
        sessionId,
        ...(model('review') ? { model: model('review') as string } : {}),
        permissionMode,
        title: `${identifier} question check`,
      });
      await recordChecker(store, issueId, question.askedAt, {
        host: handle.host,
        runtime: handle.runtime,
        sessionId: handle.sessionId,
        account: handle.account,
        ...(handle.pid === undefined ? {} : { pid: handle.pid }),
        cwd: target,
      });
      ctx.stderr.write(`flow drain: handed the pick on ${identifier} to the reviewer agent.\n`);
    } catch (error) {
      // A check that never started must not hold the question forever: give it
      // back, so the next pass tries again.
      await releaseCheck(store, issueId, question.askedAt, hash);
      await removeWorktree(ctx.runProcess, mainCheckout, target);
      if (!(error instanceof LaunchError) && !(error instanceof FlowError)) throw error;
      ctx.warn(
        `the reviewer agent did not start to check the pick on ${identifier} (${(error as Error).message}); the next pass tries again`
      );
    }
  };

  /**
   * Stop a pick checker that has no more work: its question is gone, answered
   * elsewhere or no longer this park's, the item closed, or the checker
   * stopped without answering (it declined, so the question waits for a
   * person). A checker still working is left alone.
   */
  const reapChecker = async (
    issueId: string,
    facts: { closed: boolean; needsInput: boolean },
    since: string | null | undefined
  ): Promise<void> => {
    const q = store.read()[issueId]?.question;
    const checker = q?.checker;
    if (q === undefined || checker === undefined || ctx.dryRun) return;
    let done =
      q.answer !== undefined ||
      facts.closed ||
      !facts.needsInput ||
      since === undefined ||
      !belongsToPark(q, since);
    if (!done) {
      try {
        const state = await launcher(checker.host as HostName).state({
          host: checker.host as HostName,
          runtime: checker.runtime as RuntimeName,
          sessionId: checker.sessionId,
          account: checker.account ?? null,
          cwd: checker.cwd,
          ...(checker.pid === undefined ? {} : { pid: checker.pid }),
        });
        done = state.kind === 'exited' || state.kind === 'idle';
      } catch {
        done = false;
      }
    }
    if (done) await retireChecker(ctx, store, mainCheckout, issueId);
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
      // "Retry and fix problems" at Ask me first: park on red checks (autonomy.ts).
      fixFailingChecks: !asksBeforeFixing(project.loaded.autonomy),
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
    async item(identifier, parked) {
      const item = await adapter.getItem(
        identifier,
        parked === undefined ? undefined : { comments: RECENT_COMMENTS }
      );
      const facts = {
        closed: !isOpenItem(item),
        claimed: item.labels.includes(AGENT_CLAIMED),
        needsInput: item.labels.includes(AGENT_NEEDS_INPUT),
        title: item.title,
        answer: null as string | null,
      };
      await reapChecker(item.id, facts, parked === undefined ? undefined : parked.since);
      if (parked === undefined || !facts.needsInput || facts.closed) return facts;
      // The inbox pass leaves drain runs alone, so the drain notices the reply itself.
      const identity = { agent: await agentId(), marker: config.identity.marker };
      const scope = config.ownership.scope.includes('issues') ? 'issues' : 'projects';
      const reply = findAnswer(item, item.comments ?? [], parked.since, {
        identity,
        ownership: classifyOwnership(
          item,
          { ...identity, reviewer: config.identity.reviewer },
          scope
        ),
        comments: config.comments,
      });
      // Only the question asked for this park counts (a later park, for review
      // rounds or failing checks, is nobody's answer), spec flow-multiproject §7.5.
      const question =
        parked.question !== undefined && belongsToPark(parked.question, parked.since)
          ? parked.question
          : undefined;
      let answer: string | null = reply === null ? null : answerPointer(reply, identifier);
      const fromQuestion = answer === null ? parkedAnswer(question, ctx.now(), parked.since) : null;
      if (fromQuestion === 'recorded' && question !== undefined) {
        // `flow answer` recorded it (from DorkOS, or the pick at a deadline).
        answer = recordedAnswerPointer(question, identifier);
      }
      if (fromQuestion === 'take-pick' && question !== undefined) {
        // Nobody answered by the deadline: the agent's pick stands. Claimed
        // under the lock first, so a person's answer or a DorkOS deadline that
        // got there first wins and this pass posts nothing.
        if (ctx.dryRun) return facts;
        const text = pickComment(question, 'agent-default');
        const recorded = { text, at: ctx.now().toISOString(), by: 'agent-default' };
        if (await claimAnswer(store, item.id, question.askedAt, recorded)) {
          try {
            await adapter.comment(
              item,
              signBody(text, config.identity.marker, sessionProvenance(ctx, undefined))
            );
          } catch (error) {
            await releaseAnswer(store, item.id, question.askedAt, recorded);
            throw error;
          }
          answer = recordedAnswerPointer({ ...question, answer: recorded }, identifier);
        } else {
          const latest = store.read()[item.id]?.question;
          if (latest?.answer === undefined || latest.askedAt !== question.askedAt) return facts;
          answer = recordedAnswerPointer(latest, identifier);
        }
      }
      if (fromQuestion === 'check-pick' && question !== undefined) {
        // A floor question's wait is over: hand its pick to the reviewer agent
        // in a session of its own. It stays parked until someone settles it.
        if (!ctx.dryRun) await handToReviewer(item.id, identifier, question);
        return facts;
      }
      if (answer === null || ctx.dryRun) return facts;
      await applyAndVerify(adapter, item, projectionFor({ type: 'claim' }, { stages }));
      // The question is answered and the work resumes on it: clear it, so a
      // later park never mistakes it for its own.
      if (question !== undefined) {
        await retireChecker(ctx, store, mainCheckout, item.id);
        await clearQuestion(store, item.id, question.askedAt);
      }
      return { ...facts, claimed: true, needsInput: false, answer };
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
    async reviewerAccount(runtime, exclude = []) {
      const input = await gatherAssignmentInput(ctx, config);
      const rank = rankAccounts({
        now: input.now,
        repo: input.repo,
        ...(input.project === undefined ? {} : { project: input.project }),
        accounts: input.accounts,
        runtime,
        runtimes: input.runtimes,
        crossRuntimeFallback: input.crossRuntimeFallback,
        model: model('review'),
        affinity: null,
        exclude,
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
        // The chat that ran `flow drain`, so DorkOS lists the run in it too.
        ...(launchedBy === null ? {} : { dispatchedBy: launchedBy }),
      });
    },
    async release(identifier) {
      await releaseItem(ctx, setup, { identifier, to: 'ready' });
    },
    park: parker(ctx, setup, config),
    findSession: options.findSession ?? sessionFinder(ctx, dorkHome),
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
    handoffStep: options.handoffStep ?? handoff.step,
    handoffIo: handoff.io,
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
