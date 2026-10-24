/**
 * The arm guard's decision, on the same cases as the repo's arming gate
 * (`scripts/should-arm-automerge.sh`). The cases live in
 * `scripts/fixtures/arm-decisions.json`, two folders above this plugin: every
 * row says what the gate answers (`gate`) and what this guard answers
 * (`guard`). `scripts/test-should-arm-automerge.sh` checks the first column and
 * this file the second, so a change to either rule fails a suite until the row
 * says what the other one does with the same pull request.
 *
 * Each case is the fixture's `green` payload bent by one jq mutation; the test
 * runs `jq` for it, exactly as the bash suite does, so both read the same bytes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_SECURITY_GLOBS,
  decideArm,
  formatDecision,
  type ArmPolicy,
} from '../../scripts/land/arm-decision.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.resolve(here, '../../../../scripts/fixtures/arm-decisions.json');

interface Case {
  name: string;
  mutation: string;
  gate?: unknown;
  guard?: unknown;
}

interface Fixtures {
  green: Record<string, unknown>;
  guardPolicy: { securityGlobs: string[]; securityPattern: string | null; securityLabel: string };
  cases: Case[];
}

/** Whether jq is on PATH. */
function hasJq(): boolean {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The fixtures live in the marketplace repo beside this plugin, and the cases
// need jq. A copy of flow installed on its own (flow:self-test runs this suite
// there) has neither the file nor, maybe, jq, so it skips. CI never skips: in
// CI a missing file or jq fails the suite, so the parity check cannot quietly
// stop running.
const runnable = existsSync(fixturesPath) && hasJq();
if (!runnable && process.env.CI) {
  throw new Error(`arm-decision parity needs ${fixturesPath} and jq in CI`);
}
const fixtures = (
  runnable
    ? JSON.parse(readFileSync(fixturesPath, 'utf8'))
    : {
        green: {},
        guardPolicy: {
          securityGlobs: [],
          securityPattern: null,
          securityLabel: 'security-reviewed',
        },
        cases: [],
      }
) as Fixtures;

const policy: ArmPolicy = {
  securityGlobs: fixtures.guardPolicy.securityGlobs,
  securityPattern: fixtures.guardPolicy.securityPattern,
  securityLabel: fixtures.guardPolicy.securityLabel,
};

/** The green payload bent by `mutation`, through jq like the bash suite. */
function payload(mutation: string): unknown {
  const out = execFileSync('jq', [mutation], {
    input: JSON.stringify(fixtures.green),
    encoding: 'utf8',
  });
  return JSON.parse(out) as unknown;
}

describe.skipIf(!runnable)(
  'arm guard decisions (shared with scripts/should-arm-automerge.sh)',
  () => {
    it('reads the shared fixture file', () => {
      expect(fixtures.cases.length).toBeGreaterThan(40);
    });

    it('every row carries both answers', () => {
      const oneSided = fixtures.cases
        .filter((c) => typeof c.gate !== 'string' || typeof c.guard !== 'string')
        .map((c) => c.name);
      expect(oneSided).toEqual([]);
    });

    it('every row has a distinct name', () => {
      const names = fixtures.cases.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });

    for (const c of fixtures.cases) {
      it(`${c.name}: ${String(c.guard)}`, () => {
        expect(formatDecision(decideArm(payload(c.mutation), policy))).toBe(c.guard);
      });
    }

    // The rows the agreed design names one by one (DOR-3262).
    it.each([
      ['head moved after the review', 'REFUSE head-moved'],
      ['base is not main', 'REFUSE base-not-main'],
      ['security path without the label', 'REFUSE security-path-unlabelled'],
      ['package manifest without the label', 'REFUSE security-path-unlabelled'],
      ['root lockfile without the label', 'REFUSE security-path-unlabelled'],
      ['a failing check', 'REFUSE failing-checks'],
      ['a check still running', 'ARM'],
      ['release freeze on', 'REFUSE freeze'],
      ['from a fork', 'REFUSE fork'],
    ])('the agreed row "%s" is present and answers %s', (name, verdict) => {
      expect(fixtures.cases.find((c) => c.name === name)?.guard).toBe(verdict);
    });

    it('an empty object is not an open pull request', () => {
      expect(formatDecision(decideArm({}, policy))).toBe('REFUSE not-open');
    });

    it('something that is not an object refuses', () => {
      for (const value of [null, 'ARM', 42, []]) {
        expect(formatDecision(decideArm(value, policy))).toBe('REFUSE not-open');
      }
    });

    it('a refusal says what to do, in a sentence', () => {
      const decision = decideArm(
        payload('.headRefOid = "2222222222222222222222222222222222222222"'),
        policy
      );
      expect(decision.verdict).toBe('REFUSE');
      expect(decision.verdict === 'REFUSE' && decision.detail).toMatch(/2222222.*1111111/);
    });

    it('names the security paths it found', () => {
      const decision = decideArm(payload('.files += ["scripts/release/publish.sh"]'), policy);
      expect(decision.verdict === 'REFUSE' && decision.detail).toContain(
        'scripts/release/publish.sh'
      );
      expect(decision.verdict === 'REFUSE' && decision.detail).toContain('security-reviewed');
    });

    it('a configured pattern counts like the globs', () => {
      const withPattern: ArmPolicy = {
        ...policy,
        securityGlobs: [],
        securityPattern: '^apps/server/src/(http|routes)/',
      };
      expect(
        formatDecision(decideArm(payload('.files = ["apps/server/src/routes/x.ts"]'), withPattern))
      ).toBe('REFUSE security-path-unlabelled');
      expect(formatDecision(decideArm(payload('.files = ["apps/client/x.ts"]'), withPattern))).toBe(
        'ARM'
      );
    });

    it('a pattern that is not a valid regular expression refuses rather than matching nothing', () => {
      const broken: ArmPolicy = { ...policy, securityPattern: '(' };
      expect(formatDecision(decideArm(payload('.'), broken))).toBe('REFUSE files-unreadable');
    });

    it('built-in security paths match after NFKC folding, in any case', () => {
      const builtin: ArmPolicy = { ...policy, securityGlobs: [] };
      for (const file of [
        'pac\u212Aage.json',
        'PACKAGE.JSON',
        'apps/web/Package.json',
        '.NPMRC',
        '\uFF50ackage.json',
      ]) {
        expect(
          formatDecision(decideArm(payload(`.files = [${JSON.stringify(file)}]`), builtin)),
          file
        ).toBe('REFUSE security-path-unlabelled');
      }
    });

    it("the repo's own security globs stay exact-case", () => {
      const own: ArmPolicy = { ...policy, securityGlobs: ['Secrets/**'] };
      expect(formatDecision(decideArm(payload('.files = ["Secrets/a"]'), own))).toBe(
        'REFUSE security-path-unlabelled'
      );
      expect(formatDecision(decideArm(payload('.files = ["secrets/a"]'), own))).toBe('ARM');
    });

    it('the built-in security paths cover the common manifests and lockfiles at any depth', () => {
      const builtin: ArmPolicy = { ...policy, securityGlobs: [] };
      for (const file of [
        'package.json',
        'a/b/package.json',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'yarn.lock',
        'bun.lock',
        'bun.lockb',
        '.npmrc',
        'Cargo.toml',
        'Cargo.lock',
        'go.mod',
        'go.sum',
        'pyproject.toml',
        'poetry.lock',
        'uv.lock',
        'requirements.txt',
        'requirements-dev.txt',
        'Gemfile',
        'Gemfile.lock',
        'composer.json',
        'composer.lock',
        '.pnpmfile.cjs',
        '.yarn/releases/yarn-4.1.0.cjs',
        '.yarnrc',
        'deno.lock',
        'setup.py',
        'pom.xml',
        'app/build.gradle.kts',
        'x.gemspec',
        'requirements/base.txt',
        'constraints.txt',
        'Package.resolved',
        '.gitmodules',
        '.agents/flow/config.json',
      ]) {
        expect(formatDecision(decideArm(payload(`.files = ["${file}"]`), builtin)), file).toBe(
          'REFUSE security-path-unlabelled'
        );
      }
      for (const file of [
        'README.md',
        'packages.md',
        'src/package.ts',
        '.agents/flow/config.local.example.json',
      ]) {
        expect(formatDecision(decideArm(payload(`.files = ["${file}"]`), builtin)), file).toBe(
          'ARM'
        );
      }
      expect(BUILTIN_SECURITY_GLOBS).toContain('**/package.json');
    });
  }
);
