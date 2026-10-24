/**
 * The sandbox pieces Security asked for on #120 (range 2): scratch copies in a
 * private folder flow owns, and a `run:` timeout that stops the command's whole
 * process group.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcessRunner } from '../../scripts/cli/context.ts';
import {
  gitPath,
  isolatedGitEnv,
  privateTempDir,
  privateTempRoot,
} from '../../scripts/land/isolated-git.ts';

let tmp: string;
let saved: string | undefined;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-sandbox-')));
  saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
});

afterEach(() => {
  process.env.TMPDIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const rootName = () => `dorkos-flow-${process.getuid?.() ?? 'user'}`;

describe('privateTempRoot', () => {
  it('makes a folder only this user can use', () => {
    const root = privateTempRoot();
    expect(root).toBe(path.join(tmp, rootName()));
    expect(statSync(root as string).mode & 0o777).toBe(0o700);
    const dir = privateTempDir('scratch-');
    expect(typeof dir === 'string' && path.dirname(dir)).toBe(root);
  });

  it('tightens a looser mode on its own folder', () => {
    mkdirSync(path.join(tmp, rootName()), { mode: 0o777 });
    chmodSync(path.join(tmp, rootName()), 0o777);
    expect(typeof privateTempRoot()).toBe('string');
    expect(statSync(path.join(tmp, rootName())).mode & 0o777).toBe(0o700);
  });

  it('refuses a link planted where its folder goes', () => {
    const elsewhere = mkdtempSync(path.join(tmp, 'elsewhere-'));
    symlinkSync(elsewhere, path.join(tmp, rootName()));
    expect(privateTempRoot()).toMatchObject({
      error: expect.stringMatching(/not a folder flow made/),
    });
    expect(privateTempDir('scratch-')).toMatchObject({ error: expect.any(String) });
  });

  it('refuses a file planted where its folder goes', () => {
    execFileSync('touch', [path.join(tmp, rootName())]);
    expect(privateTempRoot()).toMatchObject({ error: expect.any(String) });
  });
});

describe('a process-group run', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('on a timeout, stops what the command started too', async () => {
    const pidFile = path.join(tmp, 'grandchild.pid');
    const started = realProcessRunner(
      '/bin/sh',
      ['-c', `sleep 30 & echo $! > ${pidFile}; sleep 30`],
      { timeoutMs: 1_500, processGroup: true }
    );
    await expect(started).rejects.toThrow(/timed out/);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });

  it('when the command exits, what it left running goes too', async () => {
    const pidFile = path.join(tmp, 'left.pid');
    const result = await realProcessRunner(
      '/bin/sh',
      ['-c', `sleep 30 & echo $! > ${pidFile}; exit 0`],
      { timeoutMs: 10_000, processGroup: true }
    );
    expect(result.code).toBe(0);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });

  it('a descendant that left the group and holds the pipes cannot turn a finished command into a timeout', async () => {
    const started = Date.now();
    const result = await realProcessRunner(
      '/bin/sh',
      ['-c', `perl -e 'use POSIX; POSIX::setsid(); sleep 6' & sleep 0.2; exit 0`],
      { timeoutMs: 4_000, processGroup: true }
    );
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_900);
  });

  it('returns the exit code and output like the plain runner', async () => {
    const result = await realProcessRunner('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3'], {
      processGroup: true,
    });
    expect(result).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' });
  });
});

describe("isolated git's PATH", () => {
  it("holds only system folders that only root can write to, never the agent's PATH", () => {
    const env = isolatedGitEnv({ PATH: '/tmp/evil-bin:/Users/someone/.nvm/bin', LANG: 'C' });
    expect(env.PATH).toBe(gitPath());
    for (const dir of env.PATH.split(path.delimiter)) {
      const info = statSync(dir);
      expect(info.uid, dir).toBe(0);
      expect(info.mode & 0o022, dir).toBe(0);
    }
    expect(env.PATH).not.toContain('/tmp/evil-bin');
    expect(env.PATH).not.toContain('.nvm');
  });
});
