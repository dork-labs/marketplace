/**
 * Doc lint (`scripts/selftest/doc-lint.ts`), the prose half of `flow selftest`'s
 * fast tier (DOR-2390, spec `specs/flow-self-improvement` §1).
 *
 * Every rule is exercised twice: a clean corpus that must pass, and a planted
 * break that must fail FOR THE STATED REASON (the finding names the rule and the
 * file). The last block runs the rules over the shipped plugin: its allow files
 * and budgets exist so today's prose passes, and only new drift fails.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkDuplicates,
  checkFrontmatter,
  checkLinks,
  checkWarStories,
  checkWords,
  countWords,
  headingSlugs,
  lintCorpus,
  loadCorpus,
  loadLintConfig,
  rebaseline,
  type DocFile,
  type WarStoryAllow,
} from '../scripts/selftest/doc-lint.ts';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NO_WAR_ALLOW: WarStoryAllow = { rulePrefixes: {}, lines: [] };

/** A reader over an in-memory tree: a path maps to text, a trailing-slash key is a directory. */
function reader(tree: Record<string, string>) {
  return (p: string): string | null => {
    if (p in tree) return tree[p];
    if (`${p}/` in tree) return '';
    return null;
  };
}

describe('doc-lint/words (the ratchet)', () => {
  const files: DocFile[] = [{ path: 'commands/a.md', text: 'one two three four' }];

  it('counts whitespace-separated words', () => {
    expect(countWords('  one\ntwo  three\n\n')).toBe(3);
    expect(countWords('')).toBe(0);
  });

  it('passes a file at or under its baseline', () => {
    expect(checkWords(files, { 'commands/a.md': { baseline: 4, target: 2 } })).toEqual([]);
  });

  it('fails a file that grew above its baseline, naming the file', () => {
    const findings = checkWords(files, { 'commands/a.md': { baseline: 3, target: 2 } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'doc-lint/words', path: 'commands/a.md' });
    expect(findings[0].detail).toMatch(/4 words, above its baseline of 3/);
  });

  it('fails a file with no budget entry', () => {
    const findings = checkWords(files, {});
    expect(findings[0].detail).toMatch(/add a budget/);
  });

  it('rebaseline lowers a baseline, never raises one, and adds a missing file', () => {
    const grown: DocFile[] = [
      { path: 'a.md', text: 'one two three' },
      { path: 'b.md', text: 'one' },
      { path: 'c.md', text: 'one two' },
    ];
    const out = rebaseline(grown, {
      'a.md': { baseline: 2, target: 1 },
      'b.md': { baseline: 5, target: 1 },
    });
    expect(out['a.md']).toEqual({ baseline: 2, target: 1 }); // grew: kept, still fails
    expect(out['b.md']).toEqual({ baseline: 1, target: 1 }); // shrank: lowered
    expect(out['c.md']).toEqual({ baseline: 2, target: 2 }); // new: added at today's count
  });
});

describe('doc-lint/duplicate-rule', () => {
  const rule = 'Never touch the tracker directly from a stage skill, route it through the adapter.';

  it('passes when a long sentence lives in one file', () => {
    const files = [
      { path: 'a.md', text: `Intro.\n\n${rule}` },
      { path: 'b.md', text: 'Something else entirely that is also quite long indeed.' },
    ];
    expect(checkDuplicates(files, { sentences: [] })).toEqual([]);
  });

  it('fails when the same sentence appears in two files, naming both', () => {
    const files = [
      { path: 'a.md', text: `- **${rule}**` },
      { path: 'b.md', text: `Some lead-in.\n\n${rule.toUpperCase()}` },
    ];
    const findings = checkDuplicates(files, { sentences: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('doc-lint/duplicate-rule');
    expect(findings[0].detail).toContain('a.md');
    expect(findings[0].detail).toContain('b.md');
  });

  it('ignores short sentences and fenced code', () => {
    const short = 'Run the tests now please.';
    const code = '```\nconst a = 1; // the same long line of code in both files here\n```';
    const files = [
      { path: 'a.md', text: `${short}\n\n${code}` },
      { path: 'b.md', text: `${short}\n\n${code}` },
    ];
    expect(checkDuplicates(files, { sentences: [] })).toEqual([]);
  });

  it('passes a repeat listed in the allow file', () => {
    const files = [
      { path: 'a.md', text: rule },
      { path: 'b.md', text: rule },
    ];
    const allowed = checkDuplicates(files, { sentences: [] })[0].key;
    expect(checkDuplicates(files, { sentences: [{ text: allowed, reason: 'test' }] })).toEqual([]);
  });
});

describe('doc-lint/links', () => {
  it('slugs headings the way GitHub does', () => {
    expect(headingSlugs('# Hello World\n## `flow` CLI: the core!\n## Hello World')).toEqual([
      'hello-world',
      'flow-cli-the-core',
      'hello-world-1',
    ]);
  });

  it('passes relative links to files, directories and anchors that exist', () => {
    const files = [
      {
        path: 'skills/x/SKILL.md',
        text: 'See [b](../../docs/b.md#the-part), [dir](../../templates/), [self](#top), [web](https://x.y), [site](/docs/z).\n\n# Top',
      },
    ];
    const read = reader({ 'docs/b.md': '# Intro\n## The part', 'templates/': '' });
    expect(checkLinks(files, read)).toEqual([]);
  });

  it('fails a link to a missing file', () => {
    const files = [{ path: 'a.md', text: 'See [gone](missing.md).' }];
    const findings = checkLinks(files, reader({}));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'doc-lint/links', path: 'a.md' });
    expect(findings[0].detail).toMatch(/missing\.md/);
  });

  it('fails a link to a missing anchor', () => {
    const files = [{ path: 'a.md', text: 'See [b](b.md#nope).' }];
    const findings = checkLinks(files, reader({ 'b.md': '# Yes' }));
    expect(findings[0].detail).toMatch(/#nope/);
  });

  it('ignores links inside code', () => {
    const files = [{ path: 'a.md', text: '`[x](gone.md)`\n\n```\n[y](gone.md)\n```' }];
    expect(checkLinks(files, reader({}))).toEqual([]);
  });
});

describe('doc-lint/frontmatter', () => {
  const schedule = (overrides: Record<string, string> = {}): string => {
    const fields = {
      cron: "'0 9 * * 1'",
      timezone: 'America/Los_Angeles',
      enabled: 'false',
      'max-runtime': '20m',
      permissions: 'default',
      ...overrides,
    };
    const lines = Object.entries(fields)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `  ${k}: ${v}`);
    return `---\nname: tick\ndescription: A tick.\nschedule:\n${lines.join('\n')}\n---\nBody`;
  };

  it('passes a skill and a command with valid frontmatter and schedule', () => {
    const files = [
      { path: 'skills/tick/SKILL.md', text: schedule() },
      { path: 'commands/go.md', text: '---\ndescription: Go\n---\n# Go' },
    ];
    expect(checkFrontmatter(files)).toEqual([]);
  });

  it('fails a skill whose name differs from its folder', () => {
    const findings = checkFrontmatter([{ path: 'skills/other/SKILL.md', text: schedule() }]);
    expect(findings[0].detail).toMatch(/name "tick" does not match its folder "other"/);
  });

  it('fails a command with no description', () => {
    const findings = checkFrontmatter([{ path: 'commands/go.md', text: '# Go' }]);
    expect(findings[0].detail).toMatch(/description/);
  });

  it('fails a bad cron, a bad timezone, enabled: true and a missing field', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ cron: "'0 9 * *'" }, /cron/],
      [{ timezone: 'Mars/Olympus' }, /timezone/],
      [{ enabled: 'true' }, /enabled: false/],
      [{ permissions: '' }, /permissions/],
    ];
    for (const [overrides, reason] of cases) {
      const findings = checkFrontmatter([
        { path: 'skills/tick/SKILL.md', text: schedule(overrides) },
      ]);
      expect(findings.map((f) => f.detail).join('\n')).toMatch(reason);
    }
  });
});

describe('doc-lint/war-stories', () => {
  const allow: WarStoryAllow = { rulePrefixes: { INV: 'invariant ids' }, lines: [] };

  it('fails a dated line inside a step of a skill', () => {
    const files = [{ path: 'skills/x/SKILL.md', text: '1. Claim it (this bit us on 2026-09-10).' }];
    const findings = checkWarStories(files, allow);
    expect(findings[0]).toMatchObject({ rule: 'doc-lint/war-stories', path: 'skills/x/SKILL.md' });
  });

  it('fails a tracker id in an indented continuation of a step', () => {
    const files = [{ path: 'commands/x.md', text: '- Claim the item.\n  See DOR-1910 for why.' }];
    expect(checkWarStories(files, allow)).toHaveLength(1);
  });

  it('passes a rule id with an allowed prefix, prose outside steps, and exempt files', () => {
    const files = [
      {
        path: 'skills/x/SKILL.md',
        text: '- Check INV-3 holds.\n\nOn 2026-09-10 we learned a lot.',
      },
      { path: 'docs/why.md', text: '- On 2026-09-10 DOR-1910 happened.' },
      { path: 'docs/guide.mdx', text: '- On 2026-09-10 DOR-1910 happened.' },
    ];
    expect(checkWarStories(files, allow)).toEqual([]);
  });

  it('passes a line listed in the allow file and ignores fenced code', () => {
    const files = [
      { path: 'skills/x/SKILL.md', text: '- Seen in DOR-1.\n- ```\n  2026-01-01\n  ```' },
    ];
    const withLine: WarStoryAllow = {
      rulePrefixes: {},
      lines: [{ path: 'skills/x/SKILL.md', text: '- Seen in DOR-1.' }],
    };
    expect(checkWarStories(files, withLine)).toEqual([]);
    expect(checkWarStories(files, NO_WAR_ALLOW)).toHaveLength(1);
  });
});

describe('the shipped plugin', () => {
  it('passes every doc-lint rule with its committed budgets and allow files', () => {
    const findings = lintCorpus(loadCorpus(FLOW_ROOT), loadLintConfig(FLOW_ROOT), FLOW_ROOT);
    expect(findings.map((f) => `${f.rule} ${f.path}: ${f.detail}`)).toEqual([]);
  });
});
