/**
 * The Flow extension's server half is bundled by DorkOS with esbuild into
 * CommonJS, from the installed plugin, where no package is guaranteed to be
 * installed. So everything `server.ts` loads at run time must be node
 * builtins and relative files, never `zod` or any other package, and nothing
 * may read `import.meta` (it is empty in a CommonJS bundle).
 *
 * This walks the value imports from `server.ts` and `index.ts` the way a
 * bundler would, and fails naming the file that brings in a package.
 *
 * DorkOS also parses every `.ts` file as TSX (its esbuild `loader` maps `.ts`
 * to `tsx`), so a generic arrow such as `async <T>() => …` reads as a JSX tag
 * and the whole server half fails to compile. Each reached file must parse as
 * TSX.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The value imports of a file: `import type` and `export type` are erased and skipped. */
function valueImports(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[2] !== undefined) continue;
    found.push(match[3]);
  }
  return found;
}

/** Every file reached from `entry` through value imports, with the packages each names. */
function walk(entry: string): { files: string[]; packages: { file: string; name: string }[] } {
  const files: string[] = [];
  const packages: { file: string; name: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.includes(file)) continue;
    files.push(file);
    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec));
      else if (!spec.startsWith('node:'))
        packages.push({ file: path.relative(EXTENSION_DIR, file), name: spec });
    }
  }
  return { files, packages };
}

describe('the bundle DorkOS builds', () => {
  it.each(['server.ts', 'index.ts'])('%s loads no package and never reads import.meta', (entry) => {
    const { files, packages } = walk(path.join(EXTENSION_DIR, entry));
    expect(packages).toEqual([]);
    const withMeta = files.filter((file) => readFileSync(file, 'utf8').includes('import.meta'));
    expect(withMeta.map((file) => path.relative(EXTENSION_DIR, file))).toEqual([]);
    const unparsable = files.flatMap((file) => {
      const out = ts.transpileModule(readFileSync(file, 'utf8'), {
        fileName: file.replace(/\.ts$/, '.tsx'),
        reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
      });
      return (out.diagnostics ?? []).map((d) => {
        const at =
          d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
        return `${path.relative(EXTENSION_DIR, file)}${at ? `:${at.line + 1}` : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
      });
    });
    expect(unparsable).toEqual([]);
    if (entry === 'server.ts') {
      // It does reach flow's own modules, so the walk is real.
      expect(
        files.some((file) => file.endsWith(path.join('scripts', 'fleet', 'accounts.ts')))
      ).toBe(true);
    }
  });
});
