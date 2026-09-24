import { afterEach, describe, expect, it } from 'vitest';
import {
  NonMappingFrontmatterError,
  UnsupportedFrontmatterError,
  FRONTMATTER_ENGINES,
  parseFrontmatter,
} from '@dorkos/skills/frontmatter';

/**
 * Every SKILL.md this gate reads comes from a pull request, so none of it can
 * be trusted to be data. gray-matter, left to its defaults, runs `eval` on any
 * frontmatter block that opens with `---js` or `---javascript` (DOR-2310, the
 * same hole as DOR-2308 in DorkOS). Every payload below writes to a global, so
 * a test proves the code never ran rather than only that an error came back.
 */
const SENTINEL = '__schemaCheckFrontmatterPwned';

function sentinel(): unknown {
  return (globalThis as Record<string, unknown>)[SENTINEL];
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SENTINEL];
});

const payload = (lang: string) =>
  `---${lang}\n{ name: (globalThis.${SENTINEL} = 1, 'x') }\n---\nbody\n`;

describe('parseFrontmatter refuses every non-data language', () => {
  // Purpose: the code execution itself. Each spelling gray-matter maps to its
  // eval engine, plus the case and whitespace variants its own sniffing accepts.
  it.each(['js', 'javascript', 'JS', 'JavaScript', ' js ', 'js\t'])(
    'refuses `---%s` without evaluating it',
    (lang) => {
      expect(() => parseFrontmatter(payload(lang))).toThrow(UnsupportedFrontmatterError);
      expect(sentinel()).toBeUndefined();
    }
  );

  // Purpose: a language gray-matter does not register must not fall through to
  // a prototype lookup (`---constructor`, `---toString`) or any other engine.
  it.each(['coffee', 'coffeescript', 'cson', 'toml', 'constructor', 'toString', '__proto__'])(
    'refuses `---%s`',
    (lang) => {
      expect(() => parseFrontmatter(payload(lang))).toThrow(UnsupportedFrontmatterError);
      expect(sentinel()).toBeUndefined();
    }
  );

  // Purpose: gray-matter strips a byte-order mark before it sniffs the
  // language, so the pre-check must see through one too. The message names
  // `js` as written, which only the pre-check reports: the refusing engine
  // behind it would say `javascript`, so a pre-check blind to the mark fails.
  it('refuses `---js` behind a byte-order mark', () => {
    expect(() => parseFrontmatter(`\uFEFF${payload('js')}`)).toThrow('written as "js"');
    expect(sentinel()).toBeUndefined();
  });

  // Purpose: CRLF files sniff the language up to `\r\n`; `js\r` must still be js.
  it('refuses `---js` with CRLF line endings', () => {
    expect(() => parseFrontmatter(payload('js').replace(/\n/g, '\r\n'))).toThrow('written as "js"');
    expect(sentinel()).toBeUndefined();
  });

  // Purpose: YAML's own escape hatch. js-yaml v3's full schema constructs
  // functions from `!!js/function`; the pinned default schema must refuse the
  // tag. This alone does not tell v4 from gray-matter's v3 `safeLoad`, which
  // refuses it too; the leading-zero test below is the one that does.
  it('refuses a `!!js/function` YAML tag without constructing it', () => {
    const content = `---\nname: !!js/function "function () { globalThis.${SENTINEL} = 1 }"\n---\n`;
    expect(() => parseFrontmatter(content)).toThrow();
    expect(sentinel()).toBeUndefined();
  });
});

describe('each layer holds on its own', () => {
  // Purpose: gray-matter finds `yaml` in any case but `json` only as written,
  // so the reader lowercases the language before handing the file on.
  it.each(['JSON', 'Json', ' JSON '])('reads a `---%s` block', (lang) => {
    expect(parseFrontmatter(`---${lang}\r\n{"Name": "A"}\n---\nBody`)).toEqual({
      data: { Name: 'A' },
      content: 'Body',
    });
  });

  // Purpose: layer 2 alone, with no language check in front of it. gray-matter
  // sends both spellings to its eval engine; the replacement must refuse them.
  it.each(['javascript', 'js'] as const)(
    'the replaced `%s` engine refuses without evaluating it',
    (name) => {
      expect(() =>
        FRONTMATTER_ENGINES[name].parse(`{ a: (globalThis.${SENTINEL} = 1, 2) }`)
      ).toThrow(UnsupportedFrontmatterError);
      expect(sentinel()).toBeUndefined();
    }
  );

  // Purpose: layer 3. js-yaml v4 reads `0123` as 123 and `0o17` as 15, where
  // the v3 that gray-matter bundles reads 83 and the string "0o17". This is
  // what DorkOS reads with, and it fails if the pinned YAML engine is ever
  // dropped for gray-matter's default.
  it('reads YAML with js-yaml v4, not the v3 gray-matter bundles', () => {
    expect(parseFrontmatter('---\nn: 0123\nm: 0o17\n---\n').data).toEqual({ n: 123, m: 15 });
  });
});

describe('parseFrontmatter refuses frontmatter that is not a mapping', () => {
  // Purpose: a block holding one value or a list parses, but its data is then
  // a string, number or array, never the mapping every caller indexes into.
  it.each([
    ['a single word', '---\nhello\n---\nbody', 'a string'],
    ['a number', '---\n42\n---\nbody', 'a number'],
    ['a list', '---\n- a\n- b\n---\nbody', 'a list'],
    ['a JSON list', '---json\n["a"]\n---\nbody', 'a list'],
  ])('refuses %s', (_label, content, shape) => {
    expect(() => parseFrontmatter(content)).toThrow(NonMappingFrontmatterError);
    expect(() => parseFrontmatter(content)).toThrow(`this one is ${shape}`);
  });

  // Purpose: an empty or comment-only block is no frontmatter, not an error.
  it.each(['---\n---\nbody', '---\n# nothing yet\n---\nbody', '---\nnull\n---\nbody'])(
    'reads %j as empty',
    (content) => {
      expect(parseFrontmatter(content).data).toEqual({});
    }
  );
});

describe('parseFrontmatter reads ordinary frontmatter unchanged', () => {
  // Purpose: the default (no language) path is the one every real file takes.
  it('parses YAML frontmatter and keeps the body verbatim', () => {
    const parsed = parseFrontmatter('---\nname: a\ncount: 2\nlist: [x, y]\n---\n\n# Body\n');
    expect(parsed.data).toEqual({ name: 'a', count: 2, list: ['x', 'y'] });
    expect(parsed.content).toBe('\n# Body\n');
  });

  // Purpose: `---yaml`, `---yml` and `---json` are data languages and stay allowed.
  it.each([
    ['yaml', 'name: a'],
    ['yml', 'name: a'],
    ['YAML', 'name: a'],
    ['json', '{ "name": "a" }'],
    ['JSON', '{ "name": "a" }'],
    ['Json', '{ "name": "a" }'],
  ])('parses an explicit `---%s` block', (lang, block) => {
    expect(parseFrontmatter(`---${lang}\n${block}\n---\nbody`).data).toEqual({ name: 'a' });
  });

  // Purpose: content with no frontmatter at all must not be mistaken for a
  // language line (its first line is prose, not a `---` fence).
  it('returns empty data for content without frontmatter', () => {
    expect(parseFrontmatter('javascript is fun\n')).toEqual({
      data: {},
      content: 'javascript is fun\n',
    });
  });

  // Purpose: YAML 1.2 core booleans. `yes`/`no` stay strings, which the gate's
  // comparison through upstream's `coerceYamlBoolean` depends on.
  it('keeps YAML 1.1 boolean words as strings', () => {
    expect(parseFrontmatter('---\na: yes\nb: true\n---\n').data).toEqual({ a: 'yes', b: true });
  });

  // Purpose: malformed YAML still throws, so the gate keeps reporting it.
  it('throws on malformed YAML', () => {
    expect(() => parseFrontmatter('---\nname: [unclosed\n---\n')).toThrow();
  });

  // Purpose: no shared cache. gray-matter's default returns one object per
  // content string, so mutating one result must not leak into the next.
  it('returns a fresh object per call', () => {
    const content = '---\nname: a\n---\n';
    parseFrontmatter(content).data.name = 'mutated';
    expect(parseFrontmatter(content).data.name).toBe('a');
  });
});
