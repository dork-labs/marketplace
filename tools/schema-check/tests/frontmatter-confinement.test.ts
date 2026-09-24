import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `gray-matter` runs `eval` on a `---js` frontmatter block unless every call
 * is configured not to (DOR-2310). `src/frontmatter.ts` is the one place that
 * configuration lives, so it must stay the one place that imports the package.
 * Anything else reading markdown goes through `parseFrontmatter`.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** The only file allowed to import gray-matter. */
const ALLOWED = 'tools/schema-check/src/frontmatter.ts';

/** Directories that hold no code of ours, or code we did not write. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.upstream']);

/** Every extension a script in this repo could be written in. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * A load of the package, however it is written: `import ... from` or a bare
 * `import '...'`, or the name as the first argument of any call, which covers
 * `require(...)`, `import(...)`, `createRequire(...)(...)`, an aliased require
 * and `require.resolve(...)`. Any quote style, any subpath. Prose that merely
 * names the package does not match.
 */
const SPECIFIER = /(?:\b(?:from|import)\s*|\(\s*)(['"`])gray-matter(?:\/[^'"`]*)?\1/;

/** Every repo-relative code file under `dir`. */
function codeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...codeFiles(rel));
    else if (CODE_FILE.test(entry.name)) found.push(rel);
  }
  return found;
}

/**
 * The package name, split so that the import samples below never spell a real
 * import in this file's own source, which the guard scans like any other.
 */
const PKG = ['gray', 'matter'].join('-');

describe('gray-matter confinement', () => {
  // Purpose: the guard is only as good as its pattern. Every way a script can
  // load the package, deep paths included, has to register as an import.
  it.each([
    `import matter from '${PKG}';`,
    `import "${PKG}";`,
    `export { default } from '${PKG}';`,
    `import {\n  stringify,\n} from "${PKG}";`,
    `const matter = require('${PKG}');`,
    `import matter = require('${PKG}');`,
    `const m = require ( "${PKG}/lib/engines" );`,
    `const m = await import('${PKG}/lib/parse.js');`,
    `const m = await import(\`${PKG}\`);`,
    `const matter = createRequire(import.meta.url)('${PKG}');`,
    `const req = createRequire(import.meta.url);\nconst matter = req("${PKG}/lib/parse");`,
    `const where = require.resolve('${PKG}');`,
  ])('counts %j as an import', (source) => {
    expect(SPECIFIER.test(source)).toBe(true);
  });

  // Purpose: prose naming the package, or a different package that starts
  // with the same letters, is not an import and must not fail the guard.
  it.each([
    '// gray-matter runs eval on a ---js block',
    ' * `gray-matter` is a code runner as well as a parser.',
    `import x from '${PKG}-extra';`,
  ])('does not count %j as an import', (source) => {
    expect(SPECIFIER.test(source)).toBe(false);
  });

  // Purpose: every extension a script here could use is scanned.
  it.each(['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.js', 'a.mjs', 'a.cjs', 'a.jsx'])(
    'scans %s',
    (name) => {
      expect(CODE_FILE.test(name)).toBe(true);
    }
  );

  // Purpose: a second importer would parse frontmatter with gray-matter's
  // defaults, which is the code-execution hole this module closes. Asserting
  // the exact list, not just "nothing else", also proves the pattern still
  // matches the real import, so the guard cannot go quietly blind.
  it('is imported by src/frontmatter.ts and nothing else in the repo', () => {
    const importers = codeFiles('.')
      .map((file) => file.split(path.sep).join('/'))
      .filter((file) => SPECIFIER.test(readFileSync(path.join(repoRoot, file), 'utf8')));
    expect(importers).toEqual([ALLOWED]);
  });
});
