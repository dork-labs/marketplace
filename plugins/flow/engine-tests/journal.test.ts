/**
 * The journal store (spec `flow-self-improvement` §2, DOR-2391, task 1.3):
 * the line schema, redaction, append with rotation, read, the gitignore step and
 * the off switch.
 *
 * Every write goes to a throwaway folder. The concurrency cases spawn real child
 * processes (`fixtures/journal/writer.ts`), because two writers in one process
 * never overlap. The rotation race is driven deterministically through the
 * `beforeLock` seam, which runs a second writer between the first writer's size
 * check and its lock.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowConfigSchema } from '../scripts/config-schema.ts';
import {
  JOURNAL_DEFAULTS,
  findConfigRoots,
  journalSettings,
  type JournalSettings,
} from '../scripts/config-files.ts';
import {
  JOURNAL_KINDS,
  LOCK_FILE,
  NOTE_TEXT_MAX,
  STALE_LOCK_MS,
  append,
  buildLine,
  read,
  redact,
  rotatedPath,
  shouldSampleUsage,
  USAGE_SAMPLE_INTERVAL_MS,
  type AppendOptions,
  type JournalEvent,
} from '../scripts/journal.ts';
import { JournalLineSchema } from '../scripts/journal-schema.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const WRITER = path.join(here, 'fixtures', 'journal', 'writer.ts');
const NOW = new Date('2026-09-26T12:00:00.000Z');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flow-journal-'));
});

afterEach(() => {
  // A test may leave a folder read-only; make it removable again.
  for (const sub of ['', '.dork', '.dork/flow']) {
    try {
      chmodSync(path.join(dir, sub), 0o755);
    } catch {
      // not created by this test
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Journal settings for a file in the temp folder. */
function settings(overrides: Partial<JournalSettings> = {}): JournalSettings {
  return { ...base(), ...overrides };
}
function base(): JournalSettings {
  return {
    path: path.join(dir, '.dork', 'flow', 'journal.jsonl'),
    checkout: dir,
    enabled: true,
    maxBytes: JOURNAL_DEFAULTS.maxBytes,
    keep: JOURNAL_DEFAULTS.keep,
  };
}

/** Options that collect warnings instead of printing them. */
function quiet(extra: AppendOptions = {}) {
  const warnings: string[] = [];
  const options: AppendOptions = {
    now: NOW,
    flowVersion: '0.15.0',
    warn: (message) => warnings.push(message),
    ...extra,
  };
  return { options, warnings };
}

function note(text: string): JournalEvent {
  return { kind: 'note', noteKind: 'friction', text };
}

function fileLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '');
}

/** One valid event of every kind, as a caller would pass it. */
const SAMPLES: JournalEvent[] = [
  { kind: 'verb', verb: 'claim', ms: 120, exit: 0 },
  { kind: 'oracle.error', oracle: 'dispatch', exit: 2, errorClass: 'TypeError: boom' },
  { kind: 'stage', stage: 'EXECUTE', phase: 'end', outcome: 'ok' },
  { kind: 'item.readied', by: 'triage' },
  { kind: 'claim', phase: 'claim' },
  { kind: 'retry', rung: 'resume', attempt: 1 },
  { kind: 'operator.wait', phase: 'end', waitedMs: 5000 },
  {
    kind: 'review',
    round: 2,
    sha7: 'abc1234',
    verdict: 'changes',
    blocker: 1,
    shouldFix: 2,
    nit: 0,
    categories: ['logic', 'test'],
  },
  { kind: 'ci', pr: 58, event: 'red', class: 'flake' },
  { kind: 'handoff', from: 'personal', to: 'work', reason: 'limit' },
  { kind: 'note', noteKind: 'workaround', text: 'wrote a PR watcher by hand', skill: 'flow-drain' },
  { kind: 'selftest', tiers: ['fast'], pass: 8, fail: 1, skip: 0, ms: 900, failing: ['doc-lint'] },
  { kind: 'retro', window: '7d', proposals: 3, filed: 2, commented: 1 },
  {
    kind: 'usage.snapshot',
    accountRuntime: 'codex',
    account: 'default',
    windows: {
      five_hour: { usedPct: 42, resetsAt: '2026-09-26T15:00:00.000Z' },
      seven_day: { usedPct: 80.5, resetsAt: null },
    },
    plan: 'plus',
  },
];

describe('the line schema', () => {
  // Purpose: the union is closed and every member strict, so no field outside the
  // spec's table (a body, a prompt) can ever be stored.
  it('has one member per kind, and accepts a line of each', () => {
    expect(new Set(SAMPLES.map((s) => s.kind))).toEqual(new Set(JOURNAL_KINDS));
    for (const sample of SAMPLES) {
      const result = JournalLineSchema.safeParse(buildLine(sample, { now: NOW, flowVersion: 'x' }));
      expect(result.success, sample.kind).toBe(true);
    }
  });

  it('rejects an unknown kind', () => {
    const line = { v: 1, ts: NOW.toISOString(), flow: 'x', kind: 'gossip', text: 'hi' };
    expect(JournalLineSchema.safeParse(line).success).toBe(false);
  });

  it('rejects a field its kind does not have', () => {
    const line = { ...buildLine(note('hi'), { now: NOW, flowVersion: 'x' }), body: 'secret' };
    const result = JournalLineSchema.safeParse(line);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/body/);
  });

  it('rejects a review category outside the closed set', () => {
    const line = buildLine(
      { ...(SAMPLES[7] as object), categories: ['vibes'] } as unknown as JournalEvent,
      {
        now: NOW,
        flowVersion: 'x',
      }
    );
    expect(JournalLineSchema.safeParse(line).success).toBe(false);
  });
});

describe('redact', () => {
  const home = os.homedir();
  // Purpose: free text never carries a credential, an address or a home folder.
  it.each([
    ['an Anthropic-style key', 'key sk-ant-api03-abcdefghijklmnop here'],
    ['a GitHub token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123 here'],
    ['a GitHub fine-grained token', 'pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop here'],
    ['a Linear key', 'key lin_api_abcdefghijklmnopqrstuvwxyz012345 here'],
    ['a Slack token', 'slack xoxb-1234567890-abcdefghij here'],
    ['an AWS key id', 'id AKIAIOSFODNN7EXAMPLE here'],
    ['a bearer header', 'Authorization: Bearer abc.def-ghi_jkl here'],
    ['a long base64 run', 'blob dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZQ== here'],
    ['a long hex run', 'hash 0123456789abcdef0123456789abcdef here'],
    ['a GitLab token', 'token glpat-abcdefghijklmnopqrstuvwxyz here'],
    ['a basic auth header', 'Authorization: Basic dXNlcjpwYXNzd29yZA== here'],
    ['a lowercase bearer header', 'authorization: bearer abcdefgh12345678 here'],
  ])('replaces %s with [redacted]', (_name, input) => {
    const out = redact(input);
    expect(out).toContain('[redacted]');
    expect(out.startsWith(input.split(' ')[0])).toBe(true);
    expect(out.endsWith(' here')).toBe(true);
    const secret = input.split(' ').slice(1, -1).join(' ');
    expect(out).not.toContain(secret.split(' ').pop());
  });

  it('replaces an email address with [email]', () => {
    expect(redact('ask dorian.collier@example.com today')).toBe('ask [email] today');
  });

  it('shortens the home folder to ~', () => {
    expect(redact(`read ${home}/project/file.ts`)).toBe('read ~/project/file.ts');
    expect(redact(`${home}2/other`)).toBe(`${home}2/other`);
  });

  it.each([
    'the dispatch skill told me to run claim before triage',
    'a basic workaround: bearer of bad news, Basic setup was wrong',
    'the bearer credential expired after a basic setup/teardown step',
  ])('leaves ordinary prose alone: %s', (text) => {
    expect(redact(text)).toBe(text);
  });
});

describe('buildLine', () => {
  // Purpose: the free-text fields are redacted and capped on the way in, whoever calls.
  it('redacts and caps note text at 1,000 characters', () => {
    const line = buildLine(note(`sk-abcdefghijklmnop ${'x'.repeat(2000)}`), {
      now: NOW,
      flowVersion: 'x',
    });
    expect(line.kind === 'note' && line.text.length).toBe(NOTE_TEXT_MAX);
    expect(line.kind === 'note' && line.text.startsWith('[redacted] x')).toBe(true);
  });

  it('keeps only the first line of an error class, redacted and capped at 200', () => {
    const line = buildLine(
      {
        kind: 'oracle.error',
        oracle: 'x',
        exit: 2,
        errorClass: `Error: ghp_abcdefghijklmnopqrstuvwxyz0123 ${'y'.repeat(300)}\n  at stack`,
      },
      { now: NOW, flowVersion: 'x' }
    );
    expect(line.kind === 'oracle.error' && line.errorClass.length).toBe(200);
    expect(line.kind === 'oracle.error' && line.errorClass).toMatch(/^Error: \[redacted\] y+$/);
  });

  // Purpose: EVERY string field is redacted and capped, not only the free text,
  // so a caller that skips the schema (flow note) cannot store a raw address or
  // an over-long name.
  it.each<[string, JournalEvent, string, number]>([
    [
      'item',
      { kind: 'note', noteKind: 'friction', text: 'x', item: 'dorian@example.com' },
      'item',
      64,
    ],
    ['skill', { kind: 'note', noteKind: 'friction', text: 'x', skill: 'a@b.co' }, 'skill', 100],
    [
      'handoff from',
      { kind: 'handoff', from: 'me@work.io', to: 'b', reason: 'manual' },
      'from',
      100,
    ],
    ['handoff to', { kind: 'handoff', from: 'a', to: 'you@work.io', reason: 'manual' }, 'to', 100],
    ['verb', { kind: 'verb', verb: 'x@y.io', ms: 1, exit: 0 }, 'verb', 100],
    ['stage', { kind: 'stage', stage: 'q@r.io', phase: 'start' }, 'stage', 100],
    ['oracle', { kind: 'oracle.error', oracle: 's@t.io', exit: 2, errorClass: 'e' }, 'oracle', 100],
    [
      'retro window',
      { kind: 'retro', window: 'u@v.io', proposals: 0, filed: 0, commented: 0 },
      'window',
      100,
    ],
  ])('redacts and caps the %s field', (_name, event, field, max) => {
    const redacted = buildLine(event, { now: NOW, flowVersion: 'x' }) as Record<string, unknown>;
    expect(redacted[field]).toBe('[email]');
    const long = buildLine({ ...event, [field]: 'z'.repeat(500) } as JournalEvent, {
      now: NOW,
      flowVersion: 'x',
    }) as Record<string, unknown>;
    expect((long[field] as string).length).toBe(max);
    expect(JournalLineSchema.safeParse(long).success).toBe(true);
  });

  it('redacts every entry of a list field', () => {
    const line = buildLine(
      { kind: 'selftest', tiers: ['fast'], pass: 0, fail: 1, skip: 0, ms: 1, failing: ['a@b.io'] },
      { now: NOW, flowVersion: 'x' }
    );
    expect(line.kind === 'selftest' && line.failing).toEqual(['[email]']);
  });

  it('stamps v, ts, flow and the first 8 characters of the session', () => {
    const line = buildLine(note('hi'), {
      now: NOW,
      flowVersion: '0.15.0',
      session: 'abcdef123456',
    });
    expect(line).toMatchObject({
      v: 1,
      ts: NOW.toISOString(),
      flow: '0.15.0',
      session: 'abcdef12',
    });
  });
});

describe('append', () => {
  it('writes one parseable line per event', () => {
    const { options, warnings } = quiet();
    expect(append(settings(), note('one'), options)).toBe('written');
    expect(append(settings(), note('two'), options)).toBe('written');
    const lines = fileLines(settings().path).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.text)).toEqual(['one', 'two']);
    expect(warnings).toEqual([]);
  });

  // Purpose: O_APPEND single writes never interleave inside a line.
  it('keeps 1,000 whole lines when two processes append 500 each at once', async () => {
    const s = settings();
    mkdirSync(path.dirname(s.path), { recursive: true });
    await Promise.all([writer(s.path, 500, 'a', s.maxBytes, s.keep), writer(s.path, 500, 'b')]);
    const { lines, skipped } = read(s);
    expect(skipped).toBe(0);
    expect(lines).toHaveLength(1000);
    for (const tag of ['a', 'b']) {
      const mine = lines.filter((l) => l.kind === 'note' && l.text.startsWith(`${tag} `));
      expect(mine.map((l) => (l.kind === 'note' ? Number(l.text.split(' ')[1]) : -1))).toEqual(
        Array.from({ length: 500 }, (_, i) => i)
      );
    }
  }, 60_000);

  // Purpose: rotation under two live writers drops no line, and each file stays
  // near the cap.
  it('loses no line written while two processes rotate the journal', async () => {
    const s = settings({ maxBytes: 20_000, keep: 12 });
    mkdirSync(path.dirname(s.path), { recursive: true });
    await Promise.all([
      writer(s.path, 500, 'a', s.maxBytes, s.keep),
      writer(s.path, 500, 'b', s.maxBytes, s.keep),
    ]);
    expect(existsSync(rotatedPath(s.path, 1))).toBe(true);
    const { lines, skipped } = read(s);
    expect(skipped).toBe(0);
    expect(lines).toHaveLength(1000);
  }, 60_000);

  it('rotates at the cap and keeps only `keep` older files', () => {
    const s = settings({ maxBytes: 400, keep: 2 });
    const { options } = quiet();
    for (let i = 0; i < 40; i += 1) append(s, note(`line ${i}`), options);
    expect(existsSync(rotatedPath(s.path, 1))).toBe(true);
    expect(existsSync(rotatedPath(s.path, 2))).toBe(true);
    expect(existsSync(rotatedPath(s.path, 3))).toBe(false);
    expect(existsSync(path.join(path.dirname(s.path), LOCK_FILE))).toBe(false);
    const texts = read(s).lines.map((l) => (l.kind === 'note' ? l.text : ''));
    // The newest lines survive, in order, ending with the last one written.
    expect(texts.at(-1)).toBe('line 39');
    const numbers = texts.map((t) => Number(t.split(' ')[1]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers).toEqual(
      Array.from({ length: numbers.length }, (_, i) => 40 - numbers.length + i)
    );
  });

  // Purpose: the re-stat under the lock. A writer that saw the file over the cap,
  // but reached the lock after another writer rotated, must not rotate again.
  it('rotates once, not twice, when two writers both see the file over the cap', () => {
    const s = settings({ keep: 3 });
    const { options } = quiet();
    for (let i = 0; i < 5; i += 1) append(s, note(`old ${i}`), options);
    // Now put the cap exactly at the file's size, so both writers see it full.
    s.maxBytes = statSync(s.path).size;

    let raced = false;
    const first = quiet({
      beforeLock: () => {
        if (raced) return;
        raced = true;
        // The second writer runs in full between the first one's check and its lock.
        expect(append(s, note('second'), options)).toBe('written');
      },
    });
    expect(append(s, note('first'), first.options)).toBe('written');

    expect(existsSync(rotatedPath(s.path, 2))).toBe(false);
    expect(fileLines(rotatedPath(s.path, 1)).map((l) => JSON.parse(l).text)).toEqual([
      'old 0',
      'old 1',
      'old 2',
      'old 3',
      'old 4',
    ]);
    expect(fileLines(s.path).map((l) => JSON.parse(l).text)).toEqual(['second', 'first']);
  });

  it('skips rotation, and still appends, while another writer holds a fresh lock', () => {
    const s = settings({ maxBytes: 100 });
    const { options } = quiet();
    append(s, note('x'.repeat(200)), options);
    const lock = path.join(path.dirname(s.path), LOCK_FILE);
    writeFileSync(lock, '');
    expect(append(s, note('held'), options)).toBe('written');
    expect(existsSync(rotatedPath(s.path, 1))).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(fileLines(s.path)).toHaveLength(2);
  });

  // Purpose: a writer that died holding the lock cannot stop rotation for good.
  it('deletes a stale lock without rotating; the next append rotates', () => {
    const s = settings({ maxBytes: 100 });
    const { options } = quiet();
    append(s, note('x'.repeat(200)), options);
    const lock = path.join(path.dirname(s.path), LOCK_FILE);
    writeFileSync(lock, '');
    const old = (Date.now() - STALE_LOCK_MS - 5_000) / 1000;
    utimesSync(lock, old, old);

    expect(append(s, note('clears'), options)).toBe('written');
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(rotatedPath(s.path, 1))).toBe(false);
    expect(fileLines(s.path)).toHaveLength(2);

    expect(append(s, note('rotates'), options)).toBe('written');
    expect(existsSync(rotatedPath(s.path, 1))).toBe(true);
    expect(fileLines(s.path).map((l) => JSON.parse(l).text)).toEqual(['rotates']);
  });

  // Purpose: a journal failure is one warning, never a throw.
  it('returns failed with one warning, and does not throw, in a read-only folder', () => {
    const s = settings();
    mkdirSync(path.dirname(s.path), { recursive: true });
    chmodSync(path.dirname(s.path), 0o500);
    const { options, warnings } = quiet();
    expect(() => append(s, note('nope'), options)).not.toThrow();
    expect(append(s, note('nope'), options)).toBe('failed');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/journal/);
    expect(existsSync(s.path)).toBe(false);
  });

  // Purpose: one failed call is one warning, even when info/exclude failed first.
  it('warns once when both info/exclude and the append fail', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const info = path.join(dir, '.git', 'info');
    mkdirSync(info, { recursive: true });
    writeFileSync(path.join(info, 'exclude'), '');
    chmodSync(path.join(info, 'exclude'), 0o400);
    const s = settings();
    mkdirSync(path.dirname(s.path), { recursive: true });
    chmodSync(path.dirname(s.path), 0o500);
    const { options, warnings } = quiet();
    try {
      expect(append(s, note('x'), options)).toBe('failed');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/could not be written/);

      chmodSync(path.dirname(s.path), 0o755);
      warnings.length = 0;
      expect(append(s, note('y'), options)).toBe('written');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/out of git/);
    } finally {
      chmodSync(path.join(info, 'exclude'), 0o644);
    }
  });

  it('writes nothing, and creates no folder, when the journal is off', () => {
    const s = settings({ enabled: false });
    const { options, warnings } = quiet();
    expect(append(s, note('off'), options)).toBe('off');
    expect(existsSync(path.join(dir, '.dork'))).toBe(false);
    expect(warnings).toEqual([]);
  });

  // Purpose: the journal never lands in a commit, and the exclude file is not
  // appended to on every write.
  it('adds .dork/flow/ to info/exclude once', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const s = settings();
    const { options } = quiet();
    append(s, note('one'), options);
    append(s, note('two'), options);
    rmSync(s.path);
    append(s, note('three'), options);
    const exclude = readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l.trim() === '.dork/flow/')).toHaveLength(1);
    const ignored = execFileSync('git', ['check-ignore', '.dork/flow/journal.jsonl'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(ignored.trim()).toBe('.dork/flow/journal.jsonl');
  });
});

describe('read', () => {
  it('reads rotated files oldest first, skips bad lines with a count, and filters by since', () => {
    const s = settings({ keep: 2 });
    mkdirSync(path.dirname(s.path), { recursive: true });
    const at = (iso: string, text: string) =>
      JSON.stringify(buildLine(note(text), { now: new Date(iso), flowVersion: 'x' }));
    writeFileSync(rotatedPath(s.path, 2), `${at('2026-09-01T00:00:00Z', 'oldest')}\n`);
    writeFileSync(rotatedPath(s.path, 1), `${at('2026-09-10T00:00:00Z', 'middle')}\nnot json\n`);
    writeFileSync(s.path, `${at('2026-09-20T00:00:00Z', 'newest')}\n{"v":2}\n`);

    const all = read(s);
    expect(all.lines.map((l) => (l.kind === 'note' ? l.text : ''))).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
    expect(all.skipped).toBe(2);
    const recent = read(s, new Date('2026-09-05T00:00:00Z'));
    expect(recent.lines).toHaveLength(2);
  });

  it('reads an empty result when there is no journal', () => {
    expect(read(settings())).toEqual({ lines: [], skipped: 0 });
  });
});

describe('journal settings', () => {
  // Purpose: the zod-free reader and the schema agree on the defaults.
  it('defaults match the config schema', () => {
    expect(FlowConfigSchema.parse({}).selfImprovement.journal).toEqual(JOURNAL_DEFAULTS);
  });

  it('puts the journal in the main checkout and reads the off switch, local over committed', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const flowDir = path.join(dir, '.agents', 'flow');
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(
      path.join(flowDir, 'config.json'),
      JSON.stringify({ selfImprovement: { journal: { enabled: false, keep: 5 } } })
    );
    const roots = findConfigRoots(dir, path.resolve(here, '..'));
    const off = journalSettings(roots);
    expect(off).toMatchObject({ enabled: false, keep: 5, maxBytes: JOURNAL_DEFAULTS.maxBytes });
    expect(off.path).toBe(path.join(roots.checkout, '.dork', 'flow', 'journal.jsonl'));

    writeFileSync(
      path.join(flowDir, 'config.local.json'),
      JSON.stringify({ selfImprovement: { journal: { enabled: true, keep: 'lots' } } })
    );
    expect(journalSettings(roots)).toMatchObject({ enabled: true, keep: JOURNAL_DEFAULTS.keep });
  });
});

/** Spawn one writer process and resolve when it exits 0. */
function writer(
  file: string,
  count: number,
  tag: string,
  maxBytes: number = JOURNAL_DEFAULTS.maxBytes,
  keep: number = JOURNAL_DEFAULTS.keep
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        WRITER,
        file,
        String(count),
        tag,
        String(maxBytes),
        String(keep),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}: ${stderr}`))
    );
  });
}

describe('runtime and harness on every line', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Purpose: flow runs from Claude Code, Codex and OpenCode; the retro splits
  // every measure by runtime, so every line must say which one wrote it.
  it('stamps what the caller names, and the schema requires both', () => {
    const line = buildLine(note('hi'), {
      now: NOW,
      flowVersion: 'x',
      runtime: 'codex',
      harness: 'cmux',
    });
    expect(line).toMatchObject({ runtime: 'codex', harness: 'cmux' });
    expect(JournalLineSchema.safeParse(line).success).toBe(true);
    const { runtime: _r, ...without } = line;
    expect(JournalLineSchema.safeParse(without).success).toBe(false);
  });

  it('detects them from the environment when the caller does not name them', () => {
    vi.stubEnv('FLOW_RUNTIME', 'opencode');
    vi.stubEnv('FLOW_HARNESS', 'dorkos');
    expect(buildLine(note('hi'), { now: NOW })).toMatchObject({
      runtime: 'opencode',
      harness: 'dorkos',
    });
  });
});

describe('usage.snapshot lines', () => {
  const snapshot = (windows: Record<string, unknown>): JournalEvent =>
    ({
      kind: 'usage.snapshot',
      accountRuntime: 'claude-code',
      account: 'acct-2',
      windows,
    }) as unknown as JournalEvent;
  const meta = { now: NOW, flowVersion: 'x', runtime: 'claude-code' as const, harness: 'dorkos' };

  it('accepts the fleet window names and rejects any other, or more than twelve', () => {
    const ok = snapshot({
      five_hour: { usedPct: 10, resetsAt: '2026-09-26T15:00:00Z' },
      'model:claude-opus': { usedPct: 3, resetsAt: null },
      'window:1440': { usedPct: 0, resetsAt: null },
    });
    expect(JournalLineSchema.safeParse(buildLine(ok, meta)).success).toBe(true);
    const bad = snapshot({ daily: { usedPct: 10, resetsAt: null } });
    expect(JournalLineSchema.safeParse(buildLine(bad, meta)).success).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`window:${i + 1}`, { usedPct: 1, resetsAt: null }])
    );
    expect(JournalLineSchema.safeParse(buildLine(snapshot(many), meta)).success).toBe(false);
  });

  it('rejects a usedPct outside 0 to 100 and a field a window does not have', () => {
    for (const reading of [
      { usedPct: 101, resetsAt: null },
      { usedPct: 5, resetsAt: null, note: 'x' },
    ]) {
      expect(
        JournalLineSchema.safeParse(buildLine(snapshot({ five_hour: reading }), meta)).success
      ).toBe(false);
    }
  });

  it('redacts a secret smuggled into a window key or value', () => {
    const line = buildLine(
      snapshot({
        ghp_abcdefghijklmnopqrstuvwxyz0123: {
          usedPct: 1,
          resetsAt: 'sk-ant-api03-abcdefghijklmnop',
        },
      }),
      meta
    ) as unknown as { windows: Record<string, { resetsAt: string }> };
    expect(JSON.stringify(line)).not.toMatch(/ghp_|sk-ant/);
  });
});

describe('shouldSampleUsage', () => {
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  const w = (usedPct: number, resetsAt: string | null = '2026-09-26T15:00:00.000Z') => ({
    usedPct,
    resetsAt,
  });
  const previous = { ts: NOW.toISOString(), windows: { five_hour: w(40), seven_day: w(70) } };

  // Purpose: the ledger keeps only the latest reading; the journal keeps a
  // sampled history, dense enough for trends and small enough to rotate slowly.
  it('samples the first reading of an account', () => {
    expect(shouldSampleUsage(undefined, { five_hour: w(1) }, NOW)).toBe(true);
  });

  it('skips a small change soon after the last sample', () => {
    expect(shouldSampleUsage(previous, { five_hour: w(44), seven_day: w(71) }, at(10))).toBe(false);
  });

  it('samples once the interval has passed, a window moved 5 points, reset, appeared or vanished', () => {
    const later = new Date(NOW.getTime() + USAGE_SAMPLE_INTERVAL_MS);
    expect(shouldSampleUsage(previous, { five_hour: w(40), seven_day: w(70) }, later)).toBe(true);
    expect(shouldSampleUsage(previous, { five_hour: w(45), seven_day: w(70) }, at(1))).toBe(true);
    expect(
      shouldSampleUsage(
        previous,
        { five_hour: w(2, '2026-09-26T20:00:00.000Z'), seven_day: w(70) },
        at(1)
      )
    ).toBe(true);
    expect(shouldSampleUsage(previous, { five_hour: w(40) }, at(1))).toBe(true);
    expect(shouldSampleUsage(previous, { ...previous.windows, seven_day_opus: w(1) }, at(1))).toBe(
      true
    );
  });

  it('samples when the last snapshot time cannot be read', () => {
    expect(
      shouldSampleUsage({ ts: 'garbage', windows: previous.windows }, previous.windows, at(1))
    ).toBe(true);
  });
});
