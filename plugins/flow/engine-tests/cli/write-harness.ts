/**
 * Shared set-up for the write-verb tests (`claim`, `release`, `done`,
 * `stage`): a real temporary git project with a flow config, the in-memory
 * fake adapter, and `main(argv, deps)` driven with recording streams.
 *
 * The project is a real git checkout because the run store resolves its main
 * checkout through git, and config loading finds its roots the same way. `ps`
 * is faked (a fixed worker pid); `git` runs for real against the temp project.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { realProcessRunner, type ProcessRunner } from '../../scripts/cli/context.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';
import type { WorkItem } from '../../scripts/tracker/types.ts';
import {
  createFakeAdapter,
  type FakeBacklog,
  type FakeTracker,
} from '../fixtures/cli/fake-adapter/adapter.ts';

/** The worker pid the fake `ps` reports. */
export const FAKE_PPID = 4242;

/** One temporary project. */
export interface WriteProject {
  /** The checkout root. */
  dir: string;
  /** Delete it. */
  cleanup(): void;
  /** Write `.agents/flow/config.json`. */
  config(value: Record<string, unknown>): void;
  /** Pause flow in this project. */
  pause(): void;
  /** Every run in `flow-state.json` (`{}` when there is no file). */
  runs(): Record<string, FlowRun>;
  /** Replace `flow-state.json` with raw text. */
  writeRuns(value: Record<string, FlowRun> | string): void;
  /** Whether `flow-state.json` exists. */
  hasRunStore(): boolean;
}

/** Create a temp git project on branch `work` with a minimal fake-tracker config. */
export function makeProject(): WriteProject {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-write-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'work');
  git(
    '-c',
    'user.email=t@example.test',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  );
  const store = path.join(dir, '.dork', 'flow', 'flow-state.json');
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const project: WriteProject = {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    config: (value) =>
      write(path.join(dir, '.agents', 'flow', 'config.json'), JSON.stringify(value, null, 2)),
    pause: () =>
      write(
        path.join(dir, '.agents', 'flow', 'paused.json'),
        JSON.stringify({ pausedAt: '2026-09-26T00:00:00.000Z' })
      ),
    runs: () =>
      existsSync(store) ? (JSON.parse(readFileSync(store, 'utf8')) as Record<string, FlowRun>) : {},
    writeRuns: (value) =>
      write(store, typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    hasRunStore: () => existsSync(store),
  };
  project.config({ tracker: 'fake', identity: { agent: 'agent-1' } });
  return project;
}

/** A minimal open work item: ready, unassigned, at `stage/execute`. */
export function item(identifier: string, overrides: Partial<WorkItem> = {}): WorkItem {
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
    labels: ['type/task', 'agent/ready', 'stage/execute'],
    agentDisposition: 'ready',
    ...overrides,
  };
}

/** A string sink that records every write. */
function sink() {
  let buffer = '';
  return {
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    text: () => buffer,
  };
}

/** What one run of the CLI produced. */
export interface RunResult {
  /** The exit code. */
  code: number;
  /** stdout. */
  stdout: string;
  /** stderr. */
  stderr: string;
  /** stdout parsed as JSON (runs are made with `--json`). */
  json: Record<string, unknown>;
  /** The fake tracker, with its recorded calls and live backlog. */
  tracker: FakeTracker;
}

/** Options for {@link runFlow}. */
export interface RunOptions {
  /** Environment variables. Default: a session id and a Claude Code harness. */
  env?: Record<string, string | undefined>;
  /** Replaces the process runner (default: fake `ps`, real `git`). */
  runProcess?: ProcessRunner;
}

/** The default runner: `ps` answers {@link FAKE_PPID}; everything else runs for real. */
export const defaultRunner: ProcessRunner = async (cmd, args, opts) => {
  if (cmd === 'ps') return { code: 0, stdout: `  ${FAKE_PPID}\n`, stderr: '' };
  return realProcessRunner(cmd, args, opts);
};

/**
 * Run `flow <argv> --json` against a project and a fake tracker.
 *
 * @param project - The temp project (its folder is the cwd).
 * @param backlog - The fake tracker's state, or an already-built tracker.
 * @param argv - The arguments.
 * @param options - Env and process-runner overrides.
 * @returns The exit code, output, parsed JSON and the tracker.
 */
export async function runFlow(
  project: WriteProject,
  backlog: FakeBacklog | FakeTracker,
  argv: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const tracker = 'adapter' in backlog ? backlog : createFakeAdapter(backlog);
  const stdout = sink();
  const stderr = sink();
  const deps: MainDeps = {
    env: options.env ?? {
      FLOW_SESSION_ID: 'session-abc',
      CLAUDECODE: '1',
      CLAUDE_CONFIG_DIR: '/home/someone/.claude-work',
    },
    cwd: project.dir,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    stdout,
    stderr,
    createAdapter: async () => tracker.adapter,
    runProcess: options.runProcess ?? defaultRunner,
  };
  const code = await main([...argv, '--json'], deps);
  return {
    code,
    stdout: stdout.text(),
    stderr: stderr.text(),
    json: JSON.parse(stdout.text()) as Record<string, unknown>,
    tracker,
  };
}
