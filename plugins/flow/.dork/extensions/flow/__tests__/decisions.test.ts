/**
 * flow's asks in DorkOS's inbox (spec `flow-multiproject` §7.1-§7.4, §7.8-§7.10):
 * what is raised at each stop (and the person-only floor), one row per key,
 * settling on its own, the one answer handler through core's contract (the
 * review gate's `--head`, notes, chips, the deadline and its races, slow
 * commands credited to the person), the one-time offers, starting work, and
 * "While you were away".
 *
 * Every command of flow's CLI is faked: no test reaches a tracker or a forge.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutonomyKind, AutonomyStop } from '../../../../scripts/autonomy.ts';
import { PARK_REASONS } from '../../../../scripts/drain/drain-step.ts';
import type { ExecFileLike } from '../lib/advisor.ts';
import { FIX_IT_ANSWER, type AskProject } from '../lib/asks.ts';
import type { AutonomyStore } from '../lib/autonomy-store.ts';
import {
  CHECKS_FAILED_REASON,
  DecisionCoordinator,
  SENDING_TEXT,
  SEND_FAILED_TEXT,
  SORT_QUIET_MS,
  type PlanProject,
} from '../lib/decisions.ts';
import type {
  DecisionActionEvent,
  DecisionInput,
  InboxApi,
  RecordedDecisionInput,
} from '../lib/host-types.ts';
import type { FlowProject } from '../lib/model.ts';
import { SharedStorage } from '../lib/shared-storage.ts';
import type { TrackerRead } from '../lib/tracker-reads.ts';

const NOW = new Date('2026-09-28T12:00:00.000Z');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flow-decisions-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake inbox that records what flow did. */
function fakeInbox() {
  const open = new Map<string, DecisionInput>();
  const raised: DecisionInput[] = [];
  const resolved: { key: string; opts: Parameters<InboxApi['resolve']>[1] }[] = [];
  const recorded: RecordedDecisionInput[] = [];
  let handler: ((event: DecisionActionEvent) => unknown) | null = null;
  let refuse: ((input: DecisionInput) => unknown) | null = null;
  const inbox: InboxApi = {
    raise: vi.fn(async (input: DecisionInput) => {
      const error = refuse?.(input);
      if (error) throw error;
      raised.push(input);
      open.set(input.key, input);
      return {
        ...input,
        id: `core-${input.key}`,
        detail: input.detail ?? null,
        project: null,
        projectLabel: input.projectLabel ?? null,
        since: input.since ?? null,
        link: input.link ?? null,
        raisedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
    }),
    resolve: vi.fn(async (key, opts) => {
      resolved.push({ key, opts });
      return open.delete(key);
    }),
    record: vi.fn(async (input: RecordedDecisionInput) => {
      recorded.push(input);
    }),
    list: vi.fn(async () => []),
    onAction: vi.fn((next) => {
      handler = next as (event: DecisionActionEvent) => unknown;
      return () => {};
    }),
  };
  return {
    inbox,
    open,
    raised,
    resolved,
    recorded,
    handler: () => handler,
    refuseWith: (fn: ((input: DecisionInput) => unknown) | null) => {
      refuse = fn;
    },
  };
}

/** One call of flow's CLI. */
interface Call {
  args: string[];
  file: string | null;
}

/**
 * A fake runner for flow's CLI: `answer(args)` gives each command's exit code
 * (and how long it takes). Notes and answers are read from their temp file
 * while the command "runs", as flow would.
 */
function fakeCli(
  answer: (args: string[]) => { code: number; delayMs?: number; json?: unknown } = () => ({
    code: 0,
  })
) {
  const calls: Call[] = [];
  const execFile: ExecFileLike = (_file, args, _opts, callback) => {
    const rest = args.slice(2);
    const fileFlag = rest.findIndex((arg) => arg === '--note-file' || arg === '--text-file');
    const file = fileFlag === -1 ? null : readFileSync(rest[fileFlag + 1], 'utf8');
    calls.push({ args: rest, file });
    const reply = answer(rest);
    const done = () => {
      const stdout = reply.json === undefined ? '{"ok":true}' : JSON.stringify(reply.json);
      if (reply.code === 0) callback(null, stdout, '');
      else callback(Object.assign(new Error('exit'), { code: reply.code }), stdout, '');
    };
    if (reply.delayMs === undefined) queueMicrotask(done);
    else setTimeout(done, reply.delayMs);
    return undefined;
  };
  return { calls, execFile };
}

/** A dial per kind, set by the test. */
function dial(stops: Partial<Record<AutonomyKind, AutonomyStop>> = {}, available = true) {
  return {
    available,
    stop: (_root: string, kind: AutonomyKind, reviewer: boolean) =>
      kind === 'ship' && !reviewer ? 'ask' : (stops[kind] ?? 'ask'),
    of: () => ({ copy: null, chosen: false, firstSeen: 'existing' as const }),
  } as unknown as AutonomyStore;
}

/** Storage in memory. */
function memory(data: { value: unknown } = { value: null }) {
  return new SharedStorage({
    loadData: async <T>() => data.value as T,
    saveData: async (value) => {
      data.value = JSON.parse(JSON.stringify(value));
    },
  });
}

const ASK_PROJECT: AskProject = {
  name: 'dorkos',
  root: '/work/dorkos',
  id: '3f2a00000000',
  label: 'Linear DOR',
  tracker: 'Linear',
  link: '/x/flow/p/dorkos',
};

/** A project plan with the runs given. */
function plan(
  store: Record<string, unknown>,
  extra: Partial<PlanProject> & { root?: string; behaviour?: number } = {}
): PlanProject {
  const root = extra.root ?? ASK_PROJECT.root;
  return {
    project: {
      name: path.basename(root),
      root,
      setup: 'ready',
      version: { flow: '0.51.0', behaviour: extra.behaviour ?? 1, olderBehaviour: null },
    } as FlowProject,
    store,
    read: null,
    reviewerAgent: true,
    actionable: true,
    ideas: { waiting: null, due: false, idleSince: null },
    ask: {
      ...ASK_PROJECT,
      root,
      name: path.basename(root),
      id: root === ASK_PROJECT.root ? ASK_PROJECT.id : 'b1b1b1b1b1b1',
    },
    ...extra,
  };
}

/** A drain run waiting at the review gate with a clean review. */
function gateRun(extra: Record<string, unknown> = {}) {
  return {
    identifier: 'DOR-2387',
    title: 'The new out-of-usage banner',
    status: 'running',
    stage: 'verify',
    drain: {
      v: 1,
      phase: 'pr-ready',
      verdict: 'clean',
      reviewRound: 1,
      reviewedSha: 'abc1234def',
      pushedSha: 'abc1234def',
      pr: { number: 2303, armed: false },
    },
    ...extra,
  };
}

/** A run parked on a question from `flow ask`. */
function questionRun(question: Record<string, unknown> = {}) {
  return {
    identifier: 'DOR-2401',
    title: 'Session loading',
    status: 'running',
    stage: 'execute',
    drain: { v: 1, phase: 'parked', parkedFor: 'person', parkedAt: '2026-09-28T09:00:00.000Z' },
    question: {
      text: 'Should the old API keep working?',
      choices: [
        { id: 'c1', label: 'Keep it' },
        { id: 'c2', label: 'Remove it' },
      ],
      pick: 'c1',
      why: "It's changing how sessions load.",
      askedAt: '2026-09-28T09:00:00.000Z',
      decideBy: '2026-09-28T17:00:00.000Z',
      floor: [],
      answeredBy: 'person',
      checkAfter: null,
      ...question,
    },
  };
}

/** A person's answer as core hands it over. */
function event(key: string, extra: Partial<DecisionActionEvent> = {}): DecisionActionEvent {
  return {
    key,
    action: 'approve',
    choiceId: null,
    decidedBy: 'person',
    offerId: null,
    pendingActionId: 'pending-1',
    note: null,
    text: null,
    project: null,
    ...extra,
  };
}

/** The coordinator over fakes. */
function setup(
  opts: {
    stops?: Partial<Record<AutonomyKind, AutonomyStop>>;
    cli?: ReturnType<typeof fakeCli>;
    inbox?: ReturnType<typeof fakeInbox> | null;
    sessions?: { start: ReturnType<typeof vi.fn> };
    answerWaitMs?: number;
    storage?: { value: unknown };
  } = {}
) {
  const inbox = opts.inbox === null ? null : (opts.inbox ?? fakeInbox());
  const cli = opts.cli ?? fakeCli();
  const log = vi.fn();
  const onChange = vi.fn();
  const coordinator = new DecisionCoordinator({
    inbox: inbox?.inbox,
    sessions: opts.sessions as never,
    storage: memory(opts.storage),
    flowRoot: '/flow',
    dorkHome: dir,
    execFile: cli.execFile,
    now: () => NOW,
    log,
    autonomy: dial(opts.stops),
    onChange,
    answerWaitMs: opts.answerWaitMs ?? 1_000,
  });
  return { coordinator, inbox, cli, log, onChange };
}

describe('what is raised', () => {
  it('raises a review gate at Ask me first with its project, label, link and why', async () => {
    const { coordinator, inbox } = setup();
    await coordinator.sync([plan({ a: gateRun() })]);
    expect(inbox?.raised).toHaveLength(1);
    expect(inbox?.raised[0]).toMatchObject({
      key: 'review:3f2a00000000:DOR-2387',
      title: 'Ship The new out-of-usage banner?',
      project: '/work/dorkos',
      projectLabel: 'Linear DOR',
      link: '/x/flow/p/dorkos',
      actions: { kind: 'yes-no', approveLabel: 'Ship it', rejectLabel: 'Send it back' },
    });
    expect(coordinator.decisions()).toEqual([
      expect.objectContaining({ kind: 'review', project: 'dorkos', answerIn: 'activity' }),
    ]);
  });

  it('raises nothing for the review gate at Tell me after or Just do it, or for an armed PR', async () => {
    for (const stop of ['tell', 'auto'] as const) {
      const { coordinator, inbox } = setup({ stops: { ship: stop } });
      await coordinator.sync([plan({ a: gateRun() })]);
      expect(inbox?.raised).toEqual([]);
    }
    const { coordinator, inbox } = setup();
    await coordinator.sync([
      plan({ a: gateRun({ drain: { ...gateRun().drain, pr: { number: 1, armed: true } } }) }),
    ]);
    expect(inbox?.raised).toEqual([]);
  });

  it('keeps shipping with a person where no reviewer agent checks the work, whatever the dial', async () => {
    const { coordinator, inbox } = setup({ stops: { ship: 'auto' } });
    await coordinator.sync([plan({ a: gateRun() }, { reviewerAgent: false })]);
    expect(inbox?.raised.map((r) => r.key)).toEqual(['review:3f2a00000000:DOR-2387']);
  });

  it("raises a question with the agent's pick and deadline only off the floor at Tell me after", async () => {
    const tell = setup({ stops: { questions: 'tell' } });
    await tell.coordinator.sync([plan({ a: questionRun() })]);
    expect(tell.inbox?.raised[0].actions).toMatchObject({
      kind: 'choice',
      defaultChoice: 'c1',
      decideBy: '2026-09-28T17:00:00.000Z',
      allowReply: true,
    });
    const ask = setup({ stops: { questions: 'ask' } });
    await ask.coordinator.sync([plan({ a: questionRun() })]);
    expect(ask.inbox?.raised[0].actions).not.toHaveProperty('decideBy');
    const floor = setup({ stops: { questions: 'tell' } });
    await floor.coordinator.sync([plan({ a: questionRun({ floor: ['outward-facing'] }) })]);
    expect(floor.inbox?.raised[0].actions).not.toHaveProperty('decideBy');
  });

  it('asks nothing at Just do it, except a spend, which always waits for a person', async () => {
    const auto = setup({ stops: { questions: 'auto' } });
    await auto.coordinator.sync([
      plan({
        a: questionRun(),
        b: { ...questionRun({ floor: ['outward-facing'] }), identifier: 'DOR-9' },
      }),
    ]);
    expect(auto.inbox?.raised).toEqual([]);
    const spend = setup({ stops: { questions: 'auto' } });
    await spend.coordinator.sync([plan({ a: questionRun({ floor: ['secrets-or-spend'] }) })]);
    expect(spend.inbox?.raised.map((r) => r.title)).toEqual(['Should the old API keep working?']);
  });

  it('asks to fix failing checks only at Ask me first, when the drain parked on them', async () => {
    const run = {
      identifier: 'DOR-2410',
      title: 'Faster sidebar',
      status: 'running',
      drain: {
        v: 1,
        phase: 'parked',
        parkedFor: 'other',
        parkedReason: CHECKS_FAILED_REASON,
        parkedAt: 'x',
      },
    };
    const ask = setup({ stops: { retry: 'ask' } });
    await ask.coordinator.sync([plan({ a: run })]);
    expect(ask.inbox?.raised.map((r) => r.title)).toEqual([
      'Try fixing the failing checks on Faster sidebar?',
    ]);
    const tell = setup({ stops: { retry: 'tell' } });
    await tell.coordinator.sync([plan({ a: run })]);
    expect(tell.inbox?.raised).toEqual([]);
  });

  it('uses the drain’s own words for a park on failing checks', () => {
    expect(CHECKS_FAILED_REASON).toBe(PARK_REASONS.checksFailed);
  });

  it('asks to sign in at once whatever the dial, and never for a slow tracker', async () => {
    const auth: TrackerRead = {
      at: null,
      queue: null,
      teamUrl: null,
      facts: null,
      failure: { kind: 'auth', since: '2026-09-28T09:14:00.000Z' },
    };
    const { coordinator, inbox } = setup({
      stops: { ship: 'auto', questions: 'auto', sort: 'auto', retry: 'auto' },
    });
    await coordinator.sync([plan({}, { read: auth })]);
    expect(inbox?.raised.map((r) => r.title)).toEqual(['Sign in to Linear again']);
    const slow = setup();
    await slow.coordinator.sync([
      plan({}, { read: { ...auth, failure: { kind: 'unreachable', since: auth.failure!.since } } }),
    ]);
    expect(slow.inbox?.raised).toEqual([]);
  });

  it('raises ideas waiting only when the plan says it is due', async () => {
    const { coordinator, inbox } = setup();
    await coordinator.sync([
      plan({}, { ideas: { waiting: 12, due: true, idleSince: '2026-09-27T09:00:00.000Z' } }),
    ]);
    expect(inbox?.raised.map((r) => r.title)).toEqual(["12 new ideas haven't been sorted"]);
  });
});

describe('one row per key, settled on its own', () => {
  it('raises an unchanged ask once, and updates it in place when its words change', async () => {
    const { coordinator, inbox } = setup();
    await coordinator.sync([plan({ a: gateRun() })]);
    await coordinator.sync([plan({ a: gateRun() })]);
    expect(inbox?.raised).toHaveLength(1);
    await coordinator.sync([plan({ a: gateRun({ title: 'A better banner' }) })]);
    expect(inbox?.raised).toHaveLength(2);
    expect(new Set(inbox?.raised.map((r) => r.key)).size).toBe(1);
  });

  it('resolves an ask "cleared" when it is no longer true, and "cancelled" when its project is gone', async () => {
    const { coordinator, inbox } = setup();
    const other = plan({ a: gateRun() }, { root: '/work/blintz' });
    await coordinator.sync([plan({ a: gateRun() }), other]);
    await coordinator.sync([
      plan({ a: gateRun({ stage: 'done', drain: { v: 1, phase: 'closing' } }) }),
    ]);
    expect(inbox?.resolved).toEqual(
      expect.arrayContaining([
        { key: 'review:3f2a00000000:DOR-2387', opts: { outcome: 'cleared' } },
        { key: 'review:b1b1b1b1b1b1:DOR-2387', opts: { outcome: 'cancelled' } },
      ])
    );
  });

  it('credits the reviewer agent or the deadline when a question was settled that way', async () => {
    const { coordinator, inbox } = setup({ stops: { questions: 'tell' } });
    await coordinator.sync([plan({ a: questionRun() })]);
    const answered = questionRun();
    (answered.question as Record<string, unknown>).answer = {
      text: 'x',
      at: 'y',
      by: 'reviewer-agent',
    };
    await coordinator.sync([plan({ a: answered })]);
    expect(inbox?.resolved.at(-1)?.opts).toEqual({
      outcome: 'answered',
      by: { kind: 'agent', label: 'the reviewer agent' },
    });
  });

  it('stops raising at the open limit, keeps the rest on flow’s pages, and tries again next pass', async () => {
    const inbox = fakeInbox();
    let full = true;
    inbox.refuseWith((input) =>
      full && input.key.startsWith('question')
        ? Object.assign(new Error('full'), { code: 'inbox_limit', limit: 'open' })
        : null
    );
    const { coordinator, log } = setup({ inbox, stops: { questions: 'ask' } });
    const plans = [plan({ a: gateRun(), b: questionRun() })];
    await coordinator.sync(plans);
    expect(inbox.raised.map((r) => r.key)).toEqual(['review:3f2a00000000:DOR-2387']);
    expect(coordinator.decisions().map((d) => d.kind)).toEqual(['review', 'question']);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/inbox is full/));
    full = false;
    await coordinator.sync(plans);
    expect(inbox.raised.map((r) => r.key)).toContain('question:3f2a00000000:DOR-2401');
  });

  it('raises nothing on a DorkOS without the inbox, and still shows the asks', async () => {
    const { coordinator } = setup({ inbox: null });
    await coordinator.sync([plan({ a: gateRun() })]);
    expect(coordinator.hasInbox).toBe(false);
    expect(coordinator.decisions()).toHaveLength(1);
  });

  it('takes over what was open before a restart, and settles what is no longer true', async () => {
    const inbox = fakeInbox();
    (inbox.inbox.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { key: 'tracker:3f2a00000000', project: { root: '/work/dorkos', name: 'dorkos' } },
      { key: 'review:3f2a00000000:DOR-2387', project: { root: '/work/dorkos', name: 'dorkos' } },
    ]);
    const { coordinator } = setup({ inbox });
    await coordinator.start();
    expect(inbox.inbox.onAction).toHaveBeenCalledTimes(1);
    await coordinator.sync([plan({ a: gateRun() })]);
    // The sign-in came back while flow was stopped; the review gate still waits.
    expect(inbox.resolved).toEqual([{ key: 'tracker:3f2a00000000', opts: { outcome: 'cleared' } }]);
    expect(inbox.raised.map((r) => r.key)).toEqual(['review:3f2a00000000:DOR-2387']);
  });
});

describe('answering', () => {
  const key = 'review:3f2a00000000:DOR-2387';

  it('ships exactly the commit the ask showed, and offers once to ship on its own', async () => {
    const { coordinator, cli } = setup();
    await coordinator.sync([plan({ a: gateRun() })]);
    const result = await coordinator.handle(event(key));
    expect(cli.calls[0].args).toEqual([
      'review',
      'DOR-2387',
      '--approve',
      '--by',
      'person',
      '--head',
      'abc1234def',
      '--json',
      '--project',
      '/work/dorkos',
    ]);
    expect(result).toEqual({
      resolve: 'approved',
      offer: {
        text: 'Shipped. Next time, ship on its own when the reviewer agent approves?',
        offerId: '3f2a00000000:ship',
        settingsPatch: {
          project: '/work/dorkos',
          patch: { dial: 'ask', kinds: { retry: 'tell', ship: 'tell' } },
        },
      },
    });
    // Not raised again for the same commit.
    await coordinator.sync([plan({ a: gateRun() })]);
    expect(coordinator.decisions()).toEqual([]);
  });

  it('offers at most once a month, never without a person core credits, and never where the flow is too old', async () => {
    const storage = { value: null as unknown };
    const first = setup({ storage });
    await first.coordinator.sync([plan({ a: gateRun() })]);
    expect(await first.coordinator.handle(event(key))).toHaveProperty('offer');
    const again = setup({ storage });
    await again.coordinator.sync([
      plan({ a: gateRun({ drain: { ...gateRun().drain, reviewedSha: 'fff0000' } }) }),
    ]);
    expect(await again.coordinator.handle(event(key))).toEqual({ resolve: 'approved' });
    const page = setup();
    await page.coordinator.sync([plan({ a: gateRun() })]);
    expect(await page.coordinator.handle(event(key, { pendingActionId: null }))).toEqual({
      resolve: 'approved',
    });
    const old = setup();
    await old.coordinator.sync([plan({ a: gateRun() }, { behaviour: 0 })]);
    expect(await old.coordinator.handle(event(key))).toEqual({ resolve: 'approved' });
  });

  it('sends work back only with a note, through a file, and offers nothing', async () => {
    const { coordinator, cli } = setup();
    await coordinator.sync([plan({ a: gateRun() })]);
    expect(await coordinator.handle(event(key, { action: 'reject' }))).toEqual({
      keepOpen: true,
      message: 'Say what should change, then send it back.',
    });
    expect(
      await coordinator.handle(event(key, { action: 'reject', note: 'x'.repeat(2001) }))
    ).toMatchObject({ keepOpen: true });
    expect(cli.calls).toEqual([]);
    expect(
      await coordinator.handle(event(key, { action: 'reject', note: 'Make the banner smaller.' }))
    ).toEqual({ resolve: 'rejected' });
    expect(cli.calls[0].args.slice(0, 4)).toEqual([
      'review',
      'DOR-2387',
      '--changes',
      '--note-file',
    ]);
    expect(cli.calls[0].file).toBe('Make the banner smaller.');
    expect(cli.calls[0].args).not.toContain('Make the banner smaller.');
  });

  it('keeps the row open with a plain message when the command fails', async () => {
    const { coordinator } = setup({ cli: fakeCli(() => ({ code: 4 })) });
    await coordinator.sync([plan({ a: gateRun() })]);
    expect(await coordinator.handle(event(key))).toEqual({
      keepOpen: true,
      message: SEND_FAILED_TEXT,
    });
  });

  it('answers "Sending…" when the command is slow, then settles the row crediting the person', async () => {
    vi.useFakeTimers();
    const { coordinator, inbox } = setup({
      cli: fakeCli(() => ({ code: 0, delayMs: 3_000 })),
      answerWaitMs: 1_000,
    });
    await coordinator.sync([plan({ a: gateRun() })]);
    const answer = coordinator.handle(event(key));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await answer).toEqual({ keepOpen: true, message: SENDING_TEXT });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(inbox?.resolved.at(-1)).toEqual({
      key,
      opts: expect.objectContaining({
        outcome: 'approved',
        answering: 'pending-1',
        offer: expect.any(Object),
      }),
    });
  });

  it('posts a chip or a reply as the answer, through a file', async () => {
    const { coordinator, cli } = setup({ stops: { questions: 'tell' } });
    await coordinator.sync([plan({ a: questionRun() })]);
    const qkey = 'question:3f2a00000000:DOR-2401';
    expect(await coordinator.handle(event(qkey, { action: 'choice', choiceId: 'c2' }))).toEqual({
      resolve: 'answered',
    });
    expect(cli.calls[0].args.slice(0, 3)).toEqual(['answer', 'DOR-2401', '--text-file']);
    expect(cli.calls[0].file).toBe('Remove it');
  });

  it("takes the agent's pick at the deadline off the floor, and never settles a floor question on it", async () => {
    const qkey = 'question:3f2a00000000:DOR-2401';
    const tell = setup({ stops: { questions: 'tell' } });
    await tell.coordinator.sync([plan({ a: questionRun() })]);
    expect(
      await tell.coordinator.handle(
        event(qkey, {
          action: 'choice',
          choiceId: 'c1',
          decidedBy: 'deadline',
          pendingActionId: null,
        })
      )
    ).toEqual({
      resolve: 'answered',
    });
    expect(tell.cli.calls[0].args.slice(0, 5)).toEqual([
      'answer',
      'DOR-2401',
      '--pick',
      '--by',
      'agent-default',
    ]);
    const floor = setup({ stops: { questions: 'tell' } });
    await floor.coordinator.sync([plan({ a: questionRun({ floor: ['outward-facing'] }) })]);
    expect(
      await floor.coordinator.handle(event(qkey, { action: 'choice', decidedBy: 'deadline' }))
    ).toEqual({
      keepOpen: true,
    });
    expect(floor.cli.calls).toEqual([]);
    const ask = setup({ stops: { questions: 'ask' } });
    await ask.coordinator.sync([plan({ a: questionRun() })]);
    expect(
      await ask.coordinator.handle(event(qkey, { action: 'choice', decidedBy: 'deadline' }))
    ).toEqual({
      keepOpen: true,
    });
  });

  it('settles quietly when the question was answered elsewhere first', async () => {
    const qkey = 'question:3f2a00000000:DOR-2401';
    const deadline = setup({ stops: { questions: 'tell' }, cli: fakeCli(() => ({ code: 5 })) });
    await deadline.coordinator.sync([plan({ a: questionRun() })]);
    expect(
      await deadline.coordinator.handle(event(qkey, { action: 'choice', decidedBy: 'deadline' }))
    ).toEqual({
      settled: true,
    });
    expect(deadline.inbox?.resolved.at(-1)).toEqual({
      key: qkey,
      opts: { outcome: 'answered', by: { kind: 'deadline' } },
    });
    const person = setup({ stops: { questions: 'tell' }, cli: fakeCli(() => ({ code: 5 })) });
    await person.coordinator.sync([plan({ a: questionRun() })]);
    expect(
      await person.coordinator.handle(event(qkey, { action: 'choice', choiceId: 'c1' }))
    ).toEqual({
      keepOpen: true,
      message: 'This was already answered on the tracker.',
    });
    expect(person.inbox?.resolved.at(-1)).toEqual({ key: qkey, opts: { outcome: 'cleared' } });
  });

  it('posts the go-ahead for "Fix it", and leaves the run parked for "Leave it"', async () => {
    const run = {
      identifier: 'DOR-2410',
      status: 'running',
      drain: { v: 1, phase: 'parked', parkedReason: CHECKS_FAILED_REASON, parkedAt: 'p1' },
    };
    const fix = setup({ stops: { retry: 'ask' } });
    await fix.coordinator.sync([plan({ a: run })]);
    const rkey = 'retry:3f2a00000000:DOR-2410';
    expect(await fix.coordinator.handle(event(rkey))).toMatchObject({ resolve: 'approved' });
    expect(fix.cli.calls[0].file).toBe(FIX_IT_ANSWER);
    const leave = setup({ stops: { retry: 'ask' } });
    await leave.coordinator.sync([plan({ a: run })]);
    expect(await leave.coordinator.handle(event(rkey, { action: 'reject' }))).toEqual({
      resolve: 'rejected',
    });
    expect(leave.cli.calls).toEqual([]);
    await leave.coordinator.sync([plan({ a: run })]);
    expect(leave.coordinator.decisions()).toEqual([]);
  });

  it('answers a Yes to an offer with where to change it', async () => {
    const { coordinator } = setup();
    await coordinator.sync([plan({ a: gateRun() })]);
    expect(
      await coordinator.handle(event(key, { action: 'offer', offerId: '3f2a00000000:ship' }))
    ).toEqual({
      resolve: 'approved',
      message: "Done. Change it any time in dorkos's Flow settings.",
    });
  });
});

describe('starting work from an ask', () => {
  const auth: TrackerRead = {
    at: null,
    queue: null,
    teamUrl: null,
    facts: null,
    failure: { kind: 'auth', since: '2026-09-28T09:14:00.000Z' },
  };

  it('starts the sign-in in a new chat and keeps the row open with Watch', async () => {
    const sessions = { start: vi.fn(async () => ({ sessionId: 'chat-1' })) };
    const { coordinator, inbox } = setup({ sessions });
    await coordinator.sync([plan({}, { read: auth })]);
    expect(inbox?.raised[0].actions).toEqual({ kind: 'word', label: 'Sign in' });
    const result = await coordinator.handle(event('tracker:3f2a00000000', { action: 'word' }));
    expect(sessions.start).toHaveBeenCalledWith({
      project: '/work/dorkos',
      prompt: expect.stringMatching(/^\/flow:init/),
      title: 'Signing in to Linear for dorkos',
      reason: "Linear stopped accepting flow's sign-in",
    });
    expect(result).toEqual({
      keepOpen: true,
      watch: { sessionId: 'chat-1', label: 'Signing in to Linear…' },
    });
  });

  it('starts sorting, settles the ask for a day, and offers to sort every morning', async () => {
    const sessions = { start: vi.fn(async (_input: unknown) => ({ sessionId: 'chat-2' })) };
    const { coordinator } = setup({ sessions });
    const ideas = plan(
      {},
      { ideas: { waiting: 12, due: true, idleSince: '2026-09-27T09:00:00.000Z' } }
    );
    await coordinator.sync([ideas]);
    const result = await coordinator.handle(event('idle:3f2a00000000', { action: 'word' }));
    expect(result).toMatchObject({
      resolve: 'answered',
      watch: { sessionId: 'chat-2', label: 'Sorting 12 ideas…' },
      offer: { text: 'Sorting. Next time, sort new ideas every morning on its own?' },
    });
    expect(sessions.start.mock.calls[0][0]).toMatchObject({
      title: 'Sorting 12 new ideas in dorkos',
      reason: '12 new ideas were waiting to be sorted',
      prompt: '/flow:triage',
    });
    await coordinator.sync([ideas]);
    expect(coordinator.decisions()).toEqual([]);
    expect(SORT_QUIET_MS).toBe(24 * 60 * 60_000);
  });

  it("shows DorkOS's refusal on the row and starts nothing more", async () => {
    const refused = Object.assign(new Error('No account may work in dorkos.'), {
      code: 'account_not_allowed_here',
    });
    const sessions = { start: vi.fn(async () => Promise.reject(refused)) };
    const { coordinator } = setup({ sessions });
    await coordinator.sync([plan({}, { read: auth })]);
    expect(await coordinator.handle(event('tracker:3f2a00000000', { action: 'word' }))).toEqual({
      keepOpen: true,
      message: "No account may work in dorkos. Choose accounts in dorkos's Flow settings.",
    });
  });

  it('opens the project page from the inbox on a DorkOS that cannot start a chat', async () => {
    const { coordinator, inbox } = setup();
    await coordinator.sync([plan({}, { read: auth })]);
    expect(inbox?.raised[0].actions).toEqual({
      kind: 'word',
      label: 'Sign in',
      href: '/x/flow/p/dorkos',
    });
    expect(await coordinator.handle(event('tracker:3f2a00000000', { action: 'word' }))).toEqual({
      keepOpen: true,
      message: 'In a chat in dorkos, type /flow:init, and ask it to reconnect Linear.',
    });
  });
});

describe('"While you were away"', () => {
  /** A project folder with a journal. */
  function projectWithJournal(lines: Record<string, unknown>[]): string {
    const root = path.join(dir, 'proj');
    mkdirSync(path.join(root, '.dork', 'flow'), { recursive: true });
    writeFileSync(
      path.join(root, '.dork', 'flow', 'journal.jsonl'),
      lines.map((line) => JSON.stringify(line)).join('\n')
    );
    return root;
  }

  it('records work the reviewer agent shipped, unread at Tell me after, once, and never old history', async () => {
    const root = projectWithJournal([
      {
        v: 1,
        ts: '2026-09-27T00:00:00.000Z',
        kind: 'review.approved',
        by: 'reviewer-agent',
        item: 'DOR-1',
      },
    ]);
    const { coordinator, inbox } = setup({ stops: { ship: 'tell' } });
    const store = { a: { identifier: 'DOR-9', title: 'New sidebar', status: 'running' } };
    await coordinator.sync([plan(store, { root })]);
    expect(inbox?.recorded).toEqual([]);
    writeFileSync(
      path.join(root, '.dork', 'flow', 'journal.jsonl'),
      [
        {
          v: 1,
          ts: '2026-09-27T00:00:00.000Z',
          kind: 'review.approved',
          by: 'reviewer-agent',
          item: 'DOR-1',
        },
        {
          v: 1,
          ts: '2026-09-28T11:00:00.000Z',
          kind: 'review.approved',
          by: 'reviewer-agent',
          item: 'DOR-9',
        },
        {
          v: 1,
          ts: '2026-09-28T11:01:00.000Z',
          kind: 'review.approved',
          by: 'person',
          item: 'DOR-8',
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
    );
    await coordinator.sync([plan(store, { root })]);
    await coordinator.sync([plan(store, { root })]);
    expect(inbox?.recorded).toEqual([
      expect.objectContaining({
        title: 'Ship New sidebar?',
        by: { kind: 'agent', label: 'the reviewer agent' },
        choiceLabel: 'Shipped',
        tell: true,
        outcome: 'approved',
      }),
    ]);
  });

  it('records failing checks flow went back to fix at Just do it, quietly', async () => {
    const { coordinator, inbox } = setup({ stops: { retry: 'auto' } });
    const withCopy = dial({ retry: 'auto' });
    (withCopy as unknown as { of: () => unknown }).of = () => ({
      copy: { dial: 'auto', kinds: {} },
    });
    (coordinator as unknown as { deps: { autonomy: AutonomyStore } }).deps.autonomy = withCopy;
    const run = {
      identifier: 'DOR-3',
      status: 'running',
      drain: { v: 1, phase: 'fixing-ci', pushedSha: 'abc' },
    };
    await coordinator.sync([plan({ a: run })]);
    await coordinator.sync([plan({ a: run })]);
    expect(inbox?.recorded).toEqual([
      expect.objectContaining({
        choiceLabel: 'Fixing',
        tell: false,
        by: { kind: 'rule', label: "your 'Just do it' setting" },
      }),
    ]);
  });
});
