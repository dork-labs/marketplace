/**
 * The review route (DOR-3341): `light` skips QA and never Security; the design
 * step fires only on `review.designPaths`.
 */

import { describe, expect, it } from 'vitest';

import { decideArm, type ArmPolicy } from '../../scripts/land/arm-decision.ts';
import { reviewRoute, type RoutePolicy } from '../../scripts/land/review-route.ts';

const arm: ArmPolicy = {
  securityGlobs: [],
  securityPattern: null,
  securityLabel: 'security-reviewed',
};

const policy: RoutePolicy = {
  arm,
  designPaths: ['apps/client/**', 'apps/site/**', 'packages/ui/**', 'docs/**'],
  lightPaths: ['apps/client/src/locales/**'],
};

const SHA = 'a'.repeat(40);

/** A PR the guard would arm, but for what `files` and `labels` say. */
function armFacts(files: string[], labels: string[] = []): Record<string, unknown> {
  return {
    state: 'OPEN',
    isDraft: false,
    labels: labels.map((name) => ({ name })),
    reviewDecision: '',
    checks: [{ name: 'ci', bucket: 'pass' }],
    headRefOid: SHA,
    baseRefName: 'main',
    isCrossRepository: false,
    requiredChecks: ['ci'],
    files,
    reviewedSha: SHA,
    freeze: null,
  };
}

describe('the light class', () => {
  it('a deps-only PR is light, and still needs the Security label to arm', () => {
    const files = ['package.json', 'package-lock.json', 'apps/server/package.json'];
    const route = reviewRoute(files, policy);
    expect(route.class).toBe('light');
    expect(route.steps).toEqual({ security: true, qa: false, design: false });
    expect(route.securityLabelRequired).toBe(true);
    expect(route.securityPaths).toEqual(files);
    // The arm guard agrees: no label, no arm; the label lets it through.
    expect(decideArm(armFacts(files), arm)).toMatchObject({
      verdict: 'REFUSE',
      reason: 'security-path-unlabelled',
    });
    expect(decideArm(armFacts(files, ['security-reviewed']), arm)).toEqual({ verdict: 'ARM' });
  });

  it('docs, tests and CI together are light; Security stays on the route', () => {
    const route = reviewRoute(
      [
        'README.md',
        'apps/server/src/x.test.ts',
        'engine-tests/a.test.ts',
        '.github/workflows/ci.yml',
      ],
      { ...policy, designPaths: [] }
    );
    expect(route.class).toBe('light');
    expect(route.steps.security).toBe(true);
    expect(route.steps.qa).toBe(false);
  });

  it('one source file makes it standard, and names that file', () => {
    const route = reviewRoute(['README.md', 'apps/server/src/index.ts'], policy);
    expect(route.class).toBe('standard');
    expect(route.steps.qa).toBe(true);
    expect(route.heavy).toEqual(['apps/server/src/index.ts']);
  });

  it('agent prose is never light, though it is markdown', () => {
    for (const file of [
      'plugins/flow/skills/flow-drain/SKILL.md',
      'plugins/flow/commands/verify.md',
      '.claude/skills/creating-pull-requests/SKILL.md',
      'AGENTS.md',
    ]) {
      expect(reviewRoute([file], policy).class, file).toBe('standard');
    }
  });

  it('dependency files that are code, and the review rubric, are never light', () => {
    for (const file of [
      'patches/left-pad+1.0.0.patch',
      '.pnpmfile.cjs',
      '.yarn/releases/yarn-4.1.0.cjs',
      'gradlew',
      'setup.py',
      'REVIEW.md',
    ]) {
      expect(reviewRoute([file], policy).class, file).toBe('standard');
    }
  });

  it('a fixture is not a test: a script may read it at run time', () => {
    expect(reviewRoute(['scripts/fixtures/arm-decisions.json'], policy).class).toBe('standard');
  });

  it('an unknown or empty file list is never light, and Security wants its label', () => {
    for (const files of [null, []]) {
      const route = reviewRoute(files, policy);
      expect(route.class).toBe('standard');
      expect(route.steps).toEqual({ security: true, qa: true, design: true });
      expect(route.securityLabelRequired).toBe(true);
    }
    expect(reviewRoute(null, { ...policy, designPaths: [] }).steps.design).toBe(false);
  });
});

describe('the design step', () => {
  it('a UI path turns it on', () => {
    const route = reviewRoute(['apps/client/src/Button.tsx'], policy);
    expect(route.steps.design).toBe(true);
    expect(route.designPaths).toEqual(['apps/client/src/Button.tsx']);
    expect(route.steps.qa).toBe(true);
  });

  it('a non-UI path leaves it off', () => {
    const route = reviewRoute(['apps/server/src/routes/x.ts'], policy);
    expect(route.steps.design).toBe(false);
    expect(route.designPaths).toEqual([]);
  });

  it('no designPaths configured: no PR gets a design step', () => {
    expect(
      reviewRoute(['apps/client/src/Button.tsx'], { ...policy, designPaths: [] }).steps.design
    ).toBe(false);
  });

  it('a copy-only PR is light with the design read on, and still Security', () => {
    const route = reviewRoute(['apps/client/src/locales/en.json', 'docs/guide.mdx'], policy);
    expect(route.class).toBe('light');
    expect(route.steps).toEqual({ security: true, qa: false, design: true });
  });
});
