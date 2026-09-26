/**
 * The live tier's runner (spec `specs/flow-self-improvement` §1, tier `live`,
 * DOR-2390): each case runs a real `claude -p` session in its own sandbox,
 * then is scored on what happened, never on what the agent said.
 *
 * Opt-in and paid. {@link runLive} checks the gate again before it starts
 * anything (the self-test checks it first), resolves the credential, and then
 * for each case:
 *
 * 1. skips it when it cannot run today, or when the budget is spent;
 * 2. builds the sandbox and runs `claude -p <prompt>` in it with the fences:
 *    the flow root as its only plugin, no MCP servers (`--strict-mcp-config`
 *    with an empty config), `--permission-mode dontAsk` with a short
 *    allowlist, what is left of the budget as `--max-budget-usd`, and an
 *    environment stripped of every other credential and tracker token;
 * 3. reads the stream: the `result` event's cost and turns, and every
 *    `tool_use`, which the breach check scans;
 * 4. fails the case as a breach when a tool call left the fences, whatever
 *    the oracle says; otherwise asks the case's oracle.
 *
 * With no credential, every case that would run fails with "no credential".
 *
 * @module @dorkos/flow/selftest/live/run
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

import type { FakeBacklog } from '../../tracker/fake.ts';
import { fingerprint, type Check } from '../report.ts';
import { LIVE_CASES, type LiveCase, type RunnableCase } from './cases.ts';
import {
  NO_CREDENTIAL,
  liveRefusal,
  probeLocalLogin,
  resolveCredential,
  type CredentialSource,
  type LiveCredential,
} from './gate.ts';
import { findBreach, type ToolUse } from './breach.ts';
import { childEnv, makeSandbox } from './sandbox.ts';

/** The ceiling when neither `--max-usd` nor config says otherwise, in US dollars. */
export const DEFAULT_LIVE_BUDGET_USD = 1.0;

/** The tools a live child may use without asking; everything else is denied. */
export const ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash(node *)',
  'Bash(git *)',
];

/**
 * The settings the child loads: the sandbox's own only (it has none). The
 * person's user settings would bring their plugins, hooks, permission rules
 * and any `apiKeyHelper`, so the flow plugin comes from `--plugin-dir` alone.
 */
export const SETTING_SOURCES = 'project,local';

/**
 * What the init event's `apiKeySource` says for each credential. Claude Code
 * names the API key it read; a subscription sign-in or an OAuth token is not
 * an API key, and reads `none`.
 */
export const EXPECTED_API_KEY_SOURCE: Readonly<Record<CredentialSource, string>> = {
  'anthropic-api-key': 'ANTHROPIC_API_KEY',
  'claude-oauth-token': 'none',
  'local-claude-login': 'none',
};

/** How long one case may run before it is stopped. */
const CASE_TIMEOUT_MS = 15 * 60_000;

/** What the tier needs. */
export interface LiveTierOptions {
  /** The flow plugin root, handed to the child as `--plugin-dir`. */
  flowRoot: string;
  /** The runner's environment. */
  env: Readonly<Record<string, string | undefined>>;
  /** The most the whole tier may spend, in US dollars. */
  maxUsd: number;
  /** The cases (default {@link LIVE_CASES}). */
  cases?: readonly LiveCase[];
  /** Checks the local `claude` sign-in (a test seam). */
  probe?: (env: Readonly<Record<string, string | undefined>>) => boolean;
  /** How long one case may run, in milliseconds. */
  timeoutMs?: number;
}

/** What the tier produced. */
export interface LiveTierResult {
  /** One check per case, in order. */
  checks: Check[];
  /** Which credential paid, or `none`. */
  credentialSource: CredentialSource | 'none';
  /** What the cases reported spending, in US dollars. */
  spentUsd: number;
}

/** What one child run left in its stream. */
export interface StreamSummary {
  /** Every tool call, in order. */
  toolUses: ToolUse[];
  /** The init event's `apiKeySource`: which credential Claude Code says it is using. */
  apiKeySource?: string;
  /** The init event's `slash_commands`: what the session loaded. */
  slashCommands?: string[];
  /** The `result` event's `total_cost_usd`, when there was one. */
  costUsd?: number;
  /** The `result` event's `num_turns`. */
  turns?: number;
  /** The `result` event's `subtype` (`success`, `error_max_turns`, ...). */
  subtype?: string;
  /** Whether a `result` event arrived at all. */
  finished: boolean;
}

/**
 * Read a `--output-format stream-json` stream: one JSON event per line. Lines
 * that are not JSON are ignored; a stream with no `result` event did not finish.
 *
 * @param text - The child's stdout.
 * @returns The tool calls and the result.
 */
export function parseStream(text: string): StreamSummary {
  const summary: StreamSummary = { toolUses: [], finished: false };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.apiKeySource === 'string') summary.apiKeySource = event.apiKeySource;
      if (Array.isArray(event.slash_commands)) {
        summary.slashCommands = event.slash_commands.filter(
          (c): c is string => typeof c === 'string'
        );
      }
    } else if (event.type === 'assistant') {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Record<string, unknown>[]) {
        if (block?.type !== 'tool_use') continue;
        summary.toolUses.push({
          name: typeof block.name === 'string' ? block.name : '?',
          input:
            block.input !== null && typeof block.input === 'object'
              ? (block.input as Record<string, unknown>)
              : {},
        });
      }
    } else if (event.type === 'result') {
      summary.finished = true;
      if (typeof event.total_cost_usd === 'number') summary.costUsd = event.total_cost_usd;
      if (typeof event.num_turns === 'number') summary.turns = event.num_turns;
      if (typeof event.subtype === 'string') summary.subtype = event.subtype;
    }
  }
  return summary;
}

/** A dollar amount as the child's `--max-budget-usd` takes it (4 decimals, never negative). */
export function usd(amount: number): string {
  return String(Math.max(0, Math.round(amount * 10_000) / 10_000));
}

/**
 * The child's argv, after `claude`.
 *
 * @param runCase - The case.
 * @param options - The flow root, the empty MCP config and the budget left.
 * @returns The arguments.
 */
export function childArgs(
  runCase: RunnableCase,
  options: { flowRoot: string; mcpConfig: string; remainingUsd: number }
): string[] {
  return [
    '-p',
    runCase.prompt,
    '--plugin-dir',
    options.flowRoot,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(runCase.maxTurns),
    '--max-budget-usd',
    usd(options.remainingUsd),
    '--setting-sources',
    SETTING_SOURCES,
    '--strict-mcp-config',
    '--mcp-config',
    options.mcpConfig,
    '--permission-mode',
    'dontAsk',
    '--allowed-tools',
    ...ALLOWED_TOOLS,
  ];
}

/** Run the child and collect its output. Stops it (by the pid it holds) at the timeout. */
function runChild(
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number }
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn('claude', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        ...(timedOut ? { error: `stopped after ${options.timeoutMs / 1000}s` } : {}),
      });
    });
  });
}

/** A check record for one case. */
function record(
  id: string,
  status: Check['status'],
  ms: number,
  detail: string,
  spend: { costUsd?: number; turns?: number } = {}
): Check {
  const checkId = `live/${id}`;
  return {
    id: checkId,
    tier: 'live',
    status,
    ms,
    detail,
    fingerprint: fingerprint(checkId, id),
    ...(spend.costUsd !== undefined ? { costUsd: spend.costUsd } : {}),
    ...(spend.turns !== undefined ? { turns: spend.turns } : {}),
  };
}

/** Run one case in its sandbox and score it. */
async function runOne(
  liveCase: RunnableCase,
  context: {
    flowRoot: string;
    env: Readonly<Record<string, string | undefined>>;
    credential: LiveCredential;
    remainingUsd: number;
    timeoutMs: number;
  }
): Promise<Check> {
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const sandbox = makeSandbox({
    flowRoot: context.flowRoot,
    files: liveCase.files,
    backlog: liveCase.backlog,
  });
  try {
    const args = childArgs(liveCase, {
      flowRoot: context.flowRoot,
      mcpConfig: sandbox.mcpConfig,
      remainingUsd: context.remainingUsd,
    });
    const env = childEnv(context.env, context.credential, sandbox.backlogFile);
    const child = await runChild(args, { cwd: sandbox.dir, env, timeoutMs: context.timeoutMs });
    const stream = parseStream(child.stdout);
    // A run that reported no cost (a timeout, a crash, no result event) is
    // charged everything it was allowed, so the ceiling holds.
    const allowed = Number(usd(context.remainingUsd));
    const charged = stream.costUsd === undefined;
    const spend = { costUsd: stream.costUsd ?? allowed, turns: stream.turns ?? 0 };
    const cost = `$${spend.costUsd.toFixed(4)}${charged ? ' charged, none reported' : ''}, ${spend.turns} turns`;

    const breach = findBreach(stream.toolUses, {
      sandbox: sandbox.dir,
      flowRoot: context.flowRoot,
      home: context.env.HOME ?? os.homedir(),
    });
    if (breach !== undefined) {
      return record(liveCase.id, 'fail', elapsed(), `breach: ${breach} (${cost})`, spend);
    }
    const expected = EXPECTED_API_KEY_SOURCE[context.credential.source];
    if (stream.apiKeySource !== expected) {
      return record(
        liveCase.id,
        'fail',
        elapsed(),
        `the session did not pay with ${context.credential.source}: its apiKeySource is ${stream.apiKeySource ?? 'missing'}, expected ${expected} (${cost})`,
        spend
      );
    }
    if (!stream.finished) {
      const why = child.error ?? `exit ${child.code}`;
      const said = child.stderr.trim().split('\n')[0] ?? '';
      return record(
        liveCase.id,
        'fail',
        elapsed(),
        `the run ended without a result (${why}; ${cost})${said === '' ? '' : `: ${said}`}`,
        spend
      );
    }
    let after: FakeBacklog;
    try {
      after = JSON.parse(readFileSync(sandbox.backlogFile, 'utf8')) as FakeBacklog;
    } catch (error) {
      return record(
        liveCase.id,
        'fail',
        elapsed(),
        `the fake's store is unreadable after the run: ${(error as Error).message} (${cost})`,
        spend
      );
    }
    const problem = await liveCase.oracle({
      sandbox: sandbox.dir,
      before: liveCase.backlog,
      after,
      stream,
    });
    const ended =
      stream.subtype === undefined || stream.subtype === 'success' ? '' : `, ${stream.subtype}`;
    return problem === undefined
      ? record(liveCase.id, 'pass', elapsed(), `${cost}${ended}`, spend)
      : record(liveCase.id, 'fail', elapsed(), `${problem} (${cost}${ended})`, spend);
  } finally {
    sandbox.cleanup();
  }
}

/**
 * Run the live tier.
 *
 * @param options - The flow root, the environment, the ceiling, and test seams.
 * @returns One check per case, the credential that paid, and what was spent.
 * @throws {Error} When the gate refuses: the caller must have checked it first.
 */
export async function runLive(options: LiveTierOptions): Promise<LiveTierResult> {
  const refusal = liveRefusal(options.env);
  if (refusal !== undefined) throw new Error(refusal);
  const cases = options.cases ?? LIVE_CASES;
  const credential = resolveCredential(options.env, options.probe ?? probeLocalLogin);
  const checks: Check[] = [];
  let spent = 0;
  for (const liveCase of cases) {
    if (liveCase.skip !== undefined) {
      checks.push(record(liveCase.id, 'skip', 0, liveCase.skip));
      continue;
    }
    if (credential === undefined) {
      checks.push(record(liveCase.id, 'fail', 0, NO_CREDENTIAL));
      continue;
    }
    if (spent >= options.maxUsd) {
      checks.push(
        record(
          liveCase.id,
          'skip',
          0,
          `budget reached: $${spent.toFixed(4)} of $${options.maxUsd.toFixed(2)} spent`
        )
      );
      continue;
    }
    const check = await runOne(liveCase, {
      flowRoot: options.flowRoot,
      env: options.env,
      credential,
      remainingUsd: options.maxUsd - spent,
      timeoutMs: options.timeoutMs ?? CASE_TIMEOUT_MS,
    });
    spent += check.costUsd ?? 0;
    checks.push(check);
  }
  return { checks, credentialSource: credential?.source ?? 'none', spentUsd: spent };
}

/**
 * The live tier's ceiling for a project: `selfImprovement.selftest.liveBudgetUsd`
 * from its config, or {@link DEFAULT_LIVE_BUDGET_USD} when the project has no
 * readable config.
 *
 * @param projectDir - The project checkout.
 * @param flowRoot - The flow root.
 * @param env - The environment config loading reads.
 * @returns The ceiling in US dollars.
 */
export async function liveBudget(
  projectDir: string,
  flowRoot: string,
  env: Readonly<Record<string, string | undefined>>
): Promise<number> {
  try {
    const { findConfigRoots } = await import('../../config-files.ts');
    const { loadConfig } = await import('../../config-load.ts');
    const { config } = loadConfig(findConfigRoots(projectDir, flowRoot), env as NodeJS.ProcessEnv);
    return config.selfImprovement.selftest.liveBudgetUsd;
  } catch {
    return DEFAULT_LIVE_BUDGET_USD;
  }
}
