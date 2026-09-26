/**
 * `scripts/selftest.ts` and the fast tier behind it (DOR-2390, spec
 * `specs/flow-self-improvement` §1).
 *
 * The run is driven in process through `main(argv, deps)` against a throwaway
 * git repo as the project, so nothing is written into this checkout. The pure
 * parts of the fast tier (the conformance verdict, the schema comparison, the
 * exit code) each get a planted break that must fail for the stated reason.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_CAP, SELFTEST_DIR, main, type SelftestDeps } from '../scripts/selftest.ts';
import { conformanceProblem, engineTests, schemaMatches } from '../scripts/selftest/fast.ts';
import { buildReport, exitCode, fingerprint, type Check } from '../scripts/selftest/report.ts';
import { FLOW_ROOT } from '../scripts/selftest.ts';

let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), 'flow-selftest-'));
  execFileSync('git', ['init', '-q'], { cwd: project });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

/** Run `main` against the temp project, capturing output. */
async function run(argv: string[], env: NodeJS.ProcessEnv = { VITEST: 'true' }) {
  let stdout = '';
  let stderr = '';
  const deps: SelftestDeps = {
    env,
    cwd: project,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr };
}

describe('flow selftest (fast tier)', () => {
  it('passes on the shipped plugin, with the engine tests skipped inside Vitest', async () => {
    const { code, stdout } = await run(['--json']);
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      v: 1,
      ok: true,
      tiers: ['fast'],
      flowVersion: expect.any(String),
    });
    expect(report.checks.filter((c: Check) => c.status === 'fail')).toEqual([]);
    const engine = report.checks.find((c: Check) => c.id === 'engine-tests');
    expect(engine).toMatchObject({ status: 'skip', detail: 'already inside Vitest' });
    expect(code).toBe(0);
  });

  it('counts a skip as not passed: --strict fails the run on it', async () => {
    expect((await run(['--strict', '--no-save'])).code).toBe(1);
  });

  it('lists skips with their reason in the text report', async () => {
    const { stdout } = await run(['--no-save']);
    expect(stdout).toMatch(
      /Skipped \(not passed\):\n {2}SKIP {2}engine-tests: already inside Vitest/
    );
  });

  it('refuses tiers that do not exist yet, and unknown flags, with exit 2', async () => {
    const scenarios = await run(['--tier', 'scenarios', '--json']);
    expect(scenarios.code).toBe(2);
    expect(JSON.parse(scenarios.stdout)).toMatchObject({ v: 1, ok: false, error: { code: 2 } });
    expect(scenarios.stderr).toMatch(/arrives with the flow CLI/);
    expect((await run(['--bogus'])).code).toBe(2);
  });

  it('saves latest.json and one history line, and keeps .dork/flow/ out of git', async () => {
    await run(['--no-save']);
    expect(existsSync(path.join(project, SELFTEST_DIR))).toBe(false);

    await run([]);
    const dir = path.join(project, SELFTEST_DIR);
    expect(JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8')).v).toBe(1);
    const history = readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n');
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0]).checks[0]).toEqual({
      id: 'engine-tests',
      status: 'skip',
      fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    const exclude = readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l === '.dork/flow/')).toHaveLength(1);
    await run([]);
    const again = readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(again.split('\n').filter((l) => l === '.dork/flow/')).toHaveLength(1);
  });

  it(`caps history at ${HISTORY_CAP} runs, dropping the oldest`, async () => {
    const dir = path.join(project, SELFTEST_DIR);
    mkdirSync(dir, { recursive: true });
    const old = Array.from({ length: HISTORY_CAP + 50 }, (_, i) => JSON.stringify({ n: i }));
    writeFileSync(path.join(dir, 'history.jsonl'), `${old.join('\n')}\n`);
    await run([]);
    const lines = readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(HISTORY_CAP);
    expect(JSON.parse(lines[0])).toEqual({ n: 51 });
    expect(JSON.parse(lines.at(-1) ?? '{}').startedAt).toBe('2026-09-26T12:00:00.000Z');
  });
});

describe('the fast tier checks', () => {
  const fixtures = path.join(FLOW_ROOT, 'adapters', 'reference', 'fixtures');
  const good = JSON.parse(readFileSync(path.join(fixtures, 'work-items.good.json'), 'utf8'));
  const bad = JSON.parse(readFileSync(path.join(fixtures, 'work-items.bad.json'), 'utf8'));

  it('adapter conformance: passes when the good fixture passes and the bad one fails INV-3', () => {
    expect(conformanceProblem(good, bad)).toBeNull();
  });

  it('adapter conformance: a harness that passes the bad fixture is reported broken', () => {
    expect(conformanceProblem(good, good)).toMatch(/bad fixture should fail INV-3 and failed \[\]/);
  });

  it('adapter conformance: a good fixture that fails is reported', () => {
    expect(conformanceProblem(bad, bad)).toMatch(/good fixture fails INV-3/);
  });

  it('schema freshness compares parsed JSON, so formatting never matters but content does', () => {
    const built = { type: 'object', properties: { a: { type: 'string' } } };
    expect(schemaMatches('{"type":"object","properties":{"a":{"type":"string"}}}', built)).toBe(
      true
    );
    expect(schemaMatches('{"type":"object","properties":{}}', built)).toBe(false);
  });

  it('engine tests skip without the toolchain', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'flow-root-'));
    try {
      const result = engineTests({ flowRoot: empty, projectDir: project, env: {} });
      expect(result).toMatchObject({ status: 'skip', detail: expect.stringMatching(/toolchain/) });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('the report', () => {
  const check = (status: Check['status']): Check => ({
    id: 'x',
    tier: 'fast',
    status,
    ms: 1,
    detail: '',
    fingerprint: fingerprint('x', 'k'),
  });
  const meta = {
    startedAt: '2026-09-26T00:00:00.000Z',
    flowVersion: '0',
    tiers: ['fast' as const],
    ms: 1,
  };

  it('exits 0 on passes, 1 on a failure, and 1 on a skip only when strict', () => {
    expect(exitCode(buildReport([check('pass')], meta), { strict: true })).toBe(0);
    expect(exitCode(buildReport([check('fail')], meta), { strict: false })).toBe(1);
    expect(exitCode(buildReport([check('skip')], meta), { strict: false })).toBe(0);
    expect(exitCode(buildReport([check('skip')], meta), { strict: true })).toBe(1);
  });

  it('fingerprints are stable 12-hex ids that change with the key', () => {
    expect(fingerprint('doc-lint/words', 'README.md')).toBe(
      fingerprint('doc-lint/words', 'README.md')
    );
    expect(fingerprint('doc-lint/words', 'README.md')).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint('doc-lint/words', 'a.md')).not.toBe(fingerprint('doc-lint/words', 'b.md'));
  });
});
