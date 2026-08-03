/**
 * Contract suite for the backlog-groom invariant oracle
 * (`plugins/flow/scripts/audit-backlog.ts`, run via `node
 * --experimental-strip-types`). The oracle is a hand-rolled, dependency-free
 * script, so this suite spawns it as a real subprocess and asserts its JSON
 * verdict + exit code, exactly like `validate-adapter.test.ts`.
 *
 * The keystone property here is **every check can fail**: for each of the
 * fourteen GRM invariants there is a seeded mutation of the good fixture that
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
  opts?: { agentIdentity?: string };
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
          (s.items[1].labels as string[]).push('Bug');
        },
      },
      {
        invariant: 'GRM-13',
        seed: (s) => {
          (s.items[0].labels as string[]).push('agent/needs-input');
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
      expect(stdout).toContain('GRM-14');
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
