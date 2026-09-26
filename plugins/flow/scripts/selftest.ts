/**
 * `selftest` — flow checks itself (spec `specs/flow-self-improvement`, DOR-2390).
 *
 * Runs the `fast` tier today: free, offline checks of this flow install and its
 * prose (see `selftest/fast.ts`). The `scenarios` and `live` tiers arrive with the
 * `flow` CLI (DOR-2367), which will run this module as its `selftest` verb; the
 * flags and exit codes already follow that CLI's conventions.
 *
 *   node --experimental-strip-types <flow-root>/scripts/selftest.ts [flags]
 *
 * Flags: `--tier fast` (the default and, for now, the only tier), `--json`,
 * `--strict` (a skip fails the run), `--no-save`, `--project <dir>`,
 * `--rebaseline` (lower the word budgets to today's counts), `--help`.
 *
 * Exit codes: 0 no failures · 1 a check failed (or, with `--strict`, was skipped)
 * · 2 usage error.
 *
 * Every run (unless `--no-save`) writes `.dork/flow/selftest/latest.json` and adds
 * one line to `history.jsonl` (the last 200 runs) in the project's main checkout,
 * so every worktree shares one history.
 *
 * @module @dorkos/flow/selftest
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { flowVersion, invokedDirectly } from './_shared.ts';
import { findConfigRoots } from './config-files.ts';
import { ensureIgnored } from './git-exclude.ts';
import {
  LINT_CONFIG_DIR,
  WORD_BUDGETS_FILE,
  loadCorpus,
  loadLintConfig,
  rebaseline,
} from './selftest/doc-lint.ts';
import { runFast } from './selftest/fast.ts';
import {
  buildReport,
  exitCode,
  renderText,
  type SelftestReport,
  type Tier,
} from './selftest/report.ts';

/** The flow plugin root: the folder above `scripts/`. */
export const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where a project keeps self-test results, relative to its main checkout. */
export const SELFTEST_DIR = path.join('.dork', 'flow', 'selftest');

/** How many runs `history.jsonl` keeps. */
export const HISTORY_CAP = 200;

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
}

const HELP = `flow selftest: check this flow install and its prose.

  --tier fast        the free, offline checks (the default; the only tier for now)
  --json             print the report as one JSON object
  --strict           a skipped check fails the run
  --no-save          do not write .dork/flow/selftest/
  --project <dir>    the checkout whose config to check (default: the current folder)
  --rebaseline       lower selftest/word-budgets.json to today's counts, then exit
  --help, -h         this text

Exit codes: 0 no failures, 1 a check failed, 2 usage error.
`;

/** Parsed flags. */
interface Flags {
  help: boolean;
  json: boolean;
  strict: boolean;
  save: boolean;
  rebaseline: boolean;
  project?: string;
  tier: string;
}

/** Parse argv, or return a usage error message. */
function parseFlags(argv: readonly string[]): Flags | string {
  const flags: Flags = {
    help: false,
    json: false,
    strict: false,
    save: true,
    rebaseline: false,
    tier: 'fast',
  };
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
    else if (arg === '--rebaseline') flags.rebaseline = true;
    else if (arg === '--project') {
      const v = value();
      if (v === undefined) return '--project needs a folder';
      flags.project = v;
    } else if (arg === '--tier') {
      const v = value();
      if (v === undefined) return '--tier needs a value';
      flags.tier = v;
    } else return `unknown flag ${arg}`;
  }
  if (flags.tier !== 'fast') {
    return flags.tier === 'scenarios' || flags.tier === 'live' || flags.tier === 'all'
      ? `the ${flags.tier} tier arrives with the flow CLI (DOR-2367); run --tier fast`
      : `unknown tier ${flags.tier} (use fast)`;
  }
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

/**
 * Run the self-test.
 *
 * @param argv - Arguments after the script path.
 * @param deps - The environment, clock and output streams.
 * @returns The exit code.
 */
export async function main(argv: readonly string[], deps: SelftestDeps): Promise<number> {
  const flowRoot = deps.flowRoot ?? FLOW_ROOT;
  const flags = parseFlags(argv);
  if (typeof flags === 'string') {
    if (argv.includes('--json')) {
      deps.stdout(`${JSON.stringify({ v: 1, ok: false, error: { code: 2, message: flags } })}\n`);
    }
    deps.stderr(`flow selftest: ${flags}\n`);
    return 2;
  }
  if (flags.help) {
    deps.stdout(HELP);
    return 0;
  }
  if (flags.rebaseline) {
    const files = loadCorpus(flowRoot);
    const next = rebaseline(files, loadLintConfig(flowRoot).budgets);
    const file = path.join(flowRoot, LINT_CONFIG_DIR, WORD_BUDGETS_FILE);
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    deps.stdout(`Wrote ${file} (${Object.keys(next).length} files)\n`);
    return 0;
  }

  const projectDir = path.resolve(deps.cwd, flags.project ?? '.');
  const started = deps.now();
  const t0 = performance.now();
  const tiers: Tier[] = ['fast'];
  const checks = await runFast({ flowRoot, projectDir, env: deps.env });
  const report = buildReport(checks, {
    startedAt: started.toISOString(),
    flowVersion: flowVersion(flowRoot),
    tiers,
    ms: Math.round(performance.now() - t0),
  });

  if (flags.save) {
    try {
      const roots = findConfigRoots(projectDir, flowRoot);
      saveReport(report, roots.mainCheckout ?? roots.checkout);
    } catch (err) {
      deps.stderr(`flow selftest: could not save the report: ${(err as Error).message}\n`);
    }
  }

  deps.stdout(flags.json ? `${JSON.stringify(report)}\n` : renderText(report));
  return exitCode(report, { strict: flags.strict });
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
