/**
 * `flow retro` (DOR-2392, spec `specs/flow-self-improvement` §3): read-only
 * unless `--file`; every run writes its report and one journal line stamped
 * with the runtime; `--file` files through the shared filing module with the
 * retro marker, honours the cap, comments on a second run instead of filing
 * again, and never refiles a completed item on evidence older than its close;
 * a bad `--input` is a usage error. All against the fake tracker, in a
 * throwaway project.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
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
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from '../scripts/flow.ts';
import { proposalFingerprint } from '../scripts/retro.ts';
import { markerFor } from '../scripts/selftest/file.ts';
import { FakeTracker, type FakeBacklog } from '../scripts/tracker/fake.ts';
import type { Capability, WorkItem } from '../scripts/tracker/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'retro');
const NOW = new Date('2026-09-26T12:00:00.000Z');
const CLUSTER_FP = proposalFingerprint('note-cluster', 'skill:flow-usage');
const NO_CREATE: Capability[] = [
  'getCurrentUser',
  'getBacklogSnapshot',
  'getItem',
  'applyWorkState',
  'comment',
];

/** An item the retro filed earlier for the flow-usage note cluster. */
function filedCluster(identifier: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `flow retro: notes about flow-usage (${CLUSTER_FP})`,
    description: `Earlier.\n\n${markerFor(CLUSTER_FP, 'flow-retro')}`,
    type: 'task',
    stateCategory: 'backlog',
    stateName: 'Backlog',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['type/task', 'origin/from-agent'],
    ...over,
  };
}

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-retro-cli-')));
  execFileSync('git', ['init', '-q'], { cwd: project });
  mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
  writeFileSync(
    path.join(project, '.agents', 'flow', 'config.json'),
    JSON.stringify({ tracker: 'fake', selfImprovement: { retro: { maxItemsPerRun: 3 } } })
  );
  mkdirSync(path.join(project, '.dork', 'flow', 'selftest'), { recursive: true });
  copyFileSync(
    path.join(FIXTURES, 'journal.jsonl'),
    path.join(project, '.dork', 'flow', 'journal.jsonl')
  );
  copyFileSync(
    path.join(FIXTURES, 'selftest-history.jsonl'),
    path.join(project, '.dork', 'flow', 'selftest', 'history.jsonl')
  );
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

/** Run `flow <argv>` in the project against `fake`. */
async function flow(argv: string[], fake: FakeTracker) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: { VITEST: 'true', FLOW_RUNTIME: 'codex' },
    cwd: project,
    now: () => NOW,
    stdout: { write: (t: string) => ((out += t), true) },
    stderr: { write: (t: string) => ((err += t), true) },
    createAdapter: async () => fake.adapter,
    runProcess: async () => ({ code: 1, stdout: '', stderr: '' }),
  });
  return { code, out, err, json: out.trim().startsWith('{') ? JSON.parse(out) : undefined };
}

/** The journal's `retro` lines written by this test (the fixture has one from 09-25). */
function retroLines(): Record<string, unknown>[] {
  return readFileSync(path.join(project, '.dork', 'flow', 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('"kind":"retro"'))
    .map((l) => JSON.parse(l))
    .filter((l) => l.ts === NOW.toISOString());
}

describe('flow retro', () => {
  it('is read-only by default, writes its report, and journals the run as its runtime', async () => {
    const fake = new FakeTracker({ items: [] }, { now: () => NOW });
    const run = await flow(['retro', '--json'], fake);
    expect(run.code).toBe(0);
    expect(fake.writes).toEqual([]);
    expect(run.json.inputs).toMatchObject({
      journalLines: 28,
      prevJournalLines: 6,
      snapshot: 'tracker',
    });
    // The empty tracker holds no creation dates, so capture-to-ready has no data here.
    expect(run.json.proposals).toHaveLength(6);
    expect(run.json.filing).toBeUndefined();
    const dir = path.join(project, '.dork', 'flow', 'retro');
    expect(existsSync(path.join(dir, '2026-09-26.json'))).toBe(true);
    const md = readFileSync(path.join(dir, '2026-09-26.md'), 'utf8');
    expect(md).toMatch(
      /\| firstReviewCleanPct \| 33\.33 \| 100 \| 50 \| 0 \| no data \| no data \|/
    );
    expect(md).toMatch(/\| captureToReadyDaysMedian \| no data \|/);
    expect(md).toMatch(/2 agent notes about the flow-usage skill/);
    expect(retroLines()).toEqual([
      expect.objectContaining({
        runtime: 'codex',
        window: '7d',
        proposals: 6,
        filed: 0,
        commented: 0,
      }),
    ]);
  });

  it('files up to the cap with the retro marker, and a second run comments instead of filing', async () => {
    const fake = new FakeTracker({ items: [] }, { now: () => NOW });
    const first = await flow(['retro', '--file', '--json'], fake);
    expect(first.code).toBe(0);
    const { filing } = first.json;
    expect(filing.filed).toHaveLength(3);
    expect(filing.notFiledCap).toHaveLength(3);
    // Most evidence first: the cluster, the repeated error, then the first regression.
    expect(filing.filed.map((f: { subject: string }) => f.subject)).toEqual([
      '2 agent notes about the flow-usage skill',
      'flow.ts next failed 2 times with the same error',
      'self-test check config passed before and fails now',
    ]);
    const created = fake.backlog.items.filter((i) => i.description.includes('flow-retro:fp='));
    expect(created).toHaveLength(3);
    for (const i of created) {
      expect(i.labels).toEqual(expect.arrayContaining(['type/task', 'origin/from-agent']));
      expect(i.labels).not.toContain('agent/ready');
    }
    const cluster = created.find((i) =>
      i.description.includes(markerFor(CLUSTER_FP, 'flow-retro'))
    );
    expect(cluster?.title).toBe(
      `flow retro: 2 agent notes about the flow-usage skill (${CLUSTER_FP})`
    );
    expect(retroLines()).toEqual([expect.objectContaining({ filed: 3, commented: 0 })]);

    const second = await flow(['retro', '--file', '--json'], fake);
    expect(second.json.filing.commented.map((c: { identifier: string }) => c.identifier)).toEqual(
      filing.filed.map((f: { identifier: string }) => f.identifier)
    );
    // The three it could not file last time get their turn.
    expect(second.json.filing.filed).toHaveLength(3);
    expect(fake.backlog.items.filter((i) => i.description.includes('flow-retro:fp='))).toHaveLength(
      6
    );
  });

  it('creates with a flow-retro key, and files again once the item is closed and archived', async () => {
    const fake = new FakeTracker({ items: [] }, { now: () => NOW });
    const keys: string[] = [];
    const create = fake.adapter.createItem!;
    fake.adapter.createItem = async (spec) => {
      keys.push(spec.key ?? '');
      return create(spec);
    };
    const first = await flow(['retro', '--file', '--json'], fake);
    const cluster = first.json.filing.filed[0];
    expect(keys[0]).toBe(`flow-retro:${CLUSTER_FP}:none`);

    fake.mergePr({ body: `Closes ${cluster.identifier}` });
    fake.archive(cluster.identifier);
    const again = await flow(['retro', '--file', '--json'], fake);
    const refiled = again.json.filing.filed.find(
      (f: { subject: string }) => f.subject === cluster.subject
    );
    expect(refiled).toBeDefined();
    expect(refiled.identifier).not.toBe(cluster.identifier);
    // Archived out of every snapshot, it is no match, so the key is the same:
    // the tracker still makes a new item rather than returning the closed one.
    expect(keys.filter((k) => k === `flow-retro:${CLUSTER_FP}:none`)).toHaveLength(2);
  });

  it('does not refile a completed item when all the evidence is older than its close', async () => {
    const fake = new FakeTracker(
      {
        items: [filedCluster('FAKE-9', { stateCategory: 'completed', stateName: 'Done' })],
        closedAt: { 'FAKE-9': '2026-09-24T12:00:00.000Z' },
      },
      { now: () => NOW }
    );
    const run = await flow(['retro', '--file', '--json'], fake);
    expect(run.json.filing.notRefiled).toEqual([
      expect.objectContaining({
        identifier: 'FAKE-9',
        reason: 'completed after the newest evidence',
      }),
    ]);
  });

  it('refiles a completed item as a regression when newer evidence arrives', async () => {
    const fake = new FakeTracker(
      {
        items: [filedCluster('FAKE-9', { stateCategory: 'completed', stateName: 'Done' })],
        closedAt: { 'FAKE-9': '2026-09-23T00:00:00.000Z' },
      },
      { now: () => NOW }
    );
    const run = await flow(['retro', '--file', '--json'], fake);
    expect(run.json.filing.filed[0]).toMatchObject({ regressionOf: 'FAKE-9' });
  });

  it('without a create capability lists what it would file, writes no item, and exits 1', async () => {
    const backlog: FakeBacklog = { items: [], capabilities: NO_CREATE };
    const fake = new FakeTracker(backlog, { now: () => NOW });
    const run = await flow(['retro', '--file', '--json'], fake);
    expect(run.code).toBe(1);
    expect(run.json.filing.wouldFile).toHaveLength(3);
    expect(run.json.filing.message).toMatch(/create capability/);
    expect(fake.writes).toEqual([]);
  });

  it('files an edited --input list, and refuses a bad one with exit 2', async () => {
    const fake = new FakeTracker({ items: [] }, { now: () => NOW });
    const report = (await flow(['retro', '--json'], fake)).json;
    const edited = [
      { ...report.proposals[0], title: 'Teach flow-usage to find a default account' },
    ];
    const input = path.join(project, 'edited.json');
    writeFileSync(input, JSON.stringify(edited));
    const run = await flow(['retro', '--file', '--input', input, '--json'], fake);
    expect(run.code).toBe(0);
    expect(run.json.filing.filed).toEqual([
      expect.objectContaining({ subject: 'Teach flow-usage to find a default account' }),
    ]);

    writeFileSync(input, JSON.stringify([{ ...edited[0], fingerprint: 'zz' }]));
    const bad = await flow(['retro', '--file', '--input', input, '--json'], fake);
    expect(bad.code).toBe(2);
    expect(bad.json.error.message).toMatch(/fingerprint must be 12 hex/);
    expect((await flow(['retro', '--input', input], fake)).code).toBe(2);
    expect((await flow(['retro', '--since', '7'], fake)).code).toBe(2);
  });

  it('keeps going with no data when the tracker cannot be reached', async () => {
    const fake = new FakeTracker({ items: [], failReads: 'tracker down' }, { now: () => NOW });
    const run = await flow(['retro', '--json'], fake);
    expect(run.code).toBe(0);
    expect(run.json.measures.readyVsUntriaged.now).toBe('no data');
    expect(run.err).toMatch(/tracker down/);
  });
});
