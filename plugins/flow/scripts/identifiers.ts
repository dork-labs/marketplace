/**
 * Issue identifiers as numbers: `ABC-99` sorts before `ABC-100`. A leaf module
 * with no imports, so `work-order.ts` and `readiness.ts` can both use it
 * without importing each other.
 *
 * @module @dorkos/flow/identifiers
 */

/**
 * The number at the end of an identifier (`DOR-123` gives 123), or
 * `Infinity` when it has none, so it sorts after every numbered one.
 *
 * @param identifier - A human key such as `ABC-12`.
 * @returns Its number, or `Infinity`.
 */
export function issueNumber(identifier: string): number {
  const match = /-(\d+)$/.exec(identifier);
  return match === null ? Number.POSITIVE_INFINITY : Number(match[1]);
}

/**
 * Order identifiers by issue number, then as text (`ABC-99` before `ABC-100`).
 *
 * @param a - One identifier.
 * @param b - The other.
 * @returns Negative when `a` goes first.
 */
export function compareIdentifiers(a: string, b: string): number {
  const na = issueNumber(a);
  const nb = issueNumber(b);
  if (na !== nb) return na < nb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
