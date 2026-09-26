/**
 * The ready loop is prose the agent follows (DOR-2375, DOR-2378): a follow-up
 * filed at DONE goes through triage right away, a daily triage schedule readies
 * or parks what is untriaged and frees stale claims, the groom schedule is a
 * weekly read-only check, and triage and groom check the code before calling
 * work open or shipped. This suite pins that prose, and each guard is shown to
 * bite on a planted break.
 *
 * @see specs/flow-cli-overhaul/01-ideation.md ("Quick wins available now")
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(pluginRoot, rel), 'utf8');

/** The text between two markers (the first after `from`), which must both exist. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`markers not found: ${from} … ${to}`);
  return text.slice(start, end);
}

/** Labels of the patterns a passage fails to match. */
function missing(passage: string, needs: [string, RegExp][]): string[] {
  return needs.filter(([, re]) => !re.test(passage)).map(([label]) => label);
}

/** What DONE's follow-up step must say. */
function followUpGaps(closing: string): string[] {
  return missing(between(closing, '### 4. Create follow-up work', '### 5.'), [
    ['gives every follow-up a type, priority and project', /type, a priority and a project/],
    ['triages it right away', /triaging-work[\s\S]*right away|right away[\s\S]*triaging-work/],
    ['readies only on the six rules', /six readiness rules/],
    ['otherwise parks it with one question', /parks? it with one question/],
  ]);
}

/** What the adapter must say about claiming and closing. */
function adapterGaps(adapter: string): string[] {
  const claimRow = adapter.split('\n').find((line) => line.startsWith('| **`claim(item)`**')) ?? '';
  return [
    ...missing(claimRow, [
      ['claim swaps ready for claimed', /swaps `agent\/ready` for `agent\/claimed`/i],
      ['names the exclusive group', /exclusive/],
    ]),
    ...missing(adapter, [['Closes <id> auto-closes at merge', /`Closes <identifier>`[^\n]*merge/]]),
  ];
}

/** A shipped skill's frontmatter `schedule:` field value, quotes stripped. */
function scheduleField(skill: string, field: string): string {
  const match = new RegExp(`^\\s+${field}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm').exec(skill);
  return match?.[1] ?? '';
}

/** What the flow-groom schedule must be: a weekly, read-only check, off until approved. */
function groomGaps(groom: string): string[] {
  const [minute, hour, dom, month, dow] = scheduleField(groom, 'cron').split(' ');
  const gaps: string[] = [];
  if (!(minute && hour && dom === '*' && month === '*' && /^[0-6]$/.test(dow ?? ''))) {
    gaps.push('fires weekly');
  }
  if (scheduleField(groom, 'enabled') !== 'false') gaps.push('ships switched off');
  gaps.push(
    ...missing(groom, [
      ['runs check mode', /weekly, read-only\s+`\/flow:groom check`/],
      ['never writes', /\*\*This tick never writes\.\*\*/],
      ['says how to switch it on', /approve it on the Schedules page/],
    ])
  );
  return gaps;
}

/** What the daily triage schedule must do. */
function triageScheduleGaps(triage: string): string[] {
  const gaps: string[] = [];
  const cron = scheduleField(triage, 'cron').split(' ');
  if (!(cron.length === 5 && cron.slice(2).every((f) => f === '*'))) gaps.push('fires daily');
  if (scheduleField(triage, 'enabled') !== 'false') gaps.push('ships switched off');
  gaps.push(
    ...missing(triage, [
      ['reuses triaging-work', /<flow-root>\/skills\/triaging-work\/SKILL\.md/],
      ['readies only on the six rules', /six readiness rules/],
      ['parks the rest with one question', /one question/],
      [
        'releases claims untouched for 7+ days',
        /`agent\/claimed`[^.]*untouched for 7 or more days/,
      ],
      ['keeps floor gates for the operator', /never run unattended/],
      ['says how to switch it on', /approve it on the Schedules page/],
    ])
  );
  if (scheduleField(triage, 'permissions') !== 'default')
    gaps.push('runs with default permissions');
  gaps.push(...releaseGaps(triage));
  if (!releasesFirst(triage)) gaps.push('releases before it triages');
  return gaps;
}

/** Whether the release step comes before the triage step, so one run re-triages what it freed. */
function releasesFirst(triage: string): boolean {
  const release = triage.indexOf('**Release stale claims');
  return release !== -1 && release < triage.indexOf('**Triage what is untriaged');
}

/**
 * The stale-claim release must never take live work (DOR-2375 review): each skip
 * case, and no restored readiness.
 */
function releaseGaps(triage: string): string[] {
  const release = between(triage, '**Release stale claims', '**Triage what is untriaged');
  const gaps = missing(release, [
    ['releases only when all hold', /only when ALL of these hold/],
    [
      'skips an item with any flow run',
      /No run for it in `\.dork\/flow\/flow-state\.json`, whatever/,
    ],
    ['skips an item in review', /not in the review state/],
    ['skips an item assigned to a human', /not assigned to\s+a human/],
    ['skips an item with an open PR', /No open pull request/],
    ['skips an item with a pushed branch', /pushed branch/],
    ['skips an item with a worktree', /worktree carries its id/],
    ['does not restore readiness', /Do not restore `agent\/ready`/],
  ]);
  return gaps;
}

/** The code-check rule triage and groom both carry. */
const CODE_CHECK = /\*\*Check the code, not the ticket\.\*\*/;

/** What the parallel-drain recipe must hold. */
function recipeGaps(doc: string, meta: string, templates: Record<string, string>): string[] {
  const gaps: string[] = [];
  if (!JSON.parse(meta).pages.includes('parallel-drain')) gaps.push('listed in the docs nav');
  for (const name of ['worker-brief.md', 'reviewer-brief.md', 'watch.sh']) {
    if (!templates[name]) gaps.push(`ships templates/drain/${name}`);
    else if (!doc.includes(`templates/drain/${name}`)) gaps.push(`doc names ${name}`);
  }
  // Generalized: no machine paths, ticket ids, accounts or session ids left over.
  const leftovers = /\/Users\/|\/private\/tmp|\bDOR-[0-9]+|--account \w|6843b882|Maintenance drain/;
  for (const [name, text] of Object.entries({ doc, ...templates })) {
    if (leftovers.test(text)) gaps.push(`${name} is not generalized`);
  }
  return gaps;
}

const drainTemplates = (): Record<string, string> => {
  const dir = path.join(pluginRoot, 'templates', 'drain');
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir).map((name) => [name, readFileSync(path.join(dir, name), 'utf8')])
  );
};

const RECIPE = 'docs/parallel-drain.mdx';
const readRecipe = () => (existsSync(path.join(pluginRoot, RECIPE)) ? read(RECIPE) : '');

describe('a follow-up filed at DONE is readied or parked', () => {
  it('closing-work step 4 routes every follow-up through triage', () => {
    expect(followUpGaps(read('skills/closing-work/SKILL.md'))).toEqual([]);
  });

  it('the guard bites when the readiness rule is dropped', () => {
    const closing = read('skills/closing-work/SKILL.md').replace(/six readiness rules/g, 'rules');
    expect(followUpGaps(closing)).toEqual(['readies only on the six rules']);
  });
});

describe('the adapter documents the claim swap and closing on merge', () => {
  it('holds both notes', () => {
    expect(adapterGaps(read('skills/linear-adapter/SKILL.md'))).toEqual([]);
  });

  it('the guard bites when the swap is dropped', () => {
    const adapter = read('skills/linear-adapter/SKILL.md').replace(
      'Swaps `agent/ready` for `agent/claimed`',
      'writes `agent/claimed`'
    );
    expect(adapterGaps(adapter)).toEqual(['claim swaps ready for claimed']);
  });
});

describe('both schedules ship and are documented', () => {
  it('flow-groom is a weekly read-only check', () => {
    expect(groomGaps(read('skills/flow-groom/SKILL.md'))).toEqual([]);
  });

  it('the groom guard bites on a monthly cron', () => {
    const groom = read('skills/flow-groom/SKILL.md').replace(/cron: .*/, "cron: '0 9 1 * *'");
    expect(groomGaps(groom)).toEqual(['fires weekly']);
  });

  it('flow-triage is a daily triage that frees stale claims', () => {
    expect(triageScheduleGaps(read('skills/flow-triage/SKILL.md'))).toEqual([]);
  });

  it('the triage guard bites when it stops reusing triaging-work or ships on', () => {
    const triage = read('skills/flow-triage/SKILL.md')
      .replace(/<flow-root>\/skills\/triaging-work\/SKILL\.md/g, 'its own rules')
      .replace(/enabled: false/, 'enabled: true');
    expect(triageScheduleGaps(triage)).toEqual(['ships switched off', 'reuses triaging-work']);
  });

  it.each([
    ['skips an item with any flow run', /, whatever its worker's state/],
    ['skips an item in review', /not in the review state/],
    ['skips an item assigned to a human', /not assigned to\s+a human/],
    ['skips an item with an open PR', /No open pull request/],
    ['skips an item with a pushed branch', /pushed branch/],
    ['skips an item with a worktree', /worktree carries its id/],
    ['does not restore readiness', /Do not restore `agent\/ready`/],
  ])('the release guard bites when it drops: %s', (label, cut) => {
    const triage = read('skills/flow-triage/SKILL.md').replace(cut, 'x');
    expect(releaseGaps(triage)).toEqual([label]);
  });

  it('the release guard bites when triage runs first', () => {
    const triage = read('skills/flow-triage/SKILL.md')
      .replace('**Release stale claims', '**TMP')
      .replace('**Triage what is untriaged', '**Release stale claims')
      .replace('**TMP', '**Triage what is untriaged');
    expect(releasesFirst(read('skills/flow-triage/SKILL.md'))).toBe(true);
    expect(releasesFirst(triage)).toBe(false);
  });

  it('the permission guard bites on acceptEdits', () => {
    const triage = read('skills/flow-triage/SKILL.md').replace(
      'permissions: default',
      'permissions: acceptEdits'
    );
    expect(triageScheduleGaps(triage)).toEqual(['runs with default permissions']);
  });
});

describe('triage and groom check the code before calling work open or shipped', () => {
  it('both skills carry the rule', () => {
    for (const skill of ['triaging-work', 'grooming-backlog']) {
      expect(read(`skills/${skill}/SKILL.md`), skill).toMatch(CODE_CHECK);
    }
  });

  it('the rule names both directions', () => {
    for (const skill of ['triaging-work', 'grooming-backlog']) {
      const text = read(`skills/${skill}/SKILL.md`);
      // The rule is one bullet: it ends where the next bullet starts.
      const rule = text.slice(text.search(CODE_CHECK)).split('\n- ')[0];
      expect(rule, skill).toMatch(/shipped/i);
      expect(rule, skill).toMatch(/open/i);
    }
  });
});

describe('the parallel-drain recipe ships in the docs', () => {
  it('is listed, names its templates, and is generalized', () => {
    expect(recipeGaps(readRecipe(), read('docs/meta.json'), drainTemplates())).toEqual([]);
  });

  it('the guard bites on a leftover machine path', () => {
    const templates = drainTemplates();
    templates['worker-brief.md'] += '\nRead /Users/someone/repo/AGENTS.md.\n';
    expect(recipeGaps(readRecipe(), read('docs/meta.json'), templates)).toEqual([
      'worker-brief.md is not generalized',
    ]);
  });
});
