/**
 * Contract suite for the backlog-groom invariant oracle
 * (`plugins/flow/scripts/audit-backlog.ts`, run via `node
 * --experimental-strip-types`). The oracle is a hand-rolled, dependency-free
 * script, so this suite spawns it as a real subprocess and asserts its JSON
 * verdict + exit code, exactly like `validate-adapter.test.ts`.
 *
 * The keystone property here is **every check can fail**: for each of the
 * eighteen GRM invariants there is a seeded mutation of the good fixture that
 * must turn the verdict red, naming exactly that invariant. This ports the
 * "prove the check can fail" self-test from the 2026-08-03 tracker
 * reorganization into committed tests - a groom verification that cannot go
 * red is not a verification.
 *
 * Two invariants are deliberately coupled and asserted as such: an OPEN READY
 * item inside a dead project trips both GRM-9 (ready in a dead project) and
 * GRM-11 (dead project holds an open item). The table marks the coupling
 * explicitly rather than pretending the checks are independent.
 *
 * @see plugins/flow/skills/grooming-backlog/SKILL.md (the procedure that runs this oracle)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { audit, couldExpiryComment, expiredCoulds } from '../scripts/audit-backlog.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// engine-tests -> plugins/flow
const PLUGIN_DIR = path.resolve(here, '..');
// plugins/flow -> scripts/audit-backlog.ts
const SCRIPT = path.resolve(PLUGIN_DIR, 'scripts', 'audit-backlog.ts');
const FIXTURES_DIR = path.resolve(here, 'fixtures');
const GOOD_FIXTURE = path.join(FIXTURES_DIR, 'backlog.good.json');
const BAD_FIXTURE = path.join(FIXTURES_DIR, 'backlog.bad.json');

interface Verdict {
  ok: boolean;
  failures: Array<{ invariant: string; detail: string }>;
}

interface Snapshot {
  items: Array<Record<string, unknown>>;
  opts?: {
    agentIdentity?: string;
    unnamespacedLabels?: string[];
    now?: string;
    couldExpiryDays?: number;
    pinSetters?: string[];
    projects?: Array<Record<string, unknown>>;
    personLabel?: string;
    startedCap?: number;
  };
}

/** Spawn the oracle, returning its exit code + captured streams. */
function runOracle(opts: { stdin?: string; args?: readonly string[] } = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(
    process.execPath,
    ['--experimental-strip-types', SCRIPT, ...(opts.args ?? [])],
    {
      input: opts.stdin ?? '',
      encoding: 'utf8',
    }
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A deep-cloned parse of the committed good fixture. */
function goodSnapshot(): Snapshot {
  return JSON.parse(readFileSync(GOOD_FIXTURE, 'utf8')) as Snapshot;
}

describe('audit-backlog', () => {
  describe('good fixture', () => {
    it('passes every invariant (ok:true, exit 0)', () => {
      const { status, stdout } = runOracle({ args: ['--fixture', GOOD_FIXTURE] });
      expect(status).toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.ok).toBe(true);
      expect(verdict.failures).toEqual([]);
    });

    it('reads the same snapshot on stdin (ok:true, exit 0)', () => {
      const { status, stdout } = runOracle({ stdin: readFileSync(GOOD_FIXTURE, 'utf8') });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });

    it('accepts a bare WorkItem[] array (no opts wrapper)', () => {
      // The unassigned ready item alone: valid without an agentIdentity.
      const snapshot = goodSnapshot();
      const { status, stdout } = runOracle({ stdin: JSON.stringify([snapshot.items[0]]) });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });
  });

  describe('committed bad fixture (the live-true-positive class)', () => {
    it('fails exactly GRM-7: a ready item blocked by an open sibling', () => {
      const { status, stdout } = runOracle({ args: ['--fixture', BAD_FIXTURE] });
      expect(status).not.toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.ok).toBe(false);
      expect(verdict.failures.map((f) => f.invariant)).toEqual(['GRM-7']);
      const grm7 = verdict.failures[0];
      expect(grm7.detail).toContain('GRM-200');
      expect(grm7.detail).toContain('GRM-201');
    });
  });

  describe('every check can fail (seeded violations)', () => {
    /**
     * One row per invariant: mutate the good snapshot, expect that invariant
     * (and only the listed couplings) to go red. `items[0]` is the unassigned
     * ready task, `items[1]` the parked idea, `items[3]` the terminal duplicate.
     */
    const rows: Array<{
      invariant: string;
      also?: string[];
      seed: (s: Snapshot) => void;
    }> = [
      {
        invariant: 'GRM-1',
        seed: (s) => {
          s.items[0].labels = ['stage/execute', 'agent/ready'];
        },
      },
      {
        invariant: 'GRM-2',
        seed: (s) => {
          delete s.items[0].project;
        },
      },
      {
        invariant: 'GRM-3',
        seed: (s) => {
          s.items[0].priority = 0;
        },
      },
      {
        invariant: 'GRM-4',
        seed: (s) => {
          delete s.items[0].size;
        },
      },
      {
        invariant: 'GRM-5',
        seed: (s) => {
          s.items[0].description = 'Fix the widget.\n\n## On Completion\n\n- Nothing further.';
        },
      },
      {
        invariant: 'GRM-6',
        seed: (s) => {
          s.items[0].description = 'Fix the widget.\n\n## Validation criteria\n\n- It renders.';
        },
      },
      {
        invariant: 'GRM-7',
        seed: (s) => {
          (s.items[0].relations as Record<string, unknown>).blockedBy = ['GRM-101'];
        },
      },
      {
        invariant: 'GRM-8',
        seed: (s) => {
          s.items[0].assignee = 'a-human';
        },
      },
      {
        // An open ready item in a dead project is BOTH a readiness lie (GRM-9)
        // and a stranded open item (GRM-11); the coupling is real, not a bug.
        invariant: 'GRM-9',
        also: ['GRM-11'],
        seed: (s) => {
          (s.items[0].project as Record<string, unknown>).stateCategory = 'completed';
        },
      },
      {
        invariant: 'GRM-10',
        seed: (s) => {
          s.items[0].labels = ['type/task', 'agent/ready'];
        },
      },
      {
        // Seeded on the NON-ready parked idea, so GRM-11 trips alone.
        invariant: 'GRM-11',
        seed: (s) => {
          (s.items[1].project as Record<string, unknown>).stateCategory = 'canceled';
        },
      },
      {
        invariant: 'GRM-12',
        seed: (s) => {
          (s.items[1].labels as string[]).push('Frontend');
        },
      },
      {
        invariant: 'GRM-13',
        seed: (s) => {
          (s.items[0].labels as string[]).push('agent/needs-input');
        },
      },
      {
        // A pin with no "pin:" comment behind it.
        invariant: 'GRM-17',
        seed: (s) => {
          (s.items[1].labels as string[]).push('pin');
          s.opts = { ...s.opts, unnamespacedLabels: ['pin'] };
        },
      },
      {
        // A pin with its reason, but added by an account outside order.pinSetters.
        invariant: 'GRM-17',
        seed: (s) => {
          (s.items[1].labels as string[]).push('pin');
          s.items[1].pin = { reason: 'ships first', actor: 'someone-else' };
          s.opts = { ...s.opts, unnamespacedLabels: ['pin'], pinSetters: ['the-lead'] };
        },
      },
      {
        // A Started project with no priority (DOR-5067).
        invariant: 'GRM-18',
        seed: (s) => {
          s.opts = {
            ...s.opts,
            projects: [
              {
                id: 'proj-x',
                name: 'Example',
                slugId: 'example',
                statusType: 'started',
                targetDate: '2026-12-31',
                labels: [],
                blockedBy: [],
              },
            ],
          };
        },
      },
      {
        // The parked idea becomes a Could last touched 92 days before opts.now.
        invariant: 'GRM-16',
        seed: (s) => {
          s.items[1].priority = 4;
          s.items[1].updatedAt = '2026-07-01T00:00:00.000Z';
          s.opts = { ...s.opts, now: '2026-10-01T00:00:00.000Z' };
        },
      },
      {
        // Reviving the terminal duplicate makes it a LIVE duplicate.
        invariant: 'GRM-14',
        seed: (s) => {
          s.items[3].stateCategory = 'started';
          s.items[3].stateName = 'In Progress';
        },
      },
    ];

    it('skips only the bare labels listed in opts.unnamespacedLabels (GRM-12)', () => {
      // Purpose: the oracle stays zero-dependency, so the config exemption
      // arrives through opts; a listed bare label passes, an unlisted one fails.
      const snapshot = goodSnapshot();
      (snapshot.items[1].labels as string[]).push('cloud-contract');
      const allowed = {
        ...snapshot,
        opts: { ...snapshot.opts, unnamespacedLabels: ['cloud-contract'] },
      };
      const pass = runOracle({ stdin: JSON.stringify(allowed) });
      expect(pass.status).toBe(0);

      (snapshot.items[1].labels as string[]).push('Frontend');
      const mixed = {
        ...snapshot,
        opts: { ...snapshot.opts, unnamespacedLabels: ['cloud-contract'] },
      };
      const fail = runOracle({ stdin: JSON.stringify(mixed) });
      expect(fail.status).toBe(1);
      const verdict = JSON.parse(fail.stdout) as Verdict;
      expect(verdict.failures.map((f) => f.invariant)).toEqual(['GRM-12']);
      expect(verdict.failures[0].detail).toContain('Frontend');
      expect(verdict.failures[0].detail).not.toContain('cloud-contract');
    });

    it('passes the bare Bug, Improvement and Feature type labels the work order reads (GRM-12, DOR-5069)', () => {
      // Purpose: flow create writes one of them beside type/*, and the work
      // order's type key reads them, so they are not invisible tracker defaults.
      for (const type of ['Bug', 'Improvement', 'Feature']) {
        const snapshot = goodSnapshot();
        (snapshot.items[1].labels as string[]).push(type);
        const run = runOracle({ stdin: JSON.stringify(snapshot) });
        expect(run.status, `${type}: ${run.stdout}`).toBe(0);
      }
      // Case matters: the tracker's own names, nothing that only looks like them.
      const snapshot = goodSnapshot();
      (snapshot.items[1].labels as string[]).push('bug');
      expect(runOracle({ stdin: JSON.stringify(snapshot) }).status).toBe(1);
    });

    it.each([
      ['## Done when', 'Fix the widget.\n\n## Done when\n\n- It renders.'],
      ['## Validation criteria', 'Fix the widget.\n\n## Validation criteria\n\n- It renders.'],
    ])('accepts %s as the validation-criteria section (GRM-5, DOR-5069)', (_what, body) => {
      const snapshot = goodSnapshot();
      snapshot.items[0].description = `${body}\n\n## On Completion\n\n- Nothing further.`;
      const run = runOracle({ stdin: JSON.stringify(snapshot) });
      expect(run.status, run.stdout).toBe(0);
    });

    it('fails GRM-5 on a done-when heading with nothing under it, as readiness does', () => {
      const snapshot = goodSnapshot();
      snapshot.items[0].description =
        'Fix the widget.\n\n## Done when\n\n## On Completion\n\n- Nothing further.';
      const run = runOracle({ stdin: JSON.stringify(snapshot) });
      expect((JSON.parse(run.stdout) as Verdict).failures.map((f) => f.invariant)).toEqual([
        'GRM-5',
      ]);
      // The message names every heading the reader accepts, so a filer knows each one.
      const detail = (JSON.parse(run.stdout) as Verdict).failures[0].detail;
      for (const heading of [
        '## Done when',
        '## Validation criteria',
        '## Acceptance criteria',
        '## Definition of done',
      ]) {
        expect(detail).toContain(heading);
      }
    });

    it('never exempts a malformed label passed on stdin (GRM-12)', () => {
      // Purpose: stdin follows the config's rule (a bare label, no slash, no
      // surrounding space), so a listed "agent/" or " x" exempts nothing.
      const snapshot = goodSnapshot();
      (snapshot.items[1].labels as string[]).push('agent/', ' x');
      const listed = {
        ...snapshot,
        opts: { ...snapshot.opts, unnamespacedLabels: ['agent/', ' x'] },
      };
      const run = runOracle({ stdin: JSON.stringify(listed) });
      expect(run.status).toBe(1);
      const verdict = JSON.parse(run.stdout) as Verdict;
      const grm12 = verdict.failures.find((f) => f.invariant === 'GRM-12');
      expect(grm12?.detail).toContain('agent/');
      expect(grm12?.detail).toContain(' x');
    });

    it.each(rows)('seeding a violation turns $invariant red', ({ invariant, also, seed }) => {
      const snapshot = goodSnapshot();
      seed(snapshot);
      const { status, stdout } = runOracle({ stdin: JSON.stringify(snapshot) });
      expect(status).not.toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.ok).toBe(false);
      const invariants = verdict.failures.map((f) => f.invariant);
      expect(invariants).toContain(invariant);
      // No collateral reds beyond the declared couplings.
      expect(invariants.sort()).toEqual([invariant, ...(also ?? [])].sort());
    });
  });

  describe('GRM-15 reports every state-coherence check (seeded violations)', () => {
    /**
     * One row per STATE-n check (spec flow-cli-core §5), seeded on the good
     * snapshot so GRM-15 is the only invariant that goes red, and its detail
     * names exactly the expected checks. A started ready item necessarily also
     * carries a stage label, so STATE-4 is seeded together with STATE-2.
     */
    const rows: Array<{ check: string; expected: string[]; seed: (s: Snapshot) => void }> = [
      {
        check: 'STATE-1',
        expected: ['STATE-1'],
        seed: (s) => {
          (s.items[1].labels as string[]).push('stage/ideate', 'stage/specify');
        },
      },
      {
        check: 'STATE-2',
        expected: ['STATE-2'],
        seed: (s) => {
          s.items[1].stateCategory = 'started';
          (s.items[1].labels as string[]).push('stage/ideate');
        },
      },
      {
        check: 'STATE-3',
        expected: ['STATE-3'],
        seed: (s) => {
          (s.items[1].labels as string[]).push('agent/claimed');
        },
      },
      {
        check: 'STATE-4',
        expected: ['STATE-2', 'STATE-4'],
        seed: (s) => {
          s.items[0].stateCategory = 'started';
        },
      },
      {
        check: 'STATE-5',
        expected: ['STATE-5'],
        seed: (s) => {
          (s.items[1].labels as string[]).push('agent/completed');
        },
      },
    ];

    it.each(rows)('seeding $check turns GRM-15 red naming it', ({ expected, seed }) => {
      // Purpose: each coherence check reaches the oracle's verdict, alone.
      const snapshot = goodSnapshot();
      seed(snapshot);
      const { status, stdout } = runOracle({ stdin: JSON.stringify(snapshot) });
      expect(status).toBe(1);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.failures.map((f) => f.invariant)).toEqual(['GRM-15']);
      const named = [...verdict.failures[0].detail.matchAll(/STATE-\d/g)].map((m) => m[0]);
      expect(named.sort()).toEqual(expected);
    });
  });

  describe('scope rules', () => {
    it('skips terminal items for every open-item invariant', () => {
      const snapshot = goodSnapshot();
      // A terminal item violating almost everything: no project, priority 0,
      // bare label, two agent labels. None of it may fail - it is closed work.
      snapshot.items.push({
        id: 'uuid-9999',
        identifier: 'GRM-999',
        title: 'Closed long ago, never groomed',
        description: '',
        type: 'task',
        stateCategory: 'completed',
        stateName: 'Done',
        parent: null,
        relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
        labels: ['Bug', 'agent/claimed', 'agent/completed'],
        priority: 0,
      });
      const { status, stdout } = runOracle({ stdin: JSON.stringify(snapshot) });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });

    it('treats a blockedBy reference to a CLOSED item as non-blocking', () => {
      const snapshot = goodSnapshot();
      // items[3] (GRM-103) is canceled; blocking on it must not fail GRM-7.
      (snapshot.items[0].relations as Record<string, unknown>).blockedBy = ['GRM-103'];
      const { status, stdout } = runOracle({ stdin: JSON.stringify(snapshot) });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });

    it('treats an out-of-snapshot blockedBy reference as closed (neutral)', () => {
      const snapshot = goodSnapshot();
      (snapshot.items[0].relations as Record<string, unknown>).blockedBy = ['GRM-424242'];
      const { status, stdout } = runOracle({ stdin: JSON.stringify(snapshot) });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });

    it('does not crash on a non-conformant item (degrades, never throws)', () => {
      const snapshot = goodSnapshot();
      snapshot.items.push({
        identifier: 'GRM-666',
        stateCategory: 'backlog',
        labels: null,
        relations: 'not-an-object',
        priority: '2',
      } as unknown as Record<string, unknown>);
      const { status, stdout } = runOracle({ stdin: JSON.stringify(snapshot) });
      // It FAILS (missing type label, no project, string priority) - but as a
      // verdict, not a crash.
      expect(status).toBe(1);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.ok).toBe(false);
      expect(verdict.failures.map((f) => f.invariant)).toEqual(
        expect.arrayContaining(['GRM-1', 'GRM-2', 'GRM-3'])
      );
    });
  });

  describe('--help', () => {
    it('prints the contract and exits 0', () => {
      const { status, stdout } = runOracle({ args: ['--help'] });
      expect(status).toBe(0);
      expect(stdout).toContain('GRM-1');
      expect(stdout).toContain('GRM-15');
      expect(stdout).toContain('GRM-16');
      expect(stdout).toContain('GRM-17');
      expect(stdout).toContain('GRM-18');
      expect(stdout).toContain('--fixture');
    });
  });

  describe('invalid input', () => {
    it('exits 2 on non-JSON input and still emits a JSON verdict', () => {
      const { status, stdout, stderr } = runOracle({ stdin: 'not json at all' });
      expect(status).toBe(2);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(false);
      expect(stderr).toContain('invalid input');
    });

    it('exits 2 on a snapshot with no items array', () => {
      const { status, stdout } = runOracle({ stdin: '{"opts":{}}' });
      expect(status).toBe(2);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(false);
    });
  });
});

describe('Could expiry (GRM-16, DOR-4546)', () => {
  // Purpose: a waiting Could nobody has touched for groom.couldExpiryDays
  // (default 60) is closed by the groom, and nothing else is.
  const NOW = '2026-11-16T12:00:00.000Z';
  const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
  const item = (identifier: string, over: Record<string, unknown>) => ({
    id: `id-${identifier}`,
    identifier,
    title: `Made-up item ${identifier}`,
    description: '',
    type: 'idea',
    stateCategory: 'backlog',
    stateName: 'Backlog',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['type/idea'],
    project: { id: 'p1', name: 'Maintenance', stateCategory: 'started' },
    ...over,
  });

  it('by default selects a Could untouched 61 days, and not one untouched 59', () => {
    const items = [
      item('ABC-1', { priority: 4, updatedAt: daysAgo(61) }),
      item('ABC-2', { priority: 4, updatedAt: daysAgo(59) }),
    ];
    expect(expiredCoulds(items, NOW)).toEqual([
      { identifier: 'ABC-1', title: 'Made-up item ABC-1', days: 61 },
    ]);
  });

  it('uses a configured number of days: 29 vs 31 at 30', () => {
    const items = [
      item('ABC-3', { priority: 4, updatedAt: daysAgo(31) }),
      item('ABC-4', { priority: 4, updatedAt: daysAgo(29) }),
    ];
    expect(expiredCoulds(items, NOW, 30).map((c) => c.identifier)).toEqual(['ABC-3']);
    const verdict = audit(items, { now: NOW, couldExpiryDays: 30 });
    expect(verdict.failures[0].detail).toContain(couldExpiryComment(30));
  });

  it('reads couldExpiryDays from a stdin snapshot, and ignores a value that is not a positive whole number', () => {
    const items = [item('ABC-5', { priority: 4, updatedAt: daysAgo(40) })];
    const run = (couldExpiryDays: unknown) =>
      runOracle({ stdin: JSON.stringify({ items, opts: { now: NOW, couldExpiryDays } }) });
    expect(run(30).status).toBe(1);
    for (const bad of [0, -5, 1.5, '30']) expect(run(bad).status, String(bad)).toBe(0);
  });

  it('leaves every other priority alone, however old', () => {
    const old = daysAgo(400);
    const items = [1, 2, 3, 0].map((priority) =>
      item(`ABC-${priority + 10}`, { priority, updatedAt: old })
    );
    items.push(item('ABC-20', { updatedAt: old }));
    expect(expiredCoulds(items, NOW)).toEqual([]);
  });

  it('reads the last touch from updatedAt, else createdAt, and never expires an undated or closed item', () => {
    const items = [
      // Created long ago but touched yesterday: not expired.
      item('ABC-30', { priority: 4, createdAt: daysAgo(90), updatedAt: daysAgo(1) }),
      // Never updated since it was filed 75 days ago: expired.
      item('ABC-31', { priority: 4, createdAt: daysAgo(75) }),
      // No date at all: neutral.
      item('ABC-32', { priority: 4 }),
      // Already closed.
      item('ABC-33', { priority: 4, updatedAt: daysAgo(90), stateCategory: 'canceled' }),
    ];
    expect(expiredCoulds(items, NOW).map((c) => c.identifier)).toEqual(['ABC-31']);
  });

  it('leaves a started Could and a claimed Could alone: someone is working on them', () => {
    const old = daysAgo(90);
    const items = [
      item('ABC-50', {
        priority: 4,
        updatedAt: old,
        stateCategory: 'started',
        stateName: 'In Progress',
      }),
      item('ABC-51', {
        priority: 4,
        updatedAt: old,
        stateCategory: 'unstarted',
        labels: ['type/idea', 'agent/claimed'],
      }),
      item('ABC-52', { priority: 4, updatedAt: old, stateCategory: 'unstarted' }),
    ];
    expect(expiredCoulds(items, NOW).map((c) => c.identifier)).toEqual(['ABC-52']);
  });

  it('never expires a Could carrying a never-expire label: security unless set (Security, #183)', () => {
    const old = daysAgo(400);
    const items = [
      item('ABC-60', { priority: 4, updatedAt: old, labels: ['type/signal', 'security'] }),
      item('ABC-61', { priority: 4, updatedAt: old, labels: ['type/signal', 'area/security'] }),
      item('ABC-62', { priority: 4, updatedAt: old, labels: ['type/idea', 'area/legal'] }),
      item('ABC-63', { priority: 4, updatedAt: old }),
    ];
    // The default list: a security label, bare or as a family's leaf, keeps it open.
    expect(expiredCoulds(items, NOW).map((c) => c.identifier)).toEqual(['ABC-62', 'ABC-63']);
    const grm16 = (opts: Parameters<typeof audit>[1]) =>
      audit(items, opts).failures.find((f) => f.invariant === 'GRM-16')?.detail ?? '';
    expect(grm16({ now: NOW })).toContain('ABC-62');
    expect(grm16({ now: NOW })).not.toContain('ABC-60');
    // A custom list replaces the default.
    expect(expiredCoulds(items, NOW, 60, ['area/legal']).map((c) => c.identifier)).toEqual([
      'ABC-60',
      'ABC-61',
      'ABC-63',
    ]);
    expect(grm16({ now: NOW, neverExpireLabels: ['legal'] })).toContain('ABC-60');
    expect(grm16({ now: NOW, neverExpireLabels: ['legal'] })).not.toContain('ABC-62');
    // Matched without case: Security, SECURITY and area/Security all count.
    const cased = [
      item('ABC-65', { priority: 4, updatedAt: old, labels: ['type/signal', 'Security'] }),
      item('ABC-66', { priority: 4, updatedAt: old, labels: ['type/signal', 'Area/SECURITY'] }),
      item('ABC-67', {
        priority: 4,
        updatedAt: old,
        labels: ['type/task', 'needs-security-design'],
      }),
    ];
    expect(expiredCoulds(cased, NOW)).toEqual([]);
    expect(expiredCoulds(cased, NOW, 60, ['SECURITY']).map((c) => c.identifier)).toEqual([
      'ABC-67',
    ]);
    // An empty list expires every old Could, as before the setting existed.
    expect(expiredCoulds(items, NOW, 60, []).map((c) => c.identifier)).toEqual([
      'ABC-60',
      'ABC-61',
      'ABC-62',
      'ABC-63',
    ]);
  });

  it('reads neverExpireLabels from a stdin snapshot', () => {
    const items = [
      item('ABC-64', { priority: 4, updatedAt: daysAgo(90), labels: ['type/idea', 'security'] }),
    ];
    const run = (neverExpireLabels: unknown) =>
      runOracle({
        stdin: JSON.stringify({
          items,
          opts: { now: NOW, neverExpireLabels, unnamespacedLabels: ['security'] },
        }),
      });
    expect(run(undefined).status).toBe(0);
    expect(run([]).status).toBe(1);
    expect(run(['legal']).status).toBe(1);
  });

  it('fails GRM-16 naming the item and the closing comment with the configured days', () => {
    const verdict = audit([item('ABC-40', { priority: 4, updatedAt: daysAgo(61) })], {
      now: NOW,
    });
    expect(verdict.failures.map((f) => f.invariant)).toEqual(['GRM-16']);
    expect(verdict.failures[0].detail).toContain('ABC-40');
    expect(verdict.failures[0].detail).toContain(
      'Closed after 60 days as a Could. Reopen it if it matters.'
    );
  });
});

describe('pins (GRM-17, DOR-5063)', () => {
  const pinned = (pin: Record<string, unknown> | undefined) => ({
    identifier: 'ABC-1',
    title: 'Pinned',
    stateCategory: 'unstarted',
    labels: ['type/task', 'pin'],
    ...(pin === undefined ? {} : { pin }),
  });
  const grm17 = (item: unknown, opts: Parameters<typeof audit>[1] = {}) =>
    audit([item], { unnamespacedLabels: ['pin'], ...opts }).failures.find(
      (f) => f.invariant === 'GRM-17'
    )?.detail;

  it('passes a pin with a reason, whoever set it, when no setters are configured', () => {
    expect(grm17(pinned({ reason: 'ships first', actor: 'anyone' }))).toBeUndefined();
  });

  it('flags a pin with no reason', () => {
    expect(grm17(pinned(undefined))).toBe(
      'ABC-1 is pinned with no reason: add a comment starting "pin:" that says why'
    );
  });

  it('flags a pin set by someone outside order.pinSetters, and passes one set inside it', () => {
    const outside = pinned({ reason: 'ships first', actor: 'someone-else' });
    expect(grm17(outside, { pinSetters: ['the-lead'] })).toBe(
      'ABC-1 was pinned by someone-else, who is not in order.pinSetters'
    );
    expect(
      grm17(pinned({ reason: 'ships first', actor: 'the-lead' }), { pinSetters: ['the-lead'] })
    ).toBeUndefined();
  });
});

describe('project flags (GRM-18, DOR-5067)', () => {
  const project = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id.toUpperCase(),
    slugId: id,
    statusType: 'started',
    priority: 2,
    targetDate: '2026-12-31',
    labels: [],
    blockedBy: [],
    ...extra,
  });
  const grm18 = (projects: unknown[] | undefined, startedCap?: number, personLabel?: string) =>
    audit([], {
      ...(projects === undefined ? {} : { projects }),
      ...(startedCap === undefined ? {} : { startedCap }),
      ...(personLabel === undefined ? {} : { personLabel }),
    }).failures.find((f) => f.invariant === 'GRM-18')?.detail;

  it('passes when no project info was read, or every Started project is in order', () => {
    expect(grm18(undefined)).toBeUndefined();
    expect(grm18([project('a'), project('b')])).toBeUndefined();
  });

  it('reports a Started project with no priority or waiting on another, never one with no target date', () => {
    expect(
      grm18([
        project('a', { priority: undefined }),
        project('b', { targetDate: undefined }),
        project('c', { blockedBy: ['d'] }),
        project('d', { statusType: 'planned' }),
      ])
    ).toBe("Started project C: can't start: waits on D; Started project A: needs a priority");
  });

  it('leaves Planned, Paused and order.personLabel projects out of the report', () => {
    expect(
      grm18(
        [
          project('a', { statusType: 'planned', priority: undefined }),
          project('b', { statusType: 'paused', targetDate: undefined }),
          project('c', { labels: ['owner/someone'], priority: undefined }),
        ],
        undefined,
        'owner/someone'
      )
    ).toBeUndefined();
  });

  it('with no personLabel, a project carrying that label is reported like any other', () => {
    expect(grm18([project('c', { labels: ['owner/someone'], priority: undefined })])).toBe(
      'Started project C: needs a priority'
    );
  });

  it('reports the Started cap, default 6, naming the lowest projects', () => {
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) =>
      project(id, { createdAt: `2026-01-0${i + 1}T00:00:00Z` })
    );
    expect(grm18(seven)).toBe('over cap: 7 Started, cap 6; lowest: G');
    expect(grm18(seven.slice(0, 3), 2)).toBe('over cap: 3 Started, cap 2; lowest: C');
  });

  it('reads projects and startedCap from the snapshot opts on stdin', () => {
    const snapshot = goodSnapshot();
    snapshot.opts = {
      ...snapshot.opts,
      projects: [project('a'), project('b'), project('c', { labels: ['owner/someone'] })],
      startedCap: 1,
      personLabel: 'owner/someone',
    };
    const { status, stdout } = runOracle({ stdin: JSON.stringify(snapshot) });
    expect(status).toBe(1);
    expect((JSON.parse(stdout) as Verdict).failures).toEqual([
      { invariant: 'GRM-18', detail: 'over cap: 2 Started, cap 1; lowest: B' },
    ]);
  });
});
