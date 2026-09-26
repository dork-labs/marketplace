/**
 * `flow selftest --file` (DOR-2390, spec `specs/flow-self-improvement` §1,
 * "Report and --file"): each failing check is matched against the tracker by
 * its fingerprint marker before anything is written. An open match gets one
 * comment, a recent cancel is respected, a completed match is refiled only on
 * newer evidence, and since the adapter contract cannot create an item, the
 * rest is listed, never written. Also the `flow selftest` verb's wiring.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signBody, unsignedBody } from '../scripts/cli/provenance.ts';
import { main as flowMain } from '../scripts/flow.ts';
import { main } from '../scripts/selftest.ts';
import {
  CREATE_MISSING,
  WINDOW_DAYS,
  fileFailures,
  markerFor,
  planFiling,
  titleFor,
  type Candidate,
} from '../scripts/selftest/file.ts';
import { fingerprint, type Check } from '../scripts/selftest/report.ts';
import { FakeTracker, type FakeBacklog } from '../scripts/tracker/fake.ts';
import type { WorkItem } from '../scripts/tracker/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-26T12:00:00.000Z');
const META = { evidenceAt: NOW.toISOString(), now: NOW, flowVersion: '9.9.9' };

/** A failing check. */
function failing(id: string, detail = `${id} broke`): Check {
  return { id, tier: 'scenarios', status: 'fail', ms: 1, detail, fingerprint: fingerprint(id, id) };
}

/** An item filed earlier for `check`. */
function filed(identifier: string, check: Check, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: titleFor(check),
    description: `Earlier.\n\n${markerFor(check.fingerprint)}`,
    type: 'task',
    stateCategory: 'backlog',
    stateName: 'Backlog',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['type/task', 'origin/from-agent'],
    ...overrides,
  };
}

/** A candidate as the planner sees it. */
function candidate(identifier: string, check: Check, over: Partial<Candidate> = {}): Candidate {
  return {
    identifier,
    stateCategory: 'backlog',
    description: markerFor(check.fingerprint),
    ...over,
  };
}

describe('planFiling', () => {
  const check = failing('scenarios/lifecycle');
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

  it('files a check nothing matches, with the marker, never agent/ready', () => {
    const [plan] = planFiling([check], [], META);
    expect(plan).toMatchObject({ kind: 'file', title: titleFor(check) });
    if (plan.kind !== 'file') throw new Error('not a file plan');
    expect(plan.body).toContain(markerFor(check.fingerprint));
    expect(plan.body).toContain('flow 9.9.9');
    expect(plan.labels).not.toContain('agent/ready');
  });

  it("files with selfImprovement.retro's labels and project, and never an agent/* label", () => {
    const meta = {
      ...META,
      labels: ['flow/self-test', 'agent/ready', 'type/task'],
      project: 'Flow health',
    };
    expect(planFiling([check], [], meta)[0]).toMatchObject({
      kind: 'file',
      labels: ['type/task', 'origin/from-agent', 'flow/self-test'],
      project: 'Flow health',
    });
    const none = planFiling([check], [], { ...META, project: null })[0];
    expect(none).toMatchObject({ labels: ['type/task', 'origin/from-agent'] });
    expect(none).not.toHaveProperty('project');
  });

  it('comments on an open match instead of filing', () => {
    expect(planFiling([check], [candidate('FAKE-1', check)], META)[0]).toMatchObject({
      kind: 'comment',
      identifier: 'FAKE-1',
    });
  });

  it('respects a cancel inside the window, and refiles after it', () => {
    const recent = candidate('FAKE-1', check, { stateCategory: 'canceled', closedAt: ago(10) });
    expect(planFiling([check], [recent], META)[0]).toMatchObject({ kind: 'declined' });
    const old = { ...recent, closedAt: ago(WINDOW_DAYS + 1) };
    expect(planFiling([check], [old], META)[0]).toMatchObject({ kind: 'file' });
    expect(planFiling([check], [old], META)[0]).not.toHaveProperty('regressionOf');
  });

  it('treats a cancel it cannot date as recent', () => {
    const undated = candidate('FAKE-1', check, { stateCategory: 'canceled' });
    expect(planFiling([check], [undated], META)[0]).toMatchObject({ kind: 'declined' });
  });

  it('refiles a completed match as a regression only on newer evidence', () => {
    const before = candidate('FAKE-1', check, { stateCategory: 'completed', closedAt: ago(3) });
    const plan = planFiling([check], [before], META)[0];
    expect(plan).toMatchObject({ kind: 'file', regressionOf: 'FAKE-1' });
    if (plan.kind !== 'file') throw new Error('not a file plan');
    expect(plan.body).toMatch(/^Regressed after FAKE-1\./);

    const after = { ...before, closedAt: new Date(NOW.getTime() + 1000).toISOString() };
    expect(planFiling([check], [after], META)[0]).toMatchObject({ kind: 'not-refiled' });
    const undated = { ...before, closedAt: undefined };
    expect(planFiling([check], [undated], META)[0]).toMatchObject({
      kind: 'not-refiled',
      reason: expect.stringMatching(/unknown time/),
    });
  });

  it('matches by marker only: another check’s item is no match', () => {
    const other = failing('scenarios/inbox-rules');
    expect(planFiling([check], [candidate('FAKE-1', other)], META)[0]).toMatchObject({
      kind: 'file',
    });
  });
});

describe('fileFailures against the fake tracker', () => {
  const check = failing('scenarios/lifecycle/codex');
  const sign = (body: string) => signBody(body, '— 🤖 /flow', { v: 1, host: 'test-host' });

  function tracker(backlog: FakeBacklog, now = () => NOW): FakeTracker {
    return new FakeTracker(backlog, { now });
  }

  it('writes nothing and lists the item when there is no match: no create verb', async () => {
    const fake = tracker({ items: [] });
    const result = await fileFailures([check], META, {
      adapter: fake.adapter,
      sign,
      unsign: unsignedBody,
    });
    expect(result.message).toBe(CREATE_MISSING);
    expect(result.wouldFile).toEqual([
      expect.objectContaining({ checkId: check.id, title: titleFor(check) }),
    ]);
    expect(fake.writes).toEqual([]);
  });

  it('comments once on an open match, and not again for the same detail', async () => {
    const fake = tracker({ items: [filed('FAKE-1', check)] });
    const deps = { adapter: fake.adapter, sign, unsign: unsignedBody };
    const first = await fileFailures([check], META, deps);
    expect(first.commented).toEqual([{ checkId: check.id, identifier: 'FAKE-1', posted: true }]);
    expect(first.wouldFile).toEqual([]);
    const second = await fileFailures([check], META, deps);
    expect(second.commented).toEqual([{ checkId: check.id, identifier: 'FAKE-1', posted: false }]);
    const comments = fake.backlog.comments?.['FAKE-1'] ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(check.detail);
    expect(comments[0].body).toContain('— 🤖 /flow');

    await fileFailures([{ ...check, detail: 'worse now' }], META, deps);
    expect(fake.backlog.comments?.['FAKE-1']).toHaveLength(2);
  });

  it('does not refile a match a person canceled in the window', async () => {
    const fake = tracker(
      { items: [filed('FAKE-1', check)] },
      () => new Date(NOW.getTime() - 5 * DAY)
    );
    const item = await fake.adapter.getItem('FAKE-1');
    await fake.adapter.applyWorkState(item, { stateCategory: 'canceled' });
    const writes = fake.writes.length;
    const result = await fileFailures([check], META, {
      adapter: fake.adapter,
      sign,
      unsign: unsignedBody,
    });
    expect(result.declined).toEqual([{ checkId: check.id, identifier: 'FAKE-1' }]);
    expect(result.wouldFile).toEqual([]);
    expect(fake.writes).toHaveLength(writes);
  });

  it('refiles a completed match as a regression when it closed before this run', async () => {
    const fake = tracker({ items: [filed('FAKE-1', check)] }, () => new Date(NOW.getTime() - DAY));
    fake.mergePr({ body: 'Closes FAKE-1' });
    const result = await fileFailures([check], META, {
      adapter: fake.adapter,
      sign,
      unsign: unsignedBody,
    });
    expect(result.wouldFile).toEqual([expect.objectContaining({ regressionOf: 'FAKE-1' })]);
    expect(result.message).toBe(CREATE_MISSING);
  });

  it('does not refile a completed match that closed after this run started', async () => {
    const fake = tracker({ items: [filed('FAKE-1', check)] }, () => new Date(NOW.getTime() + DAY));
    fake.mergePr({ body: 'Closes FAKE-1' });
    const result = await fileFailures([check], META, {
      adapter: fake.adapter,
      sign,
      unsign: unsignedBody,
    });
    expect(result.notRefiled).toEqual([
      { checkId: check.id, identifier: 'FAKE-1', reason: 'completed after this run started' },
    ]);
    expect(result.wouldFile).toEqual([]);
  });
});

describe('selftest --file, end to end', () => {
  let project: string;

  beforeEach(() => {
    project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-selftest-file-')));
    execFileSync('git', ['init', '-q'], { cwd: project });
    mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
    writeFileSync(
      path.join(project, '.agents', 'flow', 'config.json'),
      JSON.stringify({
        tracker: 'fake',
        selfImprovement: { retro: { labels: ['flow/self-test'], project: 'Flow health' } },
      })
    );
  });

  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it('comments on the open match, lists the rest, and exits 1 without creating anything', async () => {
    // A tracker planted to keep agent/ready on claim fails both lifecycle
    // scenarios; claude-code's already has an open item, codex's has none.
    const sticky = (
      backlog: FakeBacklog,
      options: ConstructorParameters<typeof FakeTracker>[1]
    ) => {
      const fake = new FakeTracker(backlog, options);
      const inner = fake.adapter.applyWorkState;
      fake.adapter.applyWorkState = async (item, change) => {
        await inner(item, change);
        const stored = fake.backlog.items.find((i) => i.identifier === item.identifier);
        if (change.agentLabel === 'agent/claimed') stored?.labels.push('agent/ready');
      };
      return fake;
    };
    // The scenarios tier keys each fingerprint by the scenario id.
    const claude = {
      ...failing('scenarios/lifecycle/claude-code'),
      fingerprint: fingerprint('scenarios/lifecycle/claude-code', 'lifecycle/claude-code'),
    };
    const projectTracker = new FakeTracker(
      { items: [filed('FAKE-7', claude)] },
      { now: () => NOW }
    );
    let stdout = '';
    const code = await main(['--tier', 'scenarios', '--file', '--json', '--no-save'], {
      env: { VITEST: 'true' },
      cwd: project,
      now: () => NOW,
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => undefined,
      createAdapter: async () => projectTracker.adapter,
      makeTracker: sticky,
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.filing.commented).toEqual([
      { checkId: 'scenarios/lifecycle/claude-code', identifier: 'FAKE-7', posted: true },
    ]);
    // The planted tracker breaks every scenario that claims; only the one with
    // an open item is commented on, the rest would be filed.
    const wouldFile = report.filing.wouldFile.map((w: { checkId: string }) => w.checkId);
    expect(wouldFile).toContain('scenarios/lifecycle/codex');
    expect(wouldFile).not.toContain('scenarios/lifecycle/claude-code');
    for (const item of report.filing.wouldFile) {
      expect(item).toMatchObject({
        labels: ['type/task', 'origin/from-agent', 'flow/self-test'],
        project: 'Flow health',
      });
    }
    expect(report.filing.message).toBe(CREATE_MISSING);
    expect(projectTracker.writes.map((w) => w.method)).toEqual(['comment']);
  });

  it('reports a tracker it cannot reach in the report, and still exits 1', async () => {
    let stdout = '';
    const code = await main(['--tier', 'scenarios', '--file', '--json', '--no-save'], {
      env: { VITEST: 'true' },
      cwd: project,
      now: () => NOW,
      stdout: (t) => {
        stdout += t;
      },
      stderr: () => undefined,
      createAdapter: async () => new FakeTracker({ items: [], failReads: 'tracker down' }).adapter,
      makeTracker: (backlog, options) => new FakeTracker({ ...backlog, dropWrites: true }, options),
    });
    expect(code).toBe(1);
    expect(JSON.parse(stdout).filing.error).toBe('tracker down');
  });
});

describe('the flow selftest verb', () => {
  /** Run `flow <argv>` with recording streams. */
  async function flow(argv: string[]) {
    let out = '';
    const sink = { write: (t: string) => ((out += t), true) };
    const code = await flowMain(argv, {
      env: { VITEST: 'true' },
      cwd: os.tmpdir(),
      now: () => NOW,
      stdout: sink,
      stderr: { write: () => true },
      createAdapter: async () => {
        throw new Error('no tracker in this test');
      },
      runProcess: async () => ({ code: 1, stdout: '', stderr: '' }),
    });
    return { code, out };
  }

  it('runs the same self-test and keeps its exit codes and JSON error shape', async () => {
    const ok = await flow(['selftest', '--tier', 'scenarios', '--no-save', '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ v: 1, ok: true, tiers: ['scenarios'] });

    const bad = await flow(['selftest', '--tier', 'live', '--json']);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.out)).toMatchObject({
      v: 1,
      ok: false,
      error: { code: 2, message: expect.stringMatching(/the live tier is not built yet/) },
    });
  });
});
