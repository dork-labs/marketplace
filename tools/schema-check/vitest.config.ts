import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite does not read tsconfig `paths`, so the `@dorkos/*` specifiers have to be
 * aliased for it as well. They are derived from tsconfig.json rather than
 * restated, so the two can never disagree — which also means tsconfig.json has
 * to stay comment-free JSON. The rationale for the mapping itself is in README.md.
 */
const tsconfig = JSON.parse(readFileSync(path.join(here, 'tsconfig.json'), 'utf8')) as {
  compilerOptions: { paths: Record<string, string[]> };
};

const alias = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions.paths).map(([specifier, [target]]) => [
    specifier,
    path.join(here, target),
  ])
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
