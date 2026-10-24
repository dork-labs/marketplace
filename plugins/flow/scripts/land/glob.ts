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
 * @returns The expression.
 */
export function globToRegExp(glob: string): RegExp {
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
  return new RegExp(`^${out}$`);
}

/**
 * Whether `file` matches any of `globs`.
 *
 * @param file - A repo-relative path.
 * @param globs - The globs.
 * @returns `true` on a match.
 */
export function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}
