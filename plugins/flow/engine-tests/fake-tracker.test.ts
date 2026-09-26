/**
 * The shipped fake tracker as a project would use it (DOR-2390, spec
 * `specs/flow-self-improvement` §1): its folder linked in as the project's
 * adapter, found by the real loader, reading and writing the JSON file
 * `FLOW_FAKE_BACKLOG` names. Its behavior against the contract is pinned by
 * `code-adapter-contract.test.ts`; this file pins the wiring and the fixture.
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

import type { ConfigRoots } from '../scripts/config-files.ts';
import { loadConfig } from '../scripts/config-load.ts';
import { ConfigError } from '../scripts/errors.ts';
import { FAKE_BACKLOG_ENV, FakeTracker, type FakeBacklog } from '../scripts/tracker/fake.ts';
import { loadCodeAdapter } from '../scripts/tracker/load.ts';
import { validate } from '../scripts/validate-adapter.ts';
import * as fakeModule from '../adapters/reference/fake/adapter.ts';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_DIR = path.join(FLOW_ROOT, 'adapters', 'reference', 'fake');
const FIXTURE = JSON.parse(
  readFileSync(path.join(FAKE_DIR, 'fixture.json'), 'utf8')
) as FakeBacklog;

let base: string;
let project: string;
let backlogFile: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-fake-tracker-')));
  project = path.join(base, 'project');
  mkdirSync(path.join(project, '.agents', 'flow', 'adapters'), { recursive: true });
  writeFileSync(
    path.join(project, '.agents', 'flow', 'config.json'),
    JSON.stringify({ tracker: 'fake' })
  );
  symlinkSync(FAKE_DIR, path.join(project, '.agents', 'flow', 'adapters', 'fake'), 'dir');
  backlogFile = path.join(base, 'backlog.json');
  writeFileSync(backlogFile, JSON.stringify(FIXTURE));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

function roots(): ConfigRoots {
  return { checkout: project, mainCheckout: null, inGit: true, pluginRoot: FLOW_ROOT };
}

async function load() {
  return loadCodeAdapter({
    roots: roots(),
    loaded: loadConfig(roots(), {}),
    warn: () => undefined,
  });
}

describe('the shipped fake tracker', () => {
  it('declares contract 1.4.0 and is what the loader finds for a project linked to it', async () => {
    expect(fakeModule.CONTRACT_VERSION).toBe('1.4.0');
    vi.stubEnv(FAKE_BACKLOG_ENV, backlogFile);
    const adapter = await load();
    const snapshot = await adapter.getBacklogSnapshot();
    expect(snapshot.tracker).toBe('fake');
    expect(snapshot.items.map((item) => item.identifier)).toEqual([
      'FAKE-1',
      'FAKE-2',
      'FAKE-3',
      'FAKE-4',
      'FAKE-5',
    ]);
  });

  it('saves every write to the backlog file, so the next run sees it', async () => {
    vi.stubEnv(FAKE_BACKLOG_ENV, backlogFile);
    const adapter = await load();
    const item = await adapter.getItem('FAKE-2');
    await adapter.applyWorkState(item, {
      stateCategory: 'started',
      agentLabel: 'agent/claimed',
      stageLabel: null,
    });
    const saved = JSON.parse(readFileSync(backlogFile, 'utf8')) as FakeBacklog;
    expect(saved.items.find((i) => i.identifier === 'FAKE-2')).toMatchObject({
      stateCategory: 'started',
      stateName: 'In Progress',
      labels: ['type/task', 'origin/human', 'agent/claimed'],
    });
    const again = await load();
    expect((await again.getItem('FAKE-2')).agentDisposition).toBe('claimed');
  });

  it('refuses to run without a backlog file rather than read as an empty tracker', async () => {
    vi.stubEnv(FAKE_BACKLOG_ENV, '');
    await expect(load()).rejects.toBeInstanceOf(ConfigError);
  });

  it('ships a fixture whose items pass the conformance invariants and cover all five categories', () => {
    expect(validate(FIXTURE.items)).toEqual({ ok: true, failures: [] });
    expect(new Set(FIXTURE.items.map((item) => item.stateCategory))).toEqual(
      new Set(['backlog', 'unstarted', 'started', 'completed', 'canceled'])
    );
  });

  it('uses the clock it is given for comments and snapshots', async () => {
    const tracker = new FakeTracker(structuredClone(FIXTURE), {
      now: () => new Date('2030-01-02T03:04:05.000Z'),
    });
    const item = await tracker.adapter.getItem('FAKE-1');
    await tracker.adapter.comment(item, 'hello');
    const read = await tracker.adapter.getItem('FAKE-1', { comments: 1 });
    expect(read.comments?.[0].createdAt).toBe('2030-01-02T03:04:05.000Z');
    expect((await tracker.adapter.getBacklogSnapshot()).fetchedAt).toBe('2030-01-02T03:04:05.000Z');
  });
});
