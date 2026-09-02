import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageRoot, readPin, upstreamDir } from '../scripts/fetch-upstream.ts';

const tsconfig = JSON.parse(readFileSync(path.join(packageRoot, 'tsconfig.json'), 'utf8')) as {
  compilerOptions: { paths: Record<string, string[]> };
};

const paths = tsconfig.compilerOptions.paths;

/** The `.upstream/`-relative file each `@dorkos/*` specifier maps to. */
const aliasTargets = Object.values(paths).map(([target]) => target.replace(/^\.upstream\//, ''));

/**
 * Every relative import in a downloaded file, resolved back to an
 * `.upstream/`-relative path. Upstream writes `./duration.js` for what is on
 * disk as `duration.ts`.
 */
function relativeImports(file: string): string[] {
  const source = readFileSync(path.join(upstreamDir, file), 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
    const specifier = match[1].replace(/\.js$/, '.ts');
    found.push(path.join(path.dirname(file), specifier));
  }
  return found;
}

/** Every bare `@dorkos/*` import in a downloaded file. */
function dorkosImports(file: string): string[] {
  const source = readFileSync(path.join(upstreamDir, file), 'utf8');
  return [...source.matchAll(/from '(@dorkos\/[^']+)'/g)].map((match) => match[1]);
}

describe('the upstream pin', () => {
  it('is a full commit SHA, so every run validates against the same code', () => {
    expect(readPin().ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('downloads every file the tsconfig aliases point at', () => {
    const pinned = new Set(readPin().files);
    for (const target of aliasTargets) expect(pinned).toContain(target);
  });

  // The pin's `files` list has to be the exact import closure of the aliased
  // entry points: one file short and the gate dies with a module-not-found, one
  // file long and nobody notices the dead weight. Walking the real imports is
  // the only way to know, and it is why upgrading the pin is a mechanical job.
  it('downloads exactly the closure those files import, and no more', () => {
    const pin = readPin();
    const seen = new Set<string>();
    const queue = [...aliasTargets];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      expect(existsSync(path.join(upstreamDir, file))).toBe(true);
      queue.push(...relativeImports(file));
      for (const specifier of dorkosImports(file)) {
        expect(Object.keys(paths)).toContain(specifier);
        queue.push(paths[specifier][0].replace(/^\.upstream\//, ''));
      }
    }
    expect([...seen].sort()).toEqual([...pin.files].sort());
  });
});
