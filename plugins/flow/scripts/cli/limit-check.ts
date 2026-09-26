/**
 * `flow limit-check --hook` and `flow limit-check <identifier>` (spec
 * `flow-handoff-dispatch` §5.4): tell a live Claude Code worker, between tool
 * calls, that its account is close to a usage limit.
 *
 * **As a hook** (`hooks/hooks.json`, `PostToolUse`), it reads the hook's stdin
 * JSON (`session_id`, `cwd`), finds the run whose session is that one in the
 * main checkout's `flow-state.json`, computes the account's limit signal from
 * its usage ledger, and on `warning` or `exhausted` prints
 * `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":…}}`
 * with the supervisor's wind-down words. Claude Code hands `additionalContext`
 * to the model with the tool result.
 *
 * - **Once per episode:** it records `{ window, resetsAt }` in
 *   `<worktree>/.dork/flow/drain/limit-notified-<sessionId>.json` and stays
 *   silent while that matches.
 * - **Silent for everything else:** no matching run (a session outside flow),
 *   the ambient account, no ledger, and any error at all. It always exits 0: a
 *   hook that fails must never block the worker's tool call.
 * - It imports no `zod` (it reads the run store as plain JSON), reads no tracker
 *   and makes no network call, and never outlives a 2 s watchdog.
 *
 * It is Claude Code only. Codex and OpenCode workers get the supervisor's
 * `wind-down` message at its next pass instead.
 *
 * **By hand**, `flow limit-check <identifier>` prints the run's signal.
 *
 * @module @dorkos/flow/cli/limit-check
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { limitSignal, type LimitSignal } from '../drain/account-rank.ts';
import { windowLabel } from '../drain/handoff.ts';
import { render } from '../drain/messages.ts';
import { PreconditionError } from '../errors.ts';
import { loadAccounts, loadFleetPolicy, resolveDorkHome } from '../fleet/accounts.ts';
import { readLedger, type RuntimeSlug } from '../fleet/usage-ledger.ts';
import type { FlowRun } from '../flow-run.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** The run store, relative to the main checkout. */
const STATE_FILE = path.join('.dork', 'flow', 'flow-state.json');

/** The largest hook payload read (Claude Code's is a few KB). */
const STDIN_LIMIT = 1024 * 1024;

/** The hook never runs longer than this, whatever it is doing. */
const WATCHDOG_MS = 2000;

/** Nothing to say. */
const SILENT: VerbResult = { json: {}, text: '' };

/**
 * `drain.warnMarginPct`'s default. The project config needs zod to load, which
 * the hook must not import, so the hook judges with the default margin.
 */
const DEFAULT_WARN_MARGIN_PCT = 10;

/** The runs in a main checkout's store (a map keyed by issue id), read as plain JSON (no zod). */
function readRuns(mainCheckout: string): FlowRun[] {
  const parsed = JSON.parse(readFileSync(path.join(mainCheckout, STATE_FILE), 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return Object.values(parsed as Record<string, FlowRun>).filter(
    (run) => run !== null && typeof run === 'object'
  );
}

/** The main checkout of the checkout at `cwd`: the parent of its common git dir. */
async function mainCheckoutOf(ctx: VerbContext, cwd: string): Promise<string | null> {
  const result = await ctx.runProcess(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, timeoutMs: 1500 }
  );
  if (result.code !== 0 || result.stdout.trim() === '') return null;
  return path.dirname(result.stdout.trim());
}

/** A run's account signal from its ledger; `null` for the ambient account or no ledger. */
function signalFor(ctx: VerbContext, run: FlowRun): { signal: LimitSignal; label: string } | null {
  if (!run.account) return null;
  const runtime = (run.runtime ?? 'claude-code') as RuntimeSlug;
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const ledger = readLedger(dorkHome, runtime, run.account).ledger;
  if (ledger === null) return null;
  const registry = loadAccounts(dorkHome).accounts;
  const policy = loadFleetPolicy(dorkHome, registry).accounts.find(
    (entry) => entry.runtime === runtime && entry.id === run.account
  );
  if (policy === undefined) return null;
  const label =
    registry.find((a) => a.runtime === runtime && a.id === run.account)?.label ?? run.account;
  const signal = limitSignal({
    runtime,
    windows: ledger.windows,
    spend: ledger.spend,
    policy,
    // The session's own model; the config's binding needs zod to load.
    model: run.drain?.worker?.model ?? null,
    now: ctx.now(),
    warnMarginPct: DEFAULT_WARN_MARGIN_PCT,
  });
  return { signal, label };
}

/** The hook: speak once per episode, else stay silent. Never throws. */
async function hook(ctx: VerbContext): Promise<VerbResult> {
  const raw = await ctx.io.stdin.read(STDIN_LIMIT);
  if (raw === null || raw.trim() === '') return SILENT;
  const payload = JSON.parse(raw) as { session_id?: unknown; cwd?: unknown };
  const sessionId = payload.session_id;
  const cwd = payload.cwd;
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string') return SILENT;
  const main = await mainCheckoutOf(ctx, cwd);
  if (main === null || !existsSync(path.join(main, STATE_FILE))) return SILENT;
  const run = readRuns(main).find(
    (r) => r.sessionId === sessionId && (r.status === 'running' || r.status === 'queued')
  );
  if (run === undefined) return SILENT;
  const found = signalFor(ctx, run);
  if (found === null) return SILENT;
  const { signal, label } = found;
  if (signal.level !== 'warning' && signal.level !== 'exhausted') return SILENT;

  const marker = path.join(
    run.worktreePath,
    '.dork',
    'flow',
    'drain',
    `limit-notified-${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
  );
  const episode = { window: signal.window, resetsAt: signal.resetsAt };
  try {
    const seen = JSON.parse(readFileSync(marker, 'utf8')) as typeof episode;
    if (seen.window === episode.window && seen.resetsAt === episode.resetsAt) return SILENT;
  } catch {
    // No marker yet: this episode has not been told.
  }
  const text = render('wind-down', {
    flow: `node --experimental-strip-types ${path.join(ctx.flowRoot, 'scripts', 'flow.ts')}`,
    identifier: run.identifier,
    accountLabel: label,
    windowLabel: windowLabel(signal.window),
  });
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, `${JSON.stringify(episode)}\n`);
  return {
    json: {},
    text: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
    }),
  };
}

/**
 * Run `flow limit-check`.
 *
 * @param ctx - The verb's context.
 * @returns With `--hook`: the hook's JSON when it speaks, else nothing (always
 *   exit 0). Without: the run's signal.
 * @throws {PreconditionError} By hand, when the item has no run here (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  if (ctx.args.flags.hook === true) {
    ctx.io.armWatchdog(WATCHDOG_MS);
    try {
      return await hook(ctx);
    } catch {
      return SILENT;
    }
  }
  const identifier = ctx.args.positionals[0];
  if (identifier === undefined) {
    throw new PreconditionError('flow limit-check needs the item, or --hook');
  }
  const main = await mainCheckoutOf(ctx, ctx.projectDir);
  const run =
    main === null || !existsSync(path.join(main, STATE_FILE))
      ? undefined
      : readRuns(main).find((r) => r.identifier === identifier);
  if (run === undefined) {
    throw new PreconditionError(`${identifier} has no run on this machine`);
  }
  const found = signalFor(ctx, run);
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
