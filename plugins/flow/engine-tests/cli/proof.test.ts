/**
 * `flow proof` and the review gate in `flow stage` (DOR-3261): a bug fix ships a
 * class-level test that fails before the fix and passes after, and VERIFY
 * cannot hand a bug to review without one recorded at the branch head.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import { checkProof, proofPath, type ProofRecord } from '../../scripts/proof.ts';
import { item, makeProject, runFlow, type WriteProject } from './write-harness.ts';

let project: WriteProject;

/** Run git in the project. */
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: project.dir, encoding: 'utf8' }).trim();

/** Write a file in the project and commit it. */
function commit(file: string, text: string): string {
  const full = path.join(project.dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text);
  git('add', file);
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', file);
  return git('rev-parse', 'HEAD');
}

/** The red and green run output, written into the project. */
function writeRuns(red = 'FAIL every unicode path\n1 failed', green = 'PASS\n1 passed') {
  writeFileSync(path.join(project.dir, 'red.txt'), red);
  writeFileSync(path.join(project.dir, 'green.txt'), green);
}

/** `flow proof FAKE-1 …` with the usual flags, and any extra ones. */
function proofArgs(tests = 'tests/paths.test.ts', ...extra: string[]): string[] {
  return [
    'proof',
    'FAKE-1',
    '--tests',
    tests,
    '--class',
    'every path comparison ignores case and Unicode folding',
    '--command',
    'npm test -- tests/paths.test.ts',
    '--red-file',
    'red.txt',
    '--green-file',
    'green.txt',
    ...extra,
  ];
}

const bug = item('FAKE-1', { type: 'signal', stateCategory: 'started', labels: ['agent/claimed'] });

beforeEach(() => {
  project = makeProject();
  // origin/HEAD is where the branch left: everything after it is the fix.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  commit('src/paths.ts', 'export const fixed = true;\n');
  commit('tests/paths.test.ts', 'test("every folded form", () => {});\n');
  writeRuns();
});

afterEach(() => {
  project.cleanup();
});

describe('flow proof', () => {
  it('records the proof at HEAD with the merge base, and keeps it out of git', async () => {
    // Purpose: the record is what the review gate and the reviewer read.
    const result = await runFlow(project, { items: [bug] }, proofArgs());
    expect(result.code).toBe(EXIT.ok);
    const record = JSON.parse(
      readFileSync(proofPath(project.dir, 'FAKE-1'), 'utf8')
    ) as ProofRecord;
    expect(record).toMatchObject({
      identifier: 'FAKE-1',
      headSha: git('rev-parse', 'HEAD'),
      baseSha: git('rev-parse', 'origin/main'),
      tests: ['tests/paths.test.ts'],
      red: 'FAIL every unicode path\n1 failed',
      green: 'PASS\n1 passed',
    });
    expect(git('status', '--porcelain', '--', '.dork')).toBe('');
  });

  it('refuses a test the branch does not change (exit 5), writing nothing', async () => {
    // Purpose: a test that already passed before the fix proves nothing.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = await runFlow(project, { items: [bug] }, proofArgs());
    expect(result.code).toBe(EXIT.precondition);
    expect(JSON.stringify(result.json)).toContain('not changed on this branch');
    expect(existsSync(proofPath(project.dir, 'FAKE-1'))).toBe(false);
  });

  it('refuses a test that is only in the working tree, not committed', async () => {
    // Purpose: the proof is pinned to a commit; an uncommitted file is not in it.
    writeFileSync(path.join(project.dir, 'tests', 'other.test.ts'), 'x\n');
    const result = await runFlow(project, { items: [bug] }, proofArgs('tests/other.test.ts'));
    expect(result.code).toBe(EXIT.precondition);
  });

  it('refuses identical red and green output, and empty output', async () => {
    // Purpose: one run saved twice is not a before-and-after.
    writeRuns('PASS', 'PASS');
    expect((await runFlow(project, { items: [bug] }, proofArgs())).code).toBe(EXIT.precondition);
    writeRuns('  \n', 'PASS');
    expect((await runFlow(project, { items: [bug] }, proofArgs())).code).toBe(EXIT.precondition);
  });

  it('refuses a missing flag (exit 2) and an identifier that could leave the folder', async () => {
    // Purpose: the class sentence is the point of the proof; the identifier names a file.
    const noClass = proofArgs().filter(
      (_, i, all) => all[i] !== '--class' && all[i - 1] !== '--class'
    );
    expect((await runFlow(project, { items: [bug] }, noClass)).code).toBe(EXIT.usage);
    const escape = proofArgs();
    escape[1] = '../x';
    expect((await runFlow(project, { items: [bug] }, escape)).code).toBe(EXIT.usage);
  });
});

describe('flow stage <bug> review', () => {
  it('refuses a bug with no proof (exit 5), before any write, dry runs included', async () => {
    // Purpose: DOR-3261 — VERIFY refuses to hand off a bug fix without its proof test.
    for (const extra of [[], ['--dry-run']]) {
      const result = await runFlow(project, { items: [bug] }, [
        'stage',
        'FAKE-1',
        'review',
        ...extra,
      ]);
      expect(result.code).toBe(EXIT.precondition);
      expect(JSON.stringify(result.json)).toContain('is a bug fix with no proof test');
      expect(result.tracker.calls).toEqual([]);
    }
  });

  it('lets a bug with a proof at the head into review', async () => {
    expect((await runFlow(project, { items: [bug] }, proofArgs())).code).toBe(EXIT.ok);
    const result = await runFlow(project, { items: [bug] }, ['stage', 'FAKE-1', 'review']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.calls).toHaveLength(1);
  });

  it('refuses a proof recorded before the head moved', async () => {
    // Purpose: a review fix changes the code; the proof must be run again on it.
    expect((await runFlow(project, { items: [bug] }, proofArgs())).code).toBe(EXIT.ok);
    commit('src/paths.ts', 'export const fixed = 2;\n');
    const result = await runFlow(project, { items: [bug] }, ['stage', 'FAKE-1', 'review']);
    expect(result.code).toBe(EXIT.precondition);
    expect(JSON.stringify(result.json)).toContain(
      'run the proof test at the head and record it again'
    );
    expect(result.tracker.calls).toEqual([]);
  });

  it('refuses a hand-edited or broken record', async () => {
    // Purpose: the gate reads only a record flow would have written.
    expect((await runFlow(project, { items: [bug] }, proofArgs())).code).toBe(EXIT.ok);
    writeFileSync(proofPath(project.dir, 'FAKE-1'), '{"v":1}');
    const broken = await runFlow(project, { items: [bug] }, ['stage', 'FAKE-1', 'review']);
    expect(broken.code).toBe(EXIT.precondition);
    expect(JSON.stringify(broken.json)).toContain('is not valid');
  });

  it('needs no proof for a task, or for a bug moving to another stage', async () => {
    // Purpose: the gate is scoped to bugs entering review; nothing else changes.
    const task = item('FAKE-1', { stateCategory: 'started', labels: ['agent/claimed'] });
    expect((await runFlow(project, { items: [task] }, ['stage', 'FAKE-1', 'review'])).code).toBe(
      EXIT.ok
    );
    expect((await runFlow(project, { items: [bug] }, ['stage', 'FAKE-1', 'verify'])).code).toBe(
      EXIT.ok
    );
  });
});

describe('checkProof', () => {
  const head = 'a'.repeat(40);
  const record: ProofRecord = {
    v: 1,
    identifier: 'FAKE-1',
    headSha: head,
    baseSha: 'b'.repeat(40),
    tests: ['t.test.ts'],
    bugClass: 'c',
    command: 'npm test',
    red: 'FAIL',
    green: 'PASS',
    recordedAt: '2026-10-29T00:00:00.000Z',
  };
  const text = JSON.stringify(record);

  it('refuses a test the branch stopped changing, and a record for another item', () => {
    // Purpose: a later commit that reverts the test, or a copied record, must not pass.
    expect(checkProof('FAKE-1', text, { headSha: head, changed: new Set() }).ok).toBe(false);
    expect(checkProof('FAKE-2', text, { headSha: head, changed: new Set(['t.test.ts']) }).ok).toBe(
      false
    );
    expect(checkProof('FAKE-1', text, { headSha: head, changed: new Set(['t.test.ts']) }).ok).toBe(
      true
    );
  });
});
