/**
 * The self-test's `scenarios` tier: every scenario in `scenarios/index.ts`,
 * each as one check (spec `specs/flow-self-improvement` §1, DOR-2390).
 *
 * Free and offline: a scenario runs the real `flow` verbs in process against
 * the fake tracker in a temp git project. It needs `zod` (the verbs load
 * config) and `git`; without either, every scenario is a skip naming the fix,
 * never a pass.
 *
 * The scenario modules are imported only when this tier runs, so the `fast`
 * tier keeps working before `npm install`.
 *
 * @module @dorkos/flow/selftest/scenarios
 */

import { spawnSync } from 'node:child_process';

import { fingerprint, type Check } from './report.ts';
import type { Scenario, TrackerFactory } from './scenarios/index.ts';

/** What the tier needs. */
export interface ScenarioTierOptions {
  /** The flow plugin root. */
  flowRoot: string;
  /** Builds each scenario's fake tracker; a planted-break test swaps it. */
  makeTracker?: TrackerFactory;
  /** Run only these scenarios (default: all of them). */
  scenarios?: readonly Scenario[];
}

/** The check id prefix. */
const PREFIX = 'scenarios/';

/** A check record for one scenario. */
function record(id: string, status: Check['status'], ms: number, detail: string): Check {
  return {
    id: `${PREFIX}${id}`,
    tier: 'scenarios',
    status,
    ms,
    detail,
    fingerprint: fingerprint(`${PREFIX}${id}`, id),
  };
}

/** Whether an error is Node failing to find `zod`. */
function missingZod(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' &&
    /'zod(\/[^']*)?'/.test(error.message)
  );
}

/**
 * Run every scenario into a check.
 *
 * @param options - The flow root, and test seams.
 * @returns One check per scenario, in order.
 */
export async function runScenarios(options: ScenarioTierOptions): Promise<Check[]> {
  let module: typeof import('./scenarios/index.ts');
  try {
    module = await import('./scenarios/index.ts');
  } catch (error) {
    if (!missingZod(error)) throw error;
    return [
      record('*', 'skip', 0, `needs zod: run "npm install --omit=dev" in ${options.flowRoot}`),
    ];
  }
  const scenarios = options.scenarios ?? module.SCENARIOS;
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) {
    return scenarios.map((s) => record(s.id, 'skip', 0, 'needs git on PATH'));
  }
  const checks: Check[] = [];
  for (const scenario of scenarios) {
    const start = performance.now();
    try {
      await scenario.run({ flowRoot: options.flowRoot, makeTracker: options.makeTracker });
      checks.push(record(scenario.id, 'pass', Math.round(performance.now() - start), ''));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prefix = error instanceof module.ScenarioFailure ? '' : 'the scenario itself broke: ';
      checks.push(
        record(
          scenario.id,
          'fail',
          Math.round(performance.now() - start),
          `${prefix}${message.split('\n')[0]}`
        )
      );
    }
  }
  return checks;
}
