/**
 * The tracker seam (spec `flow-cli-core` §4, task 2.1): how the flow CLI finds
 * an adapter's code, which transport it hands it, what it refuses, and how it
 * confirms a write landed.
 *
 * The loader cases run against real temporary projects and plugin folders,
 * because the loader resolves the same files `config-files.ts` does. The
 * adapter they load is the file-based fake in `fixtures/cli/fake-adapter/`,
 * linked into place so its own relative imports still resolve.
 *
 * @see specs/flow-cli-core/02-specification.md §4
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerbDefinition } from '../../scripts/cli/context.ts';
import { realProcessRunner } from '../../scripts/cli/context.ts';
import type { ConfigRoots } from '../../scripts/config-files.ts';
import { loadConfig } from '../../scripts/config-load.ts';
import { ConfigError, EXIT, TrackerError } from '../../scripts/errors.ts';
import { main } from '../../scripts/flow.ts';
import { createExternalCliTransport } from '../../scripts/tracker/external-cli.ts';
import {
  createCodeAdapter,
  loadCodeAdapter,
  requireCapabilities,
} from '../../scripts/tracker/load.ts';
import type { WorkItem } from '../../scripts/tracker/types.ts';
import { verifyWrite, writeDisagreements } from '../../scripts/tracker/verify-write.ts';
import { labelsAfterChange } from '../../scripts/work-state.ts';
import {
  createFakeAdapter,
  FAKE_BACKLOG_ENV,
  type FakeBacklog,
} from '../fixtures/cli/fake-adapter/adapter.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ADAPTER_DIR = path.resolve(here, '..', 'fixtures', 'cli', 'fake-adapter');

let base: string;
let project: string;
let plugin: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-tracker-seam-')));
  project = path.join(base, 'project');
  plugin = path.join(base, 'plugin');
  mkdirSync(project, { recursive: true });
  mkdirSync(plugin, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

function roots(): ConfigRoots {
  return { checkout: project, mainCheckout: null, inGit: true, pluginRoot: plugin };
}

function write(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function writeConfig(value: Record<string, unknown>): void {
  write(path.join(project, '.agents/flow/config.json'), value);
}

/** Link the fake adapter's folder to `target`, as a project or shipped adapter. */
function linkFakeAdapter(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  symlinkSync(FAKE_ADAPTER_DIR, target, 'dir');
}

/** A project adapter folder holding only a SKILL.md (a prose-only adapter). */
function proseOnlyAdapter(tracker: string): void {
  write(path.join(project, '.agents/flow/adapters', tracker, 'SKILL.md'), '# prose only\n');
}

async function load(transport?: Parameters<typeof loadCodeAdapter>[0]['transport']) {
  const warnings: string[] = [];
  const adapter = await loadCodeAdapter({
    roots: roots(),
    loaded: loadConfig(roots(), {}),
    warn: (message) => warnings.push(message),
    transport,
  });
  return { adapter, warnings };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** A minimal open work item for the fake backlog. */
function item(identifier: string, overrides: Partial<WorkItem> = {}): WorkItem {
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

describe('finding the adapter code', () => {
  it('loads a project adapter from beside its SKILL.md', async () => {
    // Purpose: the project folder `.agents/flow/adapters/<tracker>/` is where a
    // generated adapter lives, so the loader must find adapter.ts there.
    writeConfig({ tracker: 'fake' });
    linkFakeAdapter(path.join(project, '.agents/flow/adapters/fake'));
    const { adapter } = await load();
    expect([...adapter.capabilities].sort()).toEqual(
      ['applyWorkState', 'comment', 'getBacklogSnapshot', 'getCurrentUser', 'getItem'].sort()
    );
    expect(await adapter.getCurrentUser()).toEqual({ id: 'agent-1', name: 'Fake agent' });
  });

  it('loads a shipped adapter from the plugin skills folder', async () => {
    // Purpose: a shipped tracker's code sits in <flow-root>/skills/<tracker>-adapter/,
    // and the loader reaches it through the same resolver.
    writeConfig({ tracker: 'linear' });
    linkFakeAdapter(path.join(plugin, 'skills', 'linear-adapter'));
    const { adapter } = await load();
    expect((await adapter.getBacklogSnapshot()).tracker).toBe('fake');
  });

  it('hands the adapter the cli transport by default', async () => {
    // Purpose: connection.transport "cli" is the only transport the CLI builds,
    // and the adapter context carries it.
    writeConfig({ tracker: 'fake' });
    write(path.join(project, '.agents/flow/adapters/fake/SKILL.md'), '# spy adapter\n');
    write(
      path.join(project, '.agents/flow/adapters/fake/adapter.ts'),
      `export const CONTRACT_VERSION = '1.4.0';
export function createAdapter(ctx) {
  return {
    capabilities: ['getCurrentUser'],
    async getCurrentUser() {
      return { id: ctx.transport.kind + ':' + (ctx.secrets.trackerAccount ?? 'none') };
    },
  };
}
`
    );
    write(path.join(project, '.agents/flow/config.local.json'), {
      secrets: { trackerAccount: 'bot' },
    });
    const { adapter } = await load();
    expect(await adapter.getCurrentUser()).toEqual({ id: 'cli:bot' });
  });
});

describe('refusals (exit 3)', () => {
  it('refuses an adapter that has only prose', async () => {
    // Purpose: without adapter.ts the CLI cannot reach the tracker, and the
    // message must say the skill still works, so nobody deletes a good adapter.
    writeConfig({ tracker: 'jira' });
    proseOnlyAdapter('jira');
    const error = await rejection(load());
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).exitCode).toBe(EXIT.config);
    expect((error as Error).message).toBe(
      "the jira adapter has no code; the flow CLI cannot reach the tracker. The skill still works through the adapter's prose"
    );
  });

  it('refuses the mcp transport', async () => {
    // Purpose: an MCP server lives inside an agent session; a child process
    // cannot call it and could not pin the acting identity (Decision D3).
    writeConfig({ tracker: 'fake', connection: { transport: 'mcp' } });
    linkFakeAdapter(path.join(project, '.agents/flow/adapters/fake'));
    const error = await rejection(load());
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      'the mcp transport exists only inside an agent session; set connection.transport to cli to use the flow CLI'
    );
  });

  it('refuses when no adapter exists at all', async () => {
    // Purpose: a tracker with neither a project nor a shipped adapter points at
    // the one fix, /flow:init.
    writeConfig({ tracker: 'jira' });
    const error = await rejection(load());
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/no adapter for the jira tracker; run \/flow:init/);
  });

  it('refuses a module that does not export the contract', async () => {
    // Purpose: CONTRACT_VERSION and createAdapter are the whole module contract;
    // a file missing either is a config problem, not a crash.
    // (Two trackers, because Node caches a module by its path.)
    const adapterCode = (tracker: string, source: string) => {
      writeConfig({ tracker });
      proseOnlyAdapter(tracker);
      write(path.join(project, '.agents/flow/adapters', tracker, 'adapter.ts'), source);
    };
    adapterCode('noversion', 'export function createAdapter() { return { capabilities: [] }; }\n');
    expect(((await rejection(load())) as Error).message).toMatch(/must export CONTRACT_VERSION/);
    adapterCode('nofactory', "export const CONTRACT_VERSION = '1.4.0';\n");
    expect(((await rejection(load())) as Error).message).toMatch(/must export createAdapter/);
  });

  it('refuses a declared capability the adapter does not implement', async () => {
    // Purpose: a capability list that lies would turn a verb's first call into
    // a crash; the loader checks it up front.
    writeConfig({ tracker: 'fake' });
    proseOnlyAdapter('fake');
    write(
      path.join(project, '.agents/flow/adapters/fake/adapter.ts'),
      "export const CONTRACT_VERSION = '1.4.0';\nexport function createAdapter() { return { capabilities: ['getItem'] }; }\n"
    );
    const error = await rejection(load());
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/declares getItem but does not implement it/);
  });

  it('requireCapabilities names the missing capability', () => {
    // Purpose: a verb checks what it needs before it runs, and the refusal
    // names the method so the adapter author knows what to add.
    const { adapter } = createFakeAdapter({ items: [], capabilities: ['getCurrentUser'] });
    expect(() => requireCapabilities(adapter, ['getCurrentUser'])).not.toThrow();
    let error: unknown;
    try {
      requireCapabilities(adapter, ['getCurrentUser', 'applyWorkState']);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/does not support applyWorkState/);
  });
});

describe('tracker failures (exit 4)', () => {
  it('maps a read that throws a plain error to exit 4 through the real factory', async () => {
    // Purpose: a read that cannot reach the tracker must never read as a bug in
    // flow (exit 70) or as an empty result: the CLI exits 4.
    writeConfig({ tracker: 'fake' });
    linkFakeAdapter(path.join(project, '.agents/flow/adapters/fake'));
    const backlogFile = path.join(base, 'backlog.json');
    write(backlogFile, { items: [], failReads: 'connection reset' } satisfies FakeBacklog);
    vi.stubEnv(FAKE_BACKLOG_ENV, backlogFile);

    const probe: VerbDefinition = {
      name: 'probe',
      summary: 'A test-only verb that reads the backlog.',
      common: ['project'],
      load: async () => ({
        run: async (ctx) => {
          const adapter = await ctx.adapter();
          await adapter.getBacklogSnapshot();
          return { json: {}, text: '' };
        },
      }),
    };
    let out = '';
    const code = await main(['probe', '--json', '--project', project], {
      env: {},
      cwd: base,
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      stdout: { write: (chunk: string) => (out += chunk) },
      stderr: { write: () => true },
      createAdapter: (request) => createCodeAdapter({ ...request, flowRoot: plugin }),
      runProcess: realProcessRunner,
      verbs: [probe],
    });
    expect(code).toBe(EXIT.tracker);
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: { code: EXIT.tracker, message: expect.stringMatching(/connection reset/) },
    });
  });

  it('keeps a typed error from the adapter at its own exit code', async () => {
    // Purpose: the guard wraps only untyped throws; an adapter saying "item not
    // found" (exit 5) must not be flattened to exit 4.
    writeConfig({ tracker: 'fake' });
    linkFakeAdapter(path.join(project, '.agents/flow/adapters/fake'));
    const { adapter } = await load();
    const error = await rejection(adapter.getItem('NOPE-1'));
    expect((error as { exitCode?: number }).exitCode).toBe(EXIT.precondition);
  });
});

describe('verifyWrite', () => {
  it('passes when the tracker kept the change', async () => {
    // Purpose: the common path; the re-read agrees and is returned.
    const fake = createFakeAdapter({ items: [item('FAKE-1')] });
    const change = {
      stateCategory: 'started',
      agentLabel: 'agent/claimed',
      stageLabel: null,
    } as const;
    await fake.adapter.applyWorkState(fake.backlog.items[0], change);
    const reread = await verifyWrite(fake.adapter, item('FAKE-1'), change);
    expect(reread.labels).toEqual(['type/task', 'agent/claimed']);
  });

  it('raises a TrackerError when the read-back disagrees', async () => {
    // Purpose: a write the tracker reported as done but did not keep is the one
    // failure the labels cannot recover from, so the CLI must exit 4.
    const fake = createFakeAdapter({ items: [item('FAKE-1')], dropWrites: true });
    const change = {
      stateCategory: 'started',
      agentLabel: 'agent/claimed',
      stageLabel: null,
    } as const;
    await fake.adapter.applyWorkState(fake.backlog.items[0], change);
    const error = await rejection(verifyWrite(fake.adapter, item('FAKE-1'), change));
    expect(error).toBeInstanceOf(TrackerError);
    expect((error as Error).message).toMatch(/state is unstarted, not started/);
    expect((error as Error).message).toMatch(
      /agent\/\* labels are agent\/ready, not agent\/claimed/
    );
    expect((error as Error).message).toMatch(/stage\/\* labels are stage\/execute, not none/);
  });

  it('checks only the families the change names', () => {
    // Purpose: an absent key means "leave it", so an unrelated label or state
    // must never read as a disagreement.
    const current = item('FAKE-1', {
      stateCategory: 'started',
      labels: ['agent/claimed', 'stage/x'],
    });
    expect(writeDisagreements(current, { agentLabel: 'agent/claimed' })).toEqual([]);
    expect(writeDisagreements(current, { stageLabel: null })).toEqual([
      'its stage/* labels are stage/x, not none',
    ]);
  });
});

describe('labelsAfterChange', () => {
  it('replaces only the named families and keeps every other label in order', () => {
    // Purpose: the one "replace the family" rule adapters and verifyWrite share.
    const labels = ['type/task', 'agent/ready', 'stage/execute', 'repo/app', 'agent/claimed'];
    expect(labelsAfterChange(labels, { agentLabel: 'agent/claimed', stageLabel: null })).toEqual([
      'type/task',
      'repo/app',
      'agent/claimed',
    ]);
    expect(labelsAfterChange(labels, { stageLabel: 'stage/verify' })).toEqual([
      'type/task',
      'agent/ready',
      'repo/app',
      'agent/claimed',
      'stage/verify',
    ]);
    expect(labelsAfterChange(labels, {})).toEqual(labels);
  });
});

describe('the cli transport', () => {
  it('resolves a non-zero exit and leaves its meaning to the adapter', async () => {
    // Purpose: a command that ran and failed is the adapter's to interpret
    // (a tracker error message on stdout), not a transport failure.
    const transport = createExternalCliTransport();
    const result = await transport.run(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
    ]);
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('turns a command that cannot start into a TrackerError without its arguments', async () => {
    // Purpose: a missing binary is "cannot reach the tracker" (exit 4), and the
    // message must not echo arguments, which carry the account handle.
    const transport = createExternalCliTransport();
    const error = await rejection(
      transport.run('flow-no-such-binary', ['--account', 'secret-handle'])
    );
    expect(error).toBeInstanceOf(TrackerError);
    expect((error as Error).message).toMatch(/not installed or not on PATH/);
    expect((error as Error).message).not.toContain('secret-handle');
  });

  it('turns a timeout into a TrackerError', async () => {
    // Purpose: a hung tracker CLI must not hang flow; it is stopped and reported.
    const transport = createExternalCliTransport();
    const error = await rejection(
      transport.run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 })
    );
    expect(error).toBeInstanceOf(TrackerError);
    expect((error as Error).message).toMatch(/did not finish within/);
  });

  it('runs with no shell, so an argument cannot inject a command', async () => {
    // Purpose: titles and bodies reach the tracker CLI as arguments; a shell
    // would let one run a command.
    const transport = createExternalCliTransport();
    const marker = path.join(base, 'injected');
    const result = await transport.run(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      `$(touch ${marker}); touch ${marker}`,
    ]);
    expect(result.stdout).toBe(`$(touch ${marker}); touch ${marker}`);
    expect(() => readFileSync(marker)).toThrow();
  });
});
