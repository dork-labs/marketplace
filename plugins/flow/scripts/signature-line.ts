/**
 * Whether a body ends in a valid `agent:provenance` line (`docs/provenance.md`
 * §2: the signature is the body's LAST line). Dependency-free, so the engine's
 * comment rules can read it without reaching into the CLI.
 *
 * @module @dorkos/flow/signature-line
 */

/** A whole provenance line under either accepted name, its JSON captured. */
const SIGNATURE_LINE = /^<!--\s*(?:agent|flow):provenance\s+(\{.*\})\s*-->$/;

/**
 * Whether the last non-blank line of `body` is a provenance line that parses:
 * either accepted name, a JSON object. A line anywhere else, or one that fails
 * to parse, does not count. Anyone can paste such a line, so on its own it
 * never proves who wrote a comment.
 *
 * @param body - A comment body.
 * @returns `true` when the body ends in a valid signature.
 */
export function endsWithSignature(body: string): boolean {
  const last = body.trimEnd().split('\n').at(-1)?.trim() ?? '';
  const match = SIGNATURE_LINE.exec(last);
  if (match === null) return false;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
