/**
 * `flow create` (DOR-2433): one new item through the adapter's `createItem`,
 * signed, idempotent with a key, refused before any tracker call when the
 * request is malformed. Against the reference fake tracker, in a throwaway
 * git project configured for it.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keyMarker } from '../../scripts/cli/create.ts';
import { EXIT } from '../../scripts/errors.ts';
import { main } from '../../scripts/flow.ts';
import { FakeTracker, type FakeBacklog } from '../../scripts/tracker/fake.ts';
import type { Capability, WorkItem } from '../../scripts/tracker/types.ts';

const NOW = new Date('2026-09-26T12:00:00.000Z');

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-create-')));
  execFileSync('git', ['init', '-q'], { cwd: project });
  mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
  writeFileSync(
    path.join(project, '.agents', 'flow', 'config.json'),
    JSON.stringify({ tracker: 'fake', identity: { agent: 'user-flow-agent' } })
  );
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

/** An open item already in the tracker. */
function existing(identifier: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    description: '',
    type: 'idea',
    stateCategory: 'backlog',
    stateName: 'Triage',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['type/idea', 'origin/human'],
    ...over,
  };
}

/** A fake whose every call is counted, reads included. */
function tracker(backlog: FakeBacklog = { items: [] }) {
  const fake = new FakeTracker(backlog, { now: () => NOW });
  const calls: string[] = [];
  const counted = new Proxy(fake.adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fake, calls, adapter: counted };
}

/** Run `flow <argv> --json` in the project. */
async function flow(argv: string[], t: ReturnType<typeof tracker>, json = true) {
  let out = '';
  let err = '';
  const code = await main(json ? [...argv, '--json'] : argv, {
    env: { FLOW_SESSION_ID: 'session-abc', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/h/.claude-work' },
    cwd: project,
    now: () => NOW,
    stdout: { write: (text: string) => ((out += text), true) },
    stderr: { write: (text: string) => ((err += text), true) },
    createAdapter: async () => t.adapter,
    runProcess: async () => ({ code: 1, stdout: '', stderr: '' }),
  });
  const parsed = json && out.trim().startsWith('{') ? JSON.parse(out) : undefined;
  return { code, out, err, json: parsed as Record<string, unknown> };
}

/** The items the fake holds now that it did not hold before. */
function added(t: ReturnType<typeof tracker>, before: readonly string[]): WorkItem[] {
  return t.fake.backlog.items.filter((i) => !before.includes(i.identifier));
}

const CAPTURE = [
  'create',
  '--title',
  'Export the monthly report as CSV',
  '--description',
  'People want the monthly report as a CSV file.',
  '--label',
  'type/idea',
  '--label',
  'origin/human',
];

describe('flow create', () => {
  it('files one item with the labels, in triage, and prints the v1 JSON shape', async () => {
    // Purpose: the capture write lands as asked, and the output is the stable contract.
    const t = tracker({ items: [existing('FAKE-1')] });
    const run = await flow(CAPTURE, t);
    expect(run.code).toBe(EXIT.ok);
    expect(run.json).toEqual({
      v: 1,
      ok: true,
      created: true,
      identifier: 'FAKE-2',
      url: 'https://fake.tracker/FAKE-2',
    });
    const [item] = added(t, ['FAKE-1']);
    expect(item).toMatchObject({
      title: 'Export the monthly report as CSV',
      labels: ['type/idea', 'origin/human'],
      stateName: 'Triage',
      type: 'idea',
    });
    expect(item.priority).toBeUndefined();
  });

  it('prints one line of text: identifier, title, url', async () => {
    const t = tracker();
    const run = await flow(CAPTURE, t, false);
    expect(run.code).toBe(EXIT.ok);
    expect(run.out).toBe('FAKE-1 Export the monthly report as CSV https://fake.tracker/FAKE-1\n');
  });

  it('signs the description with the identity marker and a provenance line', async () => {
    // Purpose: every flow write is signed, so comment-response rules and
    // provenance routing see the item as the agent's.
    const t = tracker();
    await flow(CAPTURE, t);
    expect(t.fake.backlog.items[0].description).toMatch(
      /^People want the monthly report as a CSV file\.\n\n— 🤖 \/flow\n<!-- agent:provenance \{"v":1,"harness":"claude-code","sessionId":"session-abc","account":"\.claude-work",.*\} -->$/
    );
  });

  it('passes project, parent and priority through', async () => {
    const project_ = { id: 'proj-1', name: 'Reports', stateCategory: 'started' as const };
    const t = tracker({ items: [existing('FAKE-1')], projects: [project_] });
    const run = await flow(
      [...CAPTURE, '--for-project', 'Reports', '--parent', 'FAKE-1', '--priority', '3'],
      t
    );
    expect(run.code).toBe(EXIT.ok);
    const [item] = added(t, ['FAKE-1']);
    expect(item).toMatchObject({ priority: 3, parent: 'FAKE-1', project: { id: 'proj-1' } });
  });

  it('returns the open item a key already filed, and creates nothing', async () => {
    // Purpose: a repeat with the same key (a retried capture) never files twice.
    const t = tracker();
    const first = await flow([...CAPTURE, '--key', 'capture-csv'], t);
    expect(first.json).toMatchObject({ created: true, identifier: 'FAKE-1' });
    expect(t.fake.backlog.items[0].description).toContain(keyMarker('capture-csv'));
    const second = await flow([...CAPTURE, '--key', 'capture-csv'], t);
    expect(second.code).toBe(EXIT.ok);
    expect(second.json).toMatchObject({ created: false, identifier: 'FAKE-1' });
    expect(t.fake.writes.map((w) => w.method)).toEqual(['createItem']);
    expect(t.fake.backlog.items).toHaveLength(1);
  });

  it('finds a keyed item by its marker even when the tracker lost the key', async () => {
    // Purpose: the snapshot check, not only the adapter's key, stops the duplicate.
    const t = tracker({
      items: [existing('FAKE-4', { description: `Earlier.\n\n${keyMarker('k1')}\n\nsig` })],
    });
    const run = await flow([...CAPTURE, '--key', 'k1'], t);
    expect(run.json).toMatchObject({ created: false, identifier: 'FAKE-4' });
    expect(t.calls).not.toContain('createItem');
  });

  it('files again once the keyed item is closed: a key names one open item', async () => {
    const t = tracker();
    await flow([...CAPTURE, '--key', 'k2'], t);
    Object.assign(t.fake.backlog.items[0], { stateCategory: 'completed', stateName: 'Done' });
    const again = await flow([...CAPTURE, '--key', 'k2'], t);
    expect(again.json).toMatchObject({ created: true, identifier: 'FAKE-2' });
  });

  it('reads the description from --description-file', async () => {
    writeFileSync(path.join(project, 'idea.md'), 'From a file.\n');
    const t = tracker();
    const run = await flow(
      ['create', '--title', 'T', '--description-file', 'idea.md', '--label', 'type/idea'],
      t
    );
    expect(run.code).toBe(EXIT.ok);
    expect(t.fake.backlog.items[0].description.startsWith('From a file.\n\n— 🤖 /flow')).toBe(true);
  });

  it.each([
    ['an empty title', ['create', '--title', '  ', '--description', 'd']],
    ['no description', ['create', '--title', 't']],
    [
      'both descriptions',
      ['create', '--title', 't', '--description', 'd', '--description-file', 'f'],
    ],
    ['an agent/* label', [...CAPTURE, '--label', 'agent/ready']],
    ['two labels in one group', [...CAPTURE, '--label', 'type/task']],
    ['a priority above 4', [...CAPTURE, '--priority', '5']],
    ['a priority that is not a number', [...CAPTURE, '--priority', 'high']],
    ['a key that could close its marker', [...CAPTURE, '--key', 'a -->']],
  ])('refuses %s with exit 2 before any tracker call', async (_what, argv) => {
    // Purpose: a malformed request never reaches the tracker, not even as a read.
    const t = tracker({ items: [], failReads: 'the tracker must not be reached' });
    const run = await flow(argv, t);
    expect(run.code).toBe(EXIT.usage);
    expect(t.calls).toEqual([]);
    expect(t.fake.writes).toEqual([]);
  });

  it('writes nothing on --dry-run and prints the planned item', async () => {
    const t = tracker();
    const run = await flow([...CAPTURE, '--dry-run', '--priority', '4'], t);
    expect(run.code).toBe(EXIT.ok);
    expect(run.json).toMatchObject({
      ok: true,
      created: false,
      dryRun: true,
      identifier: null,
      item: {
        title: 'Export the monthly report as CSV',
        labels: ['type/idea', 'origin/human'],
        priority: 4,
      },
    });
    expect(t.calls).not.toContain('createItem');
    expect(t.fake.backlog.items).toEqual([]);
  });

  it('exits 3 naming createItem when the adapter cannot create', async () => {
    const noCreate: Capability[] = [
      'getCurrentUser',
      'getBacklogSnapshot',
      'getItem',
      'applyWorkState',
      'comment',
    ];
    const t = tracker({ items: [], capabilities: noCreate });
    const run = await flow(CAPTURE, t);
    expect(run.code).toBe(EXIT.config);
    expect(JSON.stringify(run.json)).toContain('createItem');
    expect(t.fake.writes).toEqual([]);
  });

  it('exits 4 when the team has no such label, and creates nothing', async () => {
    // Purpose: flow never creates labels; the adapter's refusal comes through.
    const t = tracker();
    const run = await flow([...CAPTURE, '--label', 'area/reports'], t);
    expect(run.code).toBe(EXIT.tracker);
    expect(t.fake.backlog.items).toEqual([]);
  });
});
