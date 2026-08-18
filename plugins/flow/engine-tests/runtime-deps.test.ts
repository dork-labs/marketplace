/**
 * Runtime-dependency guard for the shipped engine oracles (F14).
 *
 * The plugin ships `scripts/*.ts` and runs them with
 * `node --experimental-strip-types`. Type-stripping erases `import type` lines
 * but leaves every value import to be resolved by Node at load time — so any
 * bare package specifier a script imports as a VALUE is a genuine runtime
 * dependency, and it has to be declared in `dependencies`, not
 * `devDependencies`.
 *
 * The regression this pins is subtle and shipped for real: `zod` sat in
 * `devDependencies` while `package.json` described the runtime as
 * dependency-free. Most oracles were unaffected, because they import zod only
 * for its types — which is exactly why nobody noticed. Four did not
 * (`dispatch.ts`, `flow-state.ts`, `transport.ts`, `comment-response.ts`), and
 * `dispatch.ts` is the oracle `/flow:init` Step 5 runs to confirm an install. An
 * adopter whose shell carried `NODE_ENV=production` (or `omit=dev`) installed
 * nothing at all, and setup's final check crashed with `ERR_MODULE_NOT_FOUND`.
 *
 * The guard is static rather than empirical on purpose: an empirical version
 * would have to delete `node_modules` to be meaningful, and a test that can pass
 * because the harness happened to have a package hoisted somewhere is no guard.
 * Reading the import statements answers the actual question — what will Node be
 * asked to resolve — with no dependence on the machine it runs on.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// engine-tests -> plugins/flow (the plugin bundle root)
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(pluginRoot, 'scripts');

const packageJson = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  description?: string;
};

const declaredDependencies = Object.keys(packageJson.dependencies ?? {});
const declaredDevDependencies = Object.keys(packageJson.devDependencies ?? {});

/**
 * Scripts that are DEV-time tooling rather than shipped oracles. `generate-config-schema.ts`
 * rebuilds `config.schema.json` from the Zod source and is only ever run by a
 * contributor through `npm run generate:schema`, so it may import dev packages.
 */
const DEV_ONLY_SCRIPTS = new Set(['generate-config-schema.ts']);

/** Every shipped engine script — the files an adopter's `/flow` run actually executes. */
const shippedScripts = readdirSync(scriptsDir)
  .filter((entry) => entry.endsWith('.ts'))
  .filter((entry) => !DEV_ONLY_SCRIPTS.has(entry));

/**
 * The bare package specifiers `source` imports as VALUES.
 *
 * Relative specifiers (`./x.ts`) are internal, and `node:` specifiers are
 * built-ins — neither needs declaring. An `import type ... from 'x'` line is
 * erased by type-stripping and never reaches Node's resolver, so it is not a
 * runtime dependency; every other import form is treated as one.
 *
 * @param source - The TypeScript source text of one script.
 * @returns The bare package names the script requires at runtime.
 */
function runtimePackageImports(source: string): string[] {
  const packages = new Set<string>();
  // `import ... from '<specifier>'`, `export ... from '<specifier>'`, and the
  // bare side-effect form `import '<specifier>'`.
  const importPattern =
    /(^|\n)\s*(import|export)\b([^'"`;]*?)from\s*'([^']+)'|(^|\n)\s*import\s*'([^']+)'/g;

  for (const match of source.matchAll(importPattern)) {
    const clause = match[3];
    const specifier = match[4] ?? match[6];
    if (!specifier) continue;
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
    // `import type { X } from 'zod'` is erased before Node ever sees it.
    if (clause && /^\s*type\s/.test(clause)) continue;
    // Scoped packages keep two segments; deep imports keep only the package.
    const segments = specifier.split('/');
    packages.add(specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]);
  }

  return [...packages];
}

describe('F14 — every runtime import of a shipped oracle is a declared dependency', () => {
  const runtimeImportsByScript = new Map<string, string[]>(
    shippedScripts.map((file) => [
      file,
      runtimePackageImports(readFileSync(path.join(scriptsDir, file), 'utf8')),
    ])
  );

  it('the scan is non-vacuous — it reads every shipped script and finds real imports', () => {
    // A broken regex or a mis-rooted scan would report "no runtime imports" and
    // pass the assertion below at its most useless. Pin that the scan sees the
    // scripts, and that it finds at least one real package import to check.
    expect(shippedScripts.length).toBeGreaterThan(20);
    const allImports = [...runtimeImportsByScript.values()].flat();
    expect(allImports.length, 'the scan found no package imports at all').toBeGreaterThan(0);
  });

  it('distinguishes a value import from an erased `import type`', () => {
    // The whole guard rests on this distinction — if it collapsed, the test
    // would either flag every type-only import or miss every real one.
    expect(runtimePackageImports("import { z } from 'zod';")).toEqual(['zod']);
    expect(runtimePackageImports("import type { z } from 'zod';")).toEqual([]);
    expect(runtimePackageImports("import { readFileSync } from 'node:fs';")).toEqual([]);
    expect(runtimePackageImports("import { helper } from './_shared.ts';")).toEqual([]);
    expect(runtimePackageImports("import addFormats from 'ajv-formats';")).toEqual(['ajv-formats']);
    expect(runtimePackageImports("import Ajv from 'ajv/dist/2019.js';")).toEqual(['ajv']);
  });

  it('finds the value imports that actually break without an install', () => {
    // Empirically confirmed: with no `node_modules`, exactly these oracles die
    // with ERR_MODULE_NOT_FOUND while the rest run. If a refactor makes one of
    // them type-only, this expectation should be updated deliberately, not
    // silently.
    expect(runtimeImportsByScript.get('config-schema.ts')).toContain('zod');
    expect(runtimeImportsByScript.get('flow-state.ts')).toContain('zod');
  });

  it('declares every runtime package import in `dependencies`', () => {
    const offenders: string[] = [];
    for (const [file, packages] of runtimeImportsByScript) {
      for (const pkg of packages) {
        if (declaredDependencies.includes(pkg)) continue;
        const where = declaredDevDependencies.includes(pkg)
          ? 'declared only in devDependencies'
          : 'not declared at all';
        offenders.push(`scripts/${file} imports "${pkg}" at runtime — ${where}`);
      }
    }

    expect(
      offenders,
      `a shipped oracle imports a package an \`npm install --omit=dev\` would not install:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('does not claim the runtime is dependency-free while it has dependencies', () => {
    // The description was the reason nobody caught this: it stated the runtime
    // needed no install, so the missing install read as expected behaviour.
    expect(declaredDependencies.length).toBeGreaterThan(0);
    expect(packageJson.description ?? '').not.toMatch(/dependency-free/i);
    expect(packageJson.description ?? '').toContain('--omit=dev');
  });
});
