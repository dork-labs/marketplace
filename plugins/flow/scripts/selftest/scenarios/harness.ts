/**
 * What every self-test scenario runs on (spec `specs/flow-self-improvement` §1,
 * tier `scenarios`, DOR-2390): a throwaway git project with a flow config, a
 * {@link FakeTracker} standing in for the team's tracker, a clock the scenario
 * moves by hand, and the REAL `flow` CLI driven in process through
 * `main(argv, deps)` from `scripts/flow.ts`.
 *
 * Nothing here reaches a network, a real tracker or this checkout's own run
 * store: the project is a new temp folder, the adapter factory returns the
 * fake's adapter, and the environment is built from scratch (never
 * `process.env`), so the harness a person happens to run in does not leak into
 * what the verbs record.
 *
 * Scenarios throw a {@link ScenarioFailure} naming what they expected and what
 * they saw; the runner turns that into a failing check.
 *
 * @module @dorkos/flow/selftest/scenarios/harness
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { realProcessRunner, type ProcessRunner } from '../../cli/context.ts';
import type { FlowRun } from '../../flow-run.ts';
import { findConfigRoots } from '../../config-files.ts';
import type { FlowConfig } from '../../config-schema.ts';
import { loadConfig } from '../../config-load.ts';
import { openFlowStateFile, type FlowStateFile } from '../../flow-state-file.ts';
import { main } from '../../flow.ts';
import { FakeTracker, type FakeBacklog, type FakeTrackerOptions } from '../../tracker/fake.ts';
import type { WorkItem } from '../../tracker/types.ts';

/** A failed scenario assertion: what was expected, and what the fake or the CLI showed. */
export class ScenarioFailure extends Error {
  override name = 'ScenarioFailure';
}

/**
 * Fail the scenario unless `condition` holds.
 *
 * @param condition - What must be true.
 * @param message - What went wrong, in terms a person reading the report can act on.
 * @throws {ScenarioFailure} When `condition` is false.
 */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioFailure(message);
}

/**
 * Fail the scenario unless two values are deeply equal.
 *
 * @param actual - What the run produced.
 * @param expected - What it should have produced.
 * @param what - The thing compared, for the message.
 * @throws {ScenarioFailure} Naming both values.
 */
export function checkEqual(actual: unknown, expected: unknown, what: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new ScenarioFailure(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

/** A clock the scenario moves by hand; the fake tracker and the CLI both read it. */
export interface ScenarioClock {
  /** The current instant. */
  now(): Date;
  /** Move time forward. */
  advance(ms: number): void;
}

/**
 * A clock starting at `start` that moves only when told.
 *
 * @param start - The first instant (ISO).
 * @returns The clock.
 */
export function manualClock(start = '2026-09-26T12:00:00.000Z'): ScenarioClock {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms) => (t += ms) };
}

/** What one `flow` invocation produced. */
export interface FlowCall {
  /** The exit code. */
  code: number;
  /** Everything on stdout. */
  stdout: string;
  /** Everything on stderr. */
  stderr: string;
  /** stdout parsed as JSON (every call runs with `--json`). */
  json: Record<string, unknown>;
}

/** Builds the fake tracker a scenario seeds; a planted-break test swaps in a broken one. */
export type TrackerFactory = (backlog: FakeBacklog, options: FakeTrackerOptions) => FakeTracker;

/** How a scenario context is built. */
export interface ScenarioOptions {
  /** The plugin folder the CLI runs from. */
  flowRoot: string;
  /** Builds the fake tracker. Default: `new FakeTracker(...)`. */
  makeTracker?: TrackerFactory;
}

/** Everything a scenario drives and reads. */
export interface ScenarioContext {
  /** The tracker the last {@link ScenarioContext.seed} built; `flow` runs against it. */
  readonly tracker: FakeTracker;
  /** The clock the tracker and the CLI read. */
  readonly clock: ScenarioClock;
  /** The temp git project (its folder is the CLI's cwd). */
  readonly projectDir: string;
  /** Seed a new backlog; later `flow` calls run against it. */
  seed(backlog: FakeBacklog): FakeTracker;
  /** Replace `.agents/flow/config.json`. */
  config(value: Record<string, unknown>): void;
  /** The project's config, loaded and defaulted as the verbs load it. */
  loadedConfig(): FlowConfig;
  /**
   * Run `flow <argv> --json` in process against the current tracker.
   *
   * @param argv - The verb and its arguments.
   * @param env - The environment the verb sees (the harness shape, for example).
   */
  flow(argv: readonly string[], env?: Record<string, string>): Promise<FlowCall>;
  /** Run `flow` and fail the scenario unless it exits `expected` (default 0). */
  flowOk(
    argv: readonly string[],
    env?: Record<string, string>,
    expected?: number
  ): Promise<FlowCall>;
  /** The project's run store (`flow-state.json`). */
  readonly store: FlowStateFile;
  /** Every run record in the store. */
  runs(): Record<string, FlowRun>;
  /** The tracker's stored item, read straight from the fake (not through the adapter). */
  item(identifier: string): WorkItem;
}

/** A text sink that keeps what is written. */
function sink(): { write(chunk: string): boolean; text(): string } {
  let buffer = '';
  return {
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    text: () => buffer,
  };
}

/**
 * A pid no process holds: above every platform's pid limit (Linux caps at
 * 2^22, macOS at 99 999), so a liveness check on it always says "gone".
 */
export const DEAD_PID = 2_000_000_000;

/**
 * The process runner the CLI gets: `git` runs for real against the temp
 * project; nothing else is expected (claims pass `--pid`, `--worktree` and
 * `--branch`), so anything else is refused loudly rather than run.
 */
const runner: ProcessRunner = async (cmd, args, opts) => {
  if (cmd === 'git') return realProcessRunner(cmd, args, opts);
  throw new ScenarioFailure(`a scenario verb tried to run "${cmd}"; scenarios run only git`);
};

/** The config every scenario starts from: the fake tracker, the agent is the tracker's user. */
export const BASE_CONFIG: Readonly<Record<string, unknown>> = {
  tracker: 'fake',
  identity: { agent: 'auto' },
};

/**
 * Run `body` against a fresh context, and delete the temp project afterwards
 * whatever happened.
 *
 * @param options - The flow root and the tracker factory.
 * @param body - The scenario.
 * @returns Whatever `body` returns.
 */
export async function withScenario<T>(
  options: ScenarioOptions,
  body: (ctx: ScenarioContext) => Promise<T>
): Promise<T> {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-scenario-')));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'work');
    git(
      '-c',
      'user.email=selftest@example.test',
      '-c',
      'user.name=selftest',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    );
    const clock = manualClock();
    const makeTracker: TrackerFactory =
      options.makeTracker ?? ((backlog, opts) => new FakeTracker(backlog, opts));
    let tracker: FakeTracker | undefined;
    const configFile = path.join(dir, '.agents', 'flow', 'config.json');
    const writeConfig = (value: Record<string, unknown>) => {
      mkdirSync(path.dirname(configFile), { recursive: true });
      writeFileSync(configFile, `${JSON.stringify(value, null, 2)}\n`);
    };
    writeConfig({ ...BASE_CONFIG });
    const store = openFlowStateFile(dir);

    const flow = async (argv: readonly string[], env: Record<string, string> = {}) => {
      if (tracker === undefined) throw new ScenarioFailure('the scenario ran flow before seeding');
      const current = tracker;
      const stdout = sink();
      const stderr = sink();
      const code = await main([...argv, '--json'], {
        env: { ...env },
        cwd: dir,
        now: () => clock.now(),
        stdout,
        stderr,
        createAdapter: async () => current.adapter,
        runProcess: runner,
        flowRoot: options.flowRoot,
      });
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(stdout.text()) as Record<string, unknown>;
      } catch {
        // Left empty: the exit-code check reports the call with its stderr.
      }
      return { code, stdout: stdout.text(), stderr: stderr.text(), json };
    };

    const ctx: ScenarioContext = {
      get tracker() {
        if (tracker === undefined)
          throw new ScenarioFailure('the scenario has not seeded a backlog');
        return tracker;
      },
      clock,
      projectDir: dir,
      seed: (backlog) => {
        tracker = makeTracker(backlog, { now: () => clock.now() });
        return tracker;
      },
      config: writeConfig,
      loadedConfig: () => loadConfig(findConfigRoots(dir, options.flowRoot), {}).config,
      flow,
      flowOk: async (argv, env, expected = 0) => {
        const call = await flow(argv, env);
        if (call.code !== expected) {
          const error = (call.json.error as { message?: string } | undefined)?.message;
          throw new ScenarioFailure(
            `"flow ${argv.join(' ')}" exited ${call.code}, expected ${expected}: ${error ?? call.stderr.trim()}`
          );
        }
        return call;
      },
      store,
      runs: () => store.read(),
      item: (identifier) => {
        const found = ctx.tracker.backlog.items.find((i) => i.identifier === identifier);
        if (found === undefined) throw new ScenarioFailure(`the fake has no item ${identifier}`);
        return found;
      },
    };
    return await body(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A work item as a scenario seeds it; every field a reader needs, overridable.
 *
 * @param identifier - The key, for example `FAKE-1`.
 * @param overrides - Fields to replace.
 * @returns The item.
 */
export function seedItem(identifier: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'unstarted',
    stateName: 'Todo',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * The labels of one family on an item, for messages and checks.
 *
 * @param item - The item.
 * @param prefix - The family, for example `agent/`.
 * @returns Its labels of that family.
 */
export function family(item: WorkItem, prefix: string): string[] {
  return item.labels.filter((label) => label.startsWith(prefix));
}
