/**
 * Scenario `groom-audit`: `flow audit` over the groom fixtures, loaded into the
 * fake tracker (spec `specs/flow-self-improvement` §1).
 *
 * The committed fixtures (`engine-tests/fixtures/backlog.{bad,good}.json`) are
 * seeded as the fake's backlog, so the audit reads them through the adapter
 * snapshot the way it reads a real team. The bad one must fail exactly the ids
 * `engine-tests/audit-backlog.test.ts` pins for it (`GRM-7`, naming both
 * items), and the good one none.
 *
 * @module @dorkos/flow/selftest/scenarios/groom-audit
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { WorkItem } from '../../tracker/types.ts';
import { BASE_CONFIG, check, checkEqual, type ScenarioOptions, withScenario } from './harness.ts';

/** A groom fixture file: items, plus the agent identity the audit runs as. */
interface GroomFixture {
  items: WorkItem[];
  opts?: { agentIdentity?: string };
}

/** What each fixture must produce: the failing invariant ids, and items each detail names. */
export const EXPECTED: Readonly<Record<'bad' | 'good', { ids: string[]; names: string[] }>> = {
  bad: { ids: ['GRM-7'], names: ['GRM-200', 'GRM-201'] },
  good: { ids: [], names: [] },
};

/**
 * Run the groom-audit scenario.
 *
 * @param options - The flow root and the tracker factory.
 */
export async function groomAudit(options: ScenarioOptions): Promise<void> {
  for (const which of ['bad', 'good'] as const) {
    await withScenario(options, async (ctx) => {
      const file = path.join(options.flowRoot, 'engine-tests', 'fixtures', `backlog.${which}.json`);
      const fixture = JSON.parse(readFileSync(file, 'utf8')) as GroomFixture;
      const agent = fixture.opts?.agentIdentity ?? 'flow-bot';
      ctx.seed({ team: { key: 'GRM', id: 'team-grm' }, user: { id: agent }, items: fixture.items });
      ctx.config({ ...BASE_CONFIG, identity: { agent } });

      const want = EXPECTED[which];
      const call = await ctx.flow(['audit']);
      const failures = (call.json.failures as { invariant: string; detail: string }[]) ?? [];
      checkEqual(
        failures.map((f) => f.invariant),
        want.ids,
        `flow audit on backlog.${which}.json fails`
      );
      checkEqual(
        call.code,
        want.ids.length === 0 ? 0 : 1,
        `flow audit on backlog.${which}.json exit code`
      );
      const details = failures.map((f) => f.detail).join('\n');
      for (const name of want.names) {
        check(details.includes(name), `flow audit on backlog.${which}.json does not name ${name}`);
      }
    });
  }
}
