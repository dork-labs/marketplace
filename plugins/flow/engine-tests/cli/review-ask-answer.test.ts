/**
 * `flow review`, `flow ask`, `flow answer`, `flow autonomy` and `flow report
 * review-brief` (spec `flow-multiproject` §7.5, §7.7): driven through `main`
 * against a real temp git project with a bare `origin`, a fake forge that
 * records every call, the fake tracker, and a temp DorkOS home holding the
 * project's autonomy dial. Only `git remote get-url origin` is answered by the
 * test (a GitHub address); every other git call is real.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { autonomyCopyPath } from '../../scripts/autonomy.ts';
import { realProcessRunner, type ProcessRunner } from '../../scripts/cli/context.ts';
import { shouldRespondToComment } from '../../scripts/comment-response.ts';
import { FlowConfigSchema } from '../../scripts/config-schema.ts';
import type { DrainState } from '../../scripts/drain/state.ts';
import { EXIT, TrackerError } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { main } from '../../scripts/flow.ts';
import {
  LaunchError,
  type HostName,
  type LaunchRequest,
  type Launcher,
} from '../../scripts/launchers/types.ts';
import {
  ForgeError,
  type Forge,
  type ForgeTarget,
  type ReviewInput,
} from '../../scripts/forge/types.ts';
import { canonicalProjectRoot } from '../../scripts/main-checkout.ts';
import { createFakeAdapter, type FakeTracker } from '../fixtures/cli/fake-adapter/adapter.ts';
import { item, makeProject, type WriteProject } from './write-harness.ts';

const MARKER = '— 🤖 /flow';
const NOW = '2026-09-26T12:00:00.000Z';

let project: WriteProject;
let origin: string;
let dorkHome: string;

/** Run git in the project with a fixed identity. */
function git(...args: string[]): string {
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
    { cwd: project.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

/** Write the project's autonomy dial where the Flow extension would. */
function dial(value: Record<string, unknown>): void {
  const file = autonomyCopyPath(dorkHome, canonicalProjectRoot(project.dir));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/** A fake forge recording its calls; `head` is the branch's head on origin. */
function fakeForge(
  opts: {
    head?: string | null;
    pr?: boolean;
    failing?: string[] | string[][];
    pending?: number | number[];
    /** How many checks the head reported at all; absent: as many as `pending` says, at least 1. */
    reported?: number;
    /** What `requiredChecks` answers; `'missing'` leaves the method off, `'throw'` fails it. */
    required?: string[] | null | 'missing' | 'throw';
    /** The names of the reported checks. */
    checkNames?: string[];
    /** The PR's head per `prStatus` call (default `head`); a list is used in turn. */
    prHead?: string | string[];
    /** `prStatus` throws this forge error. */
    statusError?: string;
  } = {}
) {
  const calls: { method: string; arg?: unknown }[] = [];
  const forge: Forge = {
    repo: 'acme/app',
    async branchHead() {
      return opts.head ?? null;
    },
    async prForBranch() {
      return opts.pr === false
        ? null
        : { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: opts.head ?? null };
    },
    async createPr() {
      throw new Error('review never opens a PR');
    },
    async prStatus(pr) {
      calls.push({ method: 'prStatus', arg: pr });
      if (opts.statusError !== undefined) throw new ForgeError(opts.statusError);
      const prHead = Array.isArray(opts.prHead) ? opts.prHead.shift() : opts.prHead;
      const failing = Array.isArray(opts.failing?.[0])
        ? ((opts.failing as string[][]).shift() ?? [])
        : ((opts.failing as string[] | undefined) ?? []);
      const pendingChecks = Array.isArray(opts.pending)
        ? (opts.pending.shift() ?? 0)
        : (opts.pending ?? 0);
      return {
        state: 'open',
        failing: failing.map((name) => ({ name, url: null })),
        pendingChecks,
        checksReported: opts.reported ?? Math.max(1, pendingChecks),
        ...(opts.checkNames === undefined ? {} : { checkNames: opts.checkNames }),
        armed: false,
        queued: false,
        headSha: prHead ?? opts.head ?? 'feedface',
        base: 'work',
      };
    },
    async arm(pr, sha) {
      calls.push({ method: 'arm', arg: [pr, sha] });
    },
    async disarm(pr) {
      calls.push({ method: 'disarm', arg: pr });
    },
    async recentGroupFailures() {
      return [];
    },
    async review(pr: number, input: ReviewInput) {
      calls.push({ method: 'review', arg: [pr, input] });
      return 'reviewed';
    },
  };
  const required = opts.required;
  if (required !== 'missing') {
    forge.requiredChecks = async (base) => {
      calls.push({ method: 'requiredChecks', arg: base });
      if (required === 'throw') throw new ForgeError('gh: HTTP 403');
      return required === undefined ? [] : required;
    };
  }
  return { forge, calls, factory: (_t: ForgeTarget) => forge };
}

/** A launcher that records each start and starts nothing (or throws `fail`). */
function fakeLauncher(host: HostName, starts: { req: LaunchRequest }[], fail?: Error): Launcher {
  return {
    host,
    supports: () => ({ ok: true }),
    probe: async () => ({ ok: true }),
    async start(req) {
      if (fail) throw fail;
      starts.push({ req });
      return { host, runtime: req.runtime, sessionId: req.sessionId, account: null, cwd: req.cwd };
    },
    send: async (handle) => ({ result: 'delivered', handle }),
    state: async () => ({ kind: 'busy' }),
    stop: async () => 'stopped',
  } as Launcher;
}

/** Real git, except `remote get-url origin` answers a GitHub address. */
const runner: ProcessRunner = async (cmd, args, opts) => {
  if (cmd === 'git' && args.join(' ') === 'remote get-url origin') {
    return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' };
  }
  return realProcessRunner(cmd, args, opts);
};

/** Run `flow <argv> --json` in the project. */
async function flow(
  argv: string[],
  options: {
    forge?: ReturnType<typeof fakeForge>;
    tracker?: FakeTracker;
    now?: string;
    clock?: () => Date;
    launcher?: (host: HostName) => Launcher;
    cwd?: string;
    sleep?: (ms: number) => Promise<void>;
  } = {}
) {
  const forge = options.forge ?? fakeForge();
  const tracker = options.tracker ?? createFakeAdapter({ items: [] });
  let out = '';
  let err = '';
  const code = await main([...argv, '--json'], {
    env: { FLOW_SESSION_ID: 'session-abcdef123456', CLAUDECODE: '1', DORK_HOME: dorkHome },
    cwd: options.cwd ?? project.dir,
    now: options.clock ?? (() => new Date(options.now ?? NOW)),
    stdout: { write: (c: string) => (out += c) },
    stderr: { write: (c: string) => (err += c) },
    createAdapter: async () => tracker.adapter,
    runProcess: runner,
    createForge: forge.factory,
    // --wait polls with the host's sleep; a test never waits for real.
    io: { sleep: options.sleep ?? (async () => undefined) },
    ...(options.launcher === undefined ? {} : { createLauncher: options.launcher }),
  });
  return { code, json: JSON.parse(out) as Record<string, unknown>, stderr: err, forge, tracker };
}

/** The ACME-12 run, at `stage`, with extra fields. */
function writeRun(fields: Partial<FlowRun> = {}): void {
  const run: FlowRun = {
    issueId: 'id-ACME-12',
    identifier: 'ACME-12',
    sessionId: 'session-abcdef123456',
    worktreePath: project.dir,
    branch: 'work',
    stage: 'review',
    status: 'waiting_for_review',
    attemptCount: 0,
    workerPid: 1,
    startedAt: '2026-09-26T10:00:00.000Z',
    ...fields,
  };
  project.writeRuns({ 'id-ACME-12': run });
}

function stored(): FlowRun {
  return project.runs()['id-ACME-12'];
}

function started(labels: string[] = ['type/task', 'agent/claimed']) {
  return item('ACME-12', {
    stateCategory: 'started',
    stateName: 'In Progress',
    labels,
    agentDisposition: 'claimed',
  });
}

function drain(overrides: Partial<DrainState> = {}): DrainState {
  return {
    v: 1,
    rev: 3,
    phase: 'watching',
    worker: null,
    reviewer: null,
    pushedSha: null,
    reviewedSha: null,
    verdict: null,
    reviewRound: 1,
    pr: null,
    rearmedFor: null,
    nudges: 0,
    wakeAfter: null,
    handoffs: [],
    parkedReason: null,
    ...overrides,
  };
}

/** Comments the tracker received, in order. */
function comments(tracker: FakeTracker): string[] {
  return tracker.calls.flatMap((call) =>
    call.method === 'comment' ? [(call as { body: string }).body] : []
  );
}

beforeEach(() => {
  project = makeProject();
  origin = `${project.dir}-origin.git`;
  dorkHome = mkdtempSync(path.join(tmpdir(), 'flow-dorkhome-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'work', origin]);
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'work');
});

afterEach(() => {
  project.cleanup();
  rmSync(origin, { recursive: true, force: true });
  rmSync(dorkHome, { recursive: true, force: true });
});

describe('flow review --approve by a person', () => {
  // Purpose: a person's 👍 ships: a plain comment without the agent's marker,
  // an approval on the forge, and an arm when mergeOnApproval is on (the
  // default). Nothing is closed or moved.
  it('comments, approves the PR and arms it, and closes nothing', async () => {
    writeRun();
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(['review', 'ACME-12', '--approve', '--head', 'abc1234def'], {
      tracker,
      forge: fakeForge({ head: 'abc1234def' }),
    });
    expect(result.code).toBe(EXIT.ok);
    expect(comments(tracker)).toEqual(['Shipped from DorkOS.']);
    expect(tracker.calls.some((call) => call.method === 'applyWorkState')).toBe(false);
    expect(result.forge.calls).toContainEqual({
      method: 'review',
      arg: [7, { event: 'approve', body: 'Shipped from DorkOS.' }],
    });
    expect(result.forge.calls).toContainEqual({ method: 'arm', arg: [7, 'abc1234def'] });
    expect(result.json).toMatchObject({ verdict: 'approved', by: 'person', armed: true });
  });

  // Purpose: with mergeOnApproval off, a person merges: nothing is armed.
  it('leaves the merge to a person when mergeOnApproval is off', async () => {
    project.config({
      tracker: 'fake',
      identity: { agent: 'agent-1' },
      gates: { review: { mergeOnApproval: false } },
    });
    writeRun();
    const result = await flow(['review', 'ACME-12', '--approve'], {
      tracker: createFakeAdapter({ items: [started()] }),
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.forge.calls.some((call) => call.method === 'arm')).toBe(false);
  });

  // Purpose: the gate is only answered at the gate.
  it('refuses an item that is not at the review gate (exit 5)', async () => {
    writeRun({ stage: 'execute', status: 'running' });
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(['review', 'ACME-12', '--approve'], { tracker });
    expect(result.code).toBe(EXIT.precondition);
    expect(comments(tracker)).toEqual([]);
  });
});

describe('flow review --changes', () => {
  // Purpose: 👎 sends the work back with the note: a comment as the person, a
  // request for changes on the PR, and the run back at execute with its
  // session. Nothing is closed, released or reassigned.
  it('comments the note, requests changes and moves a run back to execute', async () => {
    writeRun();
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(
      ['review', 'ACME-12', '--changes', '--note', 'Use the new banner copy.'],
      { tracker }
    );
    expect(result.code).toBe(EXIT.ok);
    expect(comments(tracker)).toEqual(['Sent back: Use the new banner copy.']);
    expect(result.forge.calls).toContainEqual({
      method: 'review',
      arg: [7, { event: 'request-changes', body: 'Use the new banner copy.' }],
    });
    expect(stored()).toMatchObject({ stage: 'execute', sessionId: 'session-abcdef123456' });
    const writes = tracker.calls.filter((call) => call.method === 'applyWorkState');
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes)).not.toMatch(/completed|canceled|agent\/completed/);
  });

  // Purpose: a drain run goes back through the drain's own transition: a
  // CHANGES verdict at the pushed commit with the note as its findings, which
  // the drain hands to its worker.
  it('gives a drain run a CHANGES verdict with the note as its findings', async () => {
    writeRun({
      stage: 'verify',
      drain: drain({ pushedSha: 'abc1234def', verdict: 'clean', reviewedSha: 'abc1234def' }),
    });
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(['review', 'ACME-12', '--changes', '--note', 'Rename the flag.'], {
      tracker,
    });
    expect(result.code).toBe(EXIT.ok);
    expect(stored().drain).toMatchObject({
      phase: 'reviewing',
      verdict: 'changes',
      reviewedSha: 'abc1234def',
      reviewRound: 2,
      rev: 4,
    });
    const findings = path.join(project.dir, '.dork/flow/drain/reviews/2-abc1234.md');
    expect(readFileSync(findings, 'utf8')).toContain('Rename the flag.');
  });

  it('refuses a note over 2,000 characters (exit 2)', async () => {
    writeRun();
    const result = await flow(['review', 'ACME-12', '--changes', '--note', 'x'.repeat(2001)], {
      tracker: createFakeAdapter({ items: [started()] }),
    });
    expect(result.code).toBe(EXIT.usage);
  });
});

describe('flow review --approve --by reviewer-agent', () => {
  const clean = {
    tokenHash: 'h',
    sha: 'abc1234def',
    verdict: 'clean' as const,
    reviewedSha: 'abc1234def',
  };

  // Purpose: the reviewer agent ships only when the project lets it and a
  // token-bound clean verdict covers the branch head. It never approves on the
  // forge; its signed tracker comment is the record.
  it('ships with a clean review at the head, signed, without a forge approval', async () => {
    dial({ dial: 'tell' });
    writeRun({ review: clean });
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(['review', 'ACME-12', '--approve', '--by', 'reviewer-agent'], {
      tracker,
      forge: fakeForge({ head: 'abc1234def' }),
    });
    expect(result.code).toBe(EXIT.ok);
    const [body] = comments(tracker);
    expect(body).toContain('Shipped: the reviewer agent approved it (clean review at abc1234).');
    expect(body).toContain(MARKER);
    expect(result.forge.calls.some((call) => call.method === 'review')).toBe(false);
    expect(result.forge.calls).toContainEqual({ method: 'arm', arg: [7, 'abc1234def'] });
  });

  // Purpose: each missing condition refuses, and nothing is posted.
  it.each([
    ['at Ask me first', () => dial({ dial: 'ask' }), clean, 'abc1234def'],
    ['with no dial chosen', () => undefined, clean, 'abc1234def'],
    ['with no recorded verdict', () => dial({ dial: 'auto' }), undefined, 'abc1234def'],
    ['with a verdict on an older commit', () => dial({ dial: 'auto' }), clean, 'ffff000aaaa'],
    [
      'with a CHANGES verdict',
      () => dial({ dial: 'auto' }),
      { ...clean, verdict: 'changes' as const },
      'abc1234def',
    ],
  ])('refuses %s (exit 5)', async (_name, setup, review, head) => {
    setup();
    writeRun(review === undefined ? {} : { review });
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(['review', 'ACME-12', '--approve', '--by', 'reviewer-agent'], {
      tracker,
      forge: fakeForge({ head }),
    });
    expect(result.code).toBe(EXIT.precondition);
    expect(comments(tracker)).toEqual([]);
    expect(result.forge.calls.some((call) => call.method === 'arm')).toBe(false);
  });

  // Purpose: without a reviewer agent there is no checker, so Just do it still
  // cannot let an agent ship.
  it('refuses when review.adversarial is off, even at Just do it', async () => {
    project.config({
      tracker: 'fake',
      identity: { agent: 'agent-1' },
      review: { adversarial: false },
    });
    dial({ dial: 'auto' });
    writeRun({ review: clean });
    const result = await flow(['review', 'ACME-12', '--approve', '--by', 'reviewer-agent'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def' }),
    });
    expect(result.code).toBe(EXIT.precondition);
  });

  it('refuses while the PR has failing checks', async () => {
    dial({ dial: 'auto' });
    writeRun({ review: clean });
    const result = await flow(['review', 'ACME-12', '--approve', '--by', 'reviewer-agent'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def', failing: ['test'] }),
    });
    expect(result.code).toBe(EXIT.precondition);
  });
});

describe('flow report review-brief and verdict for VERIFY', () => {
  // Purpose: VERIFY's reviewer records a verdict only with the token its brief
  // carried, and only for the commit the brief was for. Nothing else counts.
  it('records a token-bound verdict and refuses a wrong token or another commit', async () => {
    const head = git('rev-parse', 'HEAD');
    writeRun({ stage: 'verify', status: 'running' });
    const brief = await flow([
      'report',
      'ACME-12',
      'review-brief',
      '--sha',
      'HEAD',
      '--session',
      'verify-orchestrator',
    ]);
    expect(brief.code).toBe(EXIT.ok);
    const token = brief.json.token as string;
    expect(stored().review).toMatchObject({ sha: head, verdict: null });
    expect(JSON.stringify(stored())).not.toContain(token);

    const wrong = await flow([
      'report',
      'ACME-12',
      'verdict',
      '--sha',
      head,
      '--token',
      'nope',
      '--clean',
    ]);
    expect(wrong.code).toBe(EXIT.precondition);
    const other = await flow([
      'report',
      'ACME-12',
      'verdict',
      '--sha',
      'deadbee',
      '--token',
      token,
      '--clean',
    ]);
    expect(other.json).toMatchObject({ stale: true });
    expect(stored().review?.verdict).toBeNull();

    const ok = await flow([
      'report',
      'ACME-12',
      'verdict',
      '--sha',
      head,
      '--token',
      token,
      '--clean',
    ]);
    expect(ok.code).toBe(EXIT.ok);
    expect(stored().review).toMatchObject({ verdict: 'clean', reviewedSha: head });
  });
});

describe('flow ask', () => {
  const ASK = [
    'ask',
    'ACME-12',
    '--question',
    'Should the old API keep working?',
    '--choice',
    'Keep it',
    '--choice',
    'Drop it',
    '--pick',
    '1',
    '--why',
    'It changes how sessions load; keeping it is safer.',
  ];

  // Purpose: at Ask me first (or with no dial chosen) the question waits for a
  // person: no deadline, the pick marked, needs-input on the item.
  it('parks a question for a person with no deadline at Ask me first', async () => {
    writeRun({ stage: 'execute', status: 'running' });
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(ASK, { tracker });
    expect(result.code).toBe(EXIT.ok);
    expect(result.json).toMatchObject({ answeredBy: 'person', answeredByAtDeadline: null });
    expect(stored().question).toMatchObject({
      pick: 'c1',
      decideBy: null,
      answeredBy: 'person',
      choices: [
        { id: 'c1', label: 'Keep it' },
        { id: 'c2', label: 'Drop it' },
      ],
    });
    const [body] = comments(tracker);
    expect(body).toContain('1. Keep it (my pick)');
    expect(body).toContain(MARKER);
    expect(tracker.backlog.items[0].labels).toContain('agent/needs-input');
  });

  // Purpose: at Tell me after a question off the floor gets the project's wait
  // (4 hours unless the dial says otherwise); silence then means the pick.
  it('sets the deadline from the dial at Tell me after', async () => {
    dial({ dial: 'tell', questionDeadlineMinutes: 60 });
    writeRun({ stage: 'execute', status: 'running' });
    const result = await flow(ASK, { tracker: createFakeAdapter({ items: [started()] }) });
    expect(result.code).toBe(EXIT.ok);
    expect(stored().question?.decideBy).toBe('2026-09-26T13:00:00.000Z');
    expect(result.json.answeredByAtDeadline).toBe('agent-default');
  });

  // Purpose: a floor question is never settled by a deadline: it has none,
  // and the reviewer agent may check the pick once the person's wait is over.
  it('gives a floor question no deadline and a time the reviewer agent may check it', async () => {
    dial({ dial: 'tell' });
    writeRun({ stage: 'execute', status: 'running' });
    const refused = await flow(
      [...ASK, '--floor', 'outward-facing', '--decide-by', '2026-09-26T15:00:00Z'],
      {
        tracker: createFakeAdapter({ items: [started()] }),
      }
    );
    expect(refused.code).toBe(EXIT.usage);
    const result = await flow([...ASK, '--floor', 'outward-facing'], {
      tracker: createFakeAdapter({ items: [started()] }),
    });
    expect(result.code).toBe(EXIT.ok);
    expect(stored().question).toMatchObject({
      decideBy: null,
      floor: ['outward-facing'],
      checkAfter: '2026-09-26T16:00:00.000Z',
    });
  });

  // Purpose: at Just do it the agent does not ask off the floor; it goes ahead
  // with its pick. A secrets-or-spend question still waits for a person.
  it('refuses a question off the floor at Just do it, but not a spend', async () => {
    dial({ dial: 'auto' });
    writeRun({ stage: 'execute', status: 'running' });
    const refused = await flow(ASK, { tracker: createFakeAdapter({ items: [started()] }) });
    expect(refused.code).toBe(EXIT.precondition);
    const spend = await flow([...ASK, '--floor', 'secrets-or-spend'], {
      tracker: createFakeAdapter({ items: [started()] }),
    });
    expect(spend.code).toBe(EXIT.ok);
    expect(spend.json).toMatchObject({ answeredBy: 'person', answeredByAtDeadline: null });
  });

  // Purpose: a drain run parks for a person, like `flow report blocked`.
  it('parks a drain run until someone answers', async () => {
    writeRun({ stage: 'execute', status: 'running', drain: drain({ phase: 'working' }) });
    const result = await flow(ASK, { tracker: createFakeAdapter({ items: [started()] }) });
    expect(result.code).toBe(EXIT.ok);
    expect(stored().drain).toMatchObject({
      phase: 'parked',
      parkedFor: 'person',
      parkedFrom: 'working',
      rev: 4,
    });
  });

  it('refuses a choice DorkOS could not show on a button (exit 2)', async () => {
    writeRun({ stage: 'execute', status: 'running' });
    const long = [...ASK];
    long[5] = 'A choice that is far too long to fit on one button';
    expect((await flow(long, { tracker: createFakeAdapter({ items: [started()] }) })).code).toBe(
      EXIT.usage
    );
  });
});

describe('flow answer', () => {
  const question = (overrides: Record<string, unknown> = {}) => ({
    text: 'Should the old API keep working?',
    choices: [
      { id: 'c1', label: 'Keep it' },
      { id: 'c2', label: 'Drop it' },
    ],
    pick: 'c1',
    why: 'Safer.',
    askedAt: '2026-09-26T11:00:00.000Z',
    decideBy: '2026-09-26T15:00:00.000Z',
    floor: [],
    answeredBy: 'person',
    checkAfter: null,
    ...overrides,
  });
  const parked = () => started(['type/task', 'agent/claimed', 'agent/needs-input']);

  // Purpose: a person's answer from DorkOS is posted without the agent's marker,
  // so the comment rules count it as the reply, and recorded on the run.
  it("posts a person's answer the comment rules count as the reply", async () => {
    writeRun({ stage: 'execute', status: 'running', question: question() });
    const tracker = createFakeAdapter({ items: [parked()], user: { id: 'dorian' } });
    const result = await flow(['answer', 'ACME-12', '--text', 'Drop it.'], { tracker });
    expect(result.code).toBe(EXIT.ok);
    const [body] = comments(tracker);
    expect(body).toBe('Drop it.\n\nAnswered in DorkOS.');
    expect(body).not.toContain(MARKER);
    const config = FlowConfigSchema.parse({});
    const decision = shouldRespondToComment(
      { author: 'dorian', mentions: [], body },
      {
        item: parked(),
        ownership: 'unassigned',
        identity: { agent: 'agent-1', marker: config.identity.marker },
      },
      config.comments
    );
    expect(decision.action).not.toBe('ignore');
    expect(stored().question?.answer).toEqual({ text: 'Drop it.', at: NOW, by: 'person' });
  });

  // Purpose: whoever answers first wins; the second finds it settled (exit 5).
  it('refuses an item that no longer waits for an answer', async () => {
    writeRun({ stage: 'execute', status: 'running', question: question() });
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(['answer', 'ACME-12', '--text', 'Drop it.'], { tracker });
    expect(result.code).toBe(EXIT.precondition);
    expect(comments(tracker)).toEqual([]);
  });

  // Purpose: the pick stands only after the deadline, once, posted as the agent.
  it('takes the pick at the deadline, and only once', async () => {
    writeRun({ stage: 'execute', status: 'running', question: question() });
    const tracker = createFakeAdapter({ items: [parked()] });
    const early = await flow(['answer', 'ACME-12', '--pick', '--by', 'agent-default'], { tracker });
    expect(early.code).toBe(EXIT.precondition);
    const due = await flow(['answer', 'ACME-12', '--pick', '--by', 'agent-default'], {
      tracker,
      now: '2026-09-26T15:00:00.000Z',
    });
    expect(due.code).toBe(EXIT.ok);
    const [body] = comments(tracker);
    expect(body).toContain(
      'No answer by Sep 26, 15:00 UTC, so going with "Keep it" (the agent\'s pick).'
    );
    expect(body).toContain(MARKER);
    expect(stored().question?.answer?.by).toBe('agent-default');
    const again = await flow(['answer', 'ACME-12', '--pick', '--by', 'agent-default'], {
      tracker,
      now: '2026-09-26T16:00:00.000Z',
    });
    expect(again.code).toBe(EXIT.precondition);
  });

  // Purpose: a floor question is never settled by its deadline; the reviewer
  // agent checks it with the token from --check-pick, and only that token.
  it("lets only the reviewer agent's checked token settle a floor question", async () => {
    writeRun({
      stage: 'execute',
      status: 'running',
      question: question({
        decideBy: null,
        floor: ['outward-facing'],
        checkAfter: '2026-09-26T13:00:00.000Z',
      }),
    });
    const tracker = createFakeAdapter({ items: [parked()] });
    const late = '2026-09-27T00:00:00.000Z';
    expect(
      (await flow(['answer', 'ACME-12', '--pick', '--by', 'agent-default'], { tracker, now: late }))
        .code
    ).toBe(EXIT.precondition);
    // Before the wait is over, even an independent session cannot check it.
    expect(
      (await flow(['ask', 'ACME-12', '--check-pick', '--session', 'reviewer-1'], { tracker })).code
    ).toBe(EXIT.precondition);
    const check = await flow(['ask', 'ACME-12', '--check-pick', '--session', 'reviewer-1'], {
      tracker,
      now: late,
    });
    expect(check.code).toBe(EXIT.ok);
    const token = check.json.token as string;
    const wrong = await flow(
      [
        'answer',
        'ACME-12',
        '--pick',
        '--by',
        'reviewer-agent',
        '--token',
        'x',
        '--session',
        'reviewer-1',
      ],
      {
        tracker,
        now: late,
      }
    );
    expect(wrong.code).toBe(EXIT.precondition);
    const right = await flow(
      [
        'answer',
        'ACME-12',
        '--pick',
        '--by',
        'reviewer-agent',
        '--token',
        token,
        '--session',
        'reviewer-1',
      ],
      {
        tracker,
        now: late,
      }
    );
    expect(right.code).toBe(EXIT.ok);
    expect(stored().question?.answer?.by).toBe('reviewer-agent');
  });
});

describe('flow autonomy', () => {
  // Purpose: with no dial chosen flow asks first, except that failing checks
  // are still fixed as they always were.
  it("reads Ask me first with no dial, keeping today's retries", async () => {
    const result = await flow(['autonomy']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.json).toMatchObject({
      source: 'missing',
      kinds: {
        ship: { stop: 'ask', answeredBy: 'person' },
        questions: { stop: 'ask' },
        sort: { stop: 'ask' },
        retry: { stop: 'tell' },
      },
    });
    // Review finding 11: the summary says what really happens with no dial chosen.
    expect(result.json.summary).toContain('fixes failing checks on its own');
  });

  // Purpose: VERIFY asks `--kind ship` to learn whether the reviewer agent may
  // answer the gate.
  it('says the reviewer agent answers ship past Ask me first', async () => {
    dial({ dial: 'tell' });
    const result = await flow(['autonomy', '--kind', 'ship']);
    expect(result.json).toMatchObject({
      source: 'copy',
      kind: 'ship',
      stop: 'tell',
      answeredBy: 'reviewer-agent',
    });
    expect((await flow(['autonomy', '--kind', 'everything'])).code).toBe(EXIT.usage);
    expect(existsSync(autonomyCopyPath(dorkHome, canonicalProjectRoot(project.dir)))).toBe(true);
  });
});

describe('review fixes (DOR-2528 FIX-FIRST)', () => {
  const parkedItem = () => started(['type/task', 'agent/claimed', 'agent/needs-input']);
  const TOKEN = '0123456789abcdef0123456789abcdef';
  const floorQuestion = (overrides: Record<string, unknown> = {}) => ({
    text: 'Publish the post?',
    choices: [
      { id: 'c1', label: 'Publish' },
      { id: 'c2', label: 'Hold' },
    ],
    pick: 'c1',
    why: 'Safer.',
    askedAt: '2026-09-26T11:00:00.000Z',
    askedBy: 'worker-session',
    decideBy: null,
    floor: ['outward-facing'],
    answeredBy: 'person',
    checkAfter: '2026-09-26T11:30:00.000Z',
    ...overrides,
  });

  // Finding 3: a question about secrets or spending is a person's alone, read
  // from its triggers, whatever the stored fields claim: no check is handed
  // out and no pick is taken, even with a token planted by hand.
  it('refuses every pick path on a spend, whatever the record says', async () => {
    const { createHash } = await import('node:crypto');
    writeRun({
      stage: 'execute',
      status: 'running',
      question: floorQuestion({
        floor: ['secrets-or-spend'],
        answeredBy: 'reviewer-agent',
        decideBy: '2026-09-26T11:30:00.000Z',
        checkTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
      }),
    });
    const tracker = createFakeAdapter({ items: [parkedItem()] });
    const as = ['--session', 'reviewer-1'];
    expect((await flow(['ask', 'ACME-12', '--check-pick', ...as], { tracker })).code).toBe(
      EXIT.precondition
    );
    expect(
      (
        await flow(
          ['answer', 'ACME-12', '--pick', '--by', 'reviewer-agent', '--token', TOKEN, ...as],
          { tracker }
        )
      ).code
    ).toBe(EXIT.precondition);
    expect(
      (await flow(['answer', 'ACME-12', '--pick', '--by', 'agent-default', ...as], { tracker }))
        .code
    ).toBe(EXIT.precondition);
    expect(comments(tracker)).toEqual([]);
  });

  // Finding 3: the session that asked (or did the work) cannot hand its own
  // pick to the reviewer agent, nor answer as the reviewer agent.
  it('refuses a check or a reviewer answer from the asking session', async () => {
    writeRun({ stage: 'execute', status: 'running', question: floorQuestion() });
    const tracker = createFakeAdapter({ items: [parkedItem()] });
    expect(
      (await flow(['ask', 'ACME-12', '--check-pick', '--session', 'worker-session'], { tracker }))
        .code
    ).toBe(EXIT.precondition);
    expect((await flow(['ask', 'ACME-12', '--check-pick'], { tracker })).code).toBe(
      EXIT.precondition
    );
    const check = await flow(['ask', 'ACME-12', '--check-pick', '--session', 'reviewer-1'], {
      tracker,
    });
    expect(check.code).toBe(EXIT.ok);
    const self = await flow(
      [
        'answer',
        'ACME-12',
        '--pick',
        '--by',
        'reviewer-agent',
        '--token',
        check.json.token as string,
        '--session',
        'worker-session',
      ],
      { tracker }
    );
    expect(self.code).toBe(EXIT.precondition);
    expect(stored().question?.answer).toBeUndefined();
  });

  // Finding 3: VERIFY's token is minted by a session other than the one that
  // wrote the code.
  it("refuses a review brief from the run's own session", async () => {
    writeRun({ stage: 'verify', status: 'running' });
    const own = await flow(['report', 'ACME-12', 'review-brief', '--sha', 'HEAD']);
    expect(own.code).toBe(EXIT.precondition);
    expect(stored().review).toBeUndefined();
  });

  // Finding 5: two paths settling one question: the second must lose and post
  // nothing. Here the DorkOS deadline records the pick between this answer's
  // read and its write.
  it('loses cleanly when another path answers first', async () => {
    writeRun({
      stage: 'execute',
      status: 'running',
      question: floorQuestion({
        floor: [],
        checkAfter: null,
        decideBy: '2026-09-26T15:00:00.000Z',
      }),
    });
    const tracker = createFakeAdapter({ items: [parkedItem()] });
    let read = false;
    const getItem = tracker.adapter.getItem.bind(tracker.adapter);
    tracker.adapter.getItem = async (...args: Parameters<typeof getItem>) => {
      read = true;
      return getItem(...args);
    };
    let raced = false;
    const clock = () => {
      if (read && !raced) {
        raced = true;
        const run = stored();
        project.writeRuns({
          'id-ACME-12': {
            ...run,
            question: {
              ...run.question!,
              answer: { text: 'Keep it', at: NOW, by: 'agent-default' },
            },
          },
        });
      }
      return new Date(NOW);
    };
    const result = await flow(['answer', 'ACME-12', '--text', 'Hold it.'], { tracker, clock });
    expect(result.code).toBe(EXIT.precondition);
    // Re-review nit: the loser says it lost the race, not that nothing waited.
    expect(result.stderr).toContain('got there first');
    expect(comments(tracker)).toEqual([]);
    expect(stored().question?.answer?.by).toBe('agent-default');
  });

  // Finding 10: the floor the deadline was promised on is the one the pick is
  // judged by. A trigger the project took off its floor gets a deadline, and
  // the pick then stands at it.
  it('judges the pick by the same floor that set the deadline', async () => {
    project.config({
      tracker: 'fake',
      identity: { agent: 'agent-1' },
      involvement: { calibration: { alwaysAsk: ['scope-change'] } },
    });
    dial({ dial: 'tell', questionDeadlineMinutes: 60 });
    writeRun({ stage: 'execute', status: 'running' });
    const tracker = createFakeAdapter({ items: [started()] });
    const ask = await flow(
      [
        'ask',
        'ACME-12',
        '--question',
        'Rename it?',
        '--choice',
        'Yes',
        '--choice',
        'No',
        '--pick',
        '1',
        '--why',
        'Clearer.',
        '--floor',
        'outward-facing',
      ],
      { tracker }
    );
    expect(ask.code).toBe(EXIT.ok);
    expect(stored().question).toMatchObject({ floor: [], decideBy: '2026-09-26T13:00:00.000Z' });
    const pick = await flow(['answer', 'ACME-12', '--pick', '--by', 'agent-default'], {
      tracker,
      now: '2026-09-26T13:00:00.000Z',
    });
    expect(pick.code).toBe(EXIT.ok);
  });

  // Finding 11: with no run, nothing keeps a deadline, so none is promised;
  // and a deadline without its zone is refused.
  it('promises no deadline without a run, and wants a zone on --decide-by', async () => {
    dial({ dial: 'tell' });
    const tracker = createFakeAdapter({ items: [started()] });
    const ask = [
      'ask',
      'ACME-12',
      '--question',
      'Rename it?',
      '--choice',
      'Yes',
      '--choice',
      'No',
      '--pick',
      '1',
      '--why',
      'Clearer.',
    ];
    const result = await flow(ask, { tracker });
    expect(result.code).toBe(EXIT.ok);
    expect(result.json).toMatchObject({ answeredBy: 'person', answeredByAtDeadline: null });
    expect(comments(tracker)[0]).toContain("I won't go ahead until you answer.");
    writeRun({ stage: 'execute', status: 'running' });
    const noZone = await flow([...ask, '--decide-by', '2026-09-26T15:00:00'], {
      tracker: createFakeAdapter({ items: [started()] }),
    });
    expect(noZone.code).toBe(EXIT.usage);
  });

  // Finding 4: a person ships the commit they saw. A drain run arms the
  // reviewed commit; any other run arms the head the person names with
  // --head, and a head that moved since is refused.
  it('arms only the commit the person approved', async () => {
    writeRun({
      stage: 'verify',
      drain: drain({
        phase: 'watching',
        pushedSha: 'abc1234def',
        verdict: 'clean',
        reviewedSha: 'abc1234def',
      }),
    });
    const drained = await flow(['review', 'ACME-12', '--approve'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def' }),
    });
    expect(drained.code).toBe(EXIT.ok);
    expect(drained.forge.calls).toContainEqual({ method: 'arm', arg: [7, 'abc1234def'] });
    const drainMoved = await flow(['review', 'ACME-12', '--approve'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'feed999' }),
    });
    expect(drainMoved.code).toBe(EXIT.precondition);
    expect(drainMoved.forge.calls.some((call) => call.method === 'arm')).toBe(false);

    writeRun();
    const moved = await flow(['review', 'ACME-12', '--approve', '--head', 'abc1234def'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'feed999' }),
    });
    expect(moved.code).toBe(EXIT.precondition);
    expect(moved.forge.calls.some((call) => call.method === 'arm')).toBe(false);

    const unknown = await flow(['review', 'ACME-12', '--approve'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'feed999' }),
    });
    expect(unknown.code).toBe(EXIT.ok);
    expect(unknown.json.armed).toBe(false);
    expect(unknown.forge.calls.some((call) => call.method === 'arm')).toBe(false);
  });

  // Finding 11: the reviewer agent ships only when the checks passed: not
  // while any still runs, and not without a PR whose checks it can read.
  it('lets the reviewer agent ship only past passed checks', async () => {
    project.config({
      tracker: 'fake',
      identity: { agent: 'agent-1' },
      gates: { review: { mergeOnApproval: false } },
    });
    dial({ dial: 'auto' });
    const clean = {
      tokenHash: 'h',
      sha: 'abc1234def',
      verdict: 'clean' as const,
      reviewedSha: 'abc1234def',
    };
    writeRun({ review: clean });
    const pending = await flow(['review', 'ACME-12', '--approve', '--by', 'reviewer-agent'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def', pending: 1 }),
    });
    expect(pending.code).toBe(EXIT.precondition);
    const noPr = await flow(['review', 'ACME-12', '--approve', '--by', 'reviewer-agent'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def', pr: false }),
    });
    expect(noPr.code).toBe(EXIT.precondition);
  });

  // The review.approved journal line records who shipped it.
  it('journals a reviewer agent approval as review.approved', async () => {
    dial({ dial: 'auto' });
    writeRun({
      review: { tokenHash: 'h', sha: 'abc1234def', verdict: 'clean', reviewedSha: 'abc1234def' },
    });
    const result = await flow(['review', 'ACME-12', '--approve', '--by', 'reviewer-agent'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def' }),
    });
    expect(result.code).toBe(EXIT.ok);
    const journal = readFileSync(path.join(project.dir, '.dork', 'flow', 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(journal).toContainEqual(
      expect.objectContaining({
        kind: 'review.approved',
        by: 'reviewer-agent',
        sha7: 'abc1234',
        item: 'ACME-12',
      })
    );
  });
});

describe('re-review fixes (DOR-2528)', () => {
  const clean = {
    tokenHash: 'h',
    sha: 'abc1234def',
    verdict: 'clean' as const,
    reviewedSha: 'abc1234def',
  };

  // N2: DorkOS's handler ships with `flow review --approve --by person` and no
  // --head; the run's clean reviewed commit is what gets armed.
  it("arms the run's clean reviewed commit when no --head is given", async () => {
    writeRun({ review: clean });
    const result = await flow(['review', 'ACME-12', '--approve'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def' }),
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.forge.calls).toContainEqual({ method: 'arm', arg: [7, 'abc1234def'] });
  });

  // N2: with no known commit, say what happened without asking anyone to type a flag.
  // Third review: DorkOS's handler passes --head, the commit the ask showed,
  // so a person's 👍 on a run with no recorded review still arms that commit.
  it('arms the commit the ask showed, passed with --head', async () => {
    writeRun();
    const result = await flow(['review', 'ACME-12', '--approve', '--head', 'abc1234def'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def' }),
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.forge.calls).toContainEqual({ method: 'arm', arg: [7, 'abc1234def'] });
  });

  it('explains an approval it could not arm, without asking for a flag', async () => {
    writeRun();
    let text = '';
    const result = await flow(['review', 'ACME-12', '--approve'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def' }),
    });
    expect(result.code).toBe(EXIT.ok);
    text = JSON.stringify(result.json);
    expect(result.json.armed).toBe(false);
    // Third review: say what is true, not a promise nothing keeps.
    expect(result.json.note).toBe(
      "Approved. Merge it yourself; flow didn't turn on auto-merge because it couldn't tell which commit you approved."
    );
    expect(text).not.toContain('--head');
  });

  // N4: when the PR will be armed, checks still running are fine (the forge's
  // auto-merge waits for them); failing ones are not.
  it('lets the reviewer agent ship past running checks when the PR is armed', async () => {
    dial({ dial: 'auto' });
    writeRun({ review: clean });
    const result = await flow(['review', 'ACME-12', '--approve', '--by', 'reviewer-agent'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: 'abc1234def', pending: 2 }),
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.forge.calls).toContainEqual({ method: 'arm', arg: [7, 'abc1234def'] });
  });

  // N4: without the arm every check must pass, and --wait is the retry point:
  // it waits for the checks instead of handing the gate to a person.
  it('waits for the checks with --wait when the PR will not be armed', async () => {
    project.config({
      tracker: 'fake',
      identity: { agent: 'agent-1' },
      gates: { review: { mergeOnApproval: false } },
    });
    dial({ dial: 'auto' });
    writeRun({ review: clean });
    const result = await flow(
      ['review', 'ACME-12', '--approve', '--by', 'reviewer-agent', '--wait'],
      {
        tracker: createFakeAdapter({ items: [started()] }),
        forge: fakeForge({ head: 'abc1234def', pending: [2, 1, 0] }),
      }
    );
    expect(result.code).toBe(EXIT.ok);
    expect(result.json).toMatchObject({ verdict: 'approved', by: 'reviewer-agent' });
  });

  // N4: VERIFY's reviewer runs as a session of its own, started through the
  // launcher, in its own worktree; the token is only in its brief.
  it("launches VERIFY's reviewer as its own session with the token only in its brief", async () => {
    const head = git('rev-parse', 'HEAD');
    writeRun({ stage: 'verify', status: 'running' });
    const starts: { req: LaunchRequest }[] = [];
    const result = await flow(['report', 'ACME-12', 'review-launch', '--sha', 'HEAD'], {
      launcher: (host) => fakeLauncher(host, starts),
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(starts).toHaveLength(1);
    const { req } = starts[0];
    expect(req.role).toBe('reviewer');
    expect(req.cwd).not.toBe(project.dir);
    expect(git('-C', req.cwd, 'rev-parse', 'HEAD')).toBe(head);
    const brief = readFileSync(req.promptFile, 'utf8');
    const token = /--token ([0-9a-f]{32})/.exec(brief)?.[1] as string;
    expect(token).toBeDefined();
    expect(JSON.stringify(result.json)).not.toContain(token);
    expect(stored().review?.tokenHash).toBe(
      (await import('node:crypto')).createHash('sha256').update(token).digest('hex')
    );
    // The launched reviewer's verdict (from its own worktree) is token-bound.
    const verdict = await flow(
      ['report', 'ACME-12', 'verdict', '--sha', head, '--token', token, '--clean'],
      { cwd: req.cwd }
    );
    expect(verdict.code, verdict.stderr).toBe(EXIT.ok);
    expect(stored().review).toMatchObject({ verdict: 'clean', reviewedSha: head });
  });

  // Third review: the launched reviewer's session is recorded, so it can be
  // reached or stopped.
  it('records the launched reviewer on the run', async () => {
    writeRun({ stage: 'verify', status: 'running' });
    const starts: { req: LaunchRequest }[] = [];
    const result = await flow(['report', 'ACME-12', 'review-launch', '--sha', 'HEAD'], {
      launcher: (host) => fakeLauncher(host, starts),
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(stored().review?.reviewer).toMatchObject({
      sessionId: starts[0].req.sessionId,
      cwd: starts[0].req.cwd,
    });
  });

  // Third review: a failed launch never removes a worktree it did not add
  // (an earlier launch's, a live reviewer's).
  it('keeps a worktree it did not add when the launch fails', async () => {
    writeRun({ stage: 'verify', status: 'running' });
    const first: { req: LaunchRequest }[] = [];
    await flow(['report', 'ACME-12', 'review-launch', '--sha', 'HEAD'], {
      launcher: (host) => fakeLauncher(host, first),
    });
    const existing = first[0].req.cwd;
    const again = await flow(['report', 'ACME-12', 'review-launch', '--sha', 'HEAD'], {
      launcher: (host) => fakeLauncher(host, [], new LaunchError('unavailable', 'no claude')),
    });
    expect(again.code).toBe(EXIT.precondition);
    expect(existsSync(existing)).toBe(true);
  });

  // A launch that fails leaves nothing behind.
  it('leaves no review behind when the reviewer does not start', async () => {
    writeRun({ stage: 'verify', status: 'running' });
    const result = await flow(['report', 'ACME-12', 'review-launch', '--sha', 'HEAD'], {
      launcher: (host) => fakeLauncher(host, [], new LaunchError('unavailable', 'no claude')),
    });
    expect(result.code).toBe(EXIT.precondition);
    expect(stored().review).toBeUndefined();
  });
});

describe('the reviewer agent ships with auto-merge off (DOR-2535)', () => {
  const HEAD = 'abc1234def';
  const clean = { tokenHash: 'h', sha: HEAD, verdict: 'clean' as const, reviewedSha: HEAD };
  const ship = ['review', 'ACME-12', '--approve', '--by', 'reviewer-agent'];

  /** Auto-merge off, the dial at Just do it, and a clean review at HEAD. */
  function setUp(review: Record<string, unknown> = {}): void {
    project.config({
      tracker: 'fake',
      identity: { agent: 'agent-1' },
      gates: { review: { mergeOnApproval: false, ...review } },
    });
    dial({ dial: 'auto' });
    writeRun({ review: clean });
  }

  /** `NOW` plus `minutes`. */
  function later(minutes: number): string {
    return new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
  }

  // Purpose: one call that blocks for hours outlives an agent's command
  // timeout. Without --wait the check returns at once, posts nothing, and saves
  // the retry point. Fails if the verb sleeps, ships, or forgets the wait.
  it('returns pending at once, posts nothing, and saves the retry point', async () => {
    setUp();
    let slept = 0;
    const result = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 2 }),
      sleep: async () => {
        slept += 1;
      },
    });
    expect(result.code).toBe(EXIT.precondition);
    expect(result.json).toMatchObject({
      ok: false,
      verdict: 'pending',
      checks: { state: 'pending', pending: 2, waitingSince: NOW },
      retryRecorded: true,
    });
    expect(slept).toBe(0);
    expect(comments(result.tracker)).toEqual([]);
    expect(result.forge.calls.filter((c) => c.method === 'prStatus')).toHaveLength(1);
    expect(stored().shipWait).toEqual({ sha: HEAD, since: NOW, checkedAt: NOW });
  });

  // Purpose: the drain's next tick runs the same command; once the checks
  // passed it ships exactly once and the retry point is gone, so the tick stops.
  it('ships on a later check once the checks passed, and clears the retry point', async () => {
    setUp();
    await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1 }),
    });
    expect(stored().shipWait).toBeDefined();
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(ship, {
      tracker,
      forge: fakeForge({ head: HEAD, pending: 0 }),
      now: later(5),
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(result.json).toMatchObject({ verdict: 'approved', armed: false, checks: null });
    expect(comments(tracker)).toHaveLength(1);
    expect(stored().shipWait).toBeUndefined();
  });

  // Purpose: a check that fails while the reviewer agent waits is a refusal,
  // and a refusal ends the wait, so the drain hands the gate to a person once
  // instead of re-checking forever.
  it('refuses a failing check and clears the retry point', async () => {
    setUp();
    await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1 }),
    });
    const result = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, failing: ['test'] }),
    });
    expect(result.code).toBe(EXIT.precondition);
    expect(result.json.verdict).toBeUndefined();
    expect(result.stderr + JSON.stringify(result.json)).toContain('failing checks (test)');
    expect(stored().shipWait).toBeUndefined();
  });

  // Purpose: a repo with no CI reports no checks, ever. With none required it
  // waits out the grace from the FIRST look (kept across calls), then ships and
  // says plainly that no checks ran. Fails if "no checks" is pending forever or
  // passes at once.
  it('counts no checks as passed after the grace when none are required, and says so', async () => {
    setUp();
    const first = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1, reported: 0 }),
    });
    expect(first.code).toBe(EXIT.precondition);
    expect((first.json.checks as { why: string }).why).toContain(
      'none are required, so flow counts that as passed in about 10 minutes'
    );
    const early = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1, reported: 0 }),
      now: later(9),
    });
    expect(early.code).toBe(EXIT.precondition);
    expect(stored().shipWait?.since).toBe(NOW);
    const tracker = createFakeAdapter({ items: [started()] });
    const result = await flow(ship, {
      tracker,
      forge: fakeForge({ head: HEAD, pending: 1, reported: 0 }),
      now: later(10),
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(result.json).toMatchObject({ verdict: 'approved', checks: 'none' });
    expect(result.json.note).toContain(
      'No checks ran on PR #7, and work requires none, so flow counted that as passed after 10 minutes.'
    );
    expect(comments(tracker)).toHaveLength(1);
    expect(stored().shipWait).toBeUndefined();
  });

  // Purpose: a wait saved for an older commit says nothing about this one: the
  // grace restarts for the new head.
  it('restarts the no-checks grace for a new head', async () => {
    setUp();
    writeRun({
      review: clean,
      shipWait: { sha: '0ld0ld0', since: later(-60), checkedAt: later(-50) },
    });
    const result = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1, reported: 0 }),
    });
    expect(result.code).toBe(EXIT.precondition);
    expect(stored().shipWait).toEqual({ sha: HEAD, since: NOW, checkedAt: NOW });
  });

  // Purpose: "no checks" passes only when the base requires none, the forge
  // can tell, and the setting allows it. Each case stays pending past the grace.
  it.each([
    [
      'a required check has not started',
      { required: ['build'] },
      {},
      'not started on PR #7 (build)',
    ],
    ['the forge cannot list required checks', { required: 'missing' as const }, {}, 'cannot tell'],
    ['reading required checks fails', { required: 'throw' as const }, {}, 'HTTP 403'],
    ['the setting is null', {}, { noChecksPassAfterMinutes: null }, 'never counts that as passed'],
  ])('keeps no checks pending when %s', async (_name, forgeOpts, review, why) => {
    setUp(review);
    writeRun({ review: clean, shipWait: { sha: HEAD, since: later(-120), checkedAt: later(-1) } });
    const result = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1, reported: 0, ...forgeOpts }),
    });
    expect(result.code).toBe(EXIT.precondition);
    expect(result.json.verdict).toBe('pending');
    expect((result.json.checks as { why: string }).why).toContain(why);
  });

  // Purpose: --wait still works for a person, and its waiting counts toward the
  // no-checks grace even on a clock that does not move.
  it('--wait waits out the no-checks grace in one call', async () => {
    setUp();
    let slept = 0;
    const result = await flow([...ship, '--wait-minutes', '15'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1, reported: 0 }),
      sleep: async () => {
        slept += 1;
      },
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(result.json.checks).toBe('none');
    expect(slept).toBe(10);
  });

  // Purpose: a --wait that runs out returns pending with the retry point saved,
  // so the drain picks it up, the same as a --wait an agent's timeout killed.
  it('--wait that runs out leaves the retry point', async () => {
    setUp();
    const result = await flow([...ship, '--wait-minutes', '2'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 3 }),
    });
    expect(result.code).toBe(EXIT.precondition);
    expect((result.json.checks as { why: string }).why).toContain('after 2 minutes of waiting');
    expect(stored().shipWait?.sha).toBe(HEAD);
  });

  // Purpose: a dry run writes nothing, the retry point included.
  it('saves nothing on a dry run', async () => {
    setUp();
    const result = await flow([...ship, '--dry-run'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1 }),
    });
    expect(result.json).toMatchObject({ verdict: 'pending', retryRecorded: false });
    expect(stored().shipWait).toBeUndefined();
  });

  // Purpose: a person who ships or sends the work back ends the reviewer
  // agent's wait too.
  it('clears the retry point when a person ships', async () => {
    setUp();
    writeRun({ review: clean, shipWait: { sha: HEAD, since: NOW, checkedAt: NOW } });
    const result = await flow(['review', 'ACME-12', '--approve'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD }),
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(stored().shipWait).toBeUndefined();
  });

  // Review fix 3: a push since the reviewer agent checked HEAD must not be
  // approved under HEAD's review (nor inherit its no-checks clock).
  it('refuses when the PR moves to another commit, mid-wait or between ticks', async () => {
    setUp();
    const midWait = await flow([...ship, '--wait-minutes', '5'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1, prHead: [HEAD, 'beef0001'] }),
    });
    expect(midWait.code).toBe(EXIT.precondition);
    expect(midWait.stderr + JSON.stringify(midWait.json)).toContain('moved to beef000');
    expect(stored().shipWait).toBeUndefined();
    writeRun({ review: clean, shipWait: { sha: HEAD, since: later(-60), checkedAt: later(-1) } });
    const tracker = createFakeAdapter({ items: [started()] });
    const later_ = await flow(ship, {
      tracker,
      forge: fakeForge({ head: HEAD, pending: 1, reported: 0, prHead: 'beef0001' }),
    });
    expect(later_.code).toBe(EXIT.precondition);
    expect(comments(tracker)).toEqual([]);
  });

  // Review fix 4: a refusal from anywhere ends the wait, so step 2a stops
  // handing the same item to a person every tick.
  it('clears the wait when the run has left the gate or the item is closed', async () => {
    setUp();
    writeRun({
      review: clean,
      stage: 'execute',
      status: 'running',
      shipWait: { sha: HEAD, since: NOW, checkedAt: NOW },
    });
    const left = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD }),
    });
    expect(left.code).toBe(EXIT.precondition);
    expect(stored().shipWait).toBeUndefined();
    writeRun({ review: clean, shipWait: { sha: HEAD, since: NOW, checkedAt: NOW } });
    const closed = await flow(ship, {
      tracker: createFakeAdapter({
        items: [item('ACME-12', { stateCategory: 'completed', stateName: 'Done' })],
      }),
      forge: fakeForge({ head: HEAD }),
    });
    expect(closed.code).toBe(EXIT.precondition);
    expect(stored().shipWait).toBeUndefined();
  });

  // Re-review (a): the wait is found whatever case the identifier was typed in.
  it('clears the wait for an identifier typed in another case', async () => {
    setUp();
    writeRun({
      review: clean,
      stage: 'execute',
      status: 'running',
      shipWait: { sha: HEAD, since: NOW, checkedAt: NOW },
    });
    const result = await flow(['review', 'acme-12', '--approve', '--by', 'reviewer-agent'], {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD }),
    });
    expect(result.code).toBe(EXIT.precondition);
    expect(stored().shipWait).toBeUndefined();
  });

  // Re-review (b): a store that cannot be written while clearing the wait
  // never replaces the refusal (exit 5) with an internal error.
  it('keeps the refusal when the wait cannot be cleared', async () => {
    setUp();
    writeRun({
      review: clean,
      stage: 'execute',
      status: 'running',
      shipWait: { sha: HEAD, since: NOW, checkedAt: NOW },
    });
    const dir = path.join(project.dir, '.dork', 'flow');
    chmodSync(dir, 0o555);
    try {
      const result = await flow(ship, {
        tracker: createFakeAdapter({ items: [started()] }),
        forge: fakeForge({ head: HEAD }),
      });
      expect(result.code, result.stderr).toBe(EXIT.precondition);
      expect(result.stderr + JSON.stringify(result.json)).toContain(
        'not waiting at the review gate'
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  // Review fix 4: a forge outage is not a refusal: the wait stays for the next tick.
  it('keeps the wait when the forge cannot be read (exit 4)', async () => {
    setUp();
    writeRun({ review: clean, shipWait: { sha: HEAD, since: NOW, checkedAt: NOW } });
    const result = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, statusError: 'gh: HTTP 502' }),
    });
    expect(result.code).toBe(EXIT.tracker);
    expect(stored().shipWait).toEqual({ sha: HEAD, since: NOW, checkedAt: NOW });
  });

  // Review fix 6: the wait ends BEFORE the comment, so a later tick can never
  // ship (and comment) twice; a comment that fails puts the wait back.
  it('ends the wait before posting, and restores it when posting fails', async () => {
    setUp();
    writeRun({ review: clean, shipWait: { sha: HEAD, since: NOW, checkedAt: NOW } });
    const tracker = createFakeAdapter({ items: [started()] });
    const post = tracker.adapter.comment.bind(tracker.adapter);
    let waitAtPost: unknown = 'unread';
    tracker.adapter.comment = async (...args: Parameters<typeof post>) => {
      waitAtPost = stored().shipWait;
      return post(...args);
    };
    const shipped = await flow(ship, { tracker, forge: fakeForge({ head: HEAD, pending: 0 }) });
    expect(shipped.code, shipped.stderr).toBe(EXIT.ok);
    expect(waitAtPost).toBeUndefined();

    writeRun({ review: clean, shipWait: { sha: HEAD, since: NOW, checkedAt: NOW } });
    const down = createFakeAdapter({ items: [started()] });
    down.adapter.comment = async () => {
      throw new TrackerError('tracker unreachable');
    };
    const failed = await flow(ship, {
      tracker: down,
      forge: fakeForge({ head: HEAD, pending: 0 }),
    });
    expect(failed.code).toBe(EXIT.tracker);
    expect(stored().shipWait).toEqual({ sha: HEAD, since: NOW, checkedAt: NOW });
  });

  // Review fix 8: an optional check passing does not stand in for a required
  // one that never reported.
  it('waits for a required check that never reported, even when others passed', async () => {
    setUp();
    const missing = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({
        head: HEAD,
        pending: 0,
        reported: 1,
        checkNames: ['lint'],
        required: ['build'],
      }),
    });
    expect(missing.code).toBe(EXIT.precondition);
    expect((missing.json.checks as { why: string }).why).toContain('not started on PR #7 (build)');
    const present = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({
        head: HEAD,
        pending: 0,
        reported: 2,
        checkNames: ['lint', 'build'],
        required: ['build'],
      }),
    });
    expect(present.code, present.stderr).toBe(EXIT.ok);
  });

  // Purpose: the default setup (auto-merge on) is untouched: running or absent
  // checks never hold the ship, nothing is saved, and required checks are not read.
  it('leaves auto-merge-on projects as they were', async () => {
    dial({ dial: 'auto' });
    writeRun({ review: clean });
    const result = await flow(ship, {
      tracker: createFakeAdapter({ items: [started()] }),
      forge: fakeForge({ head: HEAD, pending: 1, reported: 0 }),
    });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(result.json).toMatchObject({ armed: true, checks: null });
    expect(result.forge.calls.some((c) => c.method === 'requiredChecks')).toBe(false);
    expect(stored().shipWait).toBeUndefined();
  });
});
