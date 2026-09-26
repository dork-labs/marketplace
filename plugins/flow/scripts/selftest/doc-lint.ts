/**
 * Doc lint: the checks `flow selftest`'s fast tier runs over flow's own prose
 * (spec `specs/flow-self-improvement/02-specification.md` §1, DOR-2390).
 *
 * Every mistake of the 2026-09-25/26 session happened in the prose half of the
 * plugin, which had no check at all. These five rules are the cheap ones:
 *
 * - `doc-lint/words`: a word-count ratchet per file (never grow past the baseline).
 * - `doc-lint/duplicate-rule`: the same long sentence in two files.
 * - `doc-lint/links`: relative links to files and anchors that do not exist.
 * - `doc-lint/frontmatter`: skill and command frontmatter, and `schedule:` blocks.
 * - `doc-lint/war-stories`: dated incidents or tracker ids inside a skill's steps.
 *
 * The rules are pure functions over `{ path, text }` records (paths relative to
 * the flow root, `/`-separated); reading files is injected, so tests run on
 * in-memory trees. No dependency beyond node builtins, so an install without the
 * contributor toolchain can run it.
 *
 * @module @dorkos/flow/selftest/doc-lint
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** One file of the corpus: its path relative to the flow root, and its text. */
export interface DocFile {
  /** Path relative to the flow root, `/`-separated (for example `skills/x/SKILL.md`). */
  path: string;
  /** The file's full text. */
  text: string;
}

/** The five doc-lint rule ids. */
export type DocLintRule =
  | 'doc-lint/words'
  | 'doc-lint/duplicate-rule'
  | 'doc-lint/links'
  | 'doc-lint/frontmatter'
  | 'doc-lint/war-stories';

/** Every rule, in the order the fast tier reports them. */
export const DOC_LINT_RULES: readonly DocLintRule[] = [
  'doc-lint/words',
  'doc-lint/duplicate-rule',
  'doc-lint/links',
  'doc-lint/frontmatter',
  'doc-lint/war-stories',
];

/** One breach of one rule. */
export interface Finding {
  /** The rule that failed. */
  rule: DocLintRule;
  /** The file the breach is in (the first file, for a duplicate). */
  path: string;
  /** What is wrong, in one line a person can act on. */
  detail: string;
  /**
   * A stable key for the breach, free of counts and line numbers, so the same
   * problem gets the same fingerprint run after run.
   */
  key: string;
}

/** A file's word budget: the ratchet baseline and where the file should end up. */
export interface WordBudget {
  /** The most words the file may have today; it can only go down. */
  baseline: number;
  /** The count the file is being trimmed toward. */
  target: number;
}

/** `selftest/word-budgets.json`: a budget per corpus file. */
export type WordBudgets = Record<string, WordBudget>;

/** `selftest/duplicate-allow.json`: repeats that are allowed, each with a reason. */
export interface DuplicateAllow {
  /**
   * Normalized sentences (the `key` a duplicate finding carries), the files each
   * may repeat in, and why. A copy into any other file still fails.
   */
  sentences: Array<{ text: string; paths: string[]; reason: string }>;
}

/** `selftest/war-story-allow.json`: id prefixes that are not tracker ids, and allowed lines. */
export interface WarStoryAllow {
  /** Id prefixes that name rules, not tracker items (for example `INV` for INV-3), with why. */
  rulePrefixes: Record<string, string>;
  /** Lines (trimmed, exact) allowed to keep their date or id, per file. */
  lines: Array<{ path: string; text: string; reason?: string }>;
}

/** Everything the rules read besides the corpus itself. */
export interface LintConfig {
  /** The word budgets. */
  budgets: WordBudgets;
  /** The allowed duplicate sentences. */
  duplicates: DuplicateAllow;
  /** The war-story allowances. */
  warStories: WarStoryAllow;
}

/** Where the budget and allow files live, relative to the flow root. */
export const LINT_CONFIG_DIR = 'selftest';
/** The word budget file name. */
export const WORD_BUDGETS_FILE = 'word-budgets.json';
/** The duplicate allow file name. */
export const DUPLICATE_ALLOW_FILE = 'duplicate-allow.json';
/** The war-story allow file name. */
export const WAR_STORY_ALLOW_FILE = 'war-story-allow.json';

/** A sentence needs at least this many words before a repeat counts as a copied rule. */
const MIN_DUPLICATE_WORDS = 8;

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/**
 * Split a file into its YAML frontmatter (without the fences) and its body.
 *
 * @param text - The file text.
 * @returns The frontmatter text, or `null` when the file has none, and the body.
 */
function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return { frontmatter: null, body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/**
 * Replace the lines of fenced code blocks with empty lines, keeping line numbers.
 * A fence is any line whose trimmed text starts with three backticks or tildes.
 *
 * @param text - Markdown text.
 * @returns The lines, with every line inside (and including) a fence blanked.
 */
function linesOutsideFences(text: string): string[] {
  let inFence = false;
  return text.split(/\r?\n/).map((line) => {
    const fence = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(```|~~~)/.test(line);
    if (fence) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line;
  });
}

/** Remove inline code spans from a line. */
function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, ' ');
}

// ---------------------------------------------------------------------------
// doc-lint/words
// ---------------------------------------------------------------------------

/**
 * Count the whitespace-separated words of a text (frontmatter and code included:
 * the budget measures what an agent has to read).
 *
 * @param text - Any text.
 * @returns The word count.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * The word ratchet: every corpus file needs a budget, and may not grow past its
 * baseline.
 *
 * @param files - The corpus.
 * @param budgets - The committed budgets.
 * @returns One finding per file over its baseline or without a budget.
 */
export function checkWords(files: readonly DocFile[], budgets: WordBudgets): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const count = countWords(file.text);
    const budget = budgets[file.path];
    if (budget === undefined) {
      findings.push({
        rule: 'doc-lint/words',
        path: file.path,
        detail: `${count} words and no entry in ${LINT_CONFIG_DIR}/${WORD_BUDGETS_FILE}: add a budget`,
        key: file.path,
      });
    } else if (count > budget.baseline) {
      findings.push({
        rule: 'doc-lint/words',
        path: file.path,
        detail: `${count} words, above its baseline of ${budget.baseline} (target ${budget.target}): trim it back`,
        key: file.path,
      });
    }
  }
  return findings;
}

/**
 * Lower each baseline to today's count (never raise one), and add a budget at
 * today's count for a file that has none. A file that grew keeps its baseline, so
 * it still fails: rebaselining cannot launder growth.
 *
 * @param files - The corpus.
 * @param budgets - The current budgets.
 * @returns The new budgets, sorted by path.
 */
export function rebaseline(files: readonly DocFile[], budgets: WordBudgets): WordBudgets {
  const next: WordBudgets = {};
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const count = countWords(file.text);
    const budget = budgets[file.path];
    if (budget === undefined) {
      next[file.path] = { baseline: count, target: count };
    } else {
      const baseline = Math.min(budget.baseline, count);
      next[file.path] = { baseline, target: Math.min(budget.target, baseline) };
    }
  }
  return next;
}

/**
 * Total words over the corpus and the words still above target, for the report.
 *
 * @param files - The corpus.
 * @param budgets - The committed budgets.
 * @returns The corpus total and the sum of each file's excess over its target.
 */
export function wordSummary(
  files: readonly DocFile[],
  budgets: WordBudgets
): { total: number; overTarget: number } {
  let total = 0;
  let overTarget = 0;
  for (const file of files) {
    const count = countWords(file.text);
    total += count;
    const budget = budgets[file.path];
    if (budget !== undefined && count > budget.target) overTarget += count - budget.target;
  }
  return { total, overTarget };
}

// ---------------------------------------------------------------------------
// doc-lint/duplicate-rule
// ---------------------------------------------------------------------------

/**
 * Normalize a sentence for comparison: markdown and punctuation stripped,
 * lowercased, whitespace collapsed.
 *
 * @param sentence - Raw sentence text.
 * @returns The normalized sentence.
 */
export function normalizeSentence(sentence: string): string {
  return sentence
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a markdown body into sentences: paragraphs are joined across their line
 * breaks, while each list item, heading and table row starts a new block; then
 * each block splits after `.`, `!` or `?`.
 *
 * @param text - Markdown text (frontmatter included; it is skipped).
 * @returns The raw sentences.
 */
function sentencesOf(text: string): string[] {
  const { body } = splitFrontmatter(text);
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join(' '));
    current = [];
  };
  for (const raw of linesOutsideFences(body)) {
    const line = stripInlineCode(raw).trim();
    if (line === '' || /^(import|export)\s|^<\/?[A-Za-z]/.test(line)) {
      // MDX imports, exports and JSX tags are page plumbing, not prose.
      flush();
    } else if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/.test(line)) {
      flush();
      current.push(line);
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks.flatMap((block) => block.split(/(?<=[.!?])\s+/));
}

/**
 * Find long sentences that appear in two or more files. Each shared rule should
 * live in exactly one file.
 *
 * @param files - The corpus.
 * @param allow - Repeats allowed on purpose.
 * @returns One finding per repeated sentence, naming every file it is in.
 */
export function checkDuplicates(files: readonly DocFile[], allow: DuplicateAllow): Finding[] {
  const allowed = new Map(allow.sentences.map((s) => [s.text, new Set(s.paths)]));
  const seen = new Map<string, string[]>();
  for (const file of files) {
    const mine = new Set<string>();
    for (const sentence of sentencesOf(file.text)) {
      const norm = normalizeSentence(sentence);
      if (norm.split(' ').length < MIN_DUPLICATE_WORDS || mine.has(norm)) continue;
      mine.add(norm);
      const paths = seen.get(norm) ?? [];
      paths.push(file.path);
      seen.set(norm, paths);
    }
  }
  const findings: Finding[] = [];
  for (const [norm, paths] of seen) {
    if (paths.length < 2) continue;
    const allowedPaths = allowed.get(norm);
    const extra = allowedPaths === undefined ? paths : paths.filter((p) => !allowedPaths.has(p));
    if (extra.length === 0) continue;
    const excerpt = norm.length > 80 ? `${norm.slice(0, 77)}...` : norm;
    findings.push({
      rule: 'doc-lint/duplicate-rule',
      path: extra[0],
      detail:
        allowedPaths === undefined
          ? `"${excerpt}" appears in ${paths.join(', ')}: keep it in one file`
          : `"${excerpt}" is allowed in ${[...allowedPaths].join(', ')} and was copied into ${extra.join(', ')}: keep it in one file`,
      key: norm,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// doc-lint/links
// ---------------------------------------------------------------------------

/**
 * The anchor slugs of a markdown file's headings, the way GitHub makes them:
 * lowercased, punctuation dropped, spaces to hyphens, repeats suffixed `-1`, `-2`.
 *
 * @param text - Markdown text.
 * @returns Every heading's slug, in order.
 */
export function headingSlugs(text: string): string[] {
  const counts = new Map<string, number>();
  const slugs: string[] = [];
  for (const line of linesOutsideFences(text)) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (match === null) continue;
    const base = match[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    slugs.push(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

/**
 * Check every relative markdown link: its file (or directory) exists and its
 * `#anchor` names a heading there. Web links, `mailto:`, site-absolute paths
 * (`/docs/...`) and links inside code are skipped.
 *
 * @param files - The corpus.
 * @param read - Reads a path relative to the flow root: its text, `''` for a
 *   directory, or `null` when nothing is there.
 * @returns One finding per broken link.
 */
export function checkLinks(
  files: readonly DocFile[],
  read: (relPath: string) => string | null
): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const dir = path.posix.dirname(file.path);
    for (const raw of linesOutsideFences(file.text)) {
      const line = stripInlineCode(raw);
      for (const match of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const href = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue;
        const [target, anchor] = href.split('#', 2);
        const targetPath =
          target === '' ? file.path : path.posix.normalize(path.posix.join(dir, target));
        const text = target === '' ? file.text : read(targetPath);
        if (text === null) {
          findings.push({
            rule: 'doc-lint/links',
            path: file.path,
            detail: `link to ${href}: ${targetPath} does not exist`,
            key: `${file.path}->${href}`,
          });
        } else if (anchor !== undefined && anchor !== '' && !headingSlugs(text).includes(anchor)) {
          findings.push({
            rule: 'doc-lint/links',
            path: file.path,
            detail: `link to ${href}: ${targetPath} has no heading #${anchor}`,
            key: `${file.path}->${href}`,
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// doc-lint/frontmatter
// ---------------------------------------------------------------------------

/**
 * Parse the small YAML subset flow's frontmatter uses: top-level `key: value`
 * pairs and one level of indented `key: value` under a bare `key:`. Values lose
 * their surrounding quotes. Anything else is ignored.
 *
 * @param frontmatter - The frontmatter text.
 * @returns Top-level scalars, and nested maps by their parent key.
 */
function parseFrontmatter(frontmatter: string): {
  scalars: Record<string, string>;
  maps: Record<string, Record<string, string>>;
} {
  const scalars: Record<string, string> = {};
  const maps: Record<string, Record<string, string>> = {};
  let parent: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const nested = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    const top = /^([\w-]+):\s*(.*)$/.exec(line);
    if (nested !== null && parent !== null) {
      maps[parent][nested[1]] = unquote(nested[2]);
    } else if (top !== null) {
      if (top[2] === '') {
        parent = top[1];
        maps[parent] = {};
      } else {
        parent = null;
        scalars[top[1]] = unquote(top[2]);
      }
    }
  }
  return { scalars, maps };
}

/** Strip one pair of matching surrounding quotes. */
function unquote(value: string): string {
  const v = value.trim();
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/** Whether a string is a five-field cron expression of digits, `*`, `,`, `-` and `/`. */
function isFiveFieldCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^[\d*,/-]+$/.test(f));
}

/** Whether Node's `Intl` accepts a time zone name. */
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone !== '';
  } catch {
    return false;
  }
}

/**
 * Check skill and command frontmatter: a skill's `name` is its folder and it has
 * a `description`; a command has a `description`; a `schedule:` block has a valid
 * cron and time zone, ships `enabled: false` (the opt-in convention), and names
 * `max-runtime` and `permissions`.
 *
 * @param files - The corpus (only `skills/<name>/SKILL.md` and `commands/**` are read).
 * @returns One finding per problem.
 */
export function checkFrontmatter(files: readonly DocFile[]): Finding[] {
  const findings: Finding[] = [];
  const fail = (file: DocFile, detail: string, key: string): void => {
    findings.push({
      rule: 'doc-lint/frontmatter',
      path: file.path,
      detail,
      key: `${file.path}:${key}`,
    });
  };
  for (const file of files) {
    const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    const command = file.path.startsWith('commands/');
    if (skill === null && !command) continue;
    const { frontmatter } = splitFrontmatter(file.text);
    if (frontmatter === null) {
      fail(file, 'has no frontmatter: add a description', 'missing');
      continue;
    }
    const { scalars, maps } = parseFrontmatter(frontmatter);
    if ((scalars.description ?? '') === '') fail(file, 'has no description', 'description');
    if (skill !== null && scalars.name !== skill[1]) {
      fail(file, `name "${scalars.name ?? ''}" does not match its folder "${skill[1]}"`, 'name');
    }
    const schedule = maps.schedule;
    if (schedule === undefined) continue;
    if (!isFiveFieldCron(schedule.cron ?? '')) {
      fail(file, `schedule cron "${schedule.cron ?? ''}" is not a five-field cron`, 'cron');
    }
    if (!isTimeZone(schedule.timezone ?? '')) {
      fail(file, `schedule timezone "${schedule.timezone ?? ''}" is not a time zone`, 'timezone');
    }
    if (schedule.enabled !== 'false') {
      fail(file, 'schedule must ship enabled: false (people opt in)', 'enabled');
    }
    for (const field of ['max-runtime', 'permissions']) {
      if ((schedule[field] ?? '') === '') fail(file, `schedule has no ${field}`, field);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// doc-lint/war-stories
// ---------------------------------------------------------------------------

/** A calendar date like 2026-09-10. */
const DATE = /\b20\d\d-\d\d-\d\d\b/;
/** An id like DOR-1910 (the prefix is checked against the rule-prefix list). */
const ID = /\b([A-Z]{2,})-\d+\b/g;

/**
 * Find dated incidents and tracker ids in the prose of skills and commands:
 * steps, paragraphs and blockquotes alike (fenced and inline code are skipped).
 * A skill says what to do; the story of why belongs in `docs/why.md` or the
 * changelog, which this rule never reads. Ids whose prefix names a rule (INV-3,
 * GRM-9) are not tracker ids.
 *
 * @param files - The corpus (only `skills/**` and `commands/**` are read).
 * @param allow - Rule-id prefixes and allowed lines.
 * @returns One finding per offending line.
 */
export function checkWarStories(files: readonly DocFile[], allow: WarStoryAllow): Finding[] {
  const allowedLines = new Set(allow.lines.map((l) => `${l.path}\u0000${l.text}`));
  const findings: Finding[] = [];
  for (const file of files) {
    if (!file.path.startsWith('skills/') && !file.path.startsWith('commands/')) continue;
    for (const line of linesOutsideFences(splitFrontmatter(file.text).body)) {
      if (line.trim() === '') continue;
      const text = stripInlineCode(line);
      const ids = [...text.matchAll(ID)].filter((m) => !(m[1] in allow.rulePrefixes));
      if (!DATE.test(text) && ids.length === 0) continue;
      const trimmed = line.trim();
      if (allowedLines.has(`${file.path}\u0000${trimmed}`)) continue;
      const what = DATE.test(text) ? `a date (${DATE.exec(text)?.[0]})` : `an id (${ids[0][0]})`;
      findings.push({
        rule: 'doc-lint/war-stories',
        path: file.path,
        detail: `a line carries ${what}: move the story to docs/why.md or the changelog ("${trimmed.slice(0, 60)}")`,
        key: `${file.path}:${trimmed}`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The corpus and the whole lint
// ---------------------------------------------------------------------------

/** Recursively list files under `dir` (relative to `root`) that satisfy `keep`. */
function walk(root: string, dir: string, keep: (rel: string) => boolean): string[] {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(root, rel, keep));
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

/**
 * Load the corpus doc lint reads: `commands/**\/*.md`, `skills/**\/SKILL.md`,
 * `docs/**\/*.{md,mdx}` and `README.md`.
 *
 * @param flowRoot - The flow plugin's root directory.
 * @returns The files, sorted by path.
 */
export function loadCorpus(flowRoot: string): DocFile[] {
  const paths = [
    ...walk(flowRoot, 'commands', (p) => p.endsWith('.md')),
    ...walk(flowRoot, 'skills', (p) => p.endsWith('/SKILL.md')),
    ...walk(flowRoot, 'docs', (p) => /\.mdx?$/.test(p)),
    ...(existsSync(path.join(flowRoot, 'README.md')) ? ['README.md'] : []),
  ].sort();
  return paths.map((p) => ({ path: p, text: readFileSync(path.join(flowRoot, p), 'utf8') }));
}

/**
 * Read the committed budget and allow files under `<flow-root>/selftest/`.
 * A missing allow file reads as empty; a missing budget file as no budgets.
 *
 * @param flowRoot - The flow plugin's root directory.
 * @returns The lint config.
 */
export function loadLintConfig(flowRoot: string): LintConfig {
  const read = <T>(name: string, fallback: T): T => {
    const file = path.join(flowRoot, LINT_CONFIG_DIR, name);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
  };
  return {
    budgets: read<WordBudgets>(WORD_BUDGETS_FILE, {}),
    duplicates: read<DuplicateAllow>(DUPLICATE_ALLOW_FILE, { sentences: [] }),
    warStories: read<WarStoryAllow>(WAR_STORY_ALLOW_FILE, { rulePrefixes: {}, lines: [] }),
  };
}

/**
 * A reader for {@link checkLinks} over the real filesystem under `flowRoot`.
 *
 * @param flowRoot - The flow plugin's root directory.
 * @returns A function from a flow-root-relative path to its text, `''` for a
 *   directory, or `null` when nothing is there (or it escapes nowhere real).
 */
export function fsReader(flowRoot: string): (relPath: string) => string | null {
  return (relPath) => {
    const abs = path.join(flowRoot, relPath);
    if (!existsSync(abs)) return null;
    return statSync(abs).isDirectory() ? '' : readFileSync(abs, 'utf8');
  };
}

/**
 * Run every rule over a corpus.
 *
 * @param files - The corpus.
 * @param config - Budgets and allow files.
 * @param flowRoot - The flow root, for resolving link targets on disk.
 * @returns Every finding, in rule order.
 */
export function lintCorpus(
  files: readonly DocFile[],
  config: LintConfig,
  flowRoot: string
): Finding[] {
  return [
    ...checkWords(files, config.budgets),
    ...checkDuplicates(files, config.duplicates),
    ...checkLinks(files, fsReader(flowRoot)),
    ...checkFrontmatter(files),
    ...checkWarStories(files, config.warStories),
  ];
}
