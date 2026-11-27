/**
 * The near-duplicate test `flow create` runs before it files (DOR-4546): a new
 * title against every open item's title, by shared words.
 *
 * - A title becomes a set of words: lower case, split on anything that is not
 *   a letter or digit, a trailing capture tag (`[owner/name#N]`) dropped,
 *   one-letter words and common filler words dropped, and a plural folded to
 *   its singular (`rooms` and `room` match).
 * - Two titles are a near match when they share at least two words (one, when
 *   either title has only one) and their Dice score, twice the shared words
 *   over both sizes added, is at least {@link NEAR_MATCH}.
 *
 * Two thirds catches a reworded report ("Export the monthly report as CSV"
 * against "Let people export the monthly report as a CSV file") and passes two
 * items that only share a theme ("Flaky test in the rooms e2e suite" against
 * "Flaky test in the relay unit suite", which scores 0.6). A false match costs
 * the filer one look and `--not-duplicate-of`; a missed one costs a duplicate.
 *
 * Dependency-free and pure, so it is tested on its own.
 *
 * @module @dorkos/flow/duplicate-title
 */

/** The lowest Dice score that counts as a near match. */
export const NEAR_MATCH = 2 / 3;

/** Words that carry no meaning in a title, including the verbs most titles start with. */
const FILLER = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'our',
  'so',
  'than',
  'that',
  'the',
  'their',
  'then',
  'this',
  'to',
  'via',
  'we',
  'when',
  'with',
  'without',
  'you',
  'your',
  // Leading verbs nearly every title shares.
  'add',
  'allow',
  'fix',
  'let',
  'make',
  'support',
  'update',
]);

/**
 * A trailing capture tag (`[owner/name#N]`): the mark of an item captured
 * from outside the team. Its title keeps it after a person clears
 * `agent/from-outside`, so the words stay outside words (`flow create`,
 * `flow next`'s `makeReady.outside`).
 */
export const CAPTURE_TAG = /\[[^[\]]*\/[^[\]]*#\d+\]\s*$/;

/**
 * Fold a plural to its singular, lightly: `stories` to `story`, `rooms` to
 * `room`, leaving `status`, `class` and `analysis` alone.
 */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * The words of a title that count for matching.
 *
 * @param title - A title.
 * @returns Its words, each once.
 */
export function titleWords(title: string): Set<string> {
  const words = title
    .replace(CAPTURE_TAG, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !FILLER.has(word))
    .map(singular);
  return new Set(words);
}

/**
 * How alike two titles are.
 *
 * @param a - One title.
 * @param b - The other.
 * @returns The shared word count and the Dice score (0 when either has no words).
 */
export function titleSimilarity(a: string, b: string): { shared: number; score: number } {
  const left = titleWords(a);
  const right = titleWords(b);
  if (left.size === 0 || right.size === 0) return { shared: 0, score: 0 };
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return { shared, score: (2 * shared) / (left.size + right.size) };
}

/**
 * Whether two titles are a near match.
 *
 * @param a - One title.
 * @param b - The other.
 * @returns `true` when they share enough words, by the rule in this module's header.
 */
export function isNearMatch(a: string, b: string): boolean {
  const { shared, score } = titleSimilarity(a, b);
  const needed = Math.min(2, titleWords(a).size, titleWords(b).size);
  return shared >= needed && shared > 0 && score >= NEAR_MATCH;
}

/** An open item a new title nearly matches. */
export interface NearMatch {
  /** The item's human key. */
  identifier: string;
  /** Its title. */
  title: string;
  /** The Dice score, 0 to 1. */
  score: number;
}

/**
 * The open items whose titles nearly match a new one, best first.
 *
 * @param title - The new title.
 * @param items - The open items.
 * @returns Every near match, highest score first, then by identifier.
 */
export function nearMatches(
  title: string,
  items: readonly { identifier: string; title: string }[]
): NearMatch[] {
  return items
    .filter((item) => isNearMatch(title, item.title))
    .map((item) => ({
      identifier: item.identifier,
      title: item.title,
      score: titleSimilarity(title, item.title).score,
    }))
    .sort((x, y) => y.score - x.score || x.identifier.localeCompare(y.identifier));
}
