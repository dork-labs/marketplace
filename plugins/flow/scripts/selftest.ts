/**
 * `selftest`: flow checks itself (spec `specs/flow-self-improvement`, DOR-2390).
 *
 * Runs the `fast` tier (free, offline checks of this install and its prose,
 * `selftest/fast.ts`) and then the `scenarios` tier (the real `flow` verbs
 * against the fake tracker, `selftest/scenarios.ts`). The `live` tier (a real
 * model against the fake tracker, `selftest/live/`) runs only when asked for,
 * with `FLOW_SELFTEST_LIVE=1`, and never in CI: it spends money. The same module backs
 * the `flow selftest` verb (`scripts/cli/selftest.ts`) and this script:
 *
 *   node --experimental-strip-types <flow-root>/scripts/selftest.ts [flags]
 *
 * Flags: `--tier fast|scenarios|live|all` (default: fast and scenarios; `all`
 * adds live), `--max-usd <n>` (the live tier's ceiling), `--json`, `--strict`
 * (a skip fails the run), `--file` (turn failures into tracker work,
 * `selftest/file.ts`), `--no-save`, `--project <dir>`, `--rebaseline` (lower
 * the word budgets to today's counts), `--help`.
 *
 * Exit codes: 0 no failures · 1 a check failed (or, with `--strict`, was skipped)
 * · 2 usage error, or the live tier's gate refused.
 *
 * Every run (unless `--no-save`) writes `.dork/flow/selftest/latest.json` and adds
 * one line to `history.jsonl` (the last 200 runs) in the project's main checkout,
 * so every worktree shares one history. Every run, `--no-save` included, adds one
 * `selftest` line to the project's journal unless the journal is off.
 *
 * @module @dorkos/flow/selftest
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { flowVersion, invokedDirectly } from './_shared.ts';
import { realProcessRunner } from './cli/context.ts';
import { buildProvenance, signBody, unsignedBody } from './cli/provenance.ts';
import { findConfigRoots } from './config-files.ts';
import { UsageError } from './errors.ts';
import { ensureIgnored } from './git-exclude.ts';
import { append, journalFor, runtimeOf } from './journal.ts';
import {
  LINT_CONFIG_DIR,
  WORD_BUDGETS_FILE,
  loadCorpus,
  loadLintConfig,
  rebaseline,
} from './selftest/doc-lint.ts';
import { runFast } from './selftest/fast.ts';
import { emptyFiling, fileFailures, filingSetup, type FilingResult } from './selftest/file.ts';
import { liveRefusal } from './selftest/live/gate.ts';
import {
  buildReport,
  exitCode,
  renderText,
  type Check,
  type SelftestReport,
  type Tier,
} from './selftest/report.ts';
import { runScenarios } from './selftest/scenarios.ts';
import type { TrackerFactory } from './selftest/scenarios/index.ts';
import type { CodeAdapter } from './tracker/types.ts';

/** The flow plugin root: the folder above `scripts/`. */
export const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where a project keeps self-test results, relative to its main checkout. */
export const SELFTEST_DIR = path.join('.dork', 'flow', 'selftest');

/** How many runs `history.jsonl` keeps. */
export const HISTORY_CAP = 200;

/** The tiers a run without `--tier` runs. */
export const DEFAULT_TIERS: readonly Tier[] = ['fast', 'scenarios'];

/** What `main` reads from and writes to, injected so tests need no real process. */
export interface SelftestDeps {
  /** The environment. */
  env: NodeJS.ProcessEnv;
  /** The working directory (the project, unless `--project` says otherwise). */
  cwd: string;
  /** The clock. */
  now: () => Date;
  /** Standard output. */
  stdout: (text: string) => void;
  /** Standard error. */
  stderr: (text: string) => void;
  /** The flow root to check (defaults to this install). */
  flowRoot?: string;
  /** Builds the project's tracker adapter for `--file`. Default: the project's configured adapter. */
  createAdapter?: (projectDir: string) => Promise<CodeAdapter>;
  /** Builds the scenarios' fake tracker (a test seam for planted breaks). */
  makeTracker?: TrackerFactory;
}

const HELP = `flow selftest: check this flow install, its prose, and how its commands behave.

  --tier <tier>      fast (free, offline checks), scenarios (the flow commands
                     against a fake tracker), live (a real model against the
                     fake tracker; costs money, needs FLOW_SELFTEST_LIVE=1,
                     never runs in CI) or all; default: fast and scenarios
  --max-usd <n>      the most the live tier may spend (default: the config's
                     selfImprovement.selftest.liveBudgetUsd, else 1.00)
  --json             print the report as one JSON object
  --strict           a skipped check fails the run
  --file             turn each failure into tracker work (see the report)
  --no-save          do not write .dork/flow/selftest/
  --project <dir>    the checkout whose config to check (default: the current folder)
  --rebaseline       lower selftest/word-budgets.json to today's counts, then exit
  --help, -h         this text

Exit codes: 0 no failures, 1 a check failed, 2 usage error or the live tier refused.
`;

/**
 * The tiers a `--tier` value names.
 *
 * @param value - The flag's value, or `undefined` when it was not given.
 * @returns The tiers, or a usage error message.
 */
export function tiersFor(value: string | undefined): Tier[] | string {
  if (value === undefined) return [...DEFAULT_TIERS];
  if (value === 'fast' || value === 'scenarios' || value === 'live') return [value];
  if (value === 'all') return ['fast', 'scenarios', 'live'];
  return `unknown tier ${value} (use fast, scenarios, live or all)`;
}

/**
 * The `--max-usd` value, parsed.
 *
 * @param value - The flag's value.
 * @returns The amount, or a usage error message.
 */
export function maxUsdFor(value: string): number | string {
  const amount = Number(value);
  if (value.trim() === '' || !Number.isFinite(amount) || amount < 0) {
    return `--max-usd needs an amount in US dollars, such as 0.50 (got ${value})`;
  }
  return amount;
}

/** Parsed flags. */
interface Flags {
  help: boolean;
  json: boolean;
  strict: boolean;
  save: boolean;
  file: boolean;
  rebaseline: boolean;
  project?: string;
  maxUsd?: number;
  tiers: Tier[];
}

/** Parse argv, or return a usage error message. */
function parseFlags(argv: readonly string[]): Flags | string {
  const flags: Flags = {
    help: false,
    json: false,
    strict: false,
    save: true,
    file: false,
    rebaseline: false,
    tiers: [],
  };
  let tier: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string | undefined => {
      i += 1;
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--strict') flags.strict = true;
    else if (arg === '--no-save') flags.save = false;
    else if (arg === '--file') flags.file = true;
    else if (arg === '--rebaseline') flags.rebaseline = true;
    else if (arg === '--project') {
      const v = value();
      if (v === undefined) return '--project needs a folder';
      flags.project = v;
    } else if (arg === '--max-usd') {
      const v = value();
      if (v === undefined) return '--max-usd needs an amount';
      const amount = maxUsdFor(v);
      if (typeof amount === 'string') return amount;
      flags.maxUsd = amount;
    } else if (arg === '--tier') {
      const v = value();
      if (v === undefined) return '--tier needs a value';
      tier = v;
    } else return `unknown flag ${arg}`;
  }
  const tiers = tiersFor(tier);
  if (typeof tiers === 'string') return tiers;
  flags.tiers = tiers;
  return flags;
}

/**
 * Write `latest.json` and add a line to `history.jsonl`, keeping the newest
 * {@link HISTORY_CAP} lines. A history line records the tiers and each check's id,
 * status and fingerprint, so a later run can tell "failed" from "did not run".
 *
 * @param report - The finished report.
 * @param checkout - The project's main checkout (or the checkout outside a worktree).
 * @returns The folder written.
 */
export function saveReport(report: SelftestReport, checkout: string): string {
  const dir = path.join(checkout, SELFTEST_DIR);
  mkdirSync(dir, { recursive: true });
  ensureIgnored(checkout, path.join(SELFTEST_DIR, 'latest.json'), '.dork/flow/');
  writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  const historyFile = path.join(dir, 'history.jsonl');
  const line = JSON.stringify({
    v: 1,
    startedAt: report.startedAt,
    flowVersion: report.flowVersion,
    tiers: report.tiers,
    checks: report.checks.map(({ id, status, fingerprint }) => ({ id, status, fingerprint })),
  });
  const previous = existsSync(historyFile)
    ? readFileSync(historyFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
    : [];
  writeFileSync(historyFile, `${[...previous, line].slice(-HISTORY_CAP).join('\n')}\n`);
  return dir;
}

/** One self-test run, as the script and the `flow selftest` verb both describe it. */
export interface SelftestRun {
  /** The flow root to check. */
  flowRoot: string;
  /** The project checkout (its config, its report folder, its tracker for `--file`). */
  projectDir: string;
  /** The environment. */
  env: NodeJS.ProcessEnv;
  /** The clock. */
  now: () => Date;
  /** The tiers to run, in order. */
  tiers: readonly Tier[];
  /** Whether a skip fails the run. */
  strict: boolean;
  /** Whether to write `latest.json` and `history.jsonl`. */
  save: boolean;
  /** Whether to turn failures into tracker work. */
  file: boolean;
  /** The project's tracker adapter, built only when `--file` has something to file. */
  adapter: () => Promise<CodeAdapter>;
  /** The session id to sign `--file` comments with, when known. */
  sessionId?: string;
  /** Print a warning. */
  warn: (message: string) => void;
  /** Builds the scenarios' fake tracker (a test seam). */
  makeTracker?: TrackerFactory;
  /** The live tier's ceiling (default: the project's config, else 1.00). */
  maxUsd?: number;
}

/**
 * Run the tiers, file failures when asked, save the report.
 *
 * The live tier's gate is checked before any tier starts.
 *
 * @param run - What to run and where.
 * @returns The report and the exit code (0 or 1).
 * @throws {UsageError} When the live tier is asked for and its gate refuses.
 */
export async function runSelftest(
  run: SelftestRun
): Promise<{ report: SelftestReport; code: 0 | 1 }> {
  if (run.tiers.includes('live')) {
    const refusal = liveRefusal(run.env);
    if (refusal !== undefined) throw new UsageError(refusal);
  }
  const started = run.now();
  const t0 = performance.now();
  const checks: Check[] = [];
  let credentialSource: string | undefined;
  for (const tier of run.tiers) {
    if (tier === 'fast') {
      checks.push(
        ...(await runFast({ flowRoot: run.flowRoot, projectDir: run.projectDir, env: run.env }))
      );
    } else if (tier === 'scenarios') {
      checks.push(
        ...(await runScenarios({ flowRoot: run.flowRoot, makeTracker: run.makeTracker }))
      );
    } else if (tier === 'live') {
      const live = await import('./selftest/live/run.ts');
      const result = await live.runLive({
        flowRoot: run.flowRoot,
        env: run.env,
        maxUsd: run.maxUsd ?? (await live.liveBudget(run.projectDir, run.flowRoot, run.env)),
      });
      checks.push(...result.checks);
      credentialSource = result.credentialSource;
    }
  }
  const version = flowVersion(run.flowRoot);
  const report = buildReport(checks, {
    startedAt: started.toISOString(),
    flowVersion: version,
    tiers: [...run.tiers],
    ms: Math.round(performance.now() - t0),
    credentialSource,
  });
  if (run.file) report.filing = await file(report, run);

  if (run.save) {
    try {
      const roots = findConfigRoots(run.projectDir, run.flowRoot);
      saveReport(report, roots.mainCheckout ?? roots.checkout);
    } catch (err) {
      run.warn(`could not save the report: ${(err as Error).message}`);
    }
  }
  // The journal line is the run's history for the retro, so --no-save (which
  // is about the report files) does not skip it; only a journal that is off does.
  journal(report, run);
  return { report, code: exitCode(report, { strict: run.strict }) };
}

/**
 * Add one `selftest` line to the project's journal, stamped with the runtime
 * that ran it. Never fails the run: a journal that is off, refused or
 * unwritable only warns (through `append`).
 */
function journal(report: SelftestReport, run: SelftestRun): void {
  const target = journalFor(run.projectDir, run.flowRoot);
  if ('refusal' in target) return;
  append(
    target.settings,
    {
      kind: 'selftest',
      tiers: [...report.tiers],
      pass: report.totals.pass,
      fail: report.totals.fail,
      skip: report.totals.skip,
      ms: report.totals.ms,
      failing: report.checks.filter((c) => c.status === 'fail').map((c) => c.id),
    },
    {
      now: run.now(),
      flowVersion: report.flowVersion,
      session: run.sessionId,
      ...runtimeOf(run.env),
      warn: run.warn,
    }
  );
}

/**
 * `--file`: sign with the project's identity marker and this session's
 * provenance, and match the failures against the project's tracker. A problem
 * reaching the tracker is reported in the result, never thrown: the checks
 * already ran, and the run already fails.
 */
async function file(report: SelftestReport, run: SelftestRun): Promise<FilingResult> {
  const failing = report.checks.filter((check) => check.status === 'fail');
  if (failing.length === 0) return emptyFiling();
  try {
    const { retro, deps } = await filingSetup(run);
    const { labels, project } = retro;
    return await fileFailures(
      failing,
      {
        evidenceAt: report.startedAt,
        now: run.now(),
        flowVersion: report.flowVersion,
        labels,
        project,
      },
      deps
    );
  } catch (err) {
    return emptyFiling((err as Error).message);
  }
}

/**
 * Lower the word budgets to today's counts (never raising one).
 *
 * @param flowRoot - The flow root.
 * @returns The file written and how many files it budgets.
 */
export function writeRebaseline(flowRoot: string): { file: string; count: number } {
  const files = loadCorpus(flowRoot);
  const next = rebaseline(files, loadLintConfig(flowRoot).budgets);
  const out = path.join(flowRoot, LINT_CONFIG_DIR, WORD_BUDGETS_FILE);
  writeFileSync(out, `${JSON.stringify(next, null, 2)}\n`);
  return { file: out, count: Object.keys(next).length };
}

/**
 * Run the self-test from argv (the script entry).
 *
 * @param argv - Arguments after the script path.
 * @param deps - The environment, clock and output streams.
 * @returns The exit code.
 */
export async function main(argv: readonly string[], deps: SelftestDeps): Promise<number> {
  const flowRoot = deps.flowRoot ?? FLOW_ROOT;
  const refuse = (message: string): number => {
    if (argv.includes('--json')) {
      deps.stdout(`${JSON.stringify({ v: 1, ok: false, error: { code: 2, message } })}\n`);
    }
    deps.stderr(`flow selftest: ${message}\n`);
    return 2;
  };
  const flags = parseFlags(argv);
  if (typeof flags === 'string') return refuse(flags);
  if (flags.help) {
    deps.stdout(HELP);
    return 0;
  }
  if (flags.rebaseline) {
    const { file: out, count } = writeRebaseline(flowRoot);
    deps.stdout(`Wrote ${out} (${count} files)\n`);
    return 0;
  }

  const projectDir = path.resolve(deps.cwd, flags.project ?? '.');
  const warn = (message: string) => deps.stderr(`flow selftest: ${message}\n`);
  let outcome: Awaited<ReturnType<typeof runSelftest>>;
  try {
    outcome = await runSelftest({
      flowRoot,
      projectDir,
      env: deps.env,
      now: deps.now,
      tiers: flags.tiers,
      strict: flags.strict,
      save: flags.save,
      file: flags.file,
      adapter: () =>
        deps.createAdapter !== undefined
          ? deps.createAdapter(projectDir)
          : import('./tracker/load.ts').then((load) =>
              load.createCodeAdapter({
                projectDir,
                flowRoot,
                env: deps.env,
                runProcess: realProcessRunner,
                warn,
              })
            ),
      sessionId: deps.env.FLOW_SESSION_ID || deps.env.CLAUDE_CODE_SESSION_ID || undefined,
      warn,
      makeTracker: deps.makeTracker,
      maxUsd: flags.maxUsd,
    });
  } catch (error) {
    if (error instanceof UsageError) return refuse(error.message);
    throw error;
  }
  const { report, code } = outcome;
  deps.stdout(flags.json ? `${JSON.stringify(report)}\n` : renderText(report));
  return code;
}

if (invokedDirectly(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
