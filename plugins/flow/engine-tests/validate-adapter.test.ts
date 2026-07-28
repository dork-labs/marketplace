/**
 * Contract suite for the adapter conformance harness
 * (`plugins/flow/scripts/validate-adapter.ts`, run via `node
 * --experimental-strip-types`, task 3.2). The harness is a hand-rolled,
 * dependency-free script, so this suite spawns it as a real subprocess and
 * asserts its JSON verdict + exit code against the committed reference fixtures.
 *
 * The two keystone cases are the **good** fixture (every invariant passes;
 * `ok:true`, exit 0) and the **bad** fixture (exactly one invariant -- INV-3,
 * a native-id leak in `relations.blockedBy` -- fails; `ok:false`, exit nonzero).
 * Together they prove the harness both passes a conforming adapter and bites a
 * non-conforming one. The interface mirrored here (`--fixture <path>`, the
 * `{ ok, failures: [{ invariant, detail }] }` verdict, the exit-code contract)
 * is the one the building-adapters skill documents; keep them in lockstep.
 *
 * @see .agents/flow/adapters/SPEC.md section 4 (the normative invariants)
 * @see .agents/flow/skills/building-adapters/references/conformance-harness.md
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
// engine-tests -> plugins/flow
const PLUGIN_DIR = path.resolve(here, '..');
// plugins/flow -> scripts/validate-adapter.ts
const SCRIPT = path.resolve(PLUGIN_DIR, 'scripts', 'validate-adapter.ts');
// plugins/flow -> adapters/reference/fixtures
const FIXTURES_DIR = path.resolve(PLUGIN_DIR, 'adapters', 'reference', 'fixtures');
const GOOD_FIXTURE = path.join(FIXTURES_DIR, 'work-items.good.json');
const BAD_FIXTURE = path.join(FIXTURES_DIR, 'work-items.bad.json');

interface Verdict {
  ok: boolean;
  failures: Array<{ invariant: string; detail: string }>;
}

/** Spawn the harness, returning its exit code + captured streams. */
function runHarness(opts: { stdin?: string; args?: readonly string[] } = {}): {
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

describe('validate-adapter', () => {
  describe('good fixture', () => {
    it('passes every invariant (ok:true, exit 0)', () => {
      const { status, stdout } = runHarness({
        args: ['--fixture', GOOD_FIXTURE],
      });
      expect(status).toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.ok).toBe(true);
      expect(verdict.failures).toEqual([]);
    });

    it('reads the same fixture on stdin (ok:true, exit 0)', () => {
      const { status, stdout } = runHarness({
        stdin: readFileSync(GOOD_FIXTURE, 'utf8'),
      });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });
  });

  describe('bad fixture', () => {
    it('fails exactly INV-3 (native-id leak in blockedBy) with ok:false, exit nonzero', () => {
      const { status, stdout } = runHarness({
        args: ['--fixture', BAD_FIXTURE],
      });
      expect(status).not.toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.ok).toBe(false);
      const invariants = verdict.failures.map((f) => f.invariant);
      expect(invariants).toContain('INV-3');
      // The bad fixture is crafted to breach exactly one invariant.
      expect(invariants).toEqual(['INV-3']);
      // The detail names the offending item and the native-id reference.
      const inv3 = verdict.failures.find((f) => f.invariant === 'INV-3');
      expect(inv3?.detail).toContain('DOR-2');
      expect(inv3?.detail).toContain('node_DOR-1');
    });
  });

  describe('the `size` union (numeric estimate or t-shirt string)', () => {
    /** The good fixture with the first item's `size` replaced. */
    function fixtureWithSize(size: unknown): string {
      const items = JSON.parse(readFileSync(GOOD_FIXTURE, 'utf8'));
      const list = Array.isArray(items) ? items : items.items;
      if (size === undefined) delete list[0].size;
      else list[0].size = size;
      return JSON.stringify(Array.isArray(items) ? list : items);
    }

    it('accepts a NUMERIC estimate — the shape a points-based tracker emits', () => {
      const { status, stdout } = runHarness({ stdin: fixtureWithSize(8) });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });

    it('accepts a 0-point estimate (a real, smallest size)', () => {
      const { status, stdout } = runHarness({ stdin: fixtureWithSize(0) });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });

    it('still accepts a t-shirt string', () => {
      const { status, stdout } = runHarness({ stdin: fixtureWithSize('xl') });
      expect(status).toBe(0);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(true);
    });

    it('still rejects NULL — a missing optional must be absent, not null', () => {
      const { status, stdout } = runHarness({ stdin: fixtureWithSize(null) });
      expect(status).not.toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.failures.map((f) => f.invariant)).toContain('INV-2');
    });

    it('rejects a negative estimate — widening the type is not a blanket pass', () => {
      const { status, stdout } = runHarness({ stdin: fixtureWithSize(-3) });
      expect(status).not.toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.failures.map((f) => f.invariant)).toContain('INV-2');
    });

    it('rejects an empty-string estimate', () => {
      const { status, stdout } = runHarness({ stdin: fixtureWithSize('') });
      expect(status).not.toBe(0);
      const verdict = JSON.parse(stdout) as Verdict;
      expect(verdict.failures.map((f) => f.invariant)).toContain('INV-2');
    });
  });

  describe('--help', () => {
    it('prints the contract and exits 0', () => {
      const { status, stdout } = runHarness({ args: ['--help'] });
      expect(status).toBe(0);
      expect(stdout).toContain('INV-1');
      expect(stdout).toContain('INV-5');
      expect(stdout).toContain('--fixture');
    });
  });

  describe('invalid input', () => {
    it('exits 2 on non-JSON input and still emits a JSON verdict', () => {
      const { status, stdout, stderr } = runHarness({
        stdin: 'not json at all',
      });
      expect(status).toBe(2);
      expect((JSON.parse(stdout) as Verdict).ok).toBe(false);
      expect(stderr).toContain('invalid input');
    });
  });
});
