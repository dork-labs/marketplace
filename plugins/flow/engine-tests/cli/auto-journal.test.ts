/**
 * The journal lines the `flow` CLI writes on its own (spec
 * `flow-self-improvement` §2, DOR-2391 task 3.1): a `verb` line after every
 * verb run, `oracle.error` on an internal error, and the `claim` and `stage`
 * lines of the write verbs.
 *
 * Every case drives `main` against a real temp git project and the in-memory
 * fake tracker, with a fixed wall clock and a scripted run timer, and reads the
 * project's `.dork/flow/journal.jsonl`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordsVerbRun } from '../../scripts/cli/auto-journal.ts';
import type { VerbDefinition } from '../../scripts/cli/context.ts';
import { EXIT } from '../../scripts/errors.ts';
import { main, VERBS, type MainDeps } from '../../scripts/flow.ts';
import { JournalLineSchema } from '../../scripts/journal-schema.ts';
import {
  createFakeAdapter,
  type FakeBacklog,
  type FakeTracker,
} from '../fixtures/cli/fake-adapter/adapter.ts';
import { defaultRunner, item, makeProject, type WriteProject } from './write-harness.ts';

const NOW = '2026-09-26T12:00:00.000Z';
const FLOW_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const VERSION = (
  JSON.parse(readFileSync(path.join(FLOW_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as {
    version: string;
  }
).version;

/** A Claude Code session, as the Bash tool's environment shows it. */
const CLAUDE_ENV = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'claude-session-1234' };
/** A Codex session: Codex sets CODEX_THREAD_ID in every command's environment. */
const CODEX_ENV = { CODEX_THREAD_ID: 'codex-thread-5678' };

let projects: WriteProject[] = [];

beforeEach(() => {
  projects = [];
});

afterEach(() => {
  for (const project of projects) project.cleanup();
});

/** A fresh temp project with the fake-tracker config. */
function newProject(): WriteProject {
  const project = makeProject();
  projects.push(project);
  return project;
}

/** The project's journal file. */
function journalPath(project: WriteProject): string {
  return path.join(project.dir, '.dork', 'flow', 'journal.jsonl');
}

/** Every journal line, parsed and checked against the line schema. */
function lines(project: WriteProject): Record<string, unknown>[] {
  const file = journalPath(project);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(JournalLineSchema.safeParse(parsed).success, line).toBe(true);
      return parsed;
    });
}

/** Run `flow <argv>` in a project; the run timer says every run took 25 ms. */
async function flow(
  project: WriteProject,
  argv: string[],
  options: {
    env?: Record<string, string>;
    backlog?: FakeBacklog;
    tracker?: FakeTracker;
    verbs?: VerbDefinition[];
  } = {}
) {
  const tracker = options.tracker ?? createFakeAdapter(options.backlog ?? { items: [] });
  let stdout = '';
  let stderr = '';
  let tick = 0;
  const deps: MainDeps = {
    env: options.env ?? CLAUDE_ENV,
    cwd: project.dir,
    now: () => new Date(NOW),
    elapsedMs: () => (tick++ === 0 ? 1000 : 1025),
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => tracker.adapter,
    runProcess: defaultRunner,
    flowRoot: FLOW_ROOT,
    ...(options.verbs ? { verbs: options.verbs } : {}),
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr };
}

/** The stamp every line carries for a Claude Code session. */
const CLAUDE_STAMP = {
  v: 1,
  ts: NOW,
  flow: VERSION,
  runtime: 'claude-code',
  harness: 'claude-code',
  session: 'claude-s',
};

/** An item this session has claimed (started, `agent/claimed`). */
const claimed = (id: string) =>
  item(id, { stateCategory: 'started', labels: ['type/task', 'agent/claimed'] });

describe('the write verbs journal what they did, and every run gets a verb line', () => {
  it('claim writes a claim line, then the verb line', async () => {
    // Purpose: a claim is recorded once, as the claim and as the verb run.
    const project = newProject();
    const result = await flow(project, ['claim', 'FAKE-1'], {
      backlog: { items: [item('FAKE-1')] },
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(lines(project)).toEqual([
      { ...CLAUDE_STAMP, kind: 'claim', phase: 'claim', item: 'FAKE-1' },
      { ...CLAUDE_STAMP, kind: 'verb', verb: 'claim', ms: 25, exit: 0, item: 'FAKE-1' },
    ]);
  });

  it('a Codex session is journaled as codex, with its thread id as the session', async () => {
    // Purpose: runtime and harness come from the env the verb was given, not
    // this process's (which is a Claude Code or plain shell).
    const project = newProject();
    const result = await flow(project, ['claim', 'FAKE-1'], {
      env: CODEX_ENV,
      backlog: { items: [item('FAKE-1')] },
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    const stamp = { ...CLAUDE_STAMP, runtime: 'codex', harness: 'codex', session: 'codex-th' };
    expect(lines(project)).toEqual([
      { ...stamp, kind: 'claim', phase: 'claim', item: 'FAKE-1' },
      { ...stamp, kind: 'verb', verb: 'claim', ms: 25, exit: 0, item: 'FAKE-1' },
    ]);
    expect(project.runs()['id-FAKE-1'].runtime).toBe('codex');
  });

  it("claim's lines name the runtime the run records, --runtime included", async () => {
    // Purpose: the claim line, the verb line and FlowRun.runtime all agree.
    const project = newProject();
    const result = await flow(
      project,
      ['claim', 'FAKE-1', '--runtime', 'opencode', '--session', 'oc-session-1'],
      {
        backlog: { items: [item('FAKE-1')] },
      }
    );
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1'].runtime).toBe('opencode');
    const [claim, verb] = lines(project);
    expect(claim).toMatchObject({ kind: 'claim', runtime: 'opencode' });
    expect(verb).toMatchObject({ kind: 'verb', runtime: 'opencode' });
  });

  it('release writes a release line and no item.readied', async () => {
    // Purpose: a release is the end of a claim; handing an item back to the
    // queue is not readying it (it was readied before it was claimed).
    const project = newProject();
    const result = await flow(project, ['release', 'FAKE-1', '--stage', 'execute'], {
      backlog: { items: [claimed('FAKE-1')] },
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(lines(project)).toEqual([
      { ...CLAUDE_STAMP, kind: 'claim', phase: 'release', item: 'FAKE-1' },
      { ...CLAUDE_STAMP, kind: 'verb', verb: 'release', ms: 25, exit: 0, item: 'FAKE-1' },
    ]);
  });

  it('stage writes a stage start line for the new stage', async () => {
    const project = newProject();
    const result = await flow(project, ['stage', 'FAKE-1', 'verify'], {
      backlog: { items: [claimed('FAKE-1')] },
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(lines(project)).toEqual([
      { ...CLAUDE_STAMP, kind: 'stage', stage: 'verify', phase: 'start', item: 'FAKE-1' },
      { ...CLAUDE_STAMP, kind: 'verb', verb: 'stage', ms: 25, exit: 0, item: 'FAKE-1' },
    ]);
  });

  it('done writes a stage end line with outcome ok', async () => {
    const project = newProject();
    const result = await flow(project, ['done', 'FAKE-1', '--summary', 'Shipped.'], {
      backlog: { items: [claimed('FAKE-1')] },
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(lines(project)).toEqual([
      {
        ...CLAUDE_STAMP,
        kind: 'stage',
        stage: 'done',
        phase: 'end',
        outcome: 'ok',
        item: 'FAKE-1',
      },
      { ...CLAUDE_STAMP, kind: 'verb', verb: 'done', ms: 25, exit: 0, item: 'FAKE-1' },
    ]);
  });

  it('a repeated done (the recovery path) writes no second stage end line', async () => {
    // Purpose: done is safe to re-run; the journal must not count the item twice.
    const project = newProject();
    const tracker = createFakeAdapter({ items: [item('FAKE-1')] });
    const claimRun = await flow(project, ['claim', 'FAKE-1'], { tracker });
    expect(claimRun.code, claimRun.stderr).toBe(EXIT.ok);
    for (let i = 0; i < 2; i += 1) {
      const done = await flow(project, ['done', 'FAKE-1', '--summary', 'Shipped.'], { tracker });
      expect(done.code, done.stderr).toBe(EXIT.ok);
    }
    expect(lines(project).map((line) => `${line.kind}:${line.verb ?? line.phase}`)).toEqual([
      'claim:claim',
      'verb:claim',
      'stage:end',
      'verb:done',
      'verb:done',
    ]);
  });

  it('a repeated done with no local run record writes no second stage end line', async () => {
    // Purpose: an item closed from another machine has no FlowRun here; the
    // posted summary alone marks the re-run.
    const project = newProject();
    const tracker = createFakeAdapter({ items: [claimed('FAKE-1')] });
    for (let i = 0; i < 2; i += 1) {
      const done = await flow(project, ['done', 'FAKE-1', '--summary', 'Shipped.'], { tracker });
      expect(done.code, done.stderr).toBe(EXIT.ok);
    }
    expect(project.runs()).toEqual({});
    expect(lines(project).map((line) => `${line.kind}:${line.verb ?? line.phase}`)).toEqual([
      'stage:end',
      'verb:done',
      'verb:done',
    ]);
  });

  it('a dry run records only the verb run', async () => {
    // Purpose: a dry run changed nothing, so it claims and moves nothing.
    const project = newProject();
    const result = await flow(project, ['claim', 'FAKE-1', '--dry-run'], {
      backlog: { items: [item('FAKE-1')] },
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(lines(project).map((line) => line.kind)).toEqual(['verb']);
  });

  it('a refused verb records its exit code, and no oracle error', async () => {
    // Purpose: a precondition refusal (exit 5) is flow working, not failing.
    const project = newProject();
    const result = await flow(project, ['claim', 'FAKE-1'], {
      backlog: { items: [claimed('FAKE-1')] },
    });
    expect(result.code).toBe(EXIT.precondition);
    expect(lines(project)).toEqual([
      { ...CLAUDE_STAMP, kind: 'verb', verb: 'claim', ms: 25, exit: 5, item: 'FAKE-1' },
    ]);
  });

  it('a verb that is not about one item has no item on its line', async () => {
    const project = newProject();
    const result = await flow(project, ['next'], { backlog: { items: [item('FAKE-1')] } });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(lines(project)).toEqual([
      { ...CLAUDE_STAMP, kind: 'verb', verb: 'next', ms: 25, exit: 0 },
    ]);
  });

  it('an internal error adds an oracle.error line with the redacted first line', async () => {
    // Purpose: a bug (exit 70) is what the retro counts as an oracle error.
    const project = newProject();
    const broken: VerbDefinition = {
      name: 'broken',
      summary: 'Throws.',
      description: 'Throws.',
      load: async () => ({
        run: async () => {
          throw new Error('invariant broke for ghp_abcdefghijklmnopqrstuvwxyz0123\nstack line');
        },
      }),
    };
    const result = await flow(project, ['broken'], { verbs: [broken] });
    expect(result.code).toBe(EXIT.internal);
    expect(lines(project)).toEqual([
      { ...CLAUDE_STAMP, kind: 'verb', verb: 'broken', ms: 25, exit: 70 },
      {
        ...CLAUDE_STAMP,
        kind: 'oracle.error',
        oracle: 'broken',
        exit: 70,
        errorClass: 'invariant broke for [redacted]',
      },
    ]);
  });
});

describe('what is never journaled', () => {
  it('--help and usage errors write nothing', async () => {
    const project = newProject();
    for (const argv of [
      ['--help'],
      [],
      ['claim', '--help'],
      ['no-such-verb'],
      ['claim'],
      ['claim', 'FAKE-1', '--no-such-flag'],
    ]) {
      const result = await flow(project, argv, { backlog: { items: [item('FAKE-1')] } });
      expect(result.code === EXIT.ok || result.code === EXIT.usage, argv.join(' ')).toBe(true);
    }
    expect(existsSync(journalPath(project))).toBe(false);
  });

  it('note and journal do not journal themselves as verb runs', async () => {
    const project = newProject();
    const note = await flow(project, ['note', '--kind', 'friction', 'A step was missing.']);
    expect(note.code, note.stderr).toBe(EXIT.ok);
    const tail = await flow(project, ['journal', 'tail']);
    expect(tail.code, tail.stderr).toBe(EXIT.ok);
    expect(lines(project).map((line) => line.kind)).toEqual(['note']);
  });

  it('usage record, which the status line runs constantly, is a verb run only when it fails', () => {
    expect(recordsVerbRun('usage', ['record'], 0)).toBe(false);
    expect(recordsVerbRun('usage', ['record'], 2)).toBe(true);
    expect(recordsVerbRun('usage', ['scan'], 0)).toBe(true);
    expect(recordsVerbRun('note', [], 0)).toBe(false);
    expect(recordsVerbRun('journal', ['tail'], 0)).toBe(false);
    expect(recordsVerbRun('claim', ['FAKE-1'], 0)).toBe(true);
  });

  it('a usage record that crashes still leaves its verb and oracle.error lines', async () => {
    // Purpose: skipping the recorder's successes must not hide its crashes;
    // the retro's oracle-error count is the only place a recorder bug shows.
    const usage: VerbDefinition = {
      name: 'usage',
      summary: 'Stand-in for flow usage.',
      description: 'Throws when FAIL is set.',
      positionals: [{ name: 'sub-verb', description: 'record.' }],
      load: async () => ({
        run: async (ctx) => {
          if (ctx.env.FAIL === '1') throw new Error('ledger write exploded');
          return { json: {}, text: '' };
        },
      }),
    };
    const project = newProject();
    const ok = await flow(project, ['usage', 'record'], { verbs: [usage] });
    expect(ok.code).toBe(EXIT.ok);
    expect(lines(project)).toEqual([]);
    const crash = await flow(project, ['usage', 'record'], {
      verbs: [usage],
      env: { ...CLAUDE_ENV, FAIL: '1' },
    });
    expect(crash.code).toBe(EXIT.internal);
    expect(lines(project)).toEqual([
      { ...CLAUDE_STAMP, kind: 'verb', verb: 'usage', ms: 25, exit: 70 },
      {
        ...CLAUDE_STAMP,
        kind: 'oracle.error',
        oracle: 'usage',
        exit: 70,
        errorClass: 'ledger write exploded',
      },
    ]);
  });

  it('note and journal still get an oracle.error line when they crash', async () => {
    // Purpose: skipping their verb line must not hide an internal error.
    const project = newProject();
    const note: VerbDefinition = {
      name: 'note',
      summary: 'Stand-in for flow note.',
      description: 'Throws.',
      load: async () => ({
        run: async () => {
          throw new Error('note writer exploded');
        },
      }),
    };
    const result = await flow(project, ['note'], { verbs: [note] });
    expect(result.code).toBe(EXIT.internal);
    expect(lines(project)).toEqual([
      {
        ...CLAUDE_STAMP,
        kind: 'oracle.error',
        oracle: 'note',
        exit: 70,
        errorClass: 'note writer exploded',
      },
    ]);
  });

  it('a git project with no flow config gets no journal', async () => {
    const project = newProject();
    rmSync(path.join(project.dir, '.agents', 'flow', 'config.json'));
    const result = await flow(project, ['claim', 'FAKE-1'], {
      backlog: { items: [item('FAKE-1')] },
    });
    expect(result.code).not.toBe(EXIT.ok);
    expect(existsSync(path.join(project.dir, '.dork', 'flow'))).toBe(false);
  });

  it('every verb in the table is either journaled or deliberately left out', () => {
    // Purpose: a new verb is journaled by default; only note and journal are not
    // (usage record is left out by its sub-verb).
    const skipped = VERBS.filter((verb) => !recordsVerbRun(verb.name, [], 0)).map((v) => v.name);
    expect(skipped).toEqual(['note', 'journal']);
  });
});

describe('an unwritable journal changes nothing a caller sees', () => {
  /** Where the journal must fail: its file path is a folder, so appending fails with EISDIR. */
  function breakJournal(project: WriteProject): void {
    mkdirSync(journalPath(project), { recursive: true });
  }

  /** Turn the journal off in the project's config. */
  function journalOff(project: WriteProject): void {
    project.config({
      tracker: 'fake',
      identity: { agent: 'agent-1' },
      selfImprovement: { journal: { enabled: false } },
    });
  }

  const cases: Array<{ name: string; argv: string[]; backlog: FakeBacklog }> = [
    { name: 'claim', argv: ['claim', 'FAKE-1'], backlog: { items: [item('FAKE-1')] } },
    {
      name: 'release',
      argv: ['release', 'FAKE-1', '--stage', 'execute'],
      backlog: { items: [claimed('FAKE-1')] },
    },
    {
      name: 'stage',
      argv: ['stage', 'FAKE-1', 'verify'],
      backlog: { items: [claimed('FAKE-1')] },
    },
    {
      name: 'done',
      argv: ['done', 'FAKE-1', '--summary', 'Shipped.'],
      backlog: { items: [claimed('FAKE-1')] },
    },
    { name: 'next', argv: ['next'], backlog: { items: [item('FAKE-1')] } },
    {
      name: 'a refused claim',
      argv: ['claim', 'FAKE-1'],
      backlog: { items: [claimed('FAKE-1')] },
    },
  ];

  for (const { name, argv, backlog } of cases) {
    for (const json of [false, true]) {
      it(`${name}${json ? ' --json' : ''}: stdout, stderr and exit code are byte-identical`, async () => {
        const outcomes = [];
        for (const setup of [() => {}, breakJournal, journalOff]) {
          const project = newProject();
          setup(project);
          // The journal's own warning goes to the real stderr, not the injected one.
          const processStderr = vi.spyOn(process.stderr, 'write');
          const result = await flow(project, json ? [...argv, '--json'] : argv, {
            backlog: structuredClone(backlog),
          });
          const leaked = processStderr.mock.calls.length;
          processStderr.mockRestore();
          outcomes.push({
            leaked,
            code: result.code,
            stdout: result.stdout.split(project.dir).join('<project>'),
            stderr: result.stderr.split(project.dir).join('<project>'),
          });
        }
        const [working, broken, off] = outcomes;
        expect(working.leaked).toBe(0);
        expect(broken).toEqual(working);
        expect(off).toEqual(working);
      });
    }
  }

  it('the broken journal really was not written', async () => {
    const project = newProject();
    breakJournal(project);
    const result = await flow(project, ['claim', 'FAKE-1'], {
      backlog: { items: [item('FAKE-1')] },
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(result.stderr).toBe('');
    expect(project.runs()['id-FAKE-1']).toBeDefined();
  });
});
