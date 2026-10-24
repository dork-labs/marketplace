/**
 * The release freeze (DOR-3262): `flow freeze on|off` and the marker the arm
 * guard reads, shared by every worktree of a project and failing closed.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcessRunner } from '../../scripts/cli/context.ts';
import { main } from '../../scripts/flow.ts';
import { freezePath, readFreeze } from '../../scripts/land/freeze.ts';

let dir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'ignore' }
  );
}

async function flow(argv: string[], cwd = dir) {
  let out = '';
  const code = await main([...argv, '--json'], {
    env: {},
    cwd,
    now: () => new Date('2026-10-24T12:00:00.000Z'),
    stdout: { write: (c: string) => (out += c) },
    stderr: { write: () => undefined },
    createAdapter: async () => {
      throw new Error('no tracker here');
    },
    runProcess: realProcessRunner,
  });
  return { code, json: JSON.parse(out) as Record<string, unknown> };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-freeze-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}-wt`, { recursive: true, force: true });
});

describe('flow freeze', () => {
  it('is off until turned on, and on until turned off', async () => {
    expect((await flow(['freeze'])).json.frozen).toBe(false);
    const on = await flow(['freeze', 'on', '--reason', 'cutting 1.2']);
    expect(on.code).toBe(0);
    expect(on.json).toMatchObject({
      frozen: true,
      reason: 'cutting 1.2',
      since: '2026-10-24T12:00:00.000Z',
    });
    expect(readFreeze(dir)).toEqual({ since: '2026-10-24T12:00:00.000Z', reason: 'cutting 1.2' });
    expect((await flow(['freeze'])).json).toMatchObject({ frozen: true, reason: 'cutting 1.2' });
    const off = await flow(['freeze', 'off']);
    expect(off.json).toMatchObject({ frozen: false, wasFrozen: true });
    expect(readFreeze(dir)).toBeNull();
    expect((await flow(['freeze', 'off'])).json.wasFrozen).toBe(false);
  });

  it('needs a reason to turn on', async () => {
    expect((await flow(['freeze', 'on'])).code).toBe(2);
    expect(readFreeze(dir)).toBeNull();
  });

  it('refuses an action it does not know', async () => {
    expect((await flow(['freeze', 'maybe'])).code).toBe(2);
  });

  it('a dry run changes nothing', async () => {
    await flow(['freeze', 'on', '--reason', 'r', '--dry-run']);
    expect(readFreeze(dir)).toBeNull();
  });

  it('a freeze set in a linked worktree holds in the main checkout, and the other way round', async () => {
    git(dir, 'worktree', 'add', '-q', '-b', 'feature', `${dir}-wt`);
    await flow(['freeze', 'on', '--reason', 'release'], `${dir}-wt`);
    expect(readFreeze(dir)?.reason).toBe('release');
    expect(freezePath(dir)).toBe(path.join(dir, '.dork', 'flow', 'freeze.json'));
    await flow(['freeze', 'off'], dir);
    expect((await flow(['freeze'], `${dir}-wt`)).json.frozen).toBe(false);
  });

  it('a marker that cannot be read counts as on', () => {
    mkdirSync(path.dirname(freezePath(dir)), { recursive: true });
    writeFileSync(freezePath(dir), '{not json');
    expect(readFreeze(dir)?.reason).toMatch(/cannot be read/);
  });
});
