/**
 * The description sections flow reads (DOR-4546, DOR-5069): a proof section
 * and a done-when section. One reader for `flow create`'s refusal, the work
 * order's readiness (`needs a done-when`) and the groom's GRM-5, so an item
 * filed by the rubric is also ready by flow's rules.
 *
 * A section is a markdown heading (`#` to `######`) or a bold label line
 * (`**Proof:**`), matched without case, with a trailing colon or not, and it
 * must hold some text. A heading section runs to the next heading of its own
 * level or higher (a sub-heading is part of it); a bold-label section runs to
 * the next heading. Either also ends at the next proof or done-when label.
 * Lines inside a code fence are text, never headings. Proof also reads as
 * "Evidence"; done-when also reads as "Definition of done", "Acceptance
 * criteria" or "Validation criteria".
 *
 * @module @dorkos/flow/sections
 */

/** The headings that count as the proof section, normalized. */
const PROOF_NAMES = ['proof', 'evidence'];

/** The headings that count as the done-when section, as a person writes them. */
export const DONE_WHEN_HEADINGS: readonly string[] = [
  'Done when',
  'Validation criteria',
  'Acceptance criteria',
  'Definition of done',
];

/** The done-when headings, normalized. */
const DONE_NAMES = DONE_WHEN_HEADINGS.map((name) => name.toLowerCase());

/** Every section name a section ends at. */
const SECTION_NAMES = [...PROOF_NAMES, ...DONE_NAMES];

/** A markdown heading line, `#` to `######`. */
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** A bold label line, `**Proof:** text` or `__Proof__`. */
const BOLD_LABEL = /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*(.*)$/;

/** A code fence's opening or closing line. */
const FENCE = /^\s{0,3}(```|~~~)/;

/** A heading's name, normalized: lower case, single spaces, no trailing colon. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]+/g, ' ').replace(/:\s*$/, '').replace(/\s+/g, ' ').trim();
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
    if (heading)
      return { text, level: heading[1].length, name: normalizeName(heading[2]), rest: '' };
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
function hasSection(description: string, names: readonly string[]): boolean {
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
