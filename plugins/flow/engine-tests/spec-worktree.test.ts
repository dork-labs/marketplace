/**
 * Contract suite for `scripts/spec-worktree.sh`, the only way /flow:execute may
 * create a worktree without asking. It replaced `Bash(git worktree add:*)`,
 * which could check a branch out into any folder (`~/.config/git` included), so
 * the cases that matter are the refusals: each one proves git never ran.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(FLOW_ROOT, 'scripts', 'spec-worktree.sh');

let base: string;
let repo: string;

const FLAGS =
  '-c core.fsmonitor=false -c log.showSignature=false -c gpg.program=false ' +
  '-c core.hooksPath=/dev/null ';

/** This process's environment minus GIT_*, so a hook running the suite cannot redirect it. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}

function git(...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
    { cwd: repo, encoding: 'utf8', env: cleanEnv() }
  );
}

function run(args: string[], env: Record<string, string> = {}, cwd = repo) {
  return spawnSync(SCRIPT, args, { cwd, encoding: 'utf8', env: { ...cleanEnv(), ...env } });
}

/** A stand-in git on PATH that logs each call's arguments, then runs the real one. */
function stubGit(): { env: Record<string, string>; log: string } {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'git-calls.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 }
  );
  return { env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, log };
}

function worktreeCount(): number {
  return git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'spec-worktree-')));
  repo = path.join(base, 'project');
  mkdirSync(repo);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'one');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('spec-worktree.sh', () => {
  it('creates ../spec-<slug> on branch spec-<slug> and prints its path', () => {
    const result = run(['flow-dashboard']);
    expect(result.status).toBe(0);
    const dest = path.join(base, 'spec-flow-dashboard');
    expect(result.stdout.trim()).toBe(dest);
    expect(existsSync(dest)).toBe(true);
    expect(git('-C', dest, 'branch', '--show-current').trim()).toBe('spec-flow-dashboard');
  });

  it('puts the worktree beside the checkout root even when run from a subfolder', () => {
    mkdirSync(path.join(repo, 'sub'));
    const result = run(['dor-2691'], {}, path.join(repo, 'sub'));
    expect(result.status).toBe(0);
    expect(existsSync(path.join(base, 'spec-dor-2691'))).toBe(true);
  });

  it('accepts dots inside a slug, as in sdk-upgrade-0.2.112', () => {
    const result = run(['sdk-upgrade-0.2.112']);
    expect(result.status).toBe(0);
    expect(existsSync(path.join(base, 'spec-sdk-upgrade-0.2.112'))).toBe(true);
  });

  it('resolves a symlinked parent to its real folder', () => {
    const real = path.join(base, 'real');
    mkdirSync(real);
    const moved = path.join(real, 'project');
    execFileSync('mv', [repo, moved]);
    symlinkSync(real, path.join(base, 'link'));
    repo = path.join(base, 'link', 'project');
    const result = run(['via-link']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(real, 'spec-via-link'));
  });

  it('never runs a hook, even one the project tracks', () => {
    const hooks = path.join(repo, 'hooks');
    const marker = path.join(base, 'hook-ran');
    mkdirSync(hooks);
    writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    writeFileSync(path.join(hooks, 'reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    git('add', 'hooks');
    git('commit', '-q', '-m', 'hooks');
    git('config', 'core.hooksPath', 'hooks');
    git('branch', 'probe'); // proves the hooks fire for plain git
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const result = run(['hooked']);
    expect(result.status).toBe(0);
    expect(existsSync(path.join(base, 'spec-hooked'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['no slug', []],
    ['two arguments', ['a', 'b']],
    ['an option', ['--detach']],
    ['a path', ['../../.config/git']],
    ['a slash', ['a/b']],
    ['uppercase', ['Flow']],
    ['a leading hyphen', ['-x']],
    ['a double hyphen', ['a--b']],
    ['a trailing hyphen', ['a-']],
    ['a double dot', ['a..b']],
    ['a trailing dot', ['a.']],
    ['two dots', ['..']],
    ['a leading dot', ['.x']],
    ['a trailing newline', ['a\n']],
    ['an @', ['@{-1}']],
    ['a newline', ['a\nb']],
    ['a space', ['a b']],
    ['an empty string', ['']],
    ['65 characters', ['a'.repeat(65)]],
  ])('refuses %s with exit 2, before git runs', (_name, args) => {
    const stub = stubGit();
    const result = run(args as string[], stub.env);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^spec-worktree: /);
    expect(existsSync(stub.log)).toBe(false);
    expect(worktreeCount()).toBe(1);
  });

  it('refuses a destination that already exists', () => {
    mkdirSync(path.join(base, 'spec-taken'));
    const result = run(['taken']);
    expect(result.status).toBe(2);
    expect(worktreeCount()).toBe(1);
  });

  it('refuses a dangling symlink at the destination, which git would follow', () => {
    const link = path.join(base, 'spec-dangling');
    symlinkSync(path.join(base, 'nowhere'), link);
    const result = run(['dangling']);
    expect(result.status).toBe(2);
    expect(existsSync(path.join(base, 'nowhere'))).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(worktreeCount()).toBe(1);
  });

  it('runs every git call with config that cannot name a program', () => {
    const stub = stubGit();
    const result = run(['flags'], stub.env);
    expect(result.status).toBe(0);
    const calls = readFileSync(stub.log, 'utf8').trim().split('\n');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call.startsWith(FLAGS)).toBe(true);
  });

  it('ignores GIT_* variables from the caller', () => {
    const elsewhere = path.join(base, 'elsewhere');
    const result = run(['env-check'], { GIT_DIR: elsewhere, GIT_WORK_TREE: elsewhere });
    expect(result.status).toBe(0);
    expect(existsSync(elsewhere)).toBe(false);
    expect(existsSync(path.join(base, 'spec-env-check'))).toBe(true);
  });

  it('is executable and allowed by exactly one rule in execute.md', () => {
    const execute = readFileSync(path.join(FLOW_ROOT, 'commands', 'execute.md'), 'utf8');
    const allowed = /^allowed-tools:(.*)$/m.exec(execute)?.[1] ?? '';
    expect(allowed).toContain('Bash(${CLAUDE_PLUGIN_ROOT}/scripts/spec-worktree.sh:*)');
    expect(allowed).not.toMatch(/Bash\(git [^)]*:\*\)|Bash\(git [^)]*\*\)/);
  });
});
