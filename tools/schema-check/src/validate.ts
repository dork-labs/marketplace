/**
 * The checks behind `npm run check` in `tools/schema-check`.
 *
 * Two halves, both run against the real DorkOS Zod schemas pinned in
 * `upstream.json`:
 *
 * - {@link validateSkills} — every `SKILL.md` under `plugins/` parses as skill
 *   frontmatter, every line the author wrote survives that parse meaning what
 *   they wrote, and every skill in {@link SCHEDULED_SKILLS} is still schedulable.
 * - {@link validateManifests} — `.claude-plugin/marketplace.json` (against both
 *   the DorkOS schema and the Claude Code standard one), `.claude-plugin/dorkos.json`,
 *   and each plugin's `.dork/manifest.json`.
 *
 * **A passing zod parse is not the bar.** DorkOS frontmatter is built to absorb
 * bad input rather than reject it: unknown keys are dropped, most optional
 * fields carry `.catch(...)`, and `readScheduleField` turns an unreadable
 * `schedule:` block into a complaint the file merely carries. Nothing there
 * throws, so `safeParse` alone says "fine" to `effort: hihg`, to
 * `permissionz: acceptEdits`, and — worst of the three — to `enabled: maybe`,
 * which resolves to `enabled: true` and arms a schedule its author was trying
 * to switch off.
 *
 * All of that is the right trade for a file somebody is editing in their own
 * vault and the wrong one for a package about to be published. So this gate
 * asks a stricter question than "did it parse": it compares what the author
 * WROTE against what the schema KEPT, key by key, and reds on any line that
 * did not survive with its meaning intact. The comparison reads the schema's
 * own shape and upstream's own boolean coercion, so it needs no list of fields
 * here and cannot fall behind a schema change.
 *
 * @module validate
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { ScheduleBlockSchema, hasSchedule } from '@dorkos/skills/schedule-schema';
import { coerceYamlBoolean } from '@dorkos/skills/yaml-boolean';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace/manifest-schema';
import { MarketplaceJsonSchema } from '@dorkos/marketplace/marketplace-json-schema';
import { DorkosSidecarSchema } from '@dorkos/marketplace/dorkos-sidecar-schema';
import { validateAgainstCcSchema } from '@dorkos/marketplace/cc-validator';
import { SCHEDULED_SKILLS } from './scheduled-skills.ts';

/** One thing that is wrong, in terms of the file it is wrong in. */
export interface Finding {
  /** Repo-relative path of the offending file. */
  file: string;
  /** What is wrong and what to do about it, in one sentence. */
  message: string;
}

/** The filename DorkOS and Claude Code both look for. */
const SKILL_FILENAME = 'SKILL.md';

/** Directory holding every package in this marketplace. */
const PLUGINS_DIR = 'plugins';

/** How deep to descend under `plugins/` looking for SKILL.md files. */
const MAX_DEPTH = 6;

/**
 * The keys a `schedule:` block may carry, read off the real schema.
 *
 * Read rather than listed because `ScheduleBlockSchema` is a plain (not strict)
 * object: zod DROPS a key it does not know, so `permissionz: acceptEdits`
 * parses cleanly and silently means nothing. Comparing against the schema's own
 * shape is what turns a misspelled key into an error, and it cannot fall behind
 * upstream because it is not a list anybody maintains here.
 */
const SCHEDULE_KEYS: ReadonlySet<string> = new Set(Object.keys(ScheduleBlockSchema.shape));

/** The top-level frontmatter keys, read off `SkillFrontmatterSchema` the same way. */
const FRONTMATTER_KEYS: ReadonlySet<string> = new Set(Object.keys(SkillFrontmatterSchema.shape));

/**
 * The one top-level key left out of the survived-the-parse comparison.
 *
 * `schedule` is the only field in `SkillFrontmatterSchema` carrying a
 * `.transform()`: what comes out is a `ScheduleBlock` with defaults filled in,
 * never the mapping the author typed, so comparing the two would red on every
 * scheduled skill in the repo. It is excluded here because it gets a better
 * check of its own — {@link checkScheduleBlock} runs the same comparison one
 * level down, against the block's own schema.
 */
const TRANSFORMED_KEYS: ReadonlySet<string> = new Set(['schedule']);

/**
 * Whether two frontmatter values mean the same thing.
 *
 * Structural equality, plus upstream's own reading of the YAML 1.1 boolean
 * words: `enabled: yes` parses to `true` and that is the author getting what
 * they asked for, not a value being dropped. Reusing `coerceYamlBoolean` rather
 * than restating the word list is what keeps this from being a second opinion
 * about what DorkOS accepts.
 *
 * @param wrote - The value as it came out of the YAML parser.
 * @param kept - The value the schema produced.
 */
function meansTheSame(wrote: unknown, kept: unknown): boolean {
  const same = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return same(wrote, kept) || same(coerceYamlBoolean(wrote), kept);
}

/** A line the author wrote that the schema quietly replaced or threw away. */
interface Degraded {
  /** The key as written. */
  key: string;
  /** The value as written. */
  wrote: unknown;
  /** What the schema resolved it to instead. */
  kept: unknown;
}

/**
 * Every key the author wrote whose value did not survive the parse.
 *
 * This is the check that makes a passing `safeParse` mean something. Most
 * optional fields in both schemas end in `.catch(...)`, so zod never reports
 * them as invalid — it substitutes a fallback and returns success. Five fields
 * of the twelve in a `schedule:` block behave that way (`enabled`, `sticky`,
 * `runtime`, `model`, `effort`), and most of the top-level frontmatter does
 * too. Comparing the input against the output finds all of them at once,
 * without this file holding any opinion about which fields those are.
 *
 * @param wrote - The raw mapping from the YAML parser.
 * @param kept - The same mapping after the schema parsed it.
 * @param known - The keys the schema declares; anything else is somebody else's
 * finding (see the unknown-key checks) and is skipped here to avoid saying it twice.
 * @param skip - Keys whose schema entry transforms its input, so input and
 * output are not comparable ({@link TRANSFORMED_KEYS}).
 */
function degradedKeys(
  wrote: Record<string, unknown>,
  kept: Record<string, unknown>,
  known: ReadonlySet<string>,
  skip: ReadonlySet<string> = new Set()
): Degraded[] {
  const found: Degraded[] = [];
  for (const [key, value] of Object.entries(wrote)) {
    if (!known.has(key) || skip.has(key)) continue;
    if (meansTheSame(value, kept[key])) continue;
    found.push({ key, wrote: value, kept: kept[key] });
  }
  return found;
}

/**
 * Render one dropped line as a sentence for whoever typed it.
 *
 * @param where - What the line belongs to, e.g. `schedule`.
 * @param degraded - The line.
 */
function describeDegraded(where: string, degraded: Degraded): string {
  const wrote = JSON.stringify(degraded.wrote);
  const kept = degraded.kept === undefined ? 'nothing at all' : JSON.stringify(degraded.kept);
  return (
    `Its ${where} says ${degraded.key}: ${wrote}, which DorkOS cannot read. ` +
    `It silently uses ${kept} instead, so this skill would run with a setting nobody chose.`
  );
}

/**
 * How many single-character edits separate two words.
 *
 * Used only to guess whether a stray top-level key was meant to be `schedule`,
 * so the message can say so. Wrong guesses cost nothing: the key is already an
 * error either way.
 *
 * @param a - First word.
 * @param b - Second word.
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Whether a key looks like somebody trying to write `schedule`.
 *
 * @param key - The unknown key.
 */
function looksLikeSchedule(key: string): boolean {
  return editDistance(key.toLowerCase(), 'schedule') <= 2;
}

/**
 * Turn zod's account of a rejection into one line naming the field.
 *
 * @param error - The rejection.
 * @returns Up to three issues, `field: message`, comma-separated.
 */
function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Every `SKILL.md` under `plugins/`, as repo-relative paths, sorted.
 *
 * The walk is deliberately wider than `plugins/*​/skills/*​/SKILL.md`: skills
 * nest, and the flow plugin also ships them under `adapters/reference/`. A
 * schedule block is a property of the file, never of where the file sits.
 *
 * @param repoRoot - Absolute path to the repository root.
 */
export function findSkillFiles(repoRoot: string): string[] {
  const found: string[] = [];
  const walk = (relDir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const absDir = path.join(repoRoot, relDir);
    if (!existsSync(absDir)) return;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) walk(rel, depth + 1);
      else if (entry.name === SKILL_FILENAME) found.push(rel);
    }
  };
  walk(PLUGINS_DIR, 0);
  return found.sort();
}

/**
 * Read a SKILL.md's frontmatter.
 *
 * @param absPath - Absolute path to the file.
 * @returns The frontmatter mapping, or a parse failure message.
 */
function readFrontmatter(absPath: string): { data: Record<string, unknown> } | { error: string } {
  try {
    const parsed = matter(readFileSync(absPath, 'utf8'));
    return { data: parsed.data as Record<string, unknown> };
  } catch (cause) {
    return { error: `Its frontmatter is not valid YAML (${(cause as Error).message}).` };
  }
}

/**
 * Check a skill's `schedule:` block: that it parses, that every setting name is
 * one DorkOS knows, and that every value the author wrote survived the parse.
 *
 * @param raw - Whatever sat under the `schedule:` key.
 * @returns One message per problem.
 */
function checkScheduleBlock(raw: unknown): string[] {
  const block = ScheduleBlockSchema.safeParse(raw);
  if (!block.success) {
    return [
      `Its schedule block is broken — ${describe(block.error)}. ` +
        'DorkOS installs this file anyway and quietly drops the schedule, so the task would never run.',
    ];
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];

  const written = raw as Record<string, unknown>;
  const messages: string[] = [];

  for (const key of Object.keys(written)) {
    if (SCHEDULE_KEYS.has(key)) continue;
    messages.push(
      `Its schedule block has a setting called "${key}", which DorkOS does not know and ignores. ` +
        `Did you mean one of: ${[...SCHEDULE_KEYS].join(', ')}?`
    );
  }

  for (const degraded of degradedKeys(written, block.data, SCHEDULE_KEYS)) {
    messages.push(describeDegraded('schedule', degraded));
  }

  return messages;
}

/**
 * Check one SKILL.md's frontmatter and, if it has one, its `schedule:` block.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param file - Repo-relative path to the SKILL.md.
 * @returns Findings for this file, and whether it declares a schedule at all.
 */
function checkSkillFile(
  repoRoot: string,
  file: string
): { findings: Finding[]; declaresSchedule: boolean } {
  const messages: string[] = [];
  const read = readFrontmatter(path.join(repoRoot, file));
  if ('error' in read)
    return { findings: [{ file, message: read.error }], declaresSchedule: false };

  const raw = read.data;
  const declaresSchedule = raw.schedule !== undefined && raw.schedule !== null;

  const frontmatter = SkillFrontmatterSchema.safeParse(raw);
  if (!frontmatter.success) {
    return {
      findings: [{ file, message: `Its frontmatter is invalid — ${describe(frontmatter.error)}` }],
      declaresSchedule,
    };
  }

  // Same two checks as the block below, one level up: DorkOS drops a top-level
  // key it does not know and `.catch(...)`es most of the ones it does, so a
  // `modle:` or a `background: sometimes` is invisible without them. A key that
  // is nearly `schedule` gets called out by name — that spelling is the one
  // that costs a whole scheduled task.
  for (const key of Object.keys(raw)) {
    if (FRONTMATTER_KEYS.has(key)) continue;
    messages.push(
      looksLikeSchedule(key)
        ? `Its frontmatter has a "${key}:" key, which DorkOS ignores. Did you mean "schedule:"?`
        : `Its frontmatter has a "${key}:" key, which DorkOS does not know and ignores.`
    );
  }
  for (const degraded of degradedKeys(raw, frontmatter.data, FRONTMATTER_KEYS, TRANSFORMED_KEYS)) {
    messages.push(describeDegraded('frontmatter', degraded));
  }

  if (declaresSchedule) {
    messages.push(...checkScheduleBlock(raw.schedule));

    // The question every DorkOS scheduler surface actually asks of a skill. It
    // is implied by the checks above, and asserting it directly is what keeps
    // this gate honest if the way a block degrades ever changes upstream.
    if (messages.length === 0 && !hasSchedule(frontmatter.data)) {
      messages.push('It declares a schedule, but DorkOS does not read it as a scheduled task.');
    }
  }

  return { findings: messages.map((message) => ({ file, message })), declaresSchedule };
}

/**
 * Validate every SKILL.md under `plugins/`, and the schedules that must survive.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param required - Skill directories that must stay schedulable. Defaults to
 * {@link SCHEDULED_SKILLS}; overridden by the tests.
 * @returns Every problem found, in file order.
 */
export function validateSkills(
  repoRoot: string,
  required: readonly string[] = SCHEDULED_SKILLS
): Finding[] {
  const findings: Finding[] = [];
  const declared = new Set<string>();

  for (const file of findSkillFiles(repoRoot)) {
    const result = checkSkillFile(repoRoot, file);
    findings.push(...result.findings);
    if (result.declaresSchedule) declared.add(path.dirname(file));
  }

  for (const dir of required) {
    const file = path.join(dir, SKILL_FILENAME);
    if (!existsSync(path.join(repoRoot, file))) {
      findings.push({
        file,
        message:
          'This skill is listed in src/scheduled-skills.ts as one that must stay scheduled, but the file is gone. ' +
          'Restore it, or remove it from that list.',
      });
      continue;
    }
    if (!declared.has(dir)) {
      findings.push({
        file,
        message:
          'This skill must stay scheduled (see src/scheduled-skills.ts), but its frontmatter has no schedule block. ' +
          'Check the spelling of the "schedule:" key.',
      });
    }
  }

  const requiredSet = new Set(required);
  for (const dir of [...declared].sort()) {
    if (requiredSet.has(dir)) continue;
    findings.push({
      file: path.join(dir, SKILL_FILENAME),
      message:
        'This skill has a schedule block but is not listed in src/scheduled-skills.ts, so nothing would notice if the block disappeared. ' +
        `Add '${dir}' to SCHEDULED_SKILLS.`,
    });
  }

  return findings;
}

/**
 * Parse a JSON file.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param file - Repo-relative path.
 * @returns The parsed value, or a finding describing why it could not be read.
 */
function readJson(repoRoot: string, file: string): { value: unknown } | { finding: Finding } {
  const abs = path.join(repoRoot, file);
  if (!existsSync(abs)) return { finding: { file, message: 'This file is missing.' } };
  try {
    return { value: JSON.parse(readFileSync(abs, 'utf8')) };
  } catch (cause) {
    return { finding: { file, message: `This is not valid JSON (${(cause as Error).message}).` } };
  }
}

/**
 * Plugin directory names under `plugins/`, sorted.
 *
 * @param repoRoot - Absolute path to the repository root.
 */
function pluginDirs(repoRoot: string): string[] {
  const abs = path.join(repoRoot, PLUGINS_DIR);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Validate the registry files and each plugin's package manifest.
 *
 * A plugin without a `.dork/manifest.json` is skipped rather than failed: most
 * of the seed packages predate the manifest and DorkOS installs them from
 * `marketplace.json` alone. What is checked is that a manifest that IS there
 * says something DorkOS can read.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns Every problem found.
 */
export function validateManifests(repoRoot: string): Finding[] {
  const findings: Finding[] = [];

  const marketplaceFile = '.claude-plugin/marketplace.json';
  const marketplace = readJson(repoRoot, marketplaceFile);
  if ('finding' in marketplace) {
    findings.push(marketplace.finding);
  } else {
    const parsed = MarketplaceJsonSchema.safeParse(marketplace.value);
    if (!parsed.success) {
      findings.push({ file: marketplaceFile, message: describe(parsed.error) });
    }
    // Claude Code reads this same file, so it has to satisfy the standard
    // schema too — a DorkOS-only extra here breaks every `claude` install.
    const cc = validateAgainstCcSchema(marketplace.value);
    if (!cc.ok) {
      findings.push({
        file: marketplaceFile,
        message: `Not valid as a Claude Code marketplace — ${describe(new z.ZodError(cc.errors))}`,
      });
    }
    findings.push(...checkSourcePaths(repoRoot, marketplaceFile, marketplace.value));
  }

  const sidecarFile = '.claude-plugin/dorkos.json';
  const sidecar = readJson(repoRoot, sidecarFile);
  if ('finding' in sidecar) {
    findings.push(sidecar.finding);
  } else {
    const parsed = DorkosSidecarSchema.safeParse(sidecar.value);
    if (!parsed.success) findings.push({ file: sidecarFile, message: describe(parsed.error) });
  }

  for (const name of pluginDirs(repoRoot)) {
    const file = path.join(PLUGINS_DIR, name, '.dork', 'manifest.json');
    if (!existsSync(path.join(repoRoot, file))) continue;
    const manifest = readJson(repoRoot, file);
    if ('finding' in manifest) {
      findings.push(manifest.finding);
      continue;
    }
    const parsed = MarketplacePackageManifestSchema.safeParse(manifest.value);
    if (!parsed.success) findings.push({ file, message: describe(parsed.error) });
  }

  return findings;
}

/**
 * Check that every local `source` in `marketplace.json` points at a directory
 * that exists. Remote sources (a `{ source: 'github', ... }` object) are the
 * other repo's problem and are left alone.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param file - Repo-relative path of `marketplace.json`, for the findings.
 * @param value - The parsed file.
 */
function checkSourcePaths(repoRoot: string, file: string, value: unknown): Finding[] {
  const findings: Finding[] = [];
  // A `null` or scalar file already failed the schema above; reading `.plugins`
  // off it would throw and take every finding gathered so far down with it.
  if (typeof value !== 'object' || value === null) return findings;
  const plugins = (value as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return findings;
  for (const entry of plugins) {
    const source = (entry as { source?: unknown }).source;
    const name = (entry as { name?: unknown }).name;
    if (typeof source !== 'string' || !source.startsWith('.')) continue;
    if (existsSync(path.join(repoRoot, source))) continue;
    findings.push({
      file,
      message: `The entry "${String(name)}" points at ${source}, which does not exist.`,
    });
  }
  return findings;
}

/**
 * Run every check.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns Every problem found, skills first.
 */
export function validateRepo(repoRoot: string): Finding[] {
  return [...validateSkills(repoRoot), ...validateManifests(repoRoot)];
}
