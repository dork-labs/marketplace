/**
 * The self-test scenarios, in run order (spec `specs/flow-self-improvement`
 * §1, tier `scenarios`). Each drives the real `flow` verbs in process against
 * the fake tracker and throws a `ScenarioFailure` naming what went wrong.
 *
 * Adding a scenario is one module here and one entry below; its check id is
 * `scenarios/<id>`.
 *
 * @module @dorkos/flow/selftest/scenarios
 */

import { groomAudit } from './groom-audit.ts';
import type { ScenarioOptions } from './harness.ts';
import { inboxRules } from './inbox-rules.ts';
import { lifecycle } from './lifecycle.ts';
import { recoveryLadder } from './recovery-ladder.ts';

export { ScenarioFailure, type ScenarioOptions, type TrackerFactory } from './harness.ts';

/** One scenario: its id (the check id after `scenarios/`) and how to run it. */
export interface Scenario {
  /** For example `lifecycle/codex`. */
  id: string;
  /** Run it; throws when an assertion fails. */
  run(options: ScenarioOptions): Promise<void>;
}

/** Every scenario, in run order. */
export const SCENARIOS: readonly Scenario[] = [
  { id: 'lifecycle/claude-code', run: (options) => lifecycle('claude-code', options) },
  { id: 'lifecycle/codex', run: (options) => lifecycle('codex', options) },
  { id: 'groom-audit', run: groomAudit },
  { id: 'recovery-ladder', run: recoveryLadder },
  { id: 'inbox-rules', run: inboxRules },
];
