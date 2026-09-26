/**
 * `flow note` and `flow journal record|tail` (spec `flow-self-improvement` §2,
 * DOR-2391, task 1.4): exit codes, record validation against the line schema,
 * tail filtering, the off switch, and a journal that cannot be written.
 *
 * Every case drives the real verb table through `main(argv, deps)` against a
 * throwaway git repo as the project. One spawn test runs the real script, and a
 * static check proves the write path never imports `zod`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';
import { JournalLineSchema } from '../../scripts/journal-schema.ts';
import { createFakeAdapter } from '../fixtures/cli/fake-adapter/adapter.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FLOW_ROOT = path.resolve(here, '..', '..');
const FLOW_SCRIPT = path.join(FLOW_ROOT, 'scripts', 'flow.ts');
const NOW = new Date('2026-09-26T12:00:00.000Z');

let project: string;
let journal: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-journal-verbs-')));
  execFileSync('git', ['init', '-q'], { cwd: project });
  journal = path.join(project, '.dork', 'flow', 'journal.jsonl');
});

afterEach(() => {
  for (const sub of ['.dork/flow', '.dork']) {
    try {
      chmodSync(path.join(project, sub), 0o755);
    } catch {
      // not created by this test
    }
  }
  rmSync(project, { recursive: true, force: true });
});

/** Run `flow <argv>` in process against the temp project. */
async function flow(argv: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const deps: MainDeps = {
    env,
    cwd: project,
    now: () => NOW,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => createFakeAdapter({ items: [] }).adapter,
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    flowRoot: FLOW_ROOT,
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr };
}

function journalLines(): Record<string, unknown>[] {
  return readFileSync(journal, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
}

function writeConfig(settings: object): void {
  const dir = path.join(project, '.agents', 'flow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(settings));
}

describe('flow note', () => {
  it('stamps the runtime and harness from its own environment (a Codex-shaped run)', async () => {
    await flow(['note', '--kind', 'friction', 'the claim step was unclear'], {
      CODEX_THREAD_ID: 'thr_1',
    });
    await flow(['note', '--kind', 'friction', 'again'], {
      CLAUDECODE: '1',
      FLOW_HARNESS: 'dorkos',
    });
    expect(journalLines().map((l) => [l.runtime, l.harness])).toEqual([
      ['codex', 'codex'],
      ['claude-code', 'dorkos'],
    ]);
  });

  it('writes one schema-valid note line and exits 0', async () => {
    const { code, stdout } = await flow(
      [
        'note',
        '--kind',
        'workaround',
        '--item',
        'DOR-1',
        '--skill',
        'flow-drain',
        'wrote a watcher',
      ],
      { FLOW_SESSION_ID: 'abcdef1234567890' }
    );
    expect(code).toBe(EXIT.ok);
    expect(stdout).toMatch(/^Noted \(workaround\) in .*journal\.jsonl\.\n$/);
    const [line] = journalLines();
    expect(JournalLineSchema.safeParse(line).success).toBe(true);
    expect(line).toMatchObject({
      kind: 'note',
      noteKind: 'workaround',
      text: 'wrote a watcher',
      item: 'DOR-1',
      skill: 'flow-drain',
      session: 'abcdef12',
      ts: NOW.toISOString(),
    });
  });

  // Purpose: flow note never loads the schema, so buildLine alone must redact and
  // cap --item and --skill.
  it('redacts and caps --item and --skill', async () => {
    const { code } = await flow([
      'note',
      '--kind',
      'friction',
      '--item',
      'dorian@example.com',
      '--skill',
      's'.repeat(300),
      'x',
    ]);
    expect(code).toBe(EXIT.ok);
    const [line] = journalLines();
    expect(line.item).toBe('[email]');
    expect(line.skill).toBe('s'.repeat(100));
    expect(JournalLineSchema.safeParse(line).success).toBe(true);
  });

  it('prints a JSON result under --json', async () => {
    const { code, stdout } = await flow(['note', '--kind', 'friction', 'x', '--json']);
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(stdout)).toMatchObject({
      v: 1,
      ok: true,
      recorded: true,
      outcome: 'written',
    });
  });

  it.each([
    ['no --kind', ['note', 'text'], /--kind is required/],
    ['an unknown --kind', ['note', '--kind', 'rant', 'text'], /unknown --kind "rant"/],
    ['empty text', ['note', '--kind', 'friction', '   '], /the note is empty/],
    ['no text', ['note', '--kind', 'friction'], /missing <text>/],
  ])('exits 2 on %s and writes nothing', async (_name, argv, message) => {
    const { code, stderr } = await flow(argv);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(message);
    expect(existsSync(journal)).toBe(false);
  });

  // Purpose: the off switch covers `flow note` too, and is not an error.
  it('says the journal is off and exits 0, writing nothing, when it is off', async () => {
    writeConfig({ selfImprovement: { journal: { enabled: false } } });
    const { code, stdout } = await flow(['note', '--kind', 'confusion', 'two rules disagreed']);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toMatch(/journal is off/);
    expect(existsSync(journal)).toBe(false);
  });

  // Purpose: a journal that cannot be written never changes the exit code.
  it('exits 0 with one warning when the journal folder is read-only', async () => {
    mkdirSync(path.dirname(journal), { recursive: true });
    chmodSync(path.dirname(journal), 0o500);
    const { code, stdout, stderr } = await flow(['note', '--kind', 'friction', 'x']);
    expect(code).toBe(EXIT.ok);
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(stderr).toMatch(/^flow: warning: the journal at .* could not be written/);
    expect(stdout).toMatch(/was not written/);
  });
});

describe('flow journal record', () => {
  it('records a review, turning numbers and categories into their types', async () => {
    const { code } = await flow([
      'journal',
      'record',
      'review',
      '--round',
      '2',
      '--sha7',
      'abc1234',
      '--verdict',
      'changes',
      '--blocker',
      '1',
      '--should-fix',
      '3',
      '--categories',
      'logic, race',
      '--item',
      'DOR-9',
    ]);
    expect(code).toBe(EXIT.ok);
    const [line] = journalLines();
    expect(JournalLineSchema.safeParse(line).success).toBe(true);
    expect(line).toMatchObject({
      kind: 'review',
      round: 2,
      blocker: 1,
      shouldFix: 3,
      nit: 0,
      categories: ['logic', 'race'],
      item: 'DOR-9',
    });
  });

  it('redacts an address given to a handoff', async () => {
    const { code } = await flow([
      'journal',
      'record',
      'handoff',
      '--from',
      'dorian@example.com',
      '--to',
      'work',
      '--reason',
      'limit',
    ]);
    expect(code).toBe(EXIT.ok);
    expect(journalLines()[0].from).toBe('[email]');
  });

  it('refuses a hand-typed field longer than its limit with exit 2, and writes nothing', async () => {
    const { code } = await flow([
      'journal',
      'record',
      'handoff',
      '--from',
      'x'.repeat(101),
      '--to',
      'work',
      '--reason',
      'limit',
    ]);
    expect(code).toBe(EXIT.usage);
    expect(existsSync(journal)).toBe(false);
  });

  it('records a ci event and a handoff', async () => {
    expect(
      (await flow(['journal', 'record', 'ci', '--pr', '58', '--event', 'red', '--class', 'flake']))
        .code
    ).toBe(EXIT.ok);
    expect(
      (
        await flow([
          'journal',
          'record',
          'handoff',
          '--from',
          'personal',
          '--to',
          'work',
          '--reason',
          'limit',
        ])
      ).code
    ).toBe(EXIT.ok);
    expect(journalLines().map((l) => l.kind)).toEqual(['ci', 'handoff']);
  });

  // Purpose: hand-entered events are checked against the schema, with its message.
  it.each([
    [
      'a bad enum value',
      ['review', '--round', '1', '--sha7', 'abc1234', '--verdict', 'meh'],
      /verdict/,
    ],
    ['a missing field', ['ci', '--pr', '5', '--event', 'red'], /class/],
    ['a non-number', ['ci', '--pr', 'five', '--event', 'red', '--class', 'own'], /pr/],
    [
      'a field of another kind',
      ['ci', '--pr', '5', '--event', 'red', '--class', 'own', '--round', '1'],
      /round/,
    ],
    [
      'a category outside the set',
      [
        'review',
        '--round',
        '1',
        '--sha7',
        'abc1234',
        '--verdict',
        'clean',
        '--categories',
        'vibes',
      ],
      /categories/,
    ],
  ])('exits 2 on %s, naming the field', async (_name, rest, field) => {
    const { code, stderr } = await flow(['journal', 'record', ...rest]);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/invalid \w+ event/);
    expect(stderr).toMatch(field);
    expect(existsSync(journal)).toBe(false);
  });

  it.each([
    ['no kind', ['journal', 'record'], /missing <kind>/],
    ['a kind the CLI writes itself', ['journal', 'record', 'note'], /cannot record "note"/],
    ['a tail flag', ['journal', 'record', 'ci', '--kind', 'ci'], /does not take --kind/],
    ['an unknown action', ['journal', 'rewrite'], /unknown action "rewrite"/],
  ])('exits 2 on %s', async (_name, argv, message) => {
    const { code, stderr } = await flow(argv);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(message);
  });

  it('validates, then says the journal is off, when it is off', async () => {
    writeConfig({ selfImprovement: { journal: { enabled: false } } });
    const bad = await flow(['journal', 'record', 'ci', '--pr', '5']);
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.stderr).toMatch(/invalid ci event/);
    const good = await flow([
      'journal',
      'record',
      'ci',
      '--pr',
      '5',
      '--event',
      'red',
      '--class',
      'own',
    ]);
    expect(good.code).toBe(EXIT.ok);
    expect(good.stdout).toMatch(/journal is off/);
    expect(existsSync(journal)).toBe(false);
  });
});

describe('flow journal tail', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i += 1) await flow(['note', '--kind', 'friction', `note ${i}`]);
    await flow(['journal', 'record', 'ci', '--pr', '7', '--event', 'merged', '--class', 'own']);
  });

  it('prints the newest lines, -n of them', async () => {
    const { code, stdout } = await flow(['journal', 'tail', '-n', '2', '--json']);
    expect(code).toBe(EXIT.ok);
    const lines = JSON.parse(stdout).lines;
    expect(lines.map((l: { kind: string }) => l.kind)).toEqual(['note', 'ci']);
    expect(lines[0].text).toBe('note 4');
  });

  it('filters by --kind', async () => {
    const { stdout } = await flow(['journal', 'tail', '--kind', 'note', '--json']);
    const lines = JSON.parse(stdout).lines;
    expect(lines).toHaveLength(5);
    expect(lines.every((l: { kind: string }) => l.kind === 'note')).toBe(true);
  });

  it('prints aligned text by default', async () => {
    const { stdout } = await flow(['journal', 'tail', '-n', '1']);
    expect(stdout).toMatch(/^2026-09-26T12:00:00\.000Z {2}ci {2}unknown {2}- {2}\{"pr":7,/);
  });

  it('says so when nothing matches', async () => {
    const { code, stdout } = await flow(['journal', 'tail', '--kind', 'retro']);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toBe('No retro lines in the journal.\n');
  });

  it.each([
    ['an unknown --kind', ['--kind', 'gossip'], /unknown --kind "gossip"/],
    ['-n 0', ['-n', '0'], /-n needs a whole number/],
    ['-n that is not a number', ['-n', 'ten'], /-n needs a whole number/],
    ['a record flag', ['--pr', '5'], /does not take --pr/],
    ['an extra argument', ['review'], /unexpected argument "review"/],
  ])('exits 2 on %s', async (_name, rest, message) => {
    const { code, stderr } = await flow(['journal', 'tail', ...rest]);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(message);
  });
});

describe('the real script', () => {
  it('runs flow note and flow journal tail end to end', () => {
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', FLOW_SCRIPT, ...args],
        {
          cwd: project,
          encoding: 'utf8',
        }
      );
    expect(run(['note', '--kind', 'friction', 'from a real process']).status).toBe(0);
    const tail = run(['journal', 'tail', '--json']);
    expect(tail.status).toBe(0);
    expect(JSON.parse(tail.stdout).lines[0].text).toBe('from a real process');
  });
});

describe('the write path needs no zod', () => {
  /** Every module a file reaches through value imports (not `import type`). */
  function valueImports(file: string, seen = new Set<string>()): Set<string> {
    if (seen.has(file)) return seen;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)';/gms)) {
      const spec = match[1];
      if (spec.startsWith('.')) valueImports(path.resolve(path.dirname(file), spec), seen);
      else seen.add(spec);
    }
    return seen;
  }

  // Purpose: `flow note`, `flow journal tail` and every future verb's own
  // journal line must work before `npm install`; only `record` loads the schema.
  it.each(['scripts/journal.ts', 'scripts/cli/note.ts', 'scripts/cli/journal.ts'])(
    '%s imports zod nowhere, directly or through another module',
    (file) => {
      expect([...valueImports(path.join(FLOW_ROOT, file))]).not.toContain('zod');
    }
  );
});
