/** Opt-in real-server contract; no DorkOS dependency enters Flow's runtime. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export const DELIVERED_DORKOS_REF = '885b00fa627fad4bcefa918a93105d427f1a0f7c';
const sourceRoot = process.env.DORKOS_SOURCE_ROOT;
if (!sourceRoot || !path.isAbsolute(sourceRoot)) {
  throw new Error(
    'Set DORKOS_SOURCE_ROOT to an owned checkout of the pinned delivered DorkOS source.'
  );
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: sourceRoot,
  encoding: 'utf8',
}).trim();
if (head !== DELIVERED_DORKOS_REF)
  throw new Error(`DorkOS source must be ${DELIVERED_DORKOS_REF}.`);
if (
  execFileSync('git', ['diff', 'HEAD', '--name-only'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
) {
  throw new Error('The pinned DorkOS fixture must have no tracked source changes.');
}

// Compile the exact pinned workspace source. This avoids both a broad build and
// a stale dist silently testing another version. Third-party imports still use
// the owned source checkout's normal per-package dependency resolution.
const aliases: { find: string; replacement: string }[] = [];
for (const directory of readdirSync(path.join(sourceRoot, 'packages'))) {
  const root = path.join(sourceRoot, 'packages', directory);
  const manifestPath = path.join(root, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (subpath.includes('*')) continue;
    const value = typeof entry === 'string' ? entry : (entry as Record<string, string>).types;
    if (typeof value !== 'string') continue;
    const target = path.join(
      root,
      value.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$/, '.ts')
    );
    if (!existsSync(target)) continue;
    aliases.push({
      find: manifest.name + (subpath === '.' ? '' : subpath.slice(1)),
      replacement: target,
    });
  }
}
aliases.sort((a, b) => b.find.length - a.find.length);
const here = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: [path.join(here, '*.integration.ts')],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    // Cold imports traverse the real server graph; this is setup, not a behavior deadline.
    hookTimeout: 120_000,
    server: { deps: { inline: [/\/packages\//, /\/apps\/server\//] } },
  },
});
