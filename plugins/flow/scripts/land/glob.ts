/**
 * The path globs `land` config uses (`land.preArm[].paths`,
 * `land.securityPaths.globs`), matched against repo-relative paths with `/`
 * separators:
 *
 * - `**` matches any run of characters, `/` included. A `**` that fills a
 *   whole path segment (at the start, or between two slashes) also matches no
 *   folder at all, so "any folder, then package.json" matches a root
 *   `package.json` too.
 * - `*` matches any run of characters except `/`.
 * - `?` matches one character except `/`.
 * - Everything else matches itself. There are no braces, classes or negation:
 *   a pattern either names a path shape or it does not, which keeps a security
 *   list readable.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/land/glob
 */

/** A regular expression's special characters, escaped. */
function escape(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one glob to a regular expression that must match the whole path.
 *
 * @param glob - The glob.
 * @param opts - `ignoreCase`: match letters in any case, by Unicode case
 *   folding (the `iu` flags); pair it with NFKC-normalised input ({@link matchesAny}).
 * @returns The expression.
 */
export function globToRegExp(glob: string, opts: { ignoreCase?: boolean } = {}): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      const atSegmentStart = i === 0 || glob[i - 1] === '/';
      if (atSegmentStart && glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      out += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += escape(ch);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`, opts.ignoreCase ? 'iu' : '');
}

/**
 * Whether `file` matches any of `globs`.
 *
 * @param file - A repo-relative path.
 * @param globs - The globs.
 * @param opts - `ignoreCase`: match the way a case-insensitive disk opens a
 *   path (APFS, NTFS). Both sides are NFKC-normalised first, so a Kelvin sign
 *   or a fullwidth letter is the letter it stands for, then compared with
 *   Unicode case folding.
 * @returns `true` on a match.
 */
export function matchesAny(
  file: string,
  globs: readonly string[],
  opts: { ignoreCase?: boolean } = {}
): boolean {
  if (!opts.ignoreCase) return globs.some((glob) => globToRegExp(glob).test(file));
  const folded = file.normalize('NFKC');
  return globs.some((glob) => globToRegExp(glob.normalize('NFKC'), opts).test(folded));
}
