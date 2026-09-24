/**
 * The one safe way to read markdown frontmatter in this repo.
 *
 * gray-matter is a code runner as well as a parser. A block that opens with
 * `---js` or `---javascript` goes to its JavaScript engine, which calls `eval`
 * on the block. This gate reads every `SKILL.md` a pull request brings, on the
 * CI runner, so plain `matter(content)` let a pull request run its own code
 * there (DOR-2310). None of the markdown read here can be trusted to be data.
 *
 * This module is therefore the only importer of gray-matter in the repo
 * (`tests/frontmatter-confinement.test.ts` holds that everywhere else) and it
 * closes the hole three ways, each sufficient on its own for the eval:
 *
 * 1. A frontmatter language other than YAML or JSON is refused before
 *    gray-matter sees the content, with the same language sniffing gray-matter
 *    uses, so no engine lookup ever happens for it.
 * 2. The `javascript` engine (which `js` aliases to) is replaced by one that
 *    throws, in case a spelling ever slips past the check above.
 * 3. YAML is parsed by js-yaml v4 with its default schema pinned explicitly.
 *    v4 has no `!!js/function`-style types at all, so YAML's own tags cannot
 *    construct code either. JSON goes through `JSON.parse`.
 *
 * It is a port of DorkOS's own reader (`packages/skills/src/frontmatter.ts`,
 * DOR-2308), which is not published, so this gate parses YAML the way DorkOS
 * does. Only the reading half is ported: nothing here writes frontmatter.
 *
 * Every call also skips gray-matter's process-wide cache, which returns a
 * shared object per content string and caches a placeholder before it parses.
 *
 * @module frontmatter
 */

import matter from 'gray-matter';
import yaml from 'js-yaml';

/** Frontmatter languages this gate reads. Everything else is refused. */
const DATA_LANGUAGES: ReadonlySet<string> = new Set(['yaml', 'yml', 'json']);

/** Thrown when a frontmatter block names a language this gate will not parse. */
export class UnsupportedFrontmatterError extends Error {
  /** The language named after the opening `---`, trimmed. */
  readonly language: string;

  /**
   * Build the error for one refused language.
   *
   * @param language - The language named after the opening delimiter.
   */
  constructor(language: string) {
    super(
      `Frontmatter written as "${language}" is not supported. Use YAML between plain "---" lines.`
    );
    this.name = 'UnsupportedFrontmatterError';
    this.language = language;
  }
}

/** Thrown when a frontmatter block parses to something other than a mapping. */
export class FrontmatterShapeError extends Error {
  /**
   * Build the error for one block that is not `key: value` lines.
   *
   * @param shape - What the block holds instead, e.g. `a list`.
   */
  constructor(shape: string) {
    super(`Frontmatter has to be "key: value" lines, but this one is ${shape}.`);
    this.name = 'FrontmatterShapeError';
  }
}

/** The result of {@link parseFrontmatter}. */
export interface ParsedFrontmatter {
  /** The frontmatter mapping; `{}` when the content has none. */
  data: Record<string, unknown>;
  /** Everything after the closing delimiter, untrimmed. */
  content: string;
}

/** Engine that refuses to run, standing in for gray-matter's `eval` engine. */
const refusingEngine = {
  parse(): never {
    throw new UnsupportedFrontmatterError('javascript');
  },
};

/**
 * Options passed to every gray-matter call. Passing any options object also
 * bypasses gray-matter's cache.
 *
 * The YAML engine is js-yaml v4, which reads a few values differently from the
 * js-yaml v3 gray-matter bundles: `0123` is 123 (v3: octal 83) and `0o17` is 15
 * (v3: the string "0o17"). v4 is what DorkOS reads with, so it is what this
 * gate has to read with too.
 */
const MATTER_OPTIONS = {
  language: 'yaml',
  engines: {
    yaml: (str: string): object => yaml.load(str, { schema: yaml.DEFAULT_SCHEMA }) as object,
    json: (str: string): object => JSON.parse(str) as object,
    javascript: refusingEngine,
    js: refusingEngine,
  },
};

/**
 * Layer 1: refuse a frontmatter block that names a non-data language, using
 * gray-matter's own rules for spotting one: the content (BOM stripped) opens
 * with `---`, the fourth character is not another `-`, and whatever follows on
 * that first line is the language. Nothing is parsed.
 *
 * @param content - Raw file content.
 * @throws {UnsupportedFrontmatterError} For any language but YAML or JSON.
 */
export function assertDataLanguage(content: string): void {
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  if (!text.startsWith('---') || text.charAt(3) === '-') return;
  const language = matter.language(text).name;
  if (language !== '' && !DATA_LANGUAGES.has(language.toLowerCase())) {
    throw new UnsupportedFrontmatterError(language);
  }
}

/**
 * Layers 2 and 3 on their own: gray-matter with the refusing JavaScript engine
 * and the pinned YAML and JSON engines, and without the language check.
 *
 * Exported so each layer can be tested without the one in front of it. Read
 * files with {@link parseFrontmatter}, never with this.
 *
 * @param content - Raw file content.
 * @returns gray-matter's `data` (whatever the engine produced) and body.
 * @throws {UnsupportedFrontmatterError} When gray-matter picks the JavaScript engine.
 */
export function parseWithSafeEngines(content: string): { data: unknown; content: string } {
  const parsed = matter(content, MATTER_OPTIONS);
  return { data: parsed.data, content: parsed.content };
}

/**
 * Split markdown into its frontmatter mapping and body, safely.
 *
 * @param content - Raw file content (UTF-8).
 * @returns The frontmatter data and the untrimmed body.
 * @throws {UnsupportedFrontmatterError} When the block is written in a language
 *   other than YAML or JSON (for example `---js`).
 * @throws {FrontmatterShapeError} When the block is a single value or a list
 *   rather than `key: value` lines.
 * @throws The YAML or JSON parser's error when the block is malformed.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  assertDataLanguage(content);
  const parsed = parseWithSafeEngines(content);
  if (Array.isArray(parsed.data)) throw new FrontmatterShapeError('a list');
  if (typeof parsed.data !== 'object' || parsed.data === null) {
    throw new FrontmatterShapeError(`a single value (${JSON.stringify(parsed.data)})`);
  }
  return { data: parsed.data as Record<string, unknown>, content: parsed.content };
}
