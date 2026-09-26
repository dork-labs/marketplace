/**
 * `flow usage probe <id>` (spec `flow-usage` §2.5): run one short, official
 * Claude Code turn on an account and save the `rate_limit_event` readings its
 * `stream-json` output carries.
 *
 * The turn costs a little of the account's 5-hour limit, so the cost note is
 * always printed first and nothing runs without `--yes`. The turn runs the real
 * `claude` binary on the account's own sign-in: flow reads no stored sign-in and
 * calls no usage endpoint. Variables that would make the turn bill anything but
 * that sign-in are left out of the child's environment without being read.
 *
 * Dependency-free: node builtins and other zero-dependency local modules only.
 *
 * @module @dorkos/flow/cli/usage-probe
 */

import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, PreconditionError, UsageError } from '../errors.ts';
import { loadIdentities, resolveDorkHome, type AccountIdentity } from '../fleet/accounts.ts';
import { canonicalDir } from '../fleet/config-dir.ts';
import { fromRateLimitEvent } from '../fleet/observations.ts';
import { recordUsage, type UsageObservation } from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';

/**
 * Variables removed from the probe's environment so the turn bills the
 * account's own sign-in and nothing else. flow never reads their values; it only
 * leaves them out. This list is the one place these names may appear in the
 * usage and fleet code (the compliance guard test finds it by name).
 */
export const PROBE_STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/** The model the probe uses unless `--model` names another. */
export const DEFAULT_PROBE_MODEL = 'haiku';

/** Seconds the probe waits before stopping the turn, unless `--timeout`. */
export const DEFAULT_PROBE_TIMEOUT_S = 90;

/** The prompt: as short a turn as a model can take. */
const PROMPT = 'Reply with the single word OK.';

/**
 * The `claude` arguments for one probe turn. Never `--bare`: bare mode signs in
 * with an API key only, so it would not read the subscription's limits.
 *
 * @param model - The model alias.
 * @returns The argument array (no shell ever sees it).
 */
export function probeArgs(model: string): string[] {
  return [
    '-p',
    PROMPT,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--settings',
    '{"disableAllHooks":true}',
  ];
}

/**
 * The cost note printed before anything runs.
 *
 * @param account - The account the turn runs on.
 * @param model - The model alias.
 * @returns One paragraph.
 */
export function costNote(account: AccountIdentity, model: string): string {
  return (
    `This runs one short Claude Code turn on ${account.label ?? account.id} (${account.path}) ` +
    `with model ${model}. It uses a small part of that account's 5-hour limit, and starts a new ` +
    '5-hour window if none is running. It sends no files and allows no tools.'
  );
}

/**
 * The child's environment: the current one, minus {@link PROBE_STRIPPED_ENV},
 * with `CLAUDE_CONFIG_DIR` set to the account's folder. For the default folder
 * (`<os home>/.claude`) the variable is removed instead: Claude Code looks up a
 * differently named stored sign-in whenever it is set, even to the default
 * folder, so setting it would read that account as signed out.
 *
 * @param env - The current environment.
 * @param accountPath - The account's config folder.
 * @param osHome - The OS home folder.
 * @returns A complete environment for the child.
 */
export function probeEnv(
  env: Readonly<Record<string, string | undefined>>,
  accountPath: string,
  osHome: string
): Record<string, string> {
  const out: Record<string, string> = {};
  const stripped = new Set<string>(PROBE_STRIPPED_ENV);
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !stripped.has(key)) out[key] = value;
  }
  const isDefault =
    canonicalDir(accountPath, osHome) === canonicalDir(path.join(osHome, '.claude'), osHome);
  if (isDefault) delete out.CLAUDE_CONFIG_DIR;
  else out.CLAUDE_CONFIG_DIR = accountPath;
  return out;
}

/** Whether `file` is a file this process may run. */
function isRunnable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the `claude` binary: `--claude`, else `FLOW_CLAUDE_BIN`, else `claude`
 * on `PATH`. The first one given is the only one tried.
 *
 * @throws {ConfigError} When it is not there, naming what was tried.
 */
function resolveClaude(ctx: VerbContext): string {
  const flag = ctx.args.flags.claude;
  const fromEnv = ctx.env.FLOW_CLAUDE_BIN;
  if (typeof flag === 'string' && flag !== '') {
    const file = path.resolve(flag);
    if (isRunnable(file)) return file;
    throw new ConfigError(`no runnable claude at ${file} (from --claude)`);
  }
  if (fromEnv !== undefined && fromEnv !== '') {
    const file = path.resolve(fromEnv);
    if (isRunnable(file)) return file;
    throw new ConfigError(`no runnable claude at ${file} (from FLOW_CLAUDE_BIN)`);
  }
  for (const dir of (ctx.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const file = path.join(dir, 'claude');
    if (isRunnable(file)) return file;
  }
  throw new ConfigError(
    'no claude found on PATH (FLOW_CLAUDE_BIN and --claude were not set); pass --claude <path>'
  );
}

/** Parse `--timeout` into milliseconds. */
function readTimeoutMs(ctx: VerbContext): number {
  const raw = ctx.args.flags.timeout;
  if (raw === undefined) return DEFAULT_PROBE_TIMEOUT_S * 1000;
  const seconds = typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!(seconds > 0)) {
    throw new UsageError(`--timeout needs a number of seconds above 0 (got "${String(raw)}")`);
  }
  return Math.round(seconds * 1000);
}

/** A reset time in the reader's local time. */
function localTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return 'an unknown time';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One human line for a recorded window. */
function renderObservation(observation: UsageObservation): string {
  const used =
    observation.usedPct === null || observation.usedPct === undefined
      ? 'use unknown'
      : `${Math.round(observation.usedPct)}% used`;
  const status = observation.status ? `, ${observation.status}` : '';
  return `${observation.key}  ${used}${status}, resets ${localTime(observation.resetsAt)}`;
}

/**
 * Run `flow usage probe <id>`.
 *
 * @param ctx - The verb context.
 * @returns The note (and, with `--yes`, one line per recorded window), and the
 *   account, model, observations, whether the ledger changed and the turn's
 *   `apiKeySource` for `--json`.
 * @throws {UsageError} For a bad `--timeout`.
 * @throws {PreconditionError} For an unknown account, a turn that answered on an
 *   API key, a timeout, or a turn that reported no usage (exit 5).
 * @throws {ConfigError} When the binary is not found or cannot start (exit 3).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const id = ctx.args.positionals[1];
  const modelFlag = ctx.args.flags.model;
  const model = typeof modelFlag === 'string' && modelFlag !== '' ? modelFlag : DEFAULT_PROBE_MODEL;
  const timeoutMs = readTimeoutMs(ctx);
  const dorkHome = resolveDorkHome(ctx.env, ctx.io.osHome);
  const account = loadIdentities(dorkHome).accounts.find(
    (candidate) => candidate.id === id && candidate.routable
  );
  if (account === undefined) {
    throw new PreconditionError(
      `no registered account "${id}" with a valid id; "flow fleet" lists the accounts`
    );
  }

  // The note comes first. Under --json stdout carries only the JSON, so it goes to stderr.
  const note = costNote(account, model);
  if (ctx.json) ctx.warn(note);
  if (ctx.args.flags.yes !== true) {
    return {
      json: { account: account.id, model, ran: false },
      text: `${note}\nRun again with --yes to go ahead.`,
    };
  }

  const claude = resolveClaude(ctx);
  const observations: UsageObservation[] = [];
  let apiKeySource: string | null = null;
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'flow-probe-'));
  let outcome;
  try {
    outcome = await ctx.io.spawnStream(claude, probeArgs(model), {
      cwd,
      env: probeEnv(ctx.env, account.path, ctx.io.osHome),
      timeoutMs,
      onLine(line) {
        if (line.trim() === '') return 'continue';
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          ctx.warn(`the probe printed a line that is not JSON; skipped it: ${line.slice(0, 80)}`);
          return 'continue';
        }
        if (typeof event !== 'object' || event === null) return 'continue';
        const record = event as Record<string, unknown>;
        if (record.type === 'system' && record.subtype === 'init') {
          if (typeof record.apiKeySource === 'string') apiKeySource = record.apiKeySource;
          if (apiKeySource !== null && apiKeySource !== 'none') return 'stop';
        } else if (record.type === 'rate_limit_event') {
          const observation = fromRateLimitEvent(record.rate_limit_info, ctx.now());
          if (observation !== null) observations.push(observation);
        }
        return 'continue';
      },
    });
  } catch (error) {
    throw new ConfigError(
      `could not start ${claude}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  if (apiKeySource !== null && apiKeySource !== 'none') {
    throw new PreconditionError(
      `this account answered with an API key (${apiKeySource}), not its subscription; nothing recorded`
    );
  }
  if (outcome.timedOut) {
    throw new PreconditionError(
      `the probe did not finish within ${timeoutMs / 1000} s and was stopped; nothing recorded`
    );
  }
  if (observations.length === 0) {
    throw new PreconditionError('the probe finished but reported no usage; nothing recorded');
  }

  const result = await recordUsage(dorkHome, account.id, observations, ctx.now());
  for (const warning of result.warnings) ctx.warn(warning.message);
  if (result.status === 'dropped') {
    throw new PreconditionError(
      'the probe read the usage but could not save it (the usage file stayed locked); try again'
    );
  }

  return {
    json: {
      account: account.id,
      model,
      observations,
      changed: result.status === 'written',
      apiKeySource,
    },
    text: [note, ...observations.map(renderObservation)].join('\n'),
  };
}
