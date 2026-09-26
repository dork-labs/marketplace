/**
 * The compliance guard (spec `flow-usage` §Testing, task 2.3). Usage comes only
 * from what the official binary hands flow: the status line, transcripts and a
 * real `claude -p` turn. This test fails if the usage and fleet code ever reads
 * a stored sign-in, extracts a token, reads a key variable's value, or makes a
 * network call anywhere but the loopback DorkOS reader.
 *
 * Each rule is also proven to fire, by adding a violating line to a temp copy
 * of the guarded files and checking the guard reports it.
 */

import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OPENCODE_MESSAGE_QUERY } from '../../scripts/fleet/opencode-store.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(here, '..', '..', 'scripts');

/** Text that must never appear in a guarded file. */
const BANNED_TEXT = [
  'oauth/usage',
  'find-generic-password',
  'Keychain',
  '.credentials.json',
  'api.anthropic.com',
];

/** Variables whose value the guarded code must never read. */
const SECRET_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/** The one allowed mention of those names: the probe's removal list, found by name. */
const STRIPPED_CONST = /export const PROBE_STRIPPED_ENV = \[[^\]]*\] as const;/;

/** Text a Codex module's code must never hold: Codex's stored sign-in (A8). */
const CODEX_BANNED_CODE = ['auth.json'];

/** A Codex module: a guarded file with `codex` in its name. */
const isCodexModule = (rel: string) => /codex/i.test(path.basename(rel));

/** The one file allowed to call `fetch(`. */
const FETCH_ALLOWED = path.join('fleet', 'sessions.ts');

/** Every file under `dir`, recursively (relative to `root`). */
function walk(root: string, dir: string): string[] {
  const full = path.join(root, dir);
  let names: string[];
  try {
    names = readdirSync(full);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(root, rel)).isDirectory() ? walk(root, rel) : [rel];
  });
}

/**
 * The guarded files, relative to `root` (a `scripts/` folder): everything under
 * `fleet/` and `usage/`, `cli/usage*.ts` and `cli/fleet.ts`.
 */
function guardedFiles(root: string): string[] {
  const cli = readdirSync(path.join(root, 'cli'))
    .filter((name) => /^usage.*\.ts$/.test(name) || name === 'fleet.ts')
    .map((name) => path.join('cli', name));
  return [...walk(root, 'fleet'), ...walk(root, 'usage'), ...cli].sort();
}

/** Every rule the guarded files break, as `<file>: <why>`. */
function violations(root: string): string[] {
  const found: string[] = [];
  for (const rel of guardedFiles(root)) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    for (const banned of BANNED_TEXT) {
      if (text.includes(banned)) found.push(`${rel}: contains "${banned}"`);
    }
    const withoutConst = text.replace(STRIPPED_CONST, '');
    for (const name of SECRET_VARS) {
      if (withoutConst.includes(name)) found.push(`${rel}: names ${name}`);
    }
    if (rel !== FETCH_ALLOWED && text.includes('fetch(')) found.push(`${rel}: calls fetch(`);
    if (isCodexModule(rel)) {
      const code = codeOnly(text);
      for (const banned of CODEX_BANNED_CODE) {
        if (code.includes(banned)) found.push(`${rel}: names ${banned}`);
      }
    }
  }
  return found;
}

/** The one query the OpenCode store reader may run (spec A3, DorkOS ADR 260825-110420). Pinned. */
const OPENCODE_ALLOWED_QUERY = 'SELECT data FROM message';

/** The file that owns it, and the one line where it is declared. */
const OPENCODE_READER = path.join('fleet', 'opencode-store.ts');
const OPENCODE_QUERY_LINE = `export const OPENCODE_MESSAGE_QUERY = '${OPENCODE_ALLOWED_QUERY}';`;

/** Names from OpenCode's credential tables that no guarded code may mention. */
const OPENCODE_SECRET_NAMES = [/\baccess_token\b/, /\brefresh_token\b/, /\bcontrol_account\b/];

/**
 * `text` without its comments: block comments, and `//` comments that do not
 * follow a `:` or a quote (so `http://` in a string survives). The SQL rules
 * judge code, never what a comment says.
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * Every SQL rule the guarded code breaks: only the OpenCode reader may hold SQL,
 * its only SQL is the pinned query on its one declaration line, it prepares
 * nothing else and runs no `exec`, and no code selects from a credential or
 * account table or names a token column.
 */
function sqlViolations(root: string): string[] {
  const found: string[] = [];
  for (const rel of guardedFiles(root)) {
    const code = codeOnly(readFileSync(path.join(root, rel), 'utf8'));
    if (/\bFROM\s+(credential|account|control_account)\b/i.test(code)) {
      found.push(`${rel}: selects from a credential or account table`);
    }
    for (const name of OPENCODE_SECRET_NAMES) {
      if (name.test(code)) found.push(`${rel}: names ${name.source.replaceAll('\\b', '')}`);
    }
    // SQL is case-insensitive, and so is this count.
    const selects = code.match(/\bSELECT\b/gi)?.length ?? 0;
    if (rel !== OPENCODE_READER) {
      if (selects > 0) found.push(`${rel}: holds SQL outside ${OPENCODE_READER}`);
      // `.exec(` is also RegExp's, so only `.prepare(` marks a database statement here.
      if (/\.prepare\(/.test(code)) {
        found.push(`${rel}: prepares a database statement outside ${OPENCODE_READER}`);
      }
      continue;
    }
    if (selects !== 1 || !code.includes(OPENCODE_QUERY_LINE)) {
      found.push(`${rel}: SQL other than the pinned query`);
    }
    const prepared = [...code.matchAll(/\.prepare\(([^)]*)\)/g)].map((m) => m[1]);
    if (prepared.length === 0 || prepared.some((arg) => arg !== 'OPENCODE_MESSAGE_QUERY')) {
      found.push(`${rel}: prepares something other than OPENCODE_MESSAGE_QUERY`);
    }
    if (/\.(exec|iterate)\(/.test(code)) found.push(`${rel}: runs exec or iterate`);
  }
  return found;
}

let temp: string | undefined;

afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

/** A temp copy of `scripts/` with `line` appended to `rel`. */
function copyWith(rel: string, line: string): string {
  temp = mkdtempSync(path.join(tmpdir(), 'flow-compliance-'));
  const root = path.join(temp, 'scripts');
  cpSync(SCRIPTS, root, { recursive: true });
  appendFileSync(path.join(root, rel), `\n${line}\n`);
  return root;
}

describe('the usage compliance guard', () => {
  it('finds no violation in the shipped usage and fleet code', () => {
    // Purpose: the real files keep the compliance line (flow-fleet §3).
    const files = guardedFiles(SCRIPTS);
    expect(files).toContain(path.join('cli', 'usage-probe.ts'));
    expect(files).toContain(path.join('cli', 'usage-scan.ts'));
    expect(files).toContain(path.join('usage', 'statusline-hook.sh'));
    expect(files.filter(isCodexModule)).toEqual([
      path.join('cli', 'usage-record-codex.ts'),
      path.join('cli', 'usage-scan-codex.ts'),
      path.join('fleet', 'codex-accounts.ts'),
    ]);
    expect(violations(SCRIPTS)).toEqual([]);
  });

  it('keeps the removal list as the one named const holding every secret variable', () => {
    // Purpose: the allowed mention must exist where the guard looks for it,
    // or the exemption would silently cover nothing (or something else).
    const probe = readFileSync(path.join(SCRIPTS, 'cli', 'usage-probe.ts'), 'utf8');
    const match = probe.match(STRIPPED_CONST);
    expect(match).not.toBeNull();
    for (const name of SECRET_VARS) expect(match?.[0]).toContain(`'${name}'`);
  });

  it.each([
    ['fleet/usage-ledger.ts', "const url = 'https://api.anthropic.com/api/oauth/usage';"],
    ['usage/statusline-hook.sh', 'security find-generic-password -s "Claude Code"'],
    ['cli/usage-record.ts', '// read the Keychain entry'],
    ['cli/usage-scan.ts', "const file = '.credentials.json';"],
  ])('fires on banned text added to %s', (rel, line) => {
    // Purpose: prove the text rule can fail, in each guarded folder.
    const root = copyWith(rel, line);
    expect(violations(root).some((v) => v.startsWith(`${rel}:`))).toBe(true);
  });

  it.each([
    ['cli/usage-probe.ts', 'const key = process.env.ANTHROPIC_API_KEY;'],
    ['cli/usage-scan.ts', "const token = ctx.env['CLAUDE_CODE_OAUTH_TOKEN'];"],
    ['fleet/accounts.ts', 'const auth = env.ANTHROPIC_AUTH_TOKEN;'],
  ])('fires on a secret variable read in %s', (rel, line) => {
    // Purpose: prove the variable rule can fail, including in the probe file
    // that holds the one allowed mention.
    const root = copyWith(rel, line);
    expect(violations(root)).toContain(`${rel}: names ${line.match(/[A-Z_]{10,}/)?.[0]}`);
  });

  it('fires on fetch( outside fleet/sessions.ts, and allows it there', () => {
    // Purpose: prove the network rule can fail, and that its one exemption holds.
    const root = copyWith('cli/usage-probe.ts', "await fetch('https://example.com');");
    expect(violations(root)).toEqual(['cli/usage-probe.ts: calls fetch(']);

    rmSync(temp as string, { recursive: true, force: true });
    const allowed = copyWith('fleet/sessions.ts', "await fetch('http://127.0.0.1:4242');");
    expect(violations(allowed)).toEqual([]);
  });

  it.each([
    ['fleet/codex-accounts.ts', "const file = path.join(home, 'auth.json');"],
    ['cli/usage-scan-codex.ts', 'const signIn = `${home}/auth.json`;'],
  ])('fires on a Codex module naming auth.json in code (%s)', (rel, line) => {
    // Purpose: prove the Codex rule can fail in each Codex module folder.
    const root = copyWith(rel, line);
    expect(violations(root)).toEqual([`${rel}: names auth.json`]);
  });

  it('lets a comment in a Codex module say auth.json is never read', () => {
    // Purpose: the rule checks code, not comments (A8).
    const root = copyWith(
      'cli/usage-record-codex.ts',
      '/** Never reads auth.json. */\n// nor auth.json here'
    );
    expect(violations(root)).toEqual([]);
  });

  it('ignores files outside its scope', () => {
    // Purpose: host-io.ts owns the real fetch wiring; the guard covers only usage and fleet code.
    const root = copyWith('cli/host-io.ts', "await fetch('http://127.0.0.1');");
    expect(violations(root)).toEqual([]);
  });

  describe('the OpenCode store reader', () => {
    it('runs exactly the pinned query, and the shipped code breaks no SQL rule', () => {
      // Purpose: spec A3/A8. The reader's SQL equals the allowlisted query, checked
      // on the exported value and on the code, never on a comment.
      expect(OPENCODE_MESSAGE_QUERY).toBe(OPENCODE_ALLOWED_QUERY);
      expect(guardedFiles(SCRIPTS)).toContain(OPENCODE_READER);
      expect(sqlViolations(SCRIPTS)).toEqual([]);
    });

    it.each([
      [OPENCODE_READER, "const q = 'SELECT value FROM credential';"],
      [OPENCODE_READER, "db.exec('PRAGMA query_only = 0');"],
      [OPENCODE_READER, "db.prepare('SELECT data FROM message').all();"],
      [path.join('cli', 'usage-opencode.ts'), "const q = 'SELECT data FROM part';"],
      [path.join('cli', 'usage-scan.ts'), 'const t = row.access_token;'],
      [path.join('fleet', 'accounts.ts'), "const q = 'select * from account';"],
      [path.join('cli', 'usage-opencode.ts'), "db.prepare('select data from auth_store').all();"],
      [path.join('cli', 'usage-opencode.ts'), 'db.prepare(q).all();'],
    ])('fires on SQL added to %s: %s', (rel, line) => {
      // Purpose: prove each SQL rule can fail.
      const root = copyWith(rel, line);
      expect(sqlViolations(root).some((v) => v.startsWith(`${rel}:`))).toBe(true);
    });

    it('fires when the pinned query itself changes', () => {
      // Purpose: widening the one query (a join, another table) is caught.
      const root = copyWith(OPENCODE_READER, '');
      const file = path.join(root, OPENCODE_READER);
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          OPENCODE_QUERY_LINE,
          "export const OPENCODE_MESSAGE_QUERY = 'SELECT data FROM message, credential';"
        )
      );
      expect(sqlViolations(root)).toContain(`${OPENCODE_READER}: SQL other than the pinned query`);
    });

    it('ignores SQL in a comment', () => {
      // Purpose: the guard checks code, not comments.
      const root = copyWith(OPENCODE_READER, '// SELECT value FROM credential\n/* db.exec(x) */');
      expect(sqlViolations(root)).toEqual([]);
    });
  });
});
