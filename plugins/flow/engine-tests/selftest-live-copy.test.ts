/**
 * The live tier's copy of the plugin (`copyPlugin` in
 * `scripts/selftest/live/sandbox.ts`) against a checkout that changes while it
 * is being copied. A test run in the same checkout once wrote and deleted a
 * dotfile temp file in the plugin root, and the copy failed with ENOENT when
 * the file vanished between being listed and being copied.
 *
 * `node:fs` is wrapped so a file or folder can be deleted at the exact moment
 * the copy reaches it: the real call then meets a real ENOENT, which the copy
 * must skip. These pin the walker's behaviour; they do not replay the queue
 * run (the old `cpSync` copy never called the wrapped functions).
 */

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyPlugin } from '../scripts/selftest/live/sandbox.ts';

const race = vi.hoisted(() => ({
  /** Deleted just before the copy copies it. */
  file: null as string | null,
  /** Deleted just before the copy lists it. */
  dir: null as string | null,
  /** The destination folder of this file is deleted just before it is copied. */
  dropDestinationOf: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const copyFileSync: typeof real.copyFileSync = (from, to, mode) => {
    if (race.file !== null && String(from) === race.file) real.rmSync(race.file);
    if (race.dropDestinationOf !== null && String(from) === race.dropDestinationOf) {
      real.rmSync(path.dirname(String(to)), { recursive: true });
    }
    return real.copyFileSync(from, to, mode);
  };
  const readdirSync = ((dir: fs.PathLike, ...rest: unknown[]) => {
    if (race.dir !== null && String(dir) === race.dir) {
      real.rmSync(race.dir, { recursive: true });
    }
    return (real.readdirSync as (...args: unknown[]) => unknown)(dir, ...rest);
  }) as typeof real.readdirSync;
  const wrapped = { ...real, copyFileSync, readdirSync };
  return { ...wrapped, default: wrapped };
});

let root: string;
let source: string;
let into: string;

/** Write `content` at `rel` under the fake plugin root, creating folders. */
function put(rel: string, content = rel): void {
  const full = path.join(source, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-live-copy-')));
  source = path.join(root, 'flow');
  into = path.join(root, 'copy');
  put('package.json', JSON.stringify({ dependencies: { zod: '^3' } }));
  put('scripts/flow.ts');
  put('scripts/journal.ts');
  put('skills/x/SKILL.md');
  put('node_modules/zod/index.js');
  put('node_modules/vitest/index.js');
  race.file = null;
  race.dir = null;
  race.dropDestinationOf = null;
});

afterEach(() => {
  race.file = null;
  race.dir = null;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('copyPlugin', () => {
  it('copies the plugin and only the runtime dependencies', () => {
    copyPlugin(source, into);
    expect(fs.readFileSync(path.join(into, 'scripts/flow.ts'), 'utf8')).toBe('scripts/flow.ts');
    expect(fs.existsSync(path.join(into, 'skills/x/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(into, 'node_modules/zod/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(into, 'node_modules/vitest'))).toBe(false);
  });

  it('skips a file deleted after it was listed and before it was copied', () => {
    put('.dispatch-fixture.json');
    race.file = path.join(source, '.dispatch-fixture.json');
    expect(() => copyPlugin(source, into)).not.toThrow();
    expect(fs.existsSync(path.join(into, '.dispatch-fixture.json'))).toBe(false);
    expect(fs.existsSync(path.join(into, 'scripts/flow.ts'))).toBe(true);
  });

  it('skips a folder deleted after it was listed and before it was read', () => {
    put('scratch/a.txt');
    race.dir = path.join(source, 'scratch');
    expect(() => copyPlugin(source, into)).not.toThrow();
    expect(fs.existsSync(path.join(into, 'scratch/a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(into, 'scripts/journal.ts'))).toBe(true);
  });

  it('leaves dotfile scratch files out and keeps other dotfiles', () => {
    for (const name of ['.dispatch-fixture.tmp.json', '.x.tmp', '.tmp-123', 'scripts/.y.tmp.ts']) {
      put(name);
    }
    for (const name of ['.gitignore', '.claude-plugin/plugin.json', 'templates/a.tmpl', '.tmpl']) {
      put(name);
    }
    copyPlugin(source, into);
    for (const name of ['.dispatch-fixture.tmp.json', '.x.tmp', '.tmp-123', 'scripts/.y.tmp.ts']) {
      expect(fs.existsSync(path.join(into, name)), name).toBe(false);
    }
    for (const name of ['.gitignore', '.claude-plugin/plugin.json', 'templates/a.tmpl', '.tmpl']) {
      expect(fs.existsSync(path.join(into, name)), name).toBe(true);
    }
  });

  it('fails when the destination folder disappears, rather than leaving a partial copy', () => {
    race.dropDestinationOf = path.join(source, 'scripts/flow.ts');
    expect(() => copyPlugin(source, into)).toThrow(/ENOENT/);
  });

  it('copies a link as what it points to, and skips a link that leads nowhere', () => {
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(source, 'linked.md'));
    fs.symlinkSync(path.join(root, 'gone'), path.join(source, 'dangling.md'));
    copyPlugin(source, into);
    expect(fs.lstatSync(path.join(into, 'linked.md')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(into, 'linked.md'), 'utf8')).toBe('outside');
    expect(fs.existsSync(path.join(into, 'dangling.md'))).toBe(false);
  });

  it('does not follow a link that loops back into a folder being copied', () => {
    fs.symlinkSync(source, path.join(source, 'skills', 'loop'));
    expect(() => copyPlugin(source, into)).not.toThrow();
    expect(fs.existsSync(path.join(into, 'skills/loop'))).toBe(false);
  });

  it('keeps a script executable', () => {
    put('scripts/run.sh', '#!/bin/sh\n');
    fs.chmodSync(path.join(source, 'scripts/run.sh'), 0o755);
    copyPlugin(source, into);
    expect(fs.statSync(path.join(into, 'scripts/run.sh')).mode & 0o111).not.toBe(0);
  });
});
