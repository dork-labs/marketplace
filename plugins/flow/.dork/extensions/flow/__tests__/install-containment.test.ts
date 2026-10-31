/**
 * DorkOS compiles the extension's page half once while installing, from the
 * staging folder, and holds that build to the extension's own folder: an import
 * that resolves outside `.dork/extensions/flow/` fails the install ("Extension
 * 'flow' failed to compile", DorkOS DOR-3068, DOR-3537). Flow 0.66.1 failed to
 * install that way, because `ui/` imported `scripts/autonomy-dial.ts`.
 *
 * So this bundles `index.ts` the way that install step does: esbuild, the
 * host's externals left alone, every other import checked against the
 * extension folder. The server half is compiled later, against the whole
 * plugin folder, and may still use `scripts/`.
 *
 * The two engine modules the page half needs are kept as exact copies in
 * `shared/`, not moved: `scripts/` stays whole on its own (a copy of it runs
 * without the rest of the plugin), so the copies must never drift.
 */

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const EXTENSION_DIR = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
);

/** What DorkOS provides to an extension's page, so a bundle never inlines it. */
const HOST_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', '@dorkos/extension-api'];

/** The containment check DorkOS's install compile runs, set to the extension folder. */
function containedTo(root: string, outside: string[]): Plugin {
  return {
    name: 'install-containment',
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.contained || args.kind === 'entry-point') return undefined;
        if (HOST_EXTERNALS.some((n) => args.path === n || args.path.startsWith(`${n}/`))) {
          return undefined;
        }
        const resolved = await b.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { contained: true },
        });
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        if (resolved.external || !resolved.path) return undefined;
        const real = realpathSync(resolved.path);
        const rel = path.relative(root, real);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          outside.push(`${path.relative(root, args.importer)} imports ${args.path}`);
        }
        return { path: resolved.path };
      });
    },
  };
}

describe('the install-time build of the page half', () => {
  it('imports nothing from outside the extension folder', async () => {
    const outside: string[] = [];
    await build({
      entryPoints: [path.join(EXTENSION_DIR, 'index.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      loader: { '.ts': 'tsx' },
      external: HOST_EXTERNALS,
      logLevel: 'silent',
      plugins: [containedTo(EXTENSION_DIR, outside)],
    });
    expect(outside).toEqual([]);
  });
});

describe('the engine modules the page half keeps its own copies of', () => {
  it.each(['autonomy-dial.ts', 'config-names.ts'])(
    'shared/$0 is byte for byte scripts/$0',
    (name) => {
      const plugin = path.resolve(EXTENSION_DIR, '..', '..', '..');
      expect(readFileSync(path.join(EXTENSION_DIR, 'shared', name), 'utf8')).toBe(
        readFileSync(path.join(plugin, 'scripts', name), 'utf8')
      );
    }
  );
});
