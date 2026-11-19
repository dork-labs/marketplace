/**
 * Read the canonical Flow usage policy for a run. The manual form reports its
 * signal; PostToolUse and the internal stdin form can commit a warning episode
 * and return the same wind-down request. Both automated forms fail open and
 * stay free of zod, tracker, forge and provider clients.
 *
 * @module @dorkos/flow/cli/limit-check
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

import { isPlainObject } from '../_shared.ts';
import { readJsonFile, updateJsonFile } from '../atomic-json.ts';
import { warnMarginPct } from '../config-files.ts';
import { limitSignal, modelBucketsFor, type LimitSignal } from '../drain/account-rank.ts';
import { windowLabel } from '../drain/handoff.ts';
import { render } from '../drain/messages.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import { loadAccounts, loadFleetPolicy, resolveDorkHome } from '../fleet/accounts.ts';
import { readLedger, readSpend, readWindow } from '../fleet/usage-ledger.ts';
import type { FlowRun } from '../flow-run.ts';
import { shellQuote } from '../launchers/shell-quote.ts';
import { STATE_RELATIVE_PATH } from '../main-checkout.ts';
import { gitFreeEnv } from '../project-boundary.ts';
import type { VerbContext, VerbResult } from './context.ts';

const HOOK_INPUT_BYTES = 1024 * 1024;
const CONTEXT_INPUT_BYTES = 8 * 1024;
const HOOK_OUTPUT_BYTES = 24 * 1024;
const CONTEXT_OUTPUT_BYTES = 32 * 1024;
const WATCHDOG_MS = 2000;
const LOCK_WAIT_MS = 250;
const SILENT_HOOK: VerbResult = { json: {}, text: '' };

type SilentReason = 'healthy' | 'unknown' | 'unbound' | 'closed' | 'busy' | 'timeout';
type WarningResult =
  { v: 1; kind: 'silent'; reason: SilentReason } | { v: 1; kind: 'warning'; hookStdout: string };

interface BoundContext {
  issueId: string;
  expectedSessionId: string;
  runtime: 'codex' | 'opencode';
  accountId: string;
  cwd: string;
}

const CONTEXT_KEYS = [
  'v',
  'operation',
  'issueId',
  'expectedSessionId',
  'runtime',
  'accountId',
  'cwd',
];

type SilentResult = Extract<WarningResult, { kind: 'silent' }>;
type EpisodeWarning = {
  kind: 'warning';
  hookStdout: string;
  episode: Pick<LimitSignal, 'window' | 'resetsAt'>;
};

function silent(reason: SilentReason): SilentResult {
  return { v: 1, kind: 'silent', reason };
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    Buffer.byteLength(value) <= 256 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function parseContext(value: unknown): BoundContext | null {
  if (!isPlainObject(value) || Object.keys(value).length !== CONTEXT_KEYS.length) return null;
  if (!CONTEXT_KEYS.every((key) => Object.hasOwn(value, key))) return null;
  if (value.v !== 1 || value.operation !== 'evaluate') return null;
  const { issueId, expectedSessionId, runtime, accountId, cwd } = value;
  if (runtime !== 'codex' && runtime !== 'opencode') return null;
  if (!boundedId(issueId) || !boundedId(expectedSessionId) || !boundedId(accountId)) return null;
  if (
    typeof cwd !== 'string' ||
    !path.isAbsolute(cwd) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(cwd)
  ) {
    return null;
  }
  return { issueId, expectedSessionId, runtime, accountId, cwd };
}

/** Resolve linked worktrees to the same run store, ignoring git redirection variables. */
async function mainCheckoutOf(ctx: VerbContext, cwd: string): Promise<string | null> {
  const result = await ctx.runProcess(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, env: gitFreeEnv(), timeoutMs: 500 }
  );
  const commonDir = result.stdout.trim();
  if (result.code !== 0 || !path.isAbsolute(commonDir)) return null;
  return realpathSync(path.dirname(commonDir));
}

/** Read the canonical run map without loading the zod-backed mutation surface. */
function readRuns(mainCheckout: string): FlowRun[] {
  const { value } = readJsonFile(path.join(mainCheckout, STATE_RELATIVE_PATH));
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([issueId, run]) =>
    isPlainObject(run) && run.issueId === issueId ? [run as unknown as FlowRun] : []
  );
}

function active(run: FlowRun): boolean {
  return run.status === 'running' || run.status === 'queued';
}

function sameWorktree(run: FlowRun, cwd: string): boolean {
  return (
    typeof run.worktreePath === 'string' &&
    path.isAbsolute(run.worktreePath) &&
    realpathSync(run.worktreePath) === cwd
  );
}

/** One read-only policy evaluation for all callers. */
function signalFor(
  ctx: VerbContext,
  mainCheckout: string,
  run: FlowRun,
  registeredOnly = false
): { signal: LimitSignal; label: string } | null {
  if (!run.account) return null;
  const runtime = run.runtime ?? 'claude-code';
  if (runtime !== 'claude-code' && runtime !== 'codex' && runtime !== 'opencode') return null;
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const { accounts, registryReadable } = loadAccounts(dorkHome, { home: ctx.io.osHome });
  if (!registryReadable) return null;
  const account = accounts.find(
    (account) => account.runtime === runtime && account.id === run.account
  );
  if (account === undefined || !account.routable || (registeredOnly && account.implicit)) {
    return null;
  }
  const { ledger } = readLedger(dorkHome, runtime, account.id);
  if (ledger === null || ledger.runtime !== runtime || ledger.accountId !== account.id) return null;
  const policy = loadFleetPolicy(dorkHome, accounts).accounts.find(
    (entry) => entry.runtime === runtime && entry.id === account.id
  );
  if (policy === undefined) return null;
  const model = run.drain?.worker?.model ?? null;
  const now = ctx.now();
  if (runtime === 'opencode') {
    // Cost-only observations do not establish allowance. An explicit canonical
    // spend cap remains a budget signal, as it is for the supervisor.
    const modelBuckets = modelBucketsFor(model);
    const knownWindow = Object.entries(ledger.windows).some(
      ([key, entry]) =>
        (modelBuckets.includes(key) ||
          !(key.startsWith('model:') || key.startsWith('seven_day_'))) &&
        readWindow(entry, now, key) !== null
    );
    if (!knownWindow && (readSpend(ledger.spend)?.limitUsd ?? null) === null) return null;
  }
  const signal = limitSignal({
    runtime,
    windows: ledger.windows,
    spend: ledger.spend,
    policy,
    model,
    now,
    warnMarginPct: warnMarginPct({
      checkout: mainCheckout,
      mainCheckout: null,
      inGit: true,
      pluginRoot: ctx.flowRoot,
    }),
  });
  return { signal, label: account.label ?? account.id };
}

function warningFor(
  ctx: VerbContext,
  mainCheckout: string,
  run: FlowRun,
  registeredOnly: boolean
): SilentResult | EpisodeWarning {
  const found = signalFor(ctx, mainCheckout, run, registeredOnly);
  if (found === null || found.signal.level === 'unknown') return silent('unknown');
  const { signal, label } = found;
  if (signal.level === 'ok') return silent('healthy');
  const script = path.join(ctx.flowRoot, 'scripts', 'flow.ts');
  const scriptWord = /^[A-Za-z0-9_./-]+$/.test(script) ? script : shellQuote(script);
  const additionalContext = render('wind-down', {
    flow: `node --experimental-strip-types ${scriptWord}`,
    identifier: run.identifier,
    accountLabel: label,
    windowLabel: windowLabel(signal.window),
  });
  const hookStdout = `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
  })}\n`;
  const result = { v: 1, kind: 'warning' as const, hookStdout };
  if (
    Buffer.byteLength(hookStdout) > HOOK_OUTPUT_BYTES ||
    Buffer.byteLength(JSON.stringify(result)) + 1 > CONTEXT_OUTPUT_BYTES
  ) {
    return silent('unknown');
  }
  return {
    kind: 'warning',
    hookStdout,
    episode: { window: signal.window, resetsAt: signal.resetsAt },
  };
}

/** Re-read the bound run and ledger under the episode lock before committing a warning. */
async function evaluateWarning(
  ctx: VerbContext,
  mainCheckout: string,
  findRun: () => FlowRun | undefined,
  registeredOnly: boolean
): Promise<WarningResult> {
  const run = findRun();
  if (run === undefined) return silent('unbound');
  if (!active(run)) return silent('closed');
  const initial = warningFor(ctx, mainCheckout, run, registeredOnly);
  if (initial.kind === 'silent') return initial;
  const sessionId = run.sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const marker = path.join(
    run.worktreePath,
    '.dork',
    'flow',
    'drain',
    `limit-notified-${sessionId}.json`
  );
  let result: WarningResult = silent('closed');
  const outcome = await updateJsonFile(
    marker,
    (seen) => {
      const latest = findRun();
      if (latest === undefined || !active(latest) || latest.sessionId !== run.sessionId) {
        return undefined;
      }
      const warning = warningFor(ctx, mainCheckout, latest, registeredOnly);
      if (warning.kind === 'silent') {
        result = warning;
        return undefined;
      }
      const { episode, hookStdout } = warning;
      if (
        isPlainObject(seen) &&
        seen.window === episode.window &&
        seen.resetsAt === episode.resetsAt
      ) {
        return undefined;
      }
      result = { v: 1, kind: 'warning', hookStdout };
      return episode;
    },
    { giveUpMs: LOCK_WAIT_MS }
  );
  return outcome.status === 'dropped' ? silent('busy') : result;
}

async function evaluateHook(ctx: VerbContext, value: unknown): Promise<WarningResult> {
  if (!isPlainObject(value) || !boundedId(value.session_id) || typeof value.cwd !== 'string') {
    return silent('unbound');
  }
  const { session_id: sessionId } = value;
  const git = await ctx.runProcess('git', ['rev-parse', '--show-toplevel'], {
    cwd: value.cwd,
    env: gitFreeEnv(),
    timeoutMs: 500,
  });
  if (git.code !== 0 || !path.isAbsolute(git.stdout.trim())) return silent('unbound');
  const cwd = realpathSync(git.stdout.trim());
  const main = await mainCheckoutOf(ctx, cwd);
  if (main === null) return silent('unbound');
  const findRun = () => {
    const matching = readRuns(main).filter(
      (run) =>
        run.sessionId === sessionId &&
        (run.runtime ?? 'claude-code') === 'claude-code' &&
        sameWorktree(run, cwd)
    );
    return matching.length === 1 ? matching[0] : undefined;
  };
  return evaluateWarning(ctx, main, findRun, false);
}

async function evaluateContext(ctx: VerbContext, value: unknown): Promise<WarningResult> {
  const request = parseContext(value);
  if (request === null || realpathSync(request.cwd) !== request.cwd) return silent('unbound');
  const main = await mainCheckoutOf(ctx, request.cwd);
  if (main === null || main !== realpathSync(ctx.cwd)) return silent('unbound');
  const findRun = () => {
    const matching = readRuns(main).filter(
      (run) =>
        run.sessionId === request.expectedSessionId &&
        run.runtime === request.runtime &&
        run.account === request.accountId &&
        sameWorktree(run, request.cwd) &&
        (run.issueId === request.issueId || active(run))
    );
    return matching.length === 1 && matching[0].issueId === request.issueId
      ? matching[0]
      : undefined;
  };
  return evaluateWarning(ctx, main, findRun, true);
}

async function automatic(ctx: VerbContext, hook: boolean): Promise<VerbResult> {
  ctx.io.armWatchdog(WATCHDOG_MS);
  let result: WarningResult;
  try {
    const raw = await ctx.io.stdin.read(hook ? HOOK_INPUT_BYTES : CONTEXT_INPUT_BYTES);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    result = hook ? await evaluateHook(ctx, value) : await evaluateContext(ctx, value);
  } catch {
    result = silent('unknown');
  }
  if (!hook) return { json: result, text: JSON.stringify(result) };
  return result.kind === 'warning' ? { json: {}, text: result.hookStdout } : SILENT_HOOK;
}

/** Run the legacy hook, the internal context adapter, or the read-only manual check. */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const hook = ctx.args.flags.hook === true;
  const context = ctx.args.flags['context-stdin'] === true;
  const identifier = ctx.args.positionals[0];
  if (context && (hook || identifier !== undefined || ctx.args.flags.project !== undefined)) {
    throw new UsageError('--context-stdin takes no item, --hook or --project.');
  }
  if (hook || context) return automatic(ctx, hook);
  if (identifier === undefined) {
    throw new PreconditionError('flow limit-check needs the item, or --hook');
  }

  const main = await mainCheckoutOf(ctx, ctx.projectDir);
  const run =
    main === null ? undefined : readRuns(main).find((record) => record.identifier === identifier);
  if (main === null || run === undefined) {
    throw new PreconditionError(`${identifier} has no run on this machine`);
  }
  const found = signalFor(ctx, main, run);
  if (found === null) {
    return {
      json: { identifier, account: run.account ?? null, signal: null },
      text: `${identifier} runs on ${run.account ?? 'the ambient account'}, which has no usage reading; only its session can report a limit.`,
    };
  }
  const { signal, label } = found;
  const window = windowLabel(signal.window);
  return {
    json: { identifier, account: run.account ?? null, signal },
    text: `${identifier} on ${label}: ${signal.level}${window ? ` (${window}${signal.resetsAt ? `, resets ${signal.resetsAt}` : ''})` : ''}`,
  };
}
