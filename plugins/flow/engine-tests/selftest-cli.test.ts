/**
 * `scripts/selftest.ts` and the fast tier behind it (DOR-2390, spec
 * `specs/flow-self-improvement` §1).
 *
 * The run is driven in process through `main(argv, deps)` against a throwaway
 * git repo as the project, so nothing is written into this checkout. The pure
 * parts of the fast tier (the conformance verdict, the schema comparison, the
 * exit code) each get a planted break that must fail for the stated reason.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_CAP, SELFTEST_DIR, main, type SelftestDeps } from '../scripts/selftest.ts';
import {
  conformanceProblem,
  engineTests,
  fakeFixtureProblem,
  schemaMatches,
} from '../scripts/selftest/fast.ts';
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

/** The scenarios tier runs real git and the real verbs; 5 s is too tight on a cold, loaded run. */
const SCENARIOS_TIMEOUT = 30_000;

describe('flow selftest', () => {
  it(
    'runs fast then scenarios by default, and passes on the shipped plugin',
    { timeout: SCENARIOS_TIMEOUT },
    async () => {
      const { code, stdout } = await run(['--json']);
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({
        v: 1,
        ok: true,
        tiers: ['fast', 'scenarios'],
        flowVersion: expect.any(String),
      });
      expect(report.checks.filter((c: Check) => c.status === 'fail')).toEqual([]);
      const engine = report.checks.find((c: Check) => c.id === 'engine-tests');
      expect(engine).toMatchObject({ status: 'skip', detail: 'already inside a test run' });
      expect(report.checks.filter((c: Check) => c.tier === 'scenarios').length).toBeGreaterThan(0);
      expect(code).toBe(0);
    }
  );

  it('runs one tier when --tier names it', { timeout: SCENARIOS_TIMEOUT }, async () => {
    const fast = JSON.parse((await run(['--tier', 'fast', '--json', '--no-save'])).stdout);
    expect(fast.tiers).toEqual(['fast']);
    expect(fast.checks.every((c: Check) => c.tier === 'fast')).toBe(true);
    const scenarios = JSON.parse(
      (await run(['--tier', 'scenarios', '--json', '--no-save'])).stdout
    );
    expect(scenarios.tiers).toEqual(['scenarios']);
    expect(scenarios.checks.every((c: Check) => c.id.startsWith('scenarios/'))).toBe(true);
  });

  it('counts a skip as not passed: --strict fails the run on it', async () => {
    expect((await run(['--tier', 'fast', '--strict', '--no-save'])).code).toBe(1);
  });

  it('lists skips with their reason in the text report', async () => {
    const { stdout } = await run(['--tier', 'fast', '--no-save']);
    expect(stdout).toMatch(
      /Skipped \(not passed\):\n {2}SKIP {2}engine-tests: already inside a test run/
    );
  });

  it('refuses the live tier (not built yet), unknown tiers and unknown flags, with exit 2', async () => {
    for (const tier of ['live', 'all']) {
      const refused = await run(['--tier', tier, '--json']);
      expect(refused.code).toBe(2);
      expect(JSON.parse(refused.stdout)).toMatchObject({ v: 1, ok: false, error: { code: 2 } });
      expect(refused.stderr).toMatch(/the live tier is not built yet/);
    }
    expect((await run(['--tier', 'slow'])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
  });

  it('saves latest.json and one history line, and keeps .dork/flow/ out of git', async () => {
    await run(['--tier', 'fast', '--no-save']);
    expect(existsSync(path.join(project, SELFTEST_DIR))).toBe(false);

    await run(['--tier', 'fast']);
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
    await run(['--tier', 'fast']);
    const again = readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(again.split('\n').filter((l) => l === '.dork/flow/')).toHaveLength(1);
  });

  it(`caps history at ${HISTORY_CAP} runs, dropping the oldest`, async () => {
    const dir = path.join(project, SELFTEST_DIR);
    mkdirSync(dir, { recursive: true });
    const old = Array.from({ length: HISTORY_CAP + 50 }, (_, i) => JSON.stringify({ n: i }));
    writeFileSync(path.join(dir, 'history.jsonl'), `${old.join('\n')}\n`);
    await run(['--tier', 'fast']);
    const lines = readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(HISTORY_CAP);
    expect(JSON.parse(lines[0])).toEqual({ n: 51 });
    expect(JSON.parse(lines.at(-1) ?? '{}').startedAt).toBe('2026-09-26T12:00:00.000Z');
  });
});

/** The project's journal lines. */
function journalLines(): Record<string, unknown>[] {
  const file = path.join(project, '.dork', 'flow', 'journal.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('the selftest journal line', () => {
  it('is written on every run, --no-save included, stamped with the runtime that ran it', async () => {
    // Purpose: the retro reads self-test history from the journal, per
    // runtime; --no-save is about the report files, not that history.
    await run(['--tier', 'fast', '--no-save'], { VITEST: 'true', CODEX_THREAD_ID: 'thread-1' });
    await run(['--tier', 'fast', '--no-save'], { VITEST: 'true', CLAUDECODE: '1' });
    expect(journalLines()).toEqual([
      expect.objectContaining({ kind: 'selftest', tiers: ['fast'], runtime: 'codex', fail: 0 }),
      expect.objectContaining({ kind: 'selftest', runtime: 'claude-code', harness: 'claude-code' }),
    ]);
  });

  it('is not written when the journal is off', async () => {
    mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
    writeFileSync(
      path.join(project, '.agents', 'flow', 'config.json'),
      JSON.stringify({ selfImprovement: { journal: { enabled: false } } })
    );
    await run(['--tier', 'fast', '--no-save']);
    expect(journalLines()).toEqual([]);
  });
});

describe('the flow entry point, as a process', { timeout: SCENARIOS_TIMEOUT }, () => {
  // Purpose: /flow:self-test runs `flow.ts selftest` as a script. The scenarios
  // import flow.ts, and a top-level await of main() there deadlocks that import
  // (Node exits 13 with no output), which no in-process test can see.
  it('runs `flow selftest --tier scenarios` to a parseable report and exit 0', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        path.join(FLOW_ROOT, 'scripts', 'flow.ts'),
        'selftest',
        '--tier',
        'scenarios',
        '--no-save',
        '--json',
      ],
      { cwd: project, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 }
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ v: 1, ok: true, tiers: ['scenarios'] });
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

  it("adapter conformance: the fake tracker's fixture must conform too", () => {
    expect(fakeFixtureProblem(good)).toBeNull();
    expect(fakeFixtureProblem(bad)).toMatch(/fake tracker's fixture fails INV-3/);
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

describe('the engine-test recursion guard', () => {
  // The engine check spawns Vitest, and the suite runs the fast tier. Without a
  // guard that no injected env can switch off, each run starts another (about
  // 1,100 processes in seconds, measured). This drives the real spawn path with a
  // fake vitest.mjs, from a child process that is NOT inside Vitest.
  it('passes FLOW_SELFTEST_ENGINE to the suite, and a run inside it skips', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'flow-fake-root-'));
    try {
      const fast = path.join(FLOW_ROOT, 'scripts', 'selftest', 'fast.ts');
      const record = path.join(root, 'record.json');
      const nested = path.join(root, 'nested.ts');
      const started = path.join(root, 'started');
      // A run of the engine check with an EMPTY injected env: only the marker the
      // parent put in this process's own environment can stop it.
      writeFileSync(
        nested,
        `import { engineTests } from ${JSON.stringify(fast)};\n` +
          `const c = engineTests({ flowRoot: ${JSON.stringify(root)}, projectDir: ${JSON.stringify(root)}, env: {} });\n` +
          `process.stdout.write(JSON.stringify(c));\n`
      );
      mkdirSync(path.join(root, 'node_modules', 'vitest'), { recursive: true });
      writeFileSync(
        path.join(root, 'node_modules', 'vitest', 'vitest.mjs'),
        `import { spawnSync } from 'node:child_process';\n` +
          `import { existsSync, writeFileSync } from 'node:fs';\n` +
          // A second start means the guard failed: stop here rather than recurse.
          `if (existsSync(${JSON.stringify(started)})) process.exit(0);\n` +
          `writeFileSync(${JSON.stringify(started)}, '');\n` +
          `const inner = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', ${JSON.stringify(nested)}], { encoding: 'utf8' });\n` +
          `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ marker: process.env.FLOW_SELFTEST_ENGINE ?? null, nested: JSON.parse(inner.stdout) }));\n`
      );
      const outer = execFileSync(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', nested],
        { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } }
      );
      expect(JSON.parse(outer)).toMatchObject({ id: 'engine-tests', status: 'pass' });
      const seen = JSON.parse(readFileSync(record, 'utf8'));
      expect(seen.marker).toBe('1');
      expect(seen.nested).toMatchObject({ status: 'skip', detail: 'already inside a test run' });
    } finally {
      rmSync(root, { recursive: true, force: true });
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
