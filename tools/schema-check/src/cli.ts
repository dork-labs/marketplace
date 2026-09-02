/**
 * `npm run check` — validates this repository against the pinned DorkOS schemas
 * and prints what is wrong. Exits 1 when anything is.
 *
 * @module cli
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPin } from '../scripts/fetch-upstream.ts';
import { validateRepo } from './validate.ts';

// This file is tools/schema-check/src/cli.ts, so the repo root is three up.
const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const pin = readPin();
const findings = validateRepo(repoRoot);

if (findings.length === 0) {
  console.log(`✓ Skills and manifests match DorkOS ${pin.repo}@${pin.ref.slice(0, 12)}`);
  process.exit(0);
}

for (const finding of findings) {
  console.log(`✗ ${finding.file}: ${finding.message}`);
}
console.log(`\n${findings.length} problem(s) found.`);
process.exit(1);
