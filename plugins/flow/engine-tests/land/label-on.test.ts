/**
 * `land.securityPaths.labelOn` (DOR-3768): the loose reader the Flow panel and
 * `flow status` share, the review rubric as a security path, the schema's
 * default, and the words every surface uses for it. The guard's end-to-end
 * cases live in `arm-guard.test.ts` ("labelOn: security-paths").
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LandSchema } from '../../scripts/config-schema.ts';
import { BUILTIN_SECURITY_GLOBS } from '../../scripts/land/arm-decision.ts';
import { parseLabelEverAdded } from '../../scripts/forge/github.ts';
import { policyFor } from '../../scripts/land/arm-guard.ts';
import {
  LABEL_ON_NOTICE,
  LABEL_ON_SECURITY_GLOBS,
  labelOnOf,
  labelOnShown,
  rubricGlob,
} from '../../scripts/land/label-on.ts';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('labelOnOf', () => {
  it('is on only for the exact string', () => {
    const on = { land: { securityPaths: { labelOn: 'security-paths' } } };
    expect(labelOnOf(on)).toBe('security-paths');
    for (const value of ['Security-Paths', 'security-paths ', true, 1, null, 'every-pr']) {
      expect(labelOnOf({ land: { securityPaths: { labelOn: value } } })).toBe('every-pr');
    }
    for (const config of [
      undefined,
      null,
      [],
      'x',
      {},
      { land: [] },
      { land: { securityPaths: [] } },
    ]) {
      expect(labelOnOf(config)).toBe('every-pr');
    }
  });
});

describe('labelOnShown (flow status and the panel)', () => {
  const on = { land: { securityPaths: { labelOn: 'security-paths' } } };
  it('is on when either the working tree or origin/HEAD has it on', () => {
    expect(labelOnShown(on, undefined)).toBe('security-paths');
    expect(labelOnShown(undefined, on)).toBe('security-paths');
    expect(labelOnShown({}, {})).toBe('every-pr');
  });
});

describe('parseLabelEverAdded', () => {
  const line = (event: string, name: string, actor = 'User') =>
    JSON.stringify({ event, created_at: '2026-10-01T00:00:00Z', name, actor });
  it('is true once any add is on record, by anyone, even if removed since', () => {
    expect(parseLabelEverAdded('', 'review:deep')).toBe(false);
    expect(parseLabelEverAdded(line('labeled', 'other'), 'review:deep')).toBe(false);
    const removed = [line('labeled', 'Review:Deep', 'Bot'), line('unlabeled', 'review:deep')];
    expect(parseLabelEverAdded(removed.join('\n'), 'review:deep')).toBe(true);
  });
  it('throws on a line it cannot read', () => {
    expect(() => parseLabelEverAdded('nope', 'review:deep')).toThrow();
  });
});

describe('the schema', () => {
  it('defaults to every-pr and takes nothing but the two values', () => {
    expect(LandSchema.parse({}).securityPaths.labelOn).toBe('every-pr');
    expect(
      LandSchema.parse({ securityPaths: { labelOn: 'security-paths' } }).securityPaths.labelOn
    ).toBe('security-paths');
    expect(LandSchema.safeParse({ securityPaths: { labelOn: 'none' } }).success).toBe(false);
    expect(LandSchema.safeParse({ securityPaths: { labelOn: true } }).success).toBe(false);
  });
});

describe('the security paths while it is on', () => {
  const on = LandSchema.parse({ securityPaths: { labelOn: 'security-paths' } });
  const off = LandSchema.parse({});

  it('adds the fixed list and the rubric, and only while it is on', () => {
    expect(policyFor(on, 'docs/rubric.md').securityGlobs).toEqual([
      ...LABEL_ON_SECURITY_GLOBS,
      'docs/rubric.md',
    ]);
    expect(policyFor(off, 'docs/rubric.md').securityGlobs).toEqual([]);
  });

  it('adds every submodule and what is under it, only while it is on', () => {
    expect(policyFor(on, null, ['vendor/lib']).securityGlobs.slice(-2)).toEqual([
      'vendor/lib',
      'vendor/lib/**',
    ]);
    expect(policyFor(off, null, ['vendor/lib']).securityGlobs).toEqual([]);
  });

  it('keeps the fixed list when the repository sets its own', () => {
    const own = LandSchema.parse({
      securityPaths: { labelOn: 'security-paths', globs: ['src/auth/**'] },
    });
    expect(policyFor(own).securityGlobs).toEqual(['src/auth/**', ...LABEL_ON_SECURITY_GLOBS]);
  });

  it('covers the paths Security named, with package files and lockfiles built in', () => {
    for (const glob of ['.github/**', '**/.claude/**', '**/.agents/**', '**/.dork/**']) {
      expect(LABEL_ON_SECURITY_GLOBS).toContain(glob);
    }
    for (const glob of ['**/AGENTS.md', '**/CLAUDE*.md', 'REVIEW.md', '**/Dockerfile*']) {
      expect(LABEL_ON_SECURITY_GLOBS).toContain(glob);
    }
    for (const glob of ['**/.husky/**', '**/.githooks/**', '**/scripts/**', '**/.gitattributes']) {
      expect(LABEL_ON_SECURITY_GLOBS).toContain(glob);
    }
    for (const glob of [
      '**/package.json',
      '**/pnpm-lock.yaml',
      '**/yarn.lock',
      '**/package-lock.json',
    ]) {
      expect(BUILTIN_SECURITY_GLOBS).toContain(glob);
    }
  });

  it('takes the rubric as a repo-relative path, and nothing outside the repository', () => {
    expect(rubricGlob('REVIEW.md')).toBe('REVIEW.md');
    expect(rubricGlob('./docs/review.md')).toBe('docs/review.md');
    expect(rubricGlob('docs\\review.md')).toBe('docs/review.md');
    for (const outside of [
      '/etc/rubric.md',
      'C:/rubric.md',
      '../rubric.md',
      'a/../b.md',
      '',
      3,
      null,
    ]) {
      expect(rubricGlob(outside)).toBeNull();
    }
  });
});

// Condition 6: plain words. It is never called safe; every surface says a misled
// agent can merge a bad change, and that only a GitHub ruleset is a boundary.
describe('the words', () => {
  const MISLED =
    /A misled agent can merge a bad change that passes the checks and stays off the path list\.?/;
  const RULESET = /only a GitHub ruleset is a real boundary/i;

  it('flow status and the panel', () => {
    expect(LABEL_ON_NOTICE).toMatch(MISLED);
    expect(LABEL_ON_NOTICE).toMatch(RULESET);
    expect(LABEL_ON_NOTICE).not.toMatch(/\bsafe/i);
  });

  it.each(['docs/security-label.mdx', 'config/CONFIG.md'])('%s', (file) => {
    const text = readFileSync(path.join(FLOW_ROOT, file), 'utf8');
    const lines = text.split('\n').filter((line) => /labelOn/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    const section =
      file === 'config/CONFIG.md'
        ? lines.find((line) => line.startsWith('| `securityPaths.labelOn`'))!
        : text.slice(text.indexOf('## Letting agents merge without it'));
    expect(section).toMatch(MISLED);
    expect(section).toMatch(RULESET);
    expect(section).toMatch(/DorkOS's own repos never set it/);
    expect(section).not.toMatch(/\bsafe/i);
  });
});
