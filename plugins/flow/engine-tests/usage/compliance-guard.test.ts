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
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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

  it('ignores files outside its scope', () => {
    // Purpose: host-io.ts owns the real fetch wiring; the guard covers only usage and fleet code.
    const root = copyWith('cli/host-io.ts', "await fetch('http://127.0.0.1');");
    expect(violations(root)).toEqual([]);
  });
});
