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

/** The `scope:` value inside a frontmatter's `schedule:` block, if any. */
function scheduleScope(fm: string): string | undefined {
  const block = /^schedule:\n((?: {2}.*\n?)*)/m.exec(fm)?.[1] ?? '';
  return /^ {2}scope:\s*["']?([\w]+)["']?\s*$/m.exec(block)?.[1];
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

/**
 * `flow` verbs that only read, allowed as a prefix rule: none of their flags
 * writes a file or picks a remote (`prs` takes only `--for` and `--no-behind`).
 * Never `snapshot`: its `--out` writes to any path it is given.
 */
const READ_VERBS = ['audit', 'next', 'prs', 'autonomy'];

/**
 * `flow` invocations allowed only exactly: their other flags write (`retro --file`,
 * `snapshot --out`). The one `snapshot --out` is flow's own fixed scratch file.
 */
const READ_EXACT = [
  'selftest --json',
  'retro --json',
  'snapshot --json',
  'snapshot --include-closed --out .dork/flow/tmp/groom/backlog.json',
  // DOR-3258: one fixed `gh issue list` per configured repo, and flow's own
  // mark file. The repos come from config, never from an argument.
  'intake --json',
  'intake done --json',
];

/**
 * Exact read-only commands outside flow. Never a git command that talks to a
 * remote (`ls-remote`, `fetch`, `pull`): it runs whatever the repo's own config
 * names (`core.sshCommand`, `url.*.insteadOf`), and an agent can write that.
 */
const READ_COMMANDS = ['git worktree list --porcelain'];

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
    // `snapshot --out` writes wherever it is pointed, so no prefix and no other path.
    for (const snapshot of [
      'snapshot:*',
      'snapshot --out ../x.json',
      'snapshot --out ~/x.json',
      'snapshot --include-closed --out ../groom/backlog.json',
    ]) {
      const entry = `Bash(${NODE} "${ROOT}/scripts/flow.ts" ${snapshot})`;
      expect(scheduleGaps('flow-triage', plant(entry))).toEqual([`${entry}: not a read`]);
    }
    // Intake is exact only (DOR-3258): a prefix would take --project, and no rule names gh.
    for (const intake of ['intake:*', 'intake --project ../other --json']) {
      const entry = `Bash(${NODE} "${ROOT}/scripts/flow.ts" ${intake})`;
      expect(scheduleGaps('flow-triage', plant(entry))).toEqual([`${entry}: not a read`]);
    }
    for (const gh of ['gh:*', 'gh issue list:*', 'gh issue list -R acme/app --json number']) {
      expect(scheduleGaps('flow-triage', plant(`Bash(${gh})`))).toEqual([
        `Bash(${gh}): not a read`,
      ]);
    }
    // Git that talks to a remote runs whatever the repo's own config names.
    for (const remote of ['git ls-remote --heads origin', 'git fetch', 'git pull']) {
      expect(scheduleGaps('flow-triage', plant(`Bash(${remote})`))).toEqual([
        `Bash(${remote}): not a read`,
      ]);
    }
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

// DOR-3376: every flow schedule needs a project to work in. From a global
// install DorkOS would otherwise list it as a global schedule with no project;
// `scope: project` makes it one switch per project instead, off until approved.
describe('every scheduled skill is project-only', () => {
  it('says scope: project in its schedule block', () => {
    const skills = scheduledSkills();
    expect(Object.keys(skills).sort()).toEqual(Object.keys(SHIPPED_MODES).sort());
    for (const [name, text] of Object.entries(skills)) {
      expect({ name, scope: scheduleScope(frontmatter(text)) }).toEqual({ name, scope: 'project' });
    }
  });

  it('bites on a missing scope, another value, or a scope outside the block', () => {
    const groom = scheduledSkills()['flow-groom'];
    expect(scheduleScope(frontmatter(groom.replace('  scope: project\n', '')))).toBeUndefined();
    expect(scheduleScope(frontmatter(groom.replace('scope: project', 'scope: global')))).toBe(
      'global'
    );
    const moved = groom
      .replace('  scope: project\n', '')
      .replace('metadata:\n', 'metadata:\n  scope: project\n');
    expect(scheduleScope(frontmatter(moved))).toBeUndefined();
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

/**
 * `agent/from-outside` (Security on #128): only a person, or the PM in its own
 * triage, clears it. No flow skill removes it, attended or not; flow lists the
 * items and closes one when a person says so. The rule is stated where triage,
 * readiness and capture are taught, and no shipped prose says otherwise.
 */
const FROM_OUTSIDE_RULE: Record<string, RegExp> = {
  'skills/flow-triage/SKILL.md': /never removing `agent\/from-outside`/,
  'skills/triaging-work/SKILL.md': /Never remove `agent\/from-outside`\*\*, attended or not/,
  'docs/intake.mdx': /Flow never removes it, attended or not/,
};

/** Groom's two places, both required (the second keeps operator-only work from stripping it). */
const GROOM_RULES = [
  /Never remove `agent\/from-outside`\*\*, in any phase/,
  /no agent label \(an `agent\/from-outside` item keeps it\)/,
];

/** Every shipped prose file: skills, commands and docs. */
function shippedProse(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(FLOW_ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.mdx?$/.test(entry.name))
        out[child] = readFileSync(path.join(FLOW_ROOT, child), 'utf8');
    }
  };
  for (const rel of ['skills', 'commands', 'docs']) walk(rel);
  return out;
}

/** A file's sentences: list items and paragraphs apart, then split at sentence ends. */
function sentences(text: string): string[] {
  return text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).flatMap((block) =>
    block
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s/)
  );
}

/** Words that take the label off, in any form. */
const REMOVE =
  /\b(?:remov|clear|drop|delet|strip|replac|swap|relabel|unset|untag|take off|takes off)\w*|agentLabel:\s*null/i;
/** Words that forbid it, or say who alone may do it; they must come BEFORE the verb. */
const FORBID = /\b(?:never|not|no|nothing|refuses?|only a person|only the PM)\b/i;

/** Gaps: the rule missing where it is taught, or a sentence that tells flow to remove the label. */
function fromOutsideGaps(files: Record<string, string>): string[] {
  const gaps: string[] = [];
  for (const [file, rule] of Object.entries(FROM_OUTSIDE_RULE)) {
    if (!rule.test(files[file] ?? '')) gaps.push(`${file}: states the rule`);
  }
  for (const rule of GROOM_RULES) {
    if (!rule.test(files['skills/grooming-backlog/SKILL.md'] ?? '')) {
      gaps.push('skills/grooming-backlog/SKILL.md: states the rule');
    }
  }
  for (const [file, text] of Object.entries(files)) {
    for (const sentence of sentences(text)) {
      if (!sentence.includes('agent/from-outside') && !/this label/i.test(sentence)) continue;
      const verb = REMOVE.exec(sentence);
      if (verb === null) continue;
      const forbid = FORBID.exec(sentence);
      if (forbid !== null && forbid.index < verb.index) continue;
      gaps.push(`${file}: "${sentence.slice(0, 80)}"`);
    }
  }
  return gaps;
}

describe('agent/from-outside: no flow skill removes it', () => {
  it('the rule is stated where it is taught, and nothing shipped says otherwise', () => {
    expect(fromOutsideGaps(shippedProse())).toEqual([]);
  });

  it('bites on a dropped rule, or a step that removes the label', () => {
    const files = shippedProse();
    files['skills/triaging-work/SKILL.md'] = files['skills/triaging-work/SKILL.md'].replace(
      'Never remove `agent/from-outside`',
      'Mind `agent/from-outside`'
    );
    files['skills/grooming-backlog/SKILL.md'] = files['skills/grooming-backlog/SKILL.md'].replace(
      ' (an `agent/from-outside` item keeps it)',
      ''
    );
    files['skills/flow-groom/SKILL.md'] += [
      '',
      '- Remove `agent/from-outside` only once the item reads well',
      '- Drop `agent/from-outside`; never leave it on a readied item.',
      '- Replace `agent/from-outside` with `agent/ready`.',
      '- Write `agentLabel: null` on an `agent/from-outside` item.',
      '- Nothing removes `agent/from-outside`.',
      '',
    ].join('\n');
    expect(fromOutsideGaps(files)).toEqual([
      'skills/triaging-work/SKILL.md: states the rule',
      'skills/grooming-backlog/SKILL.md: states the rule',
      'skills/flow-groom/SKILL.md: "- Remove `agent/from-outside` only once the item reads well"',
      'skills/flow-groom/SKILL.md: "- Drop `agent/from-outside`; never leave it on a readied item."',
      'skills/flow-groom/SKILL.md: "- Replace `agent/from-outside` with `agent/ready`."',
      'skills/flow-groom/SKILL.md: "- Write `agentLabel: null` on an `agent/from-outside` item."',
    ]);
  });
});
