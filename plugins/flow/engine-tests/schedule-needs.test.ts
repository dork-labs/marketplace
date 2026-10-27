/**
 * Flow's scheduled skills never stop quietly (DOR-3257, F1).
 *
 * A scheduled run has nobody to approve a tool, so a tool that asks is refused
 * on the spot. Before this, `flow-triage`, `flow-groom` and `flow-retro` met a
 * refusal under `permissions: default` and simply ended, reported as done. This
 * suite pins the three halves of the fix, for every skill that carries a
 * `schedule:` block, not just the ones shipped today:
 *
 * - **It lists what it needs.** `metadata.flow-needs` names the tools the run
 *   reads with, and each entry is read-tier: flow's own read verbs, exact git
 *   reads, path-scoped reads of flow's folders, or the tracker's reads. A
 *   listing grants nothing; it is what a person (and later a per-schedule allow
 *   list in DorkOS) allows.
 * - **It never raises its mode to get past a refusal.** Security's condition:
 *   the interim fix may change only how a refusal ends. Each shipped schedule
 *   keeps the permission mode it had, and none carries `allowed-tools`.
 * - **A refusal ends red.** Every scheduled skill points, before its first
 *   step, at one rule file: no retry or workaround, park the item through
 *   flow's own path, note it, and a first line that says the run needs a
 *   person, never "done".
 *
 * Each guard is shown to bite on a planted break.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(FLOW_ROOT, 'skills');

/** The permission mode each shipped schedule had before F1, which it must keep. */
const SHIPPED_MODES: Record<string, string> = {
  'flow-drain': 'acceptEdits',
  'flow-groom': 'default',
  'flow-retro': 'default',
  'flow-triage': 'default',
};

/** The one file that says what a scheduled run does about a refused tool. */
const RULE_FILE = 'skills/flow-drain/refused-tool.md';

/** The line each scheduled skill carries, before its first step, pointing at the rule. */
const POINTER = '**Refused tool:** `<flow-root>/skills/flow-drain/refused-tool.md`.';

/** A skill file's leading YAML frontmatter, without its fences. */
function frontmatter(text: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error('no frontmatter');
  return match[1];
}

/** Every skill whose frontmatter carries a `schedule:` block, by name. */
function scheduledSkills(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(SKILLS)) {
    let text: string;
    try {
      text = readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    if (/^schedule:/m.test(frontmatter(text))) out[name] = text;
  }
  return out;
}

/** The `permissions:` value inside a frontmatter's `schedule:` block, if any. */
function scheduleMode(fm: string): string | undefined {
  const block = /^schedule:\n((?: {2}.*\n?)*)/m.exec(fm)?.[1] ?? '';
  return /^ {2}permissions:\s*["']?([\w]+)["']?\s*$/m.exec(block)?.[1];
}

/**
 * The entries of `metadata.flow-needs`, quotes stripped; `null` when it is
 * absent. Every line under the key, up to the next key at its level or above,
 * must be a `    - ` entry: a comment or blank line would otherwise end the
 * list early and hide what follows it from the read-tier check, so it reads as
 * an entry named `unreadable: <line>`, which is never read-tier.
 */
function flowNeeds(fm: string): string[] | null {
  const lines = fm.split('\n');
  const start = lines.indexOf('  flow-needs:');
  // It must sit under `metadata:`: the nearest top-level key above it.
  const owner = lines
    .slice(0, Math.max(start, 0))
    .reverse()
    .find((line) => /^\S/.test(line));
  if (start === -1 || owner !== 'metadata:') return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    const entry = /^ {4}- (.*)$/.exec(line);
    out.push(entry ? entry[1].replace(/^'(.*)'$/, '$1') : `unreadable: ${line}`);
  }
  return out;
}

const ROOT = '${CLAUDE_PLUGIN_ROOT}';
const NODE = 'node --experimental-strip-types';

/** `flow` verbs that only read (or keep flow's own records), allowed as a prefix rule. */
const READ_VERBS = ['snapshot', 'audit', 'next', 'prs', 'autonomy'];

/** `flow` invocations allowed only exactly: their other flags write (`retro --file`). */
const READ_EXACT = ['selftest --json', 'retro --json'];

/** Exact read-only commands outside flow. */
const READ_COMMANDS = ['git worktree list --porcelain', 'git ls-remote --heads origin'];

/**
 * Folders a read may be scoped to: flow's own, in the plugin and in the
 * project. Never `.agents/flow/`: it holds `config.local.json`, the project's
 * secrets and account handles.
 */
const READ_FOLDERS = [`${ROOT}/`, '.dork/flow/'];

/**
 * The one write every list carries: `flow note` adds a line to flow's own
 * journal, which is how a refused tool reaches the weekly retro.
 */
const NOTE_RULE = `Bash(${NODE} "${ROOT}/scripts/flow.ts" note --kind friction:*)`;

/** Every exact entry that is read-tier, built from the lists above. */
const READ_TIER = new Set([
  `Bash(${NODE} "${ROOT}/scripts/config-files.ts")`,
  `Bash(${NODE} "${ROOT}/scripts/recovery.ts":*)`,
  `Bash(${NODE} "${ROOT}/scripts/involvement.ts":*)`,
  NOTE_RULE,
  ...READ_VERBS.map((verb) => `Bash(${NODE} "${ROOT}/scripts/flow.ts" ${verb}:*)`),
  ...READ_EXACT.map((call) => `Bash(${NODE} "${ROOT}/scripts/flow.ts" ${call})`),
  ...READ_COMMANDS.map((command) => `Bash(${command})`),
  'tracker:read',
]);

/** Why a declared need is not read-tier, or `null` when it is. */
function notReadTier(entry: string): string | null {
  if (READ_TIER.has(entry)) return null;
  const read = /^(Read|Grep|Glob)\((.*)\)$/.exec(entry);
  if (read) {
    const target = read[2];
    if (target.includes('..')) return `${entry}: leaves flow's folders`;
    if (!READ_FOLDERS.some((folder) => target.startsWith(folder))) {
      return `${entry}: reads outside flow's folders`;
    }
    return null;
  }
  return `${entry}: not a read`;
}

/** Everything wrong with one scheduled skill, by label. */
function scheduleGaps(name: string, text: string): string[] {
  const fm = frontmatter(text);
  const gaps: string[] = [];
  const needs = flowNeeds(fm);
  if (needs === null || needs.length === 0) gaps.push('lists no flow-needs');
  else if (!needs.includes(NOTE_RULE)) gaps.push('cannot note a refusal');
  for (const entry of needs ?? []) {
    const why = notReadTier(entry);
    if (why) gaps.push(why);
  }
  if (/^(allowed-tools|disallowed-tools):/m.test(fm)) gaps.push('grants tools in frontmatter');
  const mode = scheduleMode(fm);
  const shipped = SHIPPED_MODES[name];
  if (shipped !== undefined && mode !== shipped) gaps.push(`mode ${mode} is not ${shipped}`);
  if (shipped === undefined && mode !== 'default') gaps.push(`a new schedule's mode is ${mode}`);
  return gaps;
}

/** Whether a skill points at the rule before its first step (the pause check). */
function pointsAtRule(text: string): boolean {
  const at = text.indexOf(POINTER);
  const firstStep = text.indexOf('0. **Pause check');
  return at !== -1 && firstStep !== -1 && at < firstStep;
}

/** What the refused-tool rule must say, by label. */
function ruleGaps(rule: string): string[] {
  const needs: [string, RegExp][] = [
    ['applies to every schedule', /Every scheduled flow skill follows this/],
    ['never quietly, never done', /never ends the run quietly, and never\s+as done/],
    ['no retry or workaround', /Don't retry it, and don't use another tool to do the same job/],
    ['starts no new step', /Start no new step/],
    ['parks through triage', /`flow triage <id> --park '<question>'`/],
    ['parks through flow ask', /`flow ask <id>`/],
    ['never takes its own pick', /only a person\s+can allow a tool/],
    [
      'its default pick never grants',
      /the choices "Allow it" and "A person does it", `--pick 2`[\s\S]*Your pick is never "Allow it"/,
    ],
    [
      'a person-does-it answer stops the run',
      /never\s+do the step yourself\.[\s\S]*`flow release <id> --to none --json`[\s\S]*hand it to a person\s+\(`assignToHuman`\) and stop\.[\s\S]*never park it again/,
    ],
    ['parking may be refused too', /Parking writes to the tracker, so it may\s+be refused too/],
    ['notes it in the journal', /`flow note --kind friction/],
    ['a fixed first line', /`FLOW RUN NEEDS YOU: refused <tool> at step <n>`/],
    ['never calls the run done', /Never call the run done/],
    ['never raises permissions', /Never raise the schedule's `permissions`/],
    ['points at the needs list', /`metadata\.flow-needs`/],
    ['points at the docs page', /`<flow-root>\/docs\/refused-tools\.mdx`/],
    ['a watched no is an answer', /declines a tool, that is their answer/],
  ];
  return needs.filter(([, re]) => !re.test(rule)).map(([label]) => label);
}

describe('every scheduled skill lists read-tier needs and keeps its mode', () => {
  it('holds for every skill with a schedule block', () => {
    const skills = scheduledSkills();
    // Non-vacuous: all four shipped schedules are found.
    expect(Object.keys(skills).sort()).toEqual(Object.keys(SHIPPED_MODES).sort());
    for (const [name, text] of Object.entries(skills)) {
      expect({ name, gaps: scheduleGaps(name, text) }).toEqual({ name, gaps: [] });
    }
  });

  it('bites on a write, a broad rule, a raised mode or a grant', () => {
    const triage = scheduledSkills()['flow-triage'];
    const plant = (entry: string) =>
      triage.replace('  flow-needs:\n', `  flow-needs:\n    - '${entry}'\n`);
    expect(scheduleGaps('flow-triage', plant('Bash'))).toEqual(['Bash: not a read']);
    expect(scheduleGaps('flow-triage', plant('Edit(.dork/flow/**)'))).toEqual([
      'Edit(.dork/flow/**): not a read',
    ]);
    expect(scheduleGaps('flow-triage', plant('tracker:write'))).toEqual([
      'tracker:write: not a read',
    ]);
    // A prefix on `retro` would also allow `retro --file`, which files items.
    const retroPrefix = `Bash(${NODE} "${ROOT}/scripts/flow.ts" retro:*)`;
    expect(scheduleGaps('flow-triage', plant(retroPrefix))).toEqual([`${retroPrefix}: not a read`]);
    const claim = `Bash(${NODE} "${ROOT}/scripts/flow.ts" claim:*)`;
    expect(scheduleGaps('flow-triage', plant(claim))).toEqual([`${claim}: not a read`]);
    expect(scheduleGaps('flow-triage', plant('Read(.dork/flow/../../**)'))).toEqual([
      "Read(.dork/flow/../../**): leaves flow's folders",
    ]);
    expect(scheduleGaps('flow-triage', plant('Read(~/.ssh/**)'))).toEqual([
      "Read(~/.ssh/**): reads outside flow's folders",
    ]);
    expect(scheduleGaps('flow-triage', plant('Read'))).toEqual(['Read: not a read']);
    expect(scheduleGaps('flow-triage', plant('Read(.agents/flow/**)'))).toEqual([
      "Read(.agents/flow/**): reads outside flow's folders",
    ]);
    // A comment line must not end the list and hide the entry after it.
    const hidden = triage.replace('  flow-needs:\n', "  flow-needs:\n    # reads\n    - 'Bash'\n");
    expect(scheduleGaps('flow-triage', hidden)).toEqual([
      'unreadable:     # reads: not a read',
      'Bash: not a read',
    ]);
    expect(scheduleGaps('flow-triage', triage.replace(`    - '${NOTE_RULE}'\n`, ''))).toEqual([
      'cannot note a refusal',
    ]);
    expect(
      scheduleGaps('flow-triage', triage.replace('permissions: default', 'permissions: dontAsk'))
    ).toEqual(['mode dontAsk is not default']);
    expect(
      scheduleGaps(
        'flow-drain',
        scheduledSkills()['flow-drain'].replace('acceptEdits', 'bypassPermissions')
      )
    ).toEqual(['mode bypassPermissions is not acceptEdits']);
    expect(
      scheduleGaps('flow-triage', triage.replace('metadata:\n', 'allowed-tools: Read\nmetadata:\n'))
    ).toEqual(['grants tools in frontmatter']);
    expect(scheduleGaps('flow-triage', triage.replace(/^metadata:\n(?: {2}.*\n)*/m, ''))).toEqual([
      'lists no flow-needs',
    ]);
  });

  it('a new schedule must list its needs and start at default', () => {
    const triage = scheduledSkills()['flow-triage'];
    expect(scheduleGaps('flow-new', triage)).toEqual([]);
    expect(
      scheduleGaps('flow-new', triage.replace('permissions: default', 'permissions: acceptEdits'))
    ).toEqual(["a new schedule's mode is acceptEdits"]);
  });
});

describe('a refused tool ends the run red, in every scheduled skill', () => {
  it('every scheduled skill points at one complete rule before its first step', () => {
    for (const [name, text] of Object.entries(scheduledSkills())) {
      expect({ name, points: pointsAtRule(text) }).toEqual({ name, points: true });
    }
    expect(ruleGaps(readFileSync(path.join(FLOW_ROOT, RULE_FILE), 'utf8'))).toEqual([]);
    // The page the rule sends a person to exists and says the same two things.
    const page = readFileSync(path.join(FLOW_ROOT, 'docs/refused-tools.mdx'), 'utf8');
    expect(page).toContain('`FLOW RUN NEEDS YOU: refused <tool> at step <n>`');
    expect(page).toContain('Never switch a flow schedule to a looser permission setting');
  });

  it('bites on a missing pointer or a missing statement', () => {
    const groom = scheduledSkills()['flow-groom'];
    expect(pointsAtRule(groom.replace(POINTER, ''))).toBe(false);
    // A pointer after the steps start comes too late to steer them.
    const late = groom.replace(`${POINTER}\n\n`, '').replace(/\n*$/, `\n\n${POINTER}\n`);
    expect(pointsAtRule(late)).toBe(false);
    const rule = readFileSync(path.join(FLOW_ROOT, RULE_FILE), 'utf8');
    expect(ruleGaps(rule.replace(/Never call the run done[^\n]*/, ''))).toEqual([
      'never calls the run done',
    ]);
    expect(ruleGaps(rule.replace('FLOW RUN NEEDS YOU', 'FLOW RUN DONE'))).toEqual([
      'a fixed first line',
    ]);
    expect(ruleGaps(rule.replace(/only a person\s+can allow a tool/, 'use your pick'))).toEqual([
      'never takes its own pick',
    ]);
    expect(ruleGaps(rule.replace('`--pick 2`', '`--pick 1`'))).toEqual([
      'its default pick never grants',
    ]);
    // Swapping the choices makes pick 2 the grant.
    expect(
      ruleGaps(
        rule.replace('"Allow it" and "A person does it"', '"A person does it" and "Allow it"')
      )
    ).toEqual(['its default pick never grants']);
    expect(ruleGaps(rule.replace(/never\s+do the step yourself/, 'do the step'))).toEqual([
      'a person-does-it answer stops the run',
    ]);
    // Handing over without letting go leaves it claimed, and recovery resumes it.
    expect(ruleGaps(rule.replace('`flow release <id> --to none --json`', '`flow note`'))).toEqual([
      'a person-does-it answer stops the run',
    ]);
  });
});
