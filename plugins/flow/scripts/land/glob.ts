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
 * @param opts - `ignoreCase`: the `iu` flags (simple Unicode case folding);
 *   {@link matchesAny} adds full folding on top.
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
 * Full case folding, where JavaScript's own is simple: lower, upper, lower.
 * It folds what a case-insensitive APFS disk treats as one name that the `iu`
 * flags miss, `ß` and `ẞ` as `ss`, the ligatures as their letters, and the
 * Kelvin sign and long s as `k` and `s`.
 */
function fullFold(text: string): string {
  return text.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
}

/**
 * Whether `file` matches any of `globs`.
 *
 * @param file - A repo-relative path.
 * @param globs - The globs.
 * @param opts - `ignoreCase`: match in any case, the way a case-insensitive
 *   disk (APFS) opens a path, and then some. The path counts as matching when
 *   any of three spellings of it does: as written (with the `iu` flags), fully
 *   case-folded, or NFKC-normalised then folded (which also takes a
 *   fullwidth letter for its letter, though APFS does not). Folding only ever
 *   adds a match, never removes one: a fullwidth slash in a name still
 *   matches as the name it is.
 * @returns `true` on a match.
 */
export function matchesAny(
  file: string,
  globs: readonly string[],
  opts: { ignoreCase?: boolean } = {}
): boolean {
  if (!opts.ignoreCase) return globs.some((glob) => globToRegExp(glob).test(file));
  const forms: ((text: string) => string)[] = [
    (text) => text,
    fullFold,
    (text) => fullFold(text.normalize('NFKC')),
  ];
  return globs.some((glob) =>
    forms.some((form) => globToRegExp(form(glob), { ignoreCase: true }).test(form(file)))
  );
}
