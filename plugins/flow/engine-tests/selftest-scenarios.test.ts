/**
 * The self-test's `scenarios` tier (DOR-2390, spec `specs/flow-self-improvement`
 * §1): every scenario passes against the fake tracker, and each one fails when
 * the tracker is planted with the break that scenario exists to catch. A
 * scenario that passes a broken tracker would be checking nothing.
 */

import { describe, expect, it } from 'vitest';

import { FLOW_ROOT } from '../scripts/selftest.ts';
import { runScenarios } from '../scripts/selftest/scenarios.ts';
import { SCENARIOS } from '../scripts/selftest/scenarios/index.ts';
import { FakeTracker, type FakeBacklog, type FakeTrackerOptions } from '../scripts/tracker/fake.ts';
import type { CodeAdapter } from '../scripts/tracker/types.ts';

/** A fake whose adapter methods are replaced by `patch(original)`. */
function patched(patch: (inner: CodeAdapter, tracker: FakeTracker) => Partial<CodeAdapter>) {
  return (backlog: FakeBacklog, options: FakeTrackerOptions): FakeTracker => {
    const tracker = new FakeTracker(backlog, options);
    const inner = { ...tracker.adapter };
    Object.assign(tracker.adapter, patch(inner, tracker));
    return tracker;
  };
}

/** Run one scenario by id and return its check. */
async function runOne(id: string, makeTracker?: ReturnType<typeof patched>) {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) throw new Error(`no scenario ${id}`);
  const [check] = await runScenarios({ flowRoot: FLOW_ROOT, makeTracker, scenarios: [scenario] });
  return check;
}

describe('the scenarios tier', () => {
  it('runs every scenario as a passing check', async () => {
    // Purpose: the tier is the CI gate for the verbs' behavior against a
    // tracker; every scenario must pass on the shipped code. (It takes about
    // 1 s alone; no timing assertion, which would flake on a loaded runner.)
    const checks = await runScenarios({ flowRoot: FLOW_ROOT });
    expect(checks.map((c) => [c.id, c.status, c.detail])).toEqual(
      SCENARIOS.map((s) => [`scenarios/${s.id}`, 'pass', ''])
    );
    expect(
      checks.every((c) => c.tier === 'scenarios' && /^[0-9a-f]{12}$/.test(c.fingerprint))
    ).toBe(true);
  });

  it('lifecycle fails on a tracker that keeps agent/ready on claim', async () => {
    // Purpose: a claim must take the item out of the ready queue; a tracker
    // that leaves agent/ready would let two agents claim it.
    const sticky = patched((inner, tracker) => ({
      applyWorkState: async (item, change) => {
        await inner.applyWorkState(item, change);
        const stored = tracker.backlog.items.find((i) => i.identifier === item.identifier);
        if (
          change.agentLabel === 'agent/claimed' &&
          stored &&
          !stored.labels.includes('agent/ready')
        ) {
          stored.labels.push('agent/ready');
        }
      },
    }));
    for (const id of ['lifecycle/claude-code', 'lifecycle/codex']) {
      const check = await runOne(id, sticky);
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/flow claim FAKE-1 .*exited 4/);
    }
  });

  it('groom-audit fails on a tracker that drops blocking relations from its snapshot', async () => {
    // Purpose: GRM-7 (a ready item blocked by an open one) is only visible if
    // the snapshot carries relations; the scenario must notice it went quiet.
    const check = await runOne(
      'groom-audit',
      patched((inner) => ({
        getBacklogSnapshot: async (opts) => {
          const snapshot = await inner.getBacklogSnapshot(opts);
          for (const item of snapshot.items) item.relations.blockedBy = [];
          return snapshot;
        },
      }))
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(
      'flow audit on backlog.bad.json fails: expected ["GRM-7"], got []'
    );
  });

  it('recovery-ladder fails on a tracker that loses agent/needs-input on read', async () => {
    // Purpose: a parked item must never be reclaimed; a tracker that hides the
    // park would let the ladder treat it as a plain in-flight item.
    const check = await runOne(
      'recovery-ladder',
      patched((inner) => ({
        getItem: async (identifier, opts) => {
          const item = await inner.getItem(identifier, opts);
          item.labels = item.labels.filter((label) => label !== 'agent/needs-input');
          return item;
        },
      }))
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/a parked item on the next tick: expected .*parked-on-human/);
  });

  it("inbox-rules fails on a tracker that reports every comment as the agent's own", async () => {
    // Purpose: rule 1 (never answer yourself) must rest on the real author; a
    // tracker that misattributes authors silences every person.
    const check = await runOne(
      'inbox-rules',
      patched((inner, tracker) => ({
        getItem: async (identifier, opts) => {
          const item = await inner.getItem(identifier, opts);
          for (const comment of item.comments ?? []) comment.author = tracker.user.id;
          return item;
        },
      }))
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(
      /inbox rule for "shared account, marker in body"|inbox rule for "@mention/
    );
  });

  it('reports a scenario that throws a plain error as the scenario itself breaking', async () => {
    // Purpose: a crash in the harness must not read like a behavior finding.
    const [check] = await runScenarios({
      flowRoot: FLOW_ROOT,
      scenarios: [{ id: 'boom', run: async () => Promise.reject(new Error('kaboom')) }],
    });
    expect(check).toMatchObject({
      id: 'scenarios/boom',
      status: 'fail',
      detail: 'the scenario itself broke: kaboom',
    });
  });
});
