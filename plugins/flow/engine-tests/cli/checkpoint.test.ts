/**
 * `flow checkpoint` (spec `flow-handoff-dispatch` §1, task 1.1): the verb as
 * registered in the shipped verb table, driven through `main` against real temp
 * git repositories with a bare `origin`, so every header fact is measured the
 * way it is in use. The run store is the real file store.
 */

import { execFileSync } from 'node:child_process';
import {
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcessRunner } from '../../scripts/cli/context.ts';
import { CHECKPOINT_EXCLUDE_LINES, parseCheckpoint } from '../../scripts/drain/checkpoint.ts';
import type { DrainState } from '../../scripts/drain/state.ts';
import { EXIT } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { openFlowStateFile } from '../../scripts/flow-state-file.ts';
import { main } from '../../scripts/flow.ts';

const NOW = '2026-09-26T18:02:11.000Z';

const BODY = [
  '## Done',
  '',
  '- Task 1.3 committed.',
  '',
  '## Next',
  '',
  '- Task 1.4.',
  '',
  '## Open questions',
  '',
  'None.',
  '',
  '## Next command',
  '',
  '```sh',
  'npm test',
  '```',
  '',
].join('\n');

let base: string;
let repo: string;
let bodyFile: string;

/** Run git quietly with a fixed identity and no signing. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

/** A recording text sink. */
function sink(): { write(chunk: string): boolean; text(): string } {
  let buffer = '';
  return {
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    text: () => buffer,
  };
}

/** Run `flow <argv>` in `cwd` with the real process runner and the shipped verbs. */
async function flow(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, {
    env: options.env ?? {},
    cwd: options.cwd ?? repo,
    now: () => new Date(NOW),
    stdout,
    stderr,
    createAdapter: async () => {
      throw new Error('flow checkpoint must not need a tracker');
    },
    runProcess: realProcessRunner,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** The checkpoint file in `dir`, parsed. */
function readCheckpoint(dir = repo) {
  const parsed = parseCheckpoint(
    readFileSync(path.join(dir, '.dork', 'flow', 'HANDOFF.md'), 'utf8')
  );
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed;
}

/** A run record for ACME-12 in `repo`. */
function run(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    issueId: 'issue-12',
    identifier: 'ACME-12',
    sessionId: 'run-session',
    worktreePath: repo,
    branch: 'acme-12',
    stage: 'verify',
    status: 'running',
    attemptCount: 0,
    workerPid: 4242,
    startedAt: '2026-09-26T16:00:00.000Z',
    account: 'claude3',
    host: 'cli',
    ...overrides,
  };
}

/** A drain state at `rev`. */
function drain(rev: number): DrainState {
  return {
    v: 1,
    rev,
    phase: 'working',
    worker: null,
    reviewer: null,
    pushedSha: null,
    reviewedSha: null,
    verdict: null,
    reviewRound: 2,
    pr: {
      repo: 'acme/app',
      number: 88,
      url: 'https://example.test/acme/app/pull/88',
      armed: false,
      disarmedForReview: false,
    },
    rearmedFor: null,
    nudges: 0,
    wakeAfter: null,
    handoffs: [],
    parkedReason: null,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-checkpoint-cli-')));
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', origin);
  repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'acme-12');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  bodyFile = path.join(base, 'body.md');
  writeFileSync(bodyFile, BODY);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('flow checkpoint', () => {
  // Purpose: with no run record the verb still writes, measuring the header
  // from git and the flags: sessionId from FLOW_SESSION_ID, account and host
  // null, an unpushed branch gives pushedSha null, and the checkpoint itself
  // does not make the tree dirty. --json prints { v, path, header }.
  it('writes a measured checkpoint with no run record', async () => {
    const result = await flow(
      [
        'checkpoint',
        'ACME-12',
        '--trigger',
        'manual',
        '--body-file',
        bodyFile,
        '--stage',
        'execute',
        '--spec',
        'specs/x/02-specification.md',
        '--json',
      ],
      { env: { FLOW_SESSION_ID: 'env-session' } }
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(EXIT.ok);
    const header = {
      v: 1,
      identifier: 'ACME-12',
      stage: 'execute',
      trigger: 'manual',
      writtenAt: NOW,
      sessionId: 'env-session',
      account: null,
      host: null,
      branch: 'acme-12',
      headSha: git(repo, 'rev-parse', 'HEAD'),
      pushedSha: null,
      dirty: false,
      spec: 'specs/x/02-specification.md',
      task: null,
      pr: null,
      reviewRound: null,
    };
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      v: 1,
      path: path.join(repo, '.dork', 'flow', 'HANDOFF.md'),
      header,
    });
    const written = readCheckpoint();
    expect(written.header).toEqual(header);
    expect(written.title).toBeNull();
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  // Purpose: the exclude lines go in before the tree is measured, so a
  // checkpoint left from before they existed does not read as uncommitted work.
  // Fails if the excludes are added only after measuring.
  it('does not count an existing checkpoint as a dirty tree', async () => {
    mkdirSync(path.join(repo, '.dork', 'flow'), { recursive: true });
    writeFileSync(path.join(repo, '.dork', 'flow', 'HANDOFF.md'), 'old');
    const result = await flow([
      'checkpoint',
      'ACME-12',
      '--trigger',
      'manual',
      '--body-file',
      bodyFile,
      '--stage',
      'execute',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(readCheckpoint().header.dirty).toBe(false);
  });

  // Purpose: pushedSha is the branch's SHA on origin, which can lag HEAD, and an
  // uncommitted file makes the tree dirty.
  it('measures pushedSha and dirty from git', async () => {
    git(repo, 'push', '-q', 'origin', 'acme-12');
    const pushed = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'second');
    writeFileSync(path.join(repo, 'scratch.txt'), 'x');

    const result = await flow([
      'checkpoint',
      'ACME-12',
      '--trigger',
      'fix',
      '--body-file',
      bodyFile,
      '--stage',
      'verify',
    ]);
    expect(result.code).toBe(EXIT.ok);
    const { header } = readCheckpoint();
    expect(header.pushedSha).toBe(pushed);
    expect(header.headSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(header.headSha).not.toBe(pushed);
    expect(header.dirty).toBe(true);
    expect(header.trigger).toBe('fix');
  });

  // Purpose: with a run record, the header takes sessionId, account, host,
  // stage, PR and review round from it; the run gets checkpointAt and
  // checkpointSha; drain.rev goes up by one on every write (the supervisor's
  // compare-and-set depends on it); the previous copy is kept; the exclude
  // lines appear once.
  it('reads and updates the run record, bumping drain.rev each write', async () => {
    const store = openFlowStateFile(repo);
    await store.upsertRun(run({ drain: drain(3) }));

    const first = await flow([
      'checkpoint',
      'ACME-12',
      '--trigger',
      'task',
      '--task',
      '1.3',
      '--body-file',
      bodyFile,
    ]);
    expect(first.code).toBe(EXIT.ok);
    const { header } = readCheckpoint();
    expect(header).toMatchObject({
      sessionId: 'run-session',
      account: 'claude3',
      host: 'cli',
      stage: 'verify',
      task: '1.3',
      pr: 'https://example.test/acme/app/pull/88',
      reviewRound: 2,
    });
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(store.read()['issue-12']).toMatchObject({ checkpointAt: NOW, checkpointSha: head });
    expect(store.read()['issue-12'].drain?.rev).toBe(4);

    const second = await flow(
      [
        'checkpoint',
        'ACME-12',
        '--trigger',
        'manual',
        '--body-file',
        bodyFile,
        '--session',
        'flag-session',
      ],
      { env: { FLOW_SESSION_ID: 'env-session' } }
    );
    expect(second.code).toBe(EXIT.ok);
    expect(readCheckpoint().header.sessionId).toBe('flag-session');
    expect(store.read()['issue-12'].drain?.rev).toBe(5);
    const prev = parseCheckpoint(
      readFileSync(path.join(repo, '.dork', 'flow', 'HANDOFF.prev.md'), 'utf8')
    );
    expect(prev.ok && prev.header.trigger).toBe('task');

    const exclude = readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n');
    for (const line of CHECKPOINT_EXCLUDE_LINES) {
      expect(exclude.filter((l) => l === line)).toHaveLength(1);
    }
  });

  // Purpose: a run with no drain gets its checkpoint fields and no drain block
  // invented for it.
  it('adds no drain state to a run outside a drain', async () => {
    const store = openFlowStateFile(repo);
    await store.upsertRun(run());
    expect(
      (await flow(['checkpoint', 'ACME-12', '--trigger', 'stage', '--body-file', bodyFile])).code
    ).toBe(EXIT.ok);
    const after = store.read()['issue-12'];
    expect(after.checkpointSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(after).not.toHaveProperty('drain');
  });

  // Purpose: outside a git worktree the verb refuses with exit 5 and writes
  // nothing.
  it('refuses a folder that is not a git worktree', async () => {
    const plain = path.join(base, 'plain');
    mkdirSync(plain);
    const result = await flow(
      [
        'checkpoint',
        'ACME-12',
        '--trigger',
        'manual',
        '--body-file',
        bodyFile,
        '--stage',
        'execute',
      ],
      { cwd: plain }
    );
    expect(result.code).toBe(EXIT.precondition);
    expect(result.stderr).toMatch(/not a git worktree/);
    expect(existsSync(path.join(plain, '.dork'))).toBe(false);
  });

  // Purpose: a body that breaks a rule is refused with exit 5 naming the rule,
  // before anything is written.
  it('refuses a body that breaks a rule, writing nothing', async () => {
    writeFileSync(bodyFile, BODY.replace('## Open questions\n\nNone.\n\n', ''));
    const result = await flow([
      'checkpoint',
      'ACME-12',
      '--trigger',
      'manual',
      '--body-file',
      bodyFile,
      '--stage',
      'execute',
    ]);
    expect(result.code).toBe(EXIT.precondition);
    expect(result.stderr).toMatch(/exactly four ## sections/);
    expect(existsSync(path.join(repo, '.dork'))).toBe(false);
  });

  // Purpose: the usage errors (exit 2): a task trigger without --task, a
  // trigger flow does not know, a missing body file flag, an unknown stage, and
  // no stage source at all.
  it.each([
    [['--trigger', 'task'], /--task/],
    [['--trigger', 'whim', '--stage', 'execute'], /trigger/],
    [['--trigger', 'manual', '--stage', 'somewhere'], /stage/],
    [['--trigger', 'manual'], /--stage/],
  ])('refuses %j as a usage error', async (flags, message) => {
    const result = await flow(['checkpoint', 'ACME-12', '--body-file', bodyFile, ...flags]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(message);
  });

  // Purpose: --body-file is required.
  it('needs --body-file', async () => {
    const result = await flow([
      'checkpoint',
      'ACME-12',
      '--trigger',
      'manual',
      '--stage',
      'execute',
    ]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/--body-file/);
  });
});
