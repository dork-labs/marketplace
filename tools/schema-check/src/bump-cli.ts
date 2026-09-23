/**
 * `npm run check:bump -- <base> <head>` — fails when a package changed between
 * the two revisions without raising its version. Exits 1 when one did.
 *
 * CI passes a PR's base and head SHAs, or a push's `before` and `after`.
 *
 * @module bump-cli
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersionBumps } from './bump.ts';

// This file is tools/schema-check/src/bump-cli.ts, so the repo root is three up.
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const [base, head] = process.argv.slice(2);

if (!base || !head) {
  console.log('Usage: npm run check:bump -- <base> <head>');
  process.exit(2);
}

// A push that creates a branch reports an all-zeros `before`: there is no base
// to compare against, so there is nothing this check can say.
if (/^0+$/.test(base)) {
  console.log(`i This push created the branch, so there is no earlier version to compare with.`);
  process.exit(0);
}

// Every message already opens with the package name, so it is printed as is.
let findings;
try {
  findings = checkVersionBumps(repoRoot, base, head);
} catch (cause) {
  const detail = (cause as { stderr?: string }).stderr?.trim() || (cause as Error).message;
  console.log(`✗ Could not compare the two commits: ${detail}`);
  process.exit(1);
}

for (const note of findings.filter((f) => f.level === 'note')) {
  console.log(`i ${note.message}`);
}

const errors = findings.filter((f) => f.level === 'error');
if (errors.length === 0) {
  console.log('✓ Every changed package raised its version');
  process.exit(0);
}

for (const error of errors) {
  console.log(`✗ ${error.message}`);
}
console.log(`\n${errors.length} package(s) changed without a higher version.`);
process.exit(1);
