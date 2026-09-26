/**
 * Shared set-up for the read-verb tests (`snapshot`, `audit`, `next`): a temp
 * project with a flow config, the fake adapter over an in-memory backlog, and
 * `main` driven in-process with recording streams.
 *
 * Not a test file itself (no `.test.ts`), so vitest only runs it through the
 * tests that import it.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CliDeps } from '../../scripts/cli/context.ts';
import { main, VERBS } from '../../scripts/flow.ts';
import type { WorkItem } from '../../scripts/tracker/types.ts';
import { createFakeAdapter, type FakeBacklog } from '../fixtures/cli/fake-adapter/adapter.ts';

/** A temp project folder and plugin folder, removed by `cleanup`. */
export interface TempProject {
  /** The project checkout (holds `.agents/flow/config.json`). */
  project: string;
  /** An empty plugin folder, so no real plugin's settings leak in. */
  plugin: string;
  /** A private DorkOS home (`DORK_HOME`), so the operator's own accounts never leak in. */
  dorkHome: string;
  /** Delete both folders. */
  cleanup(): void;
}

/**
 * Make a temp project whose committed flow config is `config`.
 *
 * @param config - The `.agents/flow/config.json` body.
 * @returns The folders.
 */
export function tempProject(config: Record<string, unknown>): TempProject {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-read-verbs-')));
  const project = path.join(base, 'project');
  const plugin = path.join(base, 'plugin');
  mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(project, '.agents', 'flow', 'config.json'), JSON.stringify(config));
  return {
    project,
    plugin,
    dorkHome: path.join(base, 'dork'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** What one in-process run produced. */
export interface RunResult {
  /** The exit code. */
  code: number;
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
  /** How many times the adapter factory was called. */
  adapterBuilds: number;
}

/** Optional parts of the world a run sees. */
export interface RunOptions {
  /** Answers external commands (`git remote get-url origin`). Default: exit 0, no output. */
  runProcess?: CliDeps['runProcess'];
}

/**
 * Run `flow <argv>` in-process against a fake backlog, with `DORK_HOME` set to
 * the temp project's own.
 *
 * @param argv - The arguments after the script path.
 * @param temp - The temp project; runs with cwd = its project folder.
 * @param backlog - The fake tracker's state.
 * @param options - Replaces the process runner.
 * @returns The exit code, both streams and the adapter build count.
 */
export async function runFlow(
  argv: readonly string[],
  temp: TempProject,
  backlog: FakeBacklog,
  options: RunOptions = {}
): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  let adapterBuilds = 0;
  const code = await main(argv, {
    env: { DORK_HOME: temp.dorkHome },
    cwd: temp.project,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => {
      adapterBuilds += 1;
      return createFakeAdapter(backlog).adapter;
    },
    runProcess: options.runProcess ?? (async () => ({ code: 0, stdout: '', stderr: '' })),
    flowRoot: temp.plugin,
    verbs: VERBS,
  });
  return { code, stdout, stderr, adapterBuilds };
}

/**
 * A minimal open work item that passes every groom invariant as a ready item.
 *
 * @param identifier - Its human key.
 * @param overrides - Fields to replace.
 * @returns The item.
 */
export function readyItem(identifier: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    description: 'Do it.\n\n## Validation criteria\n\n- Done.\n\n## On Completion\n\n- Nothing.',
    type: 'task',
    stateCategory: 'unstarted',
    stateName: 'Todo',
    priority: 2,
    size: 3,
    project: { id: 'proj-1', name: 'Widgets', stateCategory: 'started' },
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['type/task', 'agent/ready', 'stage/execute'],
    agentDisposition: 'ready',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}
