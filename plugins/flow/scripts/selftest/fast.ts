/**
 * The self-test's `fast` tier: free, offline checks of a flow install and its
 * prose (spec `specs/flow-self-improvement/02-specification.md` §1, DOR-2390).
 *
 * | Check                 | What it asserts                                                         |
 * | --------------------- | ----------------------------------------------------------------------- |
 * | `engine-tests`        | The Vitest suite passes (contributor toolchain only; else a skip)       |
 * | `adapter-conformance` | The conformance harness passes the good fixture and catches the bad one  |
 * | `config`              | The shipped example config and the project's config are valid           |
 * | `schema-fresh`        | `config.schema.json` still matches the Zod source it is generated from   |
 * | `doc-lint/*`          | The five prose rules in `doc-lint.ts`                                   |
 *
 * Each check is a small function that returns a {@link Check}; the pure parts
 * (the conformance verdicts, the schema comparison) take their inputs so tests
 * can plant a break without touching the shipped files.
 *
 * @module @dorkos/flow/selftest/fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { findConfigRoots, resolveConfigFiles } from '../config-files.ts';
import { validate as validateAdapter } from '../validate-adapter.ts';
import { validateConfig } from '../validate-config.ts';
import {
  DOC_LINT_RULES,
  checkDuplicates,
  checkFrontmatter,
  checkLinks,
  checkWarStories,
  checkWords,
  fsReader,
  loadCorpus,
  loadLintConfig,
  wordSummary,
  type Finding,
} from './doc-lint.ts';
import { fingerprint, type Check, type CheckStatus } from './report.ts';

/** What the fast tier needs to know about where it runs. */
export interface FastOptions {
  /** The flow plugin's root directory. */
  flowRoot: string;
  /** The project checkout whose config to check. */
  projectDir: string;
  /** The environment (read for `VITEST`, passed to the engine-test run). */
  env: NodeJS.ProcessEnv;
}

/** Set on the engine-test child, so any self-test run inside it skips the engine tests. */
export const ENGINE_MARKER = 'FLOW_SELFTEST_ENGINE';

/** The fixture the conformance harness must reject, and the invariant it breaks. */
export const BAD_FIXTURE_INVARIANTS: readonly string[] = ['INV-3'];

/** Build a check record. */
function check(id: string, status: CheckStatus, ms: number, detail: string, key = id): Check {
  return { id, tier: 'fast', status, ms, detail, fingerprint: fingerprint(id, key) };
}

/** Time a function that yields a check's status and detail. */
function timed(id: string, run: () => { status: CheckStatus; detail: string }): Check {
  const start = performance.now();
  try {
    const { status, detail } = run();
    return check(id, status, Math.round(performance.now() - start), detail);
  } catch (err) {
    const message = (err as Error).message.split('\n')[0];
    return check(
      id,
      'fail',
      Math.round(performance.now() - start),
      `the check itself broke: ${message}`
    );
  }
}

/**
 * Run the engine's Vitest suite. Skipped when the contributor toolchain is not
 * installed, and always skipped when this process is already inside a test run:
 * `VITEST` in this process's environment or the injected one, or
 * {@link ENGINE_MARKER}, which the spawned suite always carries. A test that runs
 * the fast tier must never start the suite again: each run would start another
 * one until the machine runs out of processes (measured: about 1,100 in seconds).
 * Checking this process's own environment too means no injected `env` can
 * switch the guard off.
 *
 * @param options - Where flow lives and the environment.
 * @returns The check.
 */
export function engineTests(options: FastOptions): Check {
  const nested = [process.env, options.env].some(
    (env) => env.VITEST !== undefined || env[ENGINE_MARKER] !== undefined
  );
  const entry = path.join(options.flowRoot, 'node_modules', 'vitest', 'vitest.mjs');
  return timed('engine-tests', () => {
    if (!existsSync(entry)) {
      return {
        status: 'skip',
        detail: 'contributor toolchain not installed (npm install --include=dev in the flow root)',
      };
    }
    if (nested) {
      return { status: 'skip', detail: 'already inside a test run' };
    }
    const res = spawnSync(process.execPath, [entry, 'run'], {
      cwd: options.flowRoot,
      env: { ...options.env, [ENGINE_MARKER]: '1' },
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
    });
    if (res.status === 0) return { status: 'pass', detail: '' };
    const summary = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
      .split('\n')
      .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
      .filter((l) => /^(Test Files|Tests)\s/.test(l))
      .join('; ');
    return { status: 'fail', detail: summary === '' ? `vitest exited ${res.status}` : summary };
  });
}

/**
 * The conformance verdict over the two reference fixtures: the good one must
 * pass, and the bad one must fail with exactly the invariants it is built to
 * break. A harness that passes the bad fixture is broken.
 *
 * @param good - The good fixture's items.
 * @param bad - The bad fixture's items.
 * @returns `null` when both verdicts are right, else what is wrong.
 */
export function conformanceProblem(
  good: readonly unknown[],
  bad: readonly unknown[]
): string | null {
  const goodVerdict = validateAdapter(good);
  if (!goodVerdict.ok) {
    return `the good fixture fails ${goodVerdict.failures.map((f) => f.invariant).join(', ')}`;
  }
  const caught = validateAdapter(bad).failures.map((f) => f.invariant);
  if (!isDeepStrictEqual(caught, [...BAD_FIXTURE_INVARIANTS])) {
    return `the bad fixture should fail ${BAD_FIXTURE_INVARIANTS.join(', ')} and failed [${caught.join(', ')}]`;
  }
  return null;
}

/**
 * The conformance verdict over the fake tracker's fixture: the backlog the
 * self-test's scenarios run against must itself be a conforming one.
 *
 * @param items - The fixture's items.
 * @returns `null` when they pass, else which invariants they fail.
 */
export function fakeFixtureProblem(items: readonly unknown[]): string | null {
  const verdict = validateAdapter(items);
  return verdict.ok
    ? null
    : `the fake tracker's fixture fails ${verdict.failures.map((f) => f.invariant).join(', ')}`;
}

/**
 * Check the adapter conformance harness against the reference fixtures, and
 * the fake tracker's fixture against the invariants.
 *
 * @param options - Where flow lives.
 * @returns The check.
 */
export function adapterConformance(options: FastOptions): Check {
  return timed('adapter-conformance', () => {
    const dir = path.join(options.flowRoot, 'adapters', 'reference', 'fixtures');
    const read = (name: string): unknown[] =>
      JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as unknown[];
    const fake = JSON.parse(
      readFileSync(
        path.join(options.flowRoot, 'adapters', 'reference', 'fake', 'fixture.json'),
        'utf8'
      )
    ) as { items: unknown[] };
    const problem =
      conformanceProblem(read('work-items.good.json'), read('work-items.bad.json')) ??
      fakeFixtureProblem(fake.items);
    return problem === null ? { status: 'pass', detail: '' } : { status: 'fail', detail: problem };
  });
}

/**
 * Check the shipped example config, and the project's own `config.json` when
 * there is one, against the committed schema.
 *
 * @param options - Where flow and the project live.
 * @returns The check.
 */
export function configCheck(options: FastOptions): Check {
  return timed('config', () => {
    const problems: string[] = [];
    const checkFile = (label: string, file: string): void => {
      const report = validateConfig(JSON.parse(readFileSync(file, 'utf8')));
      for (const e of report.errors) problems.push(`${label}: ${e.path || '(root)'} ${e.message}`);
    };
    checkFile('config.example.json', path.join(options.flowRoot, 'config', 'config.example.json'));
    const files = resolveConfigFiles(findConfigRoots(options.projectDir, options.flowRoot));
    if (files.committed !== null) checkFile(files.committed, files.committed);
    if (problems.length > 0) return { status: 'fail', detail: problems.slice(0, 3).join('; ') };
    return {
      status: 'pass',
      detail:
        files.committed === null ? 'example config valid; this project has no config.json' : '',
    };
  });
}

/**
 * Whether the committed schema still matches the one the Zod source builds,
 * compared as parsed JSON so formatting never matters.
 *
 * @param committedText - The committed `config.schema.json` text.
 * @param built - The schema object built from the Zod source.
 * @returns `true` when they match.
 */
export function schemaMatches(committedText: string, built: Record<string, unknown>): boolean {
  return isDeepStrictEqual(JSON.parse(committedText), JSON.parse(JSON.stringify(built)));
}

/**
 * Check `config/config.schema.json` against the schema built from the Zod source
 * in memory. Needs `zod` (the one runtime dependency); skipped without it.
 *
 * @param options - Where flow lives.
 * @returns The check.
 */
export async function schemaFresh(options: FastOptions): Promise<Check> {
  const start = performance.now();
  let build: () => Record<string, unknown>;
  try {
    ({ buildConfigJsonSchema: build } = await import('../config-schema-builder.ts'));
  } catch {
    return check(
      'schema-fresh',
      'skip',
      Math.round(performance.now() - start),
      'zod is not installed (npm install --omit=dev in the flow root)'
    );
  }
  return timed('schema-fresh', () => {
    const committed = readFileSync(
      path.join(options.flowRoot, 'config', 'config.schema.json'),
      'utf8'
    );
    return schemaMatches(committed, build())
      ? { status: 'pass', detail: '' }
      : {
          status: 'fail',
          detail:
            'config.schema.json no longer matches config-schema.ts: run npm run generate:schema',
        };
  });
}

/**
 * Run the doc-lint rules as checks: one failing check per finding (so each has
 * its own fingerprint), or one passing check per clean rule.
 *
 * @param options - Where flow lives.
 * @returns The checks, in rule order.
 */
export function docLint(options: FastOptions): Check[] {
  const start = performance.now();
  const files = loadCorpus(options.flowRoot);
  const config = loadLintConfig(options.flowRoot);
  const byRule: Record<string, Finding[]> = {
    'doc-lint/words': checkWords(files, config.budgets),
    'doc-lint/duplicate-rule': checkDuplicates(files, config.duplicates),
    'doc-lint/links': checkLinks(files, fsReader(options.flowRoot)),
    'doc-lint/frontmatter': checkFrontmatter(files),
    'doc-lint/war-stories': checkWarStories(files, config.warStories),
  };
  const ms = Math.round(performance.now() - start);
  const words = wordSummary(files, config.budgets);
  const checks: Check[] = [];
  for (const rule of DOC_LINT_RULES) {
    const findings = byRule[rule];
    if (findings.length === 0) {
      const detail =
        rule === 'doc-lint/words'
          ? `${words.total} words in ${files.length} files; ${words.overTarget} above target`
          : '';
      checks.push(check(rule, 'pass', ms, detail));
    } else {
      for (const f of findings)
        checks.push(check(rule, 'fail', ms, `${f.path}: ${f.detail}`, f.key));
    }
  }
  return checks;
}

/**
 * Run the whole fast tier.
 *
 * @param options - Where flow and the project live, and the environment.
 * @returns Every check, in the order of the table above.
 */
export async function runFast(options: FastOptions): Promise<Check[]> {
  return [
    engineTests(options),
    adapterConformance(options),
    configCheck(options),
    await schemaFresh(options),
    ...docLint(options),
  ];
}
