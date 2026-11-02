/**
 * Where the stale-reading refresh is wired (DOR-3704). Every ranking `flow
 * drain` does must see refreshed readings, and no other verb may pass the
 * refresh on, since each refresh spends usage. This reads the source, as the
 * compliance guard does: a drain pass is too large to run here.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, '..', '..', 'scripts', rel), 'utf8');

/** How many times `pattern` occurs in `text`. */
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

describe('the stale-reading refresh wiring', () => {
  it('flow drain hands the refresh to every ranking it does', () => {
    const drain = read('cli/drain.ts');
    expect(drain).toMatch(/const refresh = staleUsageRefresher\(ctx, config, mainCheckout\)/);
    const gathers = count(drain, /gatherAssignmentInput\(/g);
    expect(gathers).toBeGreaterThan(0);
    expect(count(drain, /gatherAssignmentInput\(ctx, config, refresh\)/g)).toBe(gathers);
    const plan = drain.slice(drain.indexOf('await planNext('));
    expect(plan.slice(0, plan.indexOf('});'))).toMatch(/refresh/);
    const wiring = drain.slice(drain.indexOf('handoffWiring({'));
    expect(wiring.slice(0, wiring.indexOf('});'))).toMatch(/refresh/);
    expect(read('cli/handoff-wiring.ts')).toMatch(
      /gatherAssignmentInput\(ctx, config, wiring\.refresh\)/
    );
  });

  it('flow next and flow accounts pick pass no refresh on', () => {
    // planNext forwards `request.refresh`; the `flow next` verb gives it none.
    const next = read('cli/next.ts');
    const verb = next.slice(next.indexOf('const plan = await planNext('));
    expect(verb.slice(0, verb.indexOf('});'))).not.toMatch(/refresh/);
    for (const call of read('cli/accounts-pick.ts').match(/gatherAssignmentInput\([^)]*\)/g) ??
      []) {
      expect(call).toBe('gatherAssignmentInput(ctx, config)');
    }
  });
});
