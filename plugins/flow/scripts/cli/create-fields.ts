/**
 * What makes a new item complete enough for `flow create` to file it
 * (DOR-4546): every item is triaged the moment it is filed, so it arrives with
 * a type, a MoSCoW priority, a size, a project, a proof section and a done-when
 * section. `flow create` names every problem, malformed or missing, in a
 * single refusal.
 *
 * **MoSCoW on the tracker's own priority (1-4).** 1 urgent and 2 high are
 * Must (urgent only for something broken now), 3 medium is Should, 4 low is
 * Could; a Won't is not filed. 0 ("none") is refused: an item with no priority
 * has not been triaged. The buckets themselves are explained once, in the
 * triaging-work skill.
 *
 * **Sections.** A section is a markdown heading (`#` to `######`) or a bold
 * label line (`**Proof:**`), matched without case, with a trailing colon or
 * not, and it must hold some text. A heading section runs to the next heading
 * of its own level or higher (a sub-heading is part of it); a bold-label
 * section runs to the next heading. Either also ends at the next proof or
 * done-when label. Lines inside a code fence are text, never headings. Proof
 * also reads as "Evidence"; done-when also reads as "Definition of done",
 * "Acceptance criteria" or "Validation criteria" (the section a ready item
 * needs anyway).
 *
 * @module @dorkos/flow/cli/create-fields
 */

import { UsageError } from '../errors.ts';
import type { NewItem } from '../tracker/types.ts';

/** The headings that count as the proof section, normalized. */
const PROOF_NAMES = ['proof', 'evidence'];

/** The headings that count as the done-when section, normalized. */
const DONE_NAMES = ['done when', 'definition of done', 'acceptance criteria', 'validation criteria'];

/** Every section name a section ends at. */
const SECTION_NAMES = [...PROOF_NAMES, ...DONE_NAMES];

/** The t-shirt sizes a tracker without numeric estimates uses, as `WorkItem.size`. */
const TSHIRT = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'];

/** A markdown heading line, `#` to `######`. */
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** A bold label line, `**Proof:** text` or `__Proof__`. */
const BOLD_LABEL = /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*(.*)$/;

/** A code fence's opening or closing line. */
const FENCE = /^\s{0,3}(```|~~~)/;

/** A heading's name, normalized: lower case, single spaces, no trailing colon. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One line of a description, read for sections. */
interface Line {
  /** The line's text. */
  text: string;
  /** Its heading level (1-6), 7 for a bold label, or `undefined` for plain text. */
  level?: number;
  /** The heading's normalized name. */
  name?: string;
  /** Text after a bold label on its own line. */
  rest?: string;
}

/** Read each line once: headings and labels outside code fences, everything else text. */
function readLines(description: string): Line[] {
  let fenced = false;
  return description.split('\n').map((text) => {
    if (FENCE.test(text)) {
      fenced = !fenced;
      return { text };
    }
    if (fenced) return { text };
    const heading = HEADING.exec(text);
    if (heading) return { text, level: heading[1].length, name: normalizeName(heading[2]), rest: '' };
    const bold = BOLD_LABEL.exec(text);
    if (bold) return { text, level: 7, name: normalizeName(bold[1]), rest: bold[2] };
    return { text };
  });
}

/**
 * Whether a description holds a non-empty section under one of the names.
 *
 * @param description - The description, before it is signed.
 * @param names - The accepted section names, normalized.
 * @returns `true` when one of those sections has text in it.
 */
export function hasSection(description: string, names: readonly string[]): boolean {
  const lines = readLines(description);
  for (let i = 0; i < lines.length; i += 1) {
    const start = lines[i];
    if (start.level === undefined || !names.includes(start.name ?? '')) continue;
    let body = start.rest ?? '';
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      const heading = line.level !== undefined && line.level <= 6;
      if (heading && (line.level as number) <= start.level) break;
      if (line.level !== undefined && SECTION_NAMES.includes(line.name ?? '')) break;
      // A sub-heading belongs to the section but is not its text; any other
      // bold line ("**Seen in:** the log") is.
      if (!heading) body += line.text;
    }
    if (body.trim() !== '') return true;
  }
  return false;
}

/**
 * Whether a description has its proof section.
 *
 * @param description - The description, before it is signed.
 * @returns `true` when it does.
 */
export function hasProof(description: string): boolean {
  return hasSection(description, PROOF_NAMES);
}

/**
 * Whether a description has its done-when section.
 *
 * @param description - The description, before it is signed.
 * @returns `true` when it does.
 */
export function hasDoneWhen(description: string): boolean {
  return hasSection(description, DONE_NAMES);
}

/**
 * `--priority` as 1-4, when given and well formed.
 *
 * @param raw - The flag's value, when given.
 * @param problems - Where a malformed value is recorded.
 * @returns The priority, or `undefined` when absent or malformed.
 */
export function priorityOf(raw: string | undefined, problems: string[]): NewItem['priority'] {
  if (raw === undefined) return undefined;
  if (raw === '0') {
    problems.push(
      "--priority 0 means none, and a new item is triaged as it is filed: pass 1 or 2 (Must), 3 (Should) or 4 (Could); a Won't is not filed"
    );
    return undefined;
  }
  if (!/^[1-4]$/.test(raw)) {
    problems.push(`--priority must be 1 to 4 (1 or 2 Must, 3 Should, 4 Could), not "${raw}"`);
    return undefined;
  }
  return Number(raw) as NewItem['priority'];
}

/**
 * `--size` as the tracker's estimate, when given and well formed: a whole
 * number of points above 0, or a t-shirt size. Which of the two, and which
 * numbers, is the tracker's own scale; the adapter refuses one it cannot hold.
 *
 * @param raw - The flag's value, when given.
 * @param problems - Where a malformed value is recorded.
 * @returns The size, or `undefined` when absent or malformed (0 included: it would read as "unknown").
 */
export function sizeOf(raw: string | undefined, problems: string[]): NewItem['size'] {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (/^[1-9]\d{0,3}$/.test(value)) return Number(value);
  if (TSHIRT.includes(value)) return value;
  problems.push(
    `--size takes a whole number of points above 0, on the tracker's own estimate scale, or a t-shirt size (${TSHIRT.join(', ')}), not "${raw}"`
  );
  return undefined;
}

/** What {@link missingFields} reads. */
export interface Draft {
  /** The title, trimmed; `''` when not given. */
  title: string;
  /** The description, or `undefined` when neither description flag was given or it is blank. */
  description: string | undefined;
  /** The labels. */
  labels: readonly string[];
  /** The priority flag as given, malformed or not. */
  priority: string | undefined;
  /** The size flag as given, malformed or not. */
  size: string | undefined;
  /** The project flag as given, empty or not. */
  project: string | undefined;
}

/**
 * Every field a draft lacks, each as a phrase naming the flag that fills it.
 * A field given but malformed is not missing: its own problem names it.
 *
 * @param draft - The item as asked for.
 * @returns The missing fields, in a fixed order; empty when none is.
 */
export function missingFields(draft: Draft): string[] {
  const missing: string[] = [];
  if (draft.title === '') missing.push('a title (--title)');
  if (draft.description === undefined) {
    missing.push(
      'a description (--description or --description-file) with a "## Proof" and a "## Done when" section'
    );
  }
  if (!draft.labels.some((label) => label.startsWith('type/'))) {
    missing.push('a type (--label type/<kind>)');
  }
  if (draft.priority === undefined) {
    missing.push('a priority (--priority 1 or 2 Must, 3 Should, 4 Could)');
  }
  if (draft.size === undefined) {
    missing.push("a size (--size, on the tracker's own estimate scale)");
  }
  if (draft.project === undefined) missing.push('a project (--for-project)');
  if (draft.description !== undefined) {
    if (!hasProof(draft.description)) {
      missing.push(
        'a "## Proof" section in the description (what you saw: a log line, file:line, a failing command or the steps)'
      );
    }
    if (!hasDoneWhen(draft.description)) {
      missing.push(
        'a "## Done when" section in the description (one to three lines you can check)'
      );
    }
  }
  return missing;
}

/**
 * The one refusal for an incomplete or malformed draft.
 *
 * @param problems - Every malformed value and missing field (not empty).
 * @returns The error, naming each of them.
 */
export function refusal(problems: readonly string[]): UsageError {
  const what = problems.length === 1 ? 'Fix this' : `Fix these ${problems.length}`;
  return new UsageError(
    `flow create files only a complete, triaged item. ${what}: ${problems.join('; ')}. Nothing was filed.`
  );
}

/** What an identifier passed to `--not-duplicate-of` may look like. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The items `--not-duplicate-of` names, each once: repeatable, and each value
 * may list several, separated by commas or spaces.
 *
 * @param values - The flag's values, in order.
 * @param problems - Where a malformed value is recorded.
 * @returns The identifiers, upper-cased as trackers show them.
 */
export function notDuplicateOf(values: readonly string[], problems: string[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    const parts = value.split(/[\s,]+/).filter((part) => part !== '');
    if (parts.length === 0) problems.push('a --not-duplicate-of is empty');
    for (const part of parts) {
      if (IDENTIFIER.test(part)) ids.add(part.toUpperCase());
      else problems.push(`--not-duplicate-of takes item identifiers, and "${part}" is not one`);
    }
  }
  return [...ids];
}
