/**
 * What makes a new item complete enough for `flow create` to file it
 * (DOR-4546): every item is triaged the moment it is filed, so it arrives with
 * a type, a MoSCoW priority, a size, a project, a proof section and a done-when
 * section. `flow create` names every missing one in a single refusal.
 *
 * **MoSCoW on the tracker's own priority (1-4).** 1 urgent and 2 high are
 * Must (urgent only for something broken now), 3 medium is Should, 4 low is
 * Could; a Won't is not filed. 0 ("none") is refused: an item with no priority
 * has not been triaged.
 *
 * **Sections.** A section is a markdown heading (`#` to `######`) or a bold
 * label line (`**Proof:**`), matched without case, with a trailing colon or
 * not, and it must hold some text before the next heading or section label. Proof also reads
 * as "Evidence"; done-when also reads as "Definition of done", "Acceptance
 * criteria" or "Validation criteria" (the section a ready item needs anyway).
 *
 * @module @dorkos/flow/cli/create-fields
 */

import { UsageError } from '../errors.ts';
import type { NewItem } from '../tracker/types.ts';

/** The headings that count as the proof section, normalized. */
const PROOF_NAMES = ['proof', 'evidence'];

/** The headings that count as the done-when section, normalized. */
const DONE_NAMES = ['done when', 'definition of done', 'acceptance criteria', 'validation criteria'];

/** The t-shirt sizes a tracker without numeric estimates uses, as `WorkItem.size`. */
const TSHIRT = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'];

/** A markdown heading line, `#` to `######`. */
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/** A bold label line, `**Proof:** text` or `__Proof__`. */
const BOLD_LABEL = /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*(.*)$/;

/** A heading's name, normalized: lower case, single spaces, no trailing colon. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A heading on one line: its normalized name and any text after it on that line. */
function headingOf(line: string): { name: string; rest: string } | undefined {
  const heading = HEADING.exec(line);
  if (heading) return { name: normalizeName(heading[1]), rest: '' };
  const bold = BOLD_LABEL.exec(line);
  if (bold) return { name: normalizeName(bold[1]), rest: bold[2] };
  return undefined;
}

/** Whether a line starts a new section: a markdown heading, or a proof or done-when label. */
function endsSection(line: string): boolean {
  if (HEADING.test(line)) return true;
  const heading = headingOf(line);
  return heading !== undefined && [...PROOF_NAMES, ...DONE_NAMES].includes(heading.name);
}

/**
 * Whether a description holds a non-empty section under one of the names.
 *
 * @param description - The description, before it is signed.
 * @param names - The accepted section names, normalized.
 * @returns `true` when one of those sections has text in it.
 */
export function hasSection(description: string, names: readonly string[]): boolean {
  const lines = description.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const heading = headingOf(lines[i]);
    if (heading === undefined || !names.includes(heading.name)) continue;
    let body = heading.rest;
    // The section runs to the next markdown heading or the next proof or
    // done-when label: any other bold line ("**Seen in:** the log") is text.
    for (let j = i + 1; j < lines.length && !endsSection(lines[j]); j += 1) {
      body += lines[j];
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
 * `--priority` as 1-4, when given.
 *
 * @param raw - The flag's value, when given.
 * @returns The priority, or `undefined` when the flag was not given.
 * @throws {UsageError} On 0 ("none") or anything but 1-4.
 */
export function priorityOf(raw: string | undefined): NewItem['priority'] {
  if (raw === undefined) return undefined;
  if (raw === '0') {
    throw new UsageError(
      '--priority 0 means none, and a new item is triaged as it is filed: pass 1 or 2 (Must), 3 (Should) or 4 (Could); a Won\'t is not filed'
    );
  }
  if (!/^[1-4]$/.test(raw)) {
    throw new UsageError(
      `--priority must be 1 to 4 (1 or 2 Must, 3 Should, 4 Could), not "${raw}"`
    );
  }
  return Number(raw) as NewItem['priority'];
}

/**
 * `--size` as the tracker's estimate, when given: a whole number of points
 * above 0, or a t-shirt size.
 *
 * @param raw - The flag's value, when given.
 * @returns The size, or `undefined` when the flag was not given.
 * @throws {UsageError} On anything else, 0 included (it would read as "unknown").
 */
export function sizeOf(raw: string | undefined): NewItem['size'] {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (/^[1-9]\d{0,3}$/.test(value)) return Number(value);
  if (TSHIRT.includes(value)) return value;
  throw new UsageError(
    `--size takes whole points above 0 (for example 1, 2, 3, 5 or 8) or a t-shirt size (${TSHIRT.join(', ')}), not "${raw}"`
  );
}

/** What {@link missingFields} reads. */
export interface Draft {
  /** The title, trimmed; `''` when not given. */
  title: string;
  /** The description, or `undefined` when neither description flag was given or it is blank. */
  description: string | undefined;
  /** The labels. */
  labels: readonly string[];
  /** The priority, when given. */
  priority: NewItem['priority'];
  /** The size, when given. */
  size: NewItem['size'];
  /** The project, when given. */
  project: string | undefined;
}

/**
 * Every field a draft lacks, each as a phrase naming the flag that fills it.
 *
 * @param draft - The item as asked for.
 * @returns The missing fields, in a fixed order; empty when it is complete.
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
  if (draft.size === undefined) missing.push('a size (--size, for example 1, 2, 3, 5 or 8)');
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
 * The refusal for an incomplete draft.
 *
 * @param missing - What {@link missingFields} returned (not empty).
 * @returns The error, naming every missing field.
 */
export function incomplete(missing: readonly string[]): UsageError {
  return new UsageError(
    `flow create files only a triaged item, and this one is missing ${missing.length === 1 ? 'one thing' : `${missing.length} things`}: ${missing.join('; ')}. Nothing was filed.`
  );
}

/** What an identifier passed to `--not-duplicate-of` may look like. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The items `--not-duplicate-of` names, each once: repeatable, and each value
 * may list several, separated by commas or spaces.
 *
 * @param values - The flag's values, in order.
 * @returns The identifiers, upper-cased as trackers show them.
 * @throws {UsageError} When one is empty or not an identifier.
 */
export function notDuplicateOf(values: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    const parts = value.split(/[\s,]+/).filter((part) => part !== '');
    if (parts.length === 0) throw new UsageError('a --not-duplicate-of is empty');
    for (const part of parts) {
      if (!IDENTIFIER.test(part)) {
        throw new UsageError(`--not-duplicate-of takes item identifiers, and "${part}" is not one`);
      }
      ids.add(part.toUpperCase());
    }
  }
  return [...ids];
}
