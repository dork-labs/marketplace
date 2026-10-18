/**
 * The check before flow starts unattended sessions (DOR-3062): `config.json`
 * and a project's own tracker adapter must be committed and unchanged, and an
 * adapter counts as flow's own only by real path.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PreconditionError } from '../scripts/errors.ts';
import { assertLaunchable } from '../scripts/launch-guard.ts';

let base: string;
let repo: string;
let plugin: string;
let config: string;
let adapterDir: string;
let adapter: string;

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo });
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function check(over: Partial<Parameters<typeof assertLaunchable>[0]> = {}): void {
  assertLaunchable({ committedConfig: config, adapterPath: adapter, flowRoot: plugin, ...over });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'launch-guard-')));
  repo = path.join(base, 'repo');
  plugin = path.join(base, 'plugin');
  mkdirSync(repo);
  mkdirSync(plugin);
  git('init', '-q');
  config = path.join(repo, '.agents', 'flow', 'config.json');
  adapterDir = path.join(repo, '.agents', 'flow', 'adapters', 'acme');
  adapter = path.join(adapterDir, 'SKILL.md');
  write(config, '{}\n');
  write(adapter, '# acme\n');
  write(path.join(adapterDir, 'adapter.ts'), 'export const CONTRACT_VERSION = "2.2.0";\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'flow');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('assertLaunchable', () => {
  it('passes committed, unchanged settings and adapter', () => {
    expect(() => check()).not.toThrow();
  });

  it('refuses an untracked config.json', () => {
    git('rm', '-q', '--cached', config);
    expect(() => check()).toThrow(/config\.json\) at .* is not committed/);
  });

  it('refuses a config.json with uncommitted changes, staged or not', () => {
    write(config, '{"drain":{"permissionMode":"bypassPermissions"}}\n');
    expect(() => check()).toThrow(/changes that are not committed/);
    git('add', config);
    expect(() => check()).toThrow(PreconditionError);
  });

  it('refuses a changed adapter file', () => {
    write(path.join(adapterDir, 'adapter.ts'), 'import "child_process";\n');
    expect(() => check()).toThrow(/tracker adapter .* changes that are not committed/);
  });

  it('refuses a new file in the adapter folder, ignored or not', () => {
    write(path.join(adapterDir, 'helper.ts'), 'evil\n');
    expect(() => check()).toThrow(/files git does not track/);
    write(path.join(repo, '.gitignore'), 'helper.ts\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore');
    expect(() => check()).toThrow(/files git does not track/);
  });

  it('refuses an adapter folder that links out of the project, even committed', () => {
    const outside = path.join(base, 'outside.ts');
    write(outside, 'evil\n');
    symlinkSync(outside, path.join(adapterDir, 'lib.ts'));
    git('add', '-A');
    git('commit', '-q', '-m', 'link');
    expect(() => check()).toThrow(/link that leaves the project/);
  });

  it('refuses an adapter whose folder is a link out of the project', () => {
    const real = path.join(base, 'elsewhere', 'acme');
    write(path.join(real, 'SKILL.md'), '# acme\n');
    const linked = path.join(repo, '.agents', 'flow', 'adapters', 'linked');
    symlinkSync(real, linked);
    expect(() => check({ adapterPath: path.join(linked, 'SKILL.md') })).toThrow(
      /neither flow's own nor inside the project/
    );
  });

  it("takes an adapter as flow's own only by real path under the plugin", () => {
    const shipped = path.join(plugin, 'skills', 'linear-adapter');
    write(path.join(shipped, 'SKILL.md'), '# linear\n');
    expect(() => check({ adapterPath: path.join(shipped, 'SKILL.md') })).not.toThrow();
    // A project folder named like a shipped adapter is still the project's.
    const named = path.join(repo, '.agents', 'flow', 'adapters', 'linear-adapter');
    write(path.join(named, 'SKILL.md'), '# not shipped\n');
    expect(() => check({ adapterPath: path.join(named, 'SKILL.md') })).toThrow(
      /the tracker adapter at .* is not committed/
    );
  });

  it('refuses settings outside any git checkout', () => {
    const loose = path.join(base, 'loose', 'config.json');
    write(loose, '{}\n');
    expect(() => check({ committedConfig: loose })).toThrow(/not in a git checkout/);
  });

  it('ignores GIT_DIR from the caller', () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(base, 'nowhere');
    try {
      expect(() => check()).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});
