/**
 * How often flow's scheduled runs fire is set where they are scheduled, never in
 * the shipped `schedule:` block an update replaces (DOR-2300). That is a promise
 * made in prose, so this suite pins the prose: nothing but the dials page's
 * Cadence section names a shipped schedule's timing field, that section says
 * where the cadence really lives (on DorkOS, the Schedules page, DOR-2302), the defaults it documents are the shipped ones,
 * and `/flow:status` only ever reads DorkOS's schedules. Each guard is shown to
 * bite on a planted break.
 *
 * @see specs/flow-schedule-cadence/02-specification.md ("Testing Strategy")
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectFilterGaps } from './schedule-filter.ts';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(pluginRoot, rel), 'utf8');

const DIALS = 'docs/the-dials.mdx';
const CADENCE_HEADING = '## Cadence: set it where the tick is scheduled';
const CADENCE_ANCHOR = '#cadence-set-it-where-the-tick-is-scheduled';

/** The text between two markers (the first after `from`), which must both exist. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`markers not found: ${from} … ${to}`);
  return text.slice(start, end);
}

/** Every prose file a person or an agent reads for instructions, by plugin-relative path. */
function proseFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(pluginRoot, rel))) {
      const child = path.join(rel, name);
      if (statSync(path.join(pluginRoot, child)).isDirectory()) walk(child);
      else if (/\.mdx?$/.test(name)) out[child] = read(child);
    }
  };
  for (const dir of ['commands', 'skills', 'docs']) walk(dir);
  for (const file of ['README.md', 'config/CONFIG.md']) out[file] = read(file);
  return out;
}

const TIMING_FIELD = /schedule\.(cron|timezone)\b/g;

/** A bare `cron:` line or phrase near a shipped schedule's name or file (outside frontmatter). */
const NEAR_SHIPPED_CRON =
  /(flow-drain|flow-groom|SKILL\.md)[\s\S]{0,200}?\bcron:|\bcron:[\s\S]{0,200}?(flow-drain|flow-groom|SKILL\.md)/g;

/** A file's text with its leading YAML frontmatter blanked (same length, so offsets hold). */
function withoutFrontmatter(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(text);
  return match ? ' '.repeat(match[0].length) + text.slice(match[0].length) : text;
}

/**
 * Every mention of a shipped schedule's timing field outside the one place
 * allowed to describe it: the dials page's Cadence section.
 */
function strayTimingMentions(files: Record<string, string>): string[] {
  const stray: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const allowed = file === DIALS ? between(text, CADENCE_HEADING, '\n## ') : '';
    const allowedStart = allowed ? text.indexOf(allowed) : -1;
    const body = withoutFrontmatter(text);
    for (const match of [...body.matchAll(TIMING_FIELD), ...body.matchAll(NEAR_SHIPPED_CRON)]) {
      const at = match.index ?? 0;
      const inside =
        allowedStart !== -1 && at >= allowedStart && at < allowedStart + allowed.length;
      if (!inside) stray.push(`${file}:${text.slice(0, at).split('\n').length}`);
    }
  }
  return stray;
}

/** The Cadence section of the dials page. */
const cadenceSection = (dials: string) => between(dials, CADENCE_HEADING, '\n## ');

/** What the Cadence section must say, and what it must never say. */
function cadenceGaps(section: string): string[] {
  const needs: [string, RegExp][] = [
    ['calls the shipped block the package default', /package's defaults/],
    ['names your own scheduler entry', /your own scheduler[^.]*its own entry is the cadence/i],
    // DOR-2302: DorkOS keeps a person's timing for a package's schedule.
    ['says to change the timing on the Schedules page', /choose \*\*Edit\*\*, and set a new time or timezone/],
    ['says a flow update never undoes that timing', /a flow update never undoes it/],
    ['says reset puts flow’s timing back', /\*\*Reset to the package's default\*\* puts flow's own timing back/],
    ['says an agent’s timing change asks again', /If an agent changes the timing[^.]*approve it/],
    ['scopes the own-schedule workaround to older DorkOS', /0\.82 and earlier/],
    ['says an update undoes an edit', /undone by the next update/],
    ['says DorkOS asks for approval again', /approve the schedule again/],
    [
      'says to leave flow-drain off when you run your own',
      /leave `flow-drain` switched off on DorkOS/,
    ],
    ['gives the person-owned schedule on DorkOS', /create a schedule for this project's agent/],
    ['whose prompt runs one /flow continue tick', /prompt is `Run one \/flow continue tick/],
    ['says your own timing change keeps it approved', /stays approved, because you made the change/],
    ['warns not to copy the flow-drain text', /do not copy the text of `flow-drain`/],
    ['says the pause flag stops it', /pause flag stops it/],
    ['points at /flow:status', /`\/flow:status` shows/],
  ];
  const forbids: [string, RegExp][] = [
    ['tells a person to tighten or loosen the shipped cron', /\b(tighten|loosen)\b/i],
    ['tells a person to make the shipped tick fire more often', /fire more often/i],
  ];
  return [
    ...needs.filter(([, re]) => !re.test(section)).map(([label]) => label),
    ...forbids.filter(([, re]) => re.test(section)).map(([label]) => label),
    ...editAdvice(section),
  ];
}

/**
 * Sentences (and table rows) that pair a shipped timing field with change, edit
 * or set, other than the table's own "never in this file" answer.
 */
function editAdvice(section: string): string[] {
  return section
    .split(/(?<=[.!?])\s+|\n/)
    .filter((sentence) => /schedule\.(cron|timezone)\b/.test(sentence))
    .filter((sentence) => /\b(change|edit|set)\b/i.test(sentence))
    .filter((sentence) => !/never in this file/.test(sentence))
    .map((sentence) => `advises editing a shipped timing field: ${sentence.trim()}`);
}

/** A frontmatter `schedule:` field of a shipped skill, quotes stripped. */
function shippedField(skill: string, field: 'cron' | 'timezone'): string {
  const match = new RegExp(`^\\s+${field}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm').exec(skill);
  if (!match) throw new Error(`no ${field} in the shipped schedule`);
  return match[1];
}

/** Shipped defaults the Cadence section's defaults table does not state on that schedule's row. */
function defaultDrift(section: string, skills: Record<string, string>): string[] {
  const drift: string[] = [];
  for (const [name, skill] of Object.entries(skills)) {
    const row = section.split('\n').find((line) => line.startsWith(`| \`${name}\``));
    if (!row) {
      drift.push(`${name}: no row`);
      continue;
    }
    for (const field of ['cron', 'timezone'] as const) {
      const value = shippedField(skill, field);
      if (!row.includes(value)) drift.push(`${name}: ${field} ${value}`);
    }
  }
  return drift;
}

/** The "Which dial should I touch?" row for making the tick fire more often. */
const moreOftenRow = (dials: string) =>
  dials.split('\n').find((line) => line.startsWith('| Make the autonomous tick fire more often')) ??
  '';

/**
 * What `/flow:status` must say about the schedules it reads and shows, and what it
 * must never be allowed to do.
 */
function statusGaps(status: string): string[] {
  const allowedTools = /^allowed-tools:(.*)$/m.exec(status)?.[1] ?? '';
  const source = between(status, '5. **The schedules', 'Render, in this order');
  const gaps: string[] = [];
  if (!allowedTools.includes('mcp__dorkos__tasks_list')) gaps.push('may not call tasks_list');
  if (/tasks_update/.test(allowedTools)) gaps.push('pre-approves tasks_update');
  // A wildcard or the bare server name would pre-approve every DorkOS tool,
  // tasks_update included.
  if (/mcp__dorkos(__\*|(?![_\w]))/.test(allowedTools)) gaps.push('pre-approves every DorkOS tool');
  const sourceNeeds: [string, RegExp][] = [
    ['reads tasks_list', /Call `tasks_list`/],
    ['loads a deferred tool first', /ToolSearch/],
    ['never changes a schedule', /never calls `tasks_update`/],
  ];
  gaps.push(...sourceNeeds.filter(([, re]) => !re.test(source)).map(([label]) => label));
  gaps.push(...projectFilterGaps(source));
  const pane = between(status, '- **Schedules.**', '- **Parked.**');
  const paneNeeds: [string, RegExp][] = [
    ['shows the cron and timezone', /the `cron`\s+and its `timezone`/],
    ['explains a schedule waiting for approval', /`pending_approval` means/],
    ['explains the absent tool', /its entry decides\s+how often/],
    [
      'points at the Cadence section, not the shipped file',
      /Cadence\s+section[\s\S]*never to the shipped/,
    ],
  ];
  gaps.push(...paneNeeds.filter(([, re]) => !re.test(pane)).map(([label]) => label));
  return gaps;
}

/** The Pulse-seat step about cadence in turning-on-autonomy. */
const pulseCadenceStep = (doc: string) => between(doc, '**Cadence and limits.**', '</Step>');

const shippedSchedules = () => ({
  'flow-drain': read('skills/flow-drain/SKILL.md'),
  'flow-groom': read('skills/flow-groom/SKILL.md'),
});

describe('only the dials Cadence section names a shipped schedule timing field', () => {
  it('finds no stray mention, and does find the allowed ones', () => {
    const files = proseFiles();
    // Non-vacuous: the scan reaches the commands, every skill and every doc.
    expect(Object.keys(files).length).toBeGreaterThan(30);
    expect(strayTimingMentions(files)).toEqual([]);
    expect(cadenceSection(files[DIALS]).match(TIMING_FIELD)?.length ?? 0).toBeGreaterThan(0);
  });

  it('the guard bites on an instruction to edit the shipped cron anywhere else', () => {
    // Plant-a-break: the old "Which dial" wording, and a command telling the
    // operator to edit the tick's cron.
    const files = proseFiles();
    files[DIALS] = files[DIALS].replace(
      moreOftenRow(files[DIALS]),
      '| Make the autonomous tick fire more often | `flow-drain` `schedule.cron` |'
    );
    files['commands/status.md'] += '\nEdit `schedule.cron` in flow-drain to go faster.\n';
    // A bare `cron:` edit named beside the shipped file, without the dotted field.
    files['README.md'] +=
      '\nTo go faster, set `cron: "*/5 * * * *"` in skills/flow-drain/SKILL.md.\n';
    expect(
      strayTimingMentions(files)
        .map((at) => at.split(':')[0])
        .sort()
    ).toEqual(['README.md', 'commands/status.md', DIALS]);
  });
});

describe('the Cadence section says where the cadence lives', () => {
  it('states every part of the contract and none of the old advice', () => {
    expect(cadenceGaps(cadenceSection(read(DIALS)))).toEqual([]);
  });

  it('the guard bites on the old advice or a missing statement', () => {
    const section = cadenceSection(read(DIALS));
    expect(cadenceGaps(`${section}\nTighten for a busier queue.`)).toEqual([
      'tells a person to tighten or loosen the shipped cron',
    ]);
    expect(cadenceGaps(section.replace(/undone by the next update/g, 'kept'))).toEqual([
      'says an update undoes an edit',
    ]);
    expect(cadenceGaps(section.replace(/do not copy the text of `flow-drain`/, 'x'))).toEqual([
      'warns not to copy the flow-drain text',
    ]);
    const advice = 'You can also change `schedule.cron` in the file if you prefer.';
    expect(cadenceGaps(`${section}\n${advice}`)).toEqual([
      `advises editing a shipped timing field: ${advice}`,
    ]);
  });
});

describe('the documented defaults are the shipped ones', () => {
  it('each shipped schedule has a row with its cron and timezone', () => {
    const skills = shippedSchedules();
    // Non-vacuous: both shipped schedules really have a cron and a timezone.
    for (const skill of Object.values(skills)) {
      expect(shippedField(skill, 'cron').length).toBeGreaterThan(0);
      expect(shippedField(skill, 'timezone').length).toBeGreaterThan(0);
    }
    expect(defaultDrift(cadenceSection(read(DIALS)), skills)).toEqual([]);
  });

  it('the guard bites when a shipped default changes without the doc', () => {
    const skills = shippedSchedules();
    skills['flow-drain'] = skills['flow-drain'].replace(/cron: "[^"]+"/, 'cron: "*/15 * * * *"');
    expect(defaultDrift(cadenceSection(read(DIALS)), skills)).toEqual([
      'flow-drain: cron */15 * * * *',
    ]);
  });
});

describe('the "Which dial" row for a faster tick points at the Cadence section', () => {
  it('links the section and names no shipped field', () => {
    const row = moreOftenRow(read(DIALS));
    expect(row).toContain(CADENCE_ANCHOR);
    expect(row).not.toMatch(TIMING_FIELD);
  });
});

describe('/flow:status reads the schedules and never changes them', () => {
  it('holds the whole read-only contract', () => {
    expect(statusGaps(read('commands/status.md'))).toEqual([]);
  });

  it('the guard bites on a pre-approved tasks_update or a missing filter', () => {
    const status = read('commands/status.md');
    expect(
      statusGaps(
        status.replace(
          'mcp__dorkos__tasks_list',
          'mcp__dorkos__tasks_list, mcp__dorkos__tasks_update'
        )
      )
    ).toEqual(['pre-approves tasks_update']);
    // A bare string prefix would let `/work/app` claim `/work/app-2`.
    expect(statusGaps(status.replace('roots followed by `/`', 'roots'))).toEqual([
      'requires a separator after the root',
    ]);
    expect(
      statusGaps(status.replace(/made whose `prompt` runs `\/flow continue`/, 'made'))
    ).toEqual(['keeps a person-made /flow continue schedule']);
    for (const wide of ['mcp__dorkos__*', 'mcp__dorkos']) {
      expect(
        statusGaps(status.replace('mcp__dorkos__tasks_list', `mcp__dorkos__tasks_list, ${wide}`))
      ).toEqual(['pre-approves every DorkOS tool']);
    }
  });
});

describe('the Pulse-seat setup does not offer loop intervals as the tick cadence', () => {
  it('points at the Cadence section and never at `loops`', () => {
    const step = pulseCadenceStep(read('docs/turning-on-autonomy.mdx'));
    expect(step).toContain(CADENCE_ANCHOR);
    expect(step).not.toMatch(/`loops`/);
  });
});
