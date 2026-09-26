/**
 * A child process for the journal concurrency tests: appends `count` note lines
 * tagged `<tag> <n>` to one journal, as fast as it can.
 *
 *   node --experimental-strip-types writer.ts <journal> <count> <tag> <maxBytes> <keep>
 */

import path from 'node:path';

import { append } from '../../../scripts/journal.ts';

const [file, count, tag, maxBytes, keep] = process.argv.slice(2);
const settings = {
  path: file,
  checkout: path.dirname(file),
  enabled: true,
  maxBytes: Number(maxBytes),
  keep: Number(keep),
};
for (let i = 0; i < Number(count); i += 1) {
  const outcome = append(
    settings,
    { kind: 'note', noteKind: 'friction', text: `${tag} ${i}` },
    { flowVersion: 'test' }
  );
  if (outcome !== 'written') process.exit(1);
}
