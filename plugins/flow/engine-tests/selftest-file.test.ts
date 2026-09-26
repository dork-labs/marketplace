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
  filedLabels,
  markerFor,
  planFiling,
  planFindings,
  type Finding,
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
    const typed = planFiling([check], [], { ...META, labels: ['type/bug', 'flow/self-test'] })[0];
    // type/* is an exclusive group: a configured type never joins type/task.
    expect(typed).toMatchObject({ labels: ['type/task', 'origin/from-agent', 'flow/self-test'] });
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

describe('filing redacts what it copies into the tracker', () => {
  it('removes a home path and a token from the created item and from the comment on it', async () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    const home = `${os.homedir()}/work/private-notes.md`;
    const check: Check = {
      ...failing('doc-lint/words'),
      detail: `${home} grew; the log said ${token}`,
    };
    const fake = new FakeTracker({ items: [] }, { now: () => NOW });
    const sign = (body: string) => signBody(body, '— 🤖 /flow', { v: 1, host: 'test-host' });
    const deps = { adapter: fake.adapter, sign, unsign: unsignedBody };

    const first = await fileFailures([check], META, deps);
    expect(first.filed).toHaveLength(1);
    const created = fake.backlog.items[0];
    expect(created.description).not.toContain(token);
    expect(created.description).not.toContain(os.homedir());
    expect(created.description).toContain('~/work/private-notes.md grew');
    expect(created.description).toContain('[redacted]');
    // The marker survives, so the next run still finds the item.
    expect(created.description).toContain(markerFor(check.fingerprint));

    const second = await fileFailures([{ ...check, detail: `${check.detail} again` }], META, deps);
    expect(second.commented).toEqual([
      { subject: check.id, identifier: created.identifier, posted: true },
    ]);
    const [comment] = fake.backlog.comments?.[created.identifier] ?? [];
    expect(comment.body).not.toContain(token);
    expect(comment.body).not.toContain(os.homedir());
    expect(comment.body).toContain('[redacted]');
  });
});

describe('filing redacts a title', () => {
  it('keeps the fingerprint and drops a token', () => {
    const fp = fingerprint('retro', 'title');
    const [plan] = planFindings(
      [
        {
          subject: 'x',
          fingerprint: fp,
          title: `flow retro: ${os.homedir()} saw ghp_${'a1B2'.repeat(9)} (${fp})`,
          text: 'x',
          evidenceAt: NOW.toISOString(),
        },
      ],
      [],
      { now: NOW, marker: 'flow-retro' }
    );
    expect(plan).toMatchObject({ kind: 'file', title: `flow retro: ~ saw [redacted] (${fp})` });
  });
});

describe('planFindings under a cap', () => {
  it('files the finding with the most evidence first, whatever the input order', () => {
    const finding = (subject: string, weight: number): Finding => ({
      subject,
      fingerprint: fingerprint('retro', subject),
      title: `${subject} (${fingerprint('retro', subject)})`,
      text: subject,
      evidenceAt: NOW.toISOString(),
      weight,
    });
    const plans = planFindings([finding('light', 1), finding('heavy', 2)], [], {
      now: NOW,
      marker: 'flow-retro',
      maxNew: 1,
    });
    expect(plans.map((p) => [p.subject, p.kind])).toEqual([
      ['light', 'cap'],
      ['heavy', 'file'],
    ]);
  });
});

describe('fileFailures against the fake tracker', () => {
  const check = failing('scenarios/lifecycle/codex');
  const sign = (body: string) => signBody(body, '— 🤖 /flow', { v: 1, host: 'test-host' });

  function tracker(backlog: FakeBacklog, now = () => NOW): FakeTracker {
    return new FakeTracker(backlog, { now });
  }

  it('writes nothing and lists the item when the adapter cannot create', async () => {
    const fake = tracker({
      items: [],
      capabilities: [
        'getCurrentUser',
        'getBacklogSnapshot',
        'getItem',
        'applyWorkState',
        'comment',
      ],
    });
    const result = await fileFailures([check], META, {
      adapter: fake.adapter,
      sign,
      unsign: unsignedBody,
    });
    expect(result.message).toBe(CREATE_MISSING);
    expect(result.wouldFile).toEqual([
      expect.objectContaining({ subject: check.id, title: titleFor(check) }),
    ]);
    expect(fake.writes).toEqual([]);
  });

  it('keeps one label per group: extras in a group already filled, or agent/*, are dropped', () => {
    expect(
      filedLabels([
        'origin/human',
        'type/bug',
        'agent/ready',
        'flow/self-test',
        'flow/other',
        'Bug',
      ])
    ).toEqual(['type/task', 'origin/from-agent', 'flow/self-test', 'Bug']);
  });

  it('keeps what it already did when a create fails partway, and reports the error', async () => {
    const other = failing('scenarios/inbox-rules');
    const fake = tracker({ items: [] });
    const inner = fake.adapter.createItem;
    let calls = 0;
    fake.adapter.createItem = async (spec) => {
      calls += 1;
      if (calls === 2) throw new Error('tracker went away');
      return (await inner?.(spec)) as never;
    };
    const result = await fileFailures([check, other], META, {
      adapter: fake.adapter,
      sign,
      unsign: unsignedBody,
    });
    expect(result.filed).toHaveLength(1);
    expect(result.error).toBe('tracker went away');
  });

  it('passes the failure fingerprint as the create key, so a repeat create makes no second item', async () => {
    const fake = tracker({ items: [] });
    const seen: (string | undefined)[] = [];
    const inner = fake.adapter.createItem;
    fake.adapter.createItem = async (spec) => {
      seen.push(spec.key);
      return (await inner?.(spec)) as never;
    };
    await fileFailures([check], META, { adapter: fake.adapter, sign, unsign: unsignedBody });
    expect(seen).toEqual([`flow-selftest:${check.fingerprint}:none`]);
  });

  it('files a failure again once its old item closed long ago: the key changes with what was filed', async () => {
    // A key that stayed the same forever would return the old, closed item as
    // "filed" and never file the failure again.
    let clock = new Date('2026-01-01T12:00:00.000Z');
    const fake = new FakeTracker({ items: [] }, { now: () => clock });
    const deps = { adapter: fake.adapter, sign, unsign: unsignedBody };
    const first = await fileFailures(
      [check],
      { ...META, evidenceAt: clock.toISOString(), now: clock },
      deps
    );
    expect(first.filed.map((f) => f.identifier)).toEqual(['FAKE-1']);
    clock = new Date('2026-01-02T12:00:00.000Z');
    fake.mergePr({ body: 'Closes FAKE-1' });

    clock = new Date('2026-06-01T12:00:00.000Z');
    const later = await fileFailures(
      [check],
      { ...META, evidenceAt: clock.toISOString(), now: clock },
      deps
    );
    expect(later.filed.map((f) => f.identifier)).toEqual(['FAKE-2']);
    expect(fake.backlog.items.map((i) => i.identifier)).toEqual(['FAKE-1', 'FAKE-2']);
  });

  it('files a failure again even when its old item was archived out of every snapshot', async () => {
    // The snapshot no longer shows the archived item, so the caller's key is the
    // same as the first time: the adapter must still make a new item.
    const fake = new FakeTracker({ items: [] }, { now: () => NOW });
    const deps = { adapter: fake.adapter, sign, unsign: unsignedBody };
    const first = await fileFailures([check], META, deps);
    fake.mergePr({ body: `Closes ${first.filed[0].identifier}` });
    fake.archive(first.filed[0].identifier);
    const later = {
      ...META,
      evidenceAt: new Date(NOW.getTime() + 200 * DAY).toISOString(),
      now: new Date(NOW.getTime() + 200 * DAY),
    };
    const again = await fileFailures([check], later, deps);
    expect(again.filed.map((f) => f.identifier)).toEqual(['FAKE-2']);
  });

  it('creates the item after dedupe when the adapter can, and only comments the next time', async () => {
    const fake = tracker({ items: [] });
    const deps = { adapter: fake.adapter, sign, unsign: unsignedBody };
    const first = await fileFailures([check], META, deps);
    expect(first.wouldFile).toEqual([]);
    expect(first.message).toBeUndefined();
    expect(first.filed).toEqual([
      { subject: check.id, identifier: 'FAKE-1', url: 'https://fake.tracker/FAKE-1' },
    ]);
    const created = fake.backlog.items[0];
    expect(created).toMatchObject({
      title: titleFor(check),
      stateName: 'Triage',
      labels: ['type/task', 'origin/from-agent'],
    });
    expect(created.description).toContain(markerFor(check.fingerprint));
    expect(created.description).toContain('— 🤖 /flow');
    expect(created.labels).not.toContain('agent/ready');

    // The same failure again finds the item by its fingerprint: a comment, no second item.
    const second = await fileFailures([check], META, deps);
    expect(second.filed).toEqual([]);
    expect(second.commented).toEqual([{ subject: check.id, identifier: 'FAKE-1', posted: true }]);
    expect(fake.backlog.items).toHaveLength(1);
  });

  it('comments once on an open match, and not again for the same detail', async () => {
    const fake = tracker({ items: [filed('FAKE-1', check)] });
    const deps = { adapter: fake.adapter, sign, unsign: unsignedBody };
    const first = await fileFailures([check], META, deps);
    expect(first.commented).toEqual([{ subject: check.id, identifier: 'FAKE-1', posted: true }]);
    expect(first.wouldFile).toEqual([]);
    const second = await fileFailures([check], META, deps);
    expect(second.commented).toEqual([{ subject: check.id, identifier: 'FAKE-1', posted: false }]);
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
    expect(result.declined).toEqual([{ subject: check.id, identifier: 'FAKE-1' }]);
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
    expect(result.filed).toEqual([
      expect.objectContaining({ subject: check.id, identifier: 'FAKE-2', regressionOf: 'FAKE-1' }),
    ]);
    expect(fake.backlog.items[1].description).toMatch(/^Regressed after FAKE-1\./);
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
      { subject: check.id, identifier: 'FAKE-1', reason: 'completed after the newest evidence' },
    ]);
    expect(result.wouldFile).toEqual([]);
  });
});

/** The scenarios tier runs real git and the real verbs; 5 s is too tight on a cold, loaded run. */
const SCENARIOS_TIMEOUT = 30_000;

describe('selftest --file, end to end', { timeout: SCENARIOS_TIMEOUT }, () => {
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

  it('comments on the open match, creates the rest after dedupe, and exits 1', async () => {
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
      {
        items: [filed('FAKE-7', claude)],
        labels: ['flow/self-test'],
        projects: [{ id: 'proj-health', name: 'Flow health' }],
      },
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
      { subject: 'scenarios/lifecycle/claude-code', identifier: 'FAKE-7', posted: true },
    ]);
    // The planted tracker breaks every scenario that claims; only the one with
    // an open item is commented on, the rest are created.
    expect(report.filing.wouldFile).toEqual([]);
    const filedIds = report.filing.filed.map((f: { subject: string }) => f.subject);
    expect(filedIds).toContain('scenarios/lifecycle/codex');
    expect(filedIds).not.toContain('scenarios/lifecycle/claude-code');
    const created = projectTracker.backlog.items.filter((item) => item.identifier !== 'FAKE-7');
    expect(created).toHaveLength(filedIds.length);
    for (const item of created) {
      expect(item.labels).toEqual(['type/task', 'origin/from-agent', 'flow/self-test']);
      expect(item.project?.name).toBe('Flow health');
    }
    const methods = projectTracker.writes.map((w) => w.method);
    expect(methods[0]).toBe('comment');
    expect(methods.slice(1).every((m) => m === 'createItem')).toBe(true);
  });

  it('lists what it would file, and creates nothing, when the adapter cannot create', async () => {
    const projectTracker = new FakeTracker(
      {
        items: [],
        capabilities: [
          'getCurrentUser',
          'getBacklogSnapshot',
          'getItem',
          'applyWorkState',
          'comment',
        ],
      },
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
      makeTracker: (backlog, options) => {
        const fake = new FakeTracker(backlog, options);
        const inner = fake.adapter.applyWorkState;
        fake.adapter.applyWorkState = async (item, change) => {
          await inner(item, change);
          const stored = fake.backlog.items.find((i) => i.identifier === item.identifier);
          if (change.agentLabel === 'agent/claimed') stored?.labels.push('agent/ready');
        };
        return fake;
      },
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.filing.filed).toEqual([]);
    expect(report.filing.wouldFile.length).toBeGreaterThan(0);
    expect(report.filing.message).toBe(CREATE_MISSING);
    expect(projectTracker.writes).toEqual([]);
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

describe('the flow selftest verb', { timeout: SCENARIOS_TIMEOUT }, () => {
  let project: string;

  beforeEach(() => {
    project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-selftest-verb-')));
    execFileSync('git', ['init', '-q'], { cwd: project });
  });

  afterEach(() => rmSync(project, { recursive: true, force: true }));

  /** Run `flow <argv>` with recording streams. */
  async function flow(argv: string[]) {
    let out = '';
    const sink = { write: (t: string) => ((out += t), true) };
    const code = await flowMain(argv, {
      env: { VITEST: 'true' },
      cwd: project,
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

    // The live tier's gate refuses without FLOW_SELFTEST_LIVE=1, as a usage error.
    const bad = await flow(['selftest', '--tier', 'live', '--json']);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.out)).toMatchObject({
      v: 1,
      ok: false,
      error: { code: 2, message: expect.stringMatching(/set FLOW_SELFTEST_LIVE=1/) },
    });
  });
});
