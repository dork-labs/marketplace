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
import { realProcessRunner } from '../../../../scripts/cli/context.ts';
import { PARK_REASONS } from '../../../../scripts/drain/drain-step.ts';
import { main } from '../../../../scripts/flow.ts';
import { FakeTracker } from '../../../../scripts/tracker/fake.ts';
import {
  AGENT_USER,
  item,
  makeProject,
  type WriteProject,
} from '../../../../engine-tests/cli/write-harness.ts';
import type { ExecFileLike } from '../lib/advisor.ts';
import { FIX_IT_ANSWER, type AskProject } from '../lib/asks.ts';
import type { AutonomyStore } from '../lib/autonomy-store.ts';
import {
  ANSWER_IN_INBOX_TEXT,
  BUSY_ANSWER_TEXT,
  BUSY_REVIEW_TEXT,
  armMessage,
  CHANGED_TEXT,
  CHECKS_FAILED_REASON,
  DID_NOT_GO_THROUGH,
  DecisionCoordinator,
  SENDING_TEXT,
  SEND_FAILED_TEXT,
  SETTLED_TEXT,
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
  cwd?: string;
  env?: Record<string, string | undefined>;
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
  const execFile: ExecFileLike = (_file, args, opts, callback) => {
    const rest = args.slice(2);
    const call: Call = { args: rest, file: null, cwd: opts.cwd, env: opts.env };
    calls.push(call);
    const reply = answer(rest);
    const done = () => {
      const stdout = reply.json === undefined ? '{"ok":true}' : JSON.stringify(reply.json);
      if (reply.code === 0) callback(null, stdout, '');
      else callback(Object.assign(new Error('exit'), { code: reply.code }), stdout, '');
    };
    if (reply.delayMs === undefined) queueMicrotask(done);
    else setTimeout(done, reply.delayMs);
    // What the verb reads with `-`: the answer's words, on standard input.
    // An isolated extension's host drops what arrives before the program has
    // started, so an `end` before `spawn` is lost here too.
    let started = false;
    return {
      once: (_event: string, listener: () => void) =>
        queueMicrotask(() => {
          started = true;
          listener();
        }),
      stdin: {
        on: () => undefined,
        end: (text?: string) => {
          if (started) call.file = text ?? null;
        },
      },
    };
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
    closedRuns: [],
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

  it("raises a question with the agent's pick and the deadline flow ask stored, and none without one", async () => {
    const tell = setup({ stops: { questions: 'tell' } });
    await tell.coordinator.sync([plan({ a: questionRun() })]);
    expect(tell.inbox?.raised[0].actions).toMatchObject({
      kind: 'choice',
      defaultChoice: 'c1',
      decideBy: '2026-09-28T17:00:00.000Z',
      allowReply: true,
    });
    const ask = setup({ stops: { questions: 'ask' } });
    await ask.coordinator.sync([plan({ a: questionRun({ decideBy: null }) })]);
    expect(ask.inbox?.raised[0].actions).not.toHaveProperty('decideBy');
    const floor = setup({ stops: { questions: 'tell' } });
    await floor.coordinator.sync([
      plan({ a: questionRun({ floor: ['outward-facing'], decideBy: null }) }),
    ]);
    expect(floor.inbox?.raised[0].actions).not.toHaveProperty('decideBy');
  });

  it('leaves a floor question asked at Just do it to the reviewer agent, except a spend', async () => {
    const auto = setup({ stops: { questions: 'auto' } });
    await auto.coordinator.sync([
      plan({
        b: {
          ...questionRun({
            floor: ['outward-facing'],
            decideBy: null,
            answeredBy: 'reviewer-agent',
            checkAfter: '2026-09-28T09:00:00.000Z',
          }),
          identifier: 'DOR-9',
        },
      }),
    ]);
    expect(auto.inbox?.raised).toEqual([]);
    const spend = setup({ stops: { questions: 'auto' } });
    await spend.coordinator.sync([
      plan({ a: questionRun({ floor: ['secrets-or-spend'], decideBy: null }) }),
    ]);
    expect(spend.inbox?.raised.map((r) => r.title)).toEqual(['Should the old API keep working?']);
  });

  it('keeps a question asked at Ask me first open after the dial moves to Just do it', async () => {
    // Asked while the project asked you first: flow ask stored no deadline.
    const { coordinator, inbox } = setup({ stops: { questions: 'ask' } });
    const asked = plan({ a: questionRun({ decideBy: null }) });
    await coordinator.sync([asked]);
    expect(inbox?.raised).toHaveLength(1);
    // The person moves the dial; the question is still the same one, still waiting.
    (coordinator as unknown as { deps: { autonomy: AutonomyStore } }).deps.autonomy = dial({
      questions: 'auto',
    });
    await coordinator.sync([asked]);
    expect(inbox?.resolved).toEqual([]);
    expect(coordinator.decisions().map((d) => d.kind)).toEqual(['question']);
    expect(inbox?.raised.at(-1)?.why).toMatch(/until you answer\.$/);
  });

  it('says a stored deadline even after the dial moves back to Ask me first', async () => {
    const { coordinator, inbox } = setup({ stops: { questions: 'ask' } });
    await coordinator.sync([plan({ a: questionRun() })]);
    expect(inbox?.raised[0].why).toMatch(/by the deadline, it goes with "Keep it"/);
    expect(inbox?.raised[0].actions).toMatchObject({ decideBy: '2026-09-28T17:00:00.000Z' });
  });

  it('never drops a spend question whose words break a rule', async () => {
    const { coordinator, inbox } = setup();
    await coordinator.sync([
      plan({
        a: questionRun({
          text: '/pay the invoice now?',
          floor: ['secrets-or-spend'],
          decideBy: null,
        }),
      }),
    ]);
    expect(inbox?.raised.map((r) => r.title)).toEqual(['A question needs you in dorkos']);
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

  it("clears a review gate and a question once the tracker says the run's item closed (DOR-2924)", async () => {
    // Purpose: a run whose item closed (its PR merged, a person cancelled it)
    // stays in the run store until someone releases it; its asks must not
    // wait there forever, and none is raised for it again.
    const { coordinator, inbox } = setup({ stops: { questions: 'ask' } });
    const verifyGate = {
      identifier: 'DOR-2390',
      title: 'Gate VERIFY left',
      status: 'waiting_for_review',
      stage: 'review',
      review: { verdict: 'clean', reviewedSha: 'abc1234def' },
    };
    const store = { a: gateRun(), b: questionRun(), c: verifyGate };
    await coordinator.sync([plan(store)]);
    expect(inbox?.raised.map((r) => r.key)).toEqual([
      'review:3f2a00000000:DOR-2387',
      'review:3f2a00000000:DOR-2390',
      'question:3f2a00000000:DOR-2401',
    ]);
    const closedRuns = ['DOR-2387', 'DOR-2390', 'DOR-2401'].map((identifier) => ({
      identifier,
      sessionId: null,
    }));
    await coordinator.sync([plan(store, { closedRuns })]);
    expect(inbox?.resolved).toEqual([
      { key: 'review:3f2a00000000:DOR-2387', opts: { outcome: 'cleared' } },
      { key: 'review:3f2a00000000:DOR-2390', opts: { outcome: 'cleared' } },
      { key: 'question:3f2a00000000:DOR-2401', opts: { outcome: 'cleared' } },
    ]);
    expect(coordinator.decisions()).toEqual([]);
    await coordinator.sync([plan(store, { closedRuns })]);
    expect(inbox?.raised).toHaveLength(3);
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
    const started = coordinator.start();
    await coordinator.sync([plan({ a: gateRun() })]);
    await started;
    expect(inbox.inbox.onAction).toHaveBeenCalledTimes(1);
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
    // From the project's own folder: flow refuses a --project outside it (DOR-3377).
    expect(cli.calls[0].cwd).toBe('/work/dorkos');
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

  // DOR-3768: when only a person can clear flow's refusal, the row is raised at
  // any dial; a refusal that clears by itself raises nothing.
  describe('a refusal only a person can clear', () => {
    const refusedRun = (reason: string, sha = 'abc1234def') =>
      gateRun({ armRefusal: { sha, reason, detail: 'x', at: '2026-09-26T10:00:00.000Z' } });
    const whyOf = (coordinator: DecisionCoordinator) =>
      (coordinator.decisions()[0] as unknown as { input?: { why: string }; why?: string }).input
        ?.why ?? (coordinator.decisions()[0] as unknown as { why: string }).why;

    it.each(['tell', 'auto'] as const)('raises the Ship row at %s', async (stop) => {
      const { coordinator } = setup({ stops: { ship: stop } });
      await coordinator.sync([plan({ a: refusedRun('security-label-missing') })]);
      expect(coordinator.decisions()).toHaveLength(1);
      expect(whyOf(coordinator)).toMatch(/won't merge this by itself/);
      expect(whyOf(coordinator)).toMatch(/Ship it to merge it/);
      expect(whyOf(coordinator)).toMatch(/pre-arm check/);
    });

    it.each([
      'security-label-missing',
      'security-label-stale',
      'security-label-unverified',
      'security-path-unlabelled',
      'files-unreadable',
    ])('raises it for %s', async (reason) => {
      const { coordinator } = setup({ stops: { ship: 'auto' } });
      await coordinator.sync([plan({ a: refusedRun(reason) })]);
      expect(coordinator.decisions()).toHaveLength(1);
      expect(whyOf(coordinator).length).toBeLessThanOrEqual(300);
      expect(whyOf(coordinator)).toMatch(/can't tell who added the label/i);
      expect(whyOf(coordinator)).toMatch(/solo repo.*promise/i);
    });

    it('says the label has to come off and go back on after new commits', async () => {
      const { coordinator } = setup({ stops: { ship: 'auto' } });
      await coordinator.sync([plan({ a: refusedRun('security-label-stale') })]);
      expect(whyOf(coordinator)).toMatch(/take it off and add it back/);
    });

    it('says shipping is not enough on a security path', async () => {
      const { coordinator } = setup({ stops: { ship: 'auto' } });
      await coordinator.sync([plan({ a: refusedRun('security-path-unlabelled') })]);
      expect(whyOf(coordinator)).toMatch(/security path/);
      expect(whyOf(coordinator)).toMatch(/by hand/);
      expect(whyOf(coordinator)).not.toMatch(/Ship it to merge it/);
    });

    it.each(['freeze', 'pre-arm-deferred', 'failing-checks', 'not-squash'])(
      'raises nothing for %s',
      async (reason) => {
        const { coordinator } = setup({ stops: { ship: 'auto' } });
        await coordinator.sync([plan({ a: refusedRun(reason) })]);
        expect(coordinator.decisions()).toEqual([]);
      }
    );

    it('raises nothing for a refusal about an older commit', async () => {
      const { coordinator } = setup({ stops: { ship: 'auto' } });
      await coordinator.sync([plan({ a: refusedRun('security-label-missing', 'f'.repeat(40)) })]);
      expect(coordinator.decisions()).toEqual([]);
    });

    it('raises nothing once the PR is armed', async () => {
      const { coordinator } = setup({ stops: { ship: 'auto' } });
      const run = refusedRun('security-label-missing');
      await coordinator.sync([
        plan({ a: { ...run, drain: { ...run.drain, pr: { number: 2303, armed: true } } } }),
      ]);
      expect(coordinator.decisions()).toEqual([]);
    });

    it("words the panel's answer for a person, with no line about agents", () => {
      for (const reason of ['security-label-missing', 'security-path-unlabelled']) {
        const said = armMessage({
          armRefused: {
            reason,
            detail: 'flow arms this PR only after a person adds it. An agent must not add it',
          },
        });
        expect(said).toMatch(/^Shipped, but flow didn't turn on auto-merge/);
        expect(said).not.toMatch(/agent/i);
        expect(said).toMatch(/merge it yourself/i);
      }
      // The label is already on: adding it again does nothing.
      expect(armMessage({ armRefused: { reason: 'security-label-stale', detail: 'x' } })).toMatch(
        /take the label off and add it back/
      );
      // The label can't help when flow can't date the head.
      expect(
        armMessage({ armRefused: { reason: 'security-label-unverified', detail: 'x' } })
      ).toMatch(/Merge it yourself/);
      expect(
        armMessage({ armRefused: { reason: 'security-label-unverified', detail: 'x' } })
      ).not.toMatch(/add the/);
      expect(
        armMessage({
          armHandedToDrain: true,
          armRefused: { reason: 'security-label-stale', detail: 'An agent must not add it' },
        })
      ).not.toMatch(/agent/i);
    });
  });

  it('says what a handed-off arm still waits for', () => {
    expect(armMessage({ armHandedToDrain: true, armRefused: { detail: 'it has no label' } })).toBe(
      'Shipped. Flow turns on auto-merge once this is settled: it has no label.'
    );
  });

  // DOR-3262: an approval that shipped but armed nothing resolves, and says so.
  it('says when the approval shipped but flow did not turn on auto-merge', async () => {
    const refused = setup({
      cli: fakeCli(() => ({
        code: 0,
        json: {
          ok: true,
          verdict: 'approved',
          armed: false,
          armRefused: { reason: 'freeze', detail: 'a release freeze is on (cutting 1.4)' },
        },
      })),
    });
    await refused.coordinator.sync([plan({ a: gateRun() })]);
    expect(await refused.coordinator.handle(event(key))).toMatchObject({
      resolve: 'approved',
      message:
        "Shipped, but flow didn't turn on auto-merge: a release freeze is on (cutting 1.4). Merge it yourself.",
    });
    const handed = setup({
      cli: fakeCli(() => ({
        code: 0,
        json: { ok: true, verdict: 'approved', armed: false, armHandedToDrain: true },
      })),
    });
    await handed.coordinator.sync([plan({ a: gateRun() })]);
    expect(await handed.coordinator.handle(event(key))).toMatchObject({
      resolve: 'approved',
      message: 'Shipped. Flow turns on auto-merge as soon as its checks allow.',
    });
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
    // From flow's page (core credits it to Flow, no pending id): shipping goes to the Inbox.
    expect(await page.coordinator.handle(event(key, { pendingActionId: null }))).toEqual({
      keepOpen: true,
      message: ANSWER_IN_INBOX_TEXT,
    });
    expect(page.cli.calls).toEqual([]);
    const old = setup();
    await old.coordinator.sync([plan({ a: gateRun() }, { behaviour: 0 })]);
    expect(await old.coordinator.handle(event(key))).toEqual({ resolve: 'approved' });
  });

  // Purpose (DOR-3716): `flow review --approve`/`--changes` as the person refuse
  // an agent's shell, so DorkOS's 👍 and 👎 run them with no agent's markers,
  // session or token, even when DorkOS's own process carries them.
  it.each([
    ['👍', {}],
    ['👎', { action: 'reject', note: 'Make the banner smaller.' }],
  ] as const)('runs %s without any agent markers or session', async (_name, action) => {
    const markers = {
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 's-1',
      CODEX_THREAD_ID: 't-1',
      OPENCODE: '1',
      FLOW_RUNTIME: 'claude-code',
      FLOW_SESSION_ID: 'agent-session',
      DORKOS_AGENT_TOKEN: 'tok',
    };
    for (const [name, value] of Object.entries(markers)) vi.stubEnv(name, value);
    try {
      const { coordinator, cli } = setup();
      await coordinator.sync([plan({ a: gateRun() })]);
      await coordinator.handle(event(key, action));
      expect(cli.calls[0].args[0]).toBe('review');
      const env = cli.calls[0].env;
      expect(env).toBeDefined();
      for (const name of Object.keys(markers)) expect(env).not.toHaveProperty(name);
    } finally {
      vi.unstubAllEnvs();
    }
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
    expect(cli.calls[0].args.slice(0, 5)).toEqual([
      'review',
      'DOR-2387',
      '--changes',
      '--note-file',
      '-',
    ]);
    expect(cli.calls[0].file).toBe('Make the banner smaller.');
    expect(cli.calls[0].args).not.toContain('Make the banner smaller.');
  });

  it('says the click failed when the gate refuses after the wait', async () => {
    vi.useFakeTimers();
    const { coordinator, inbox } = setup({
      cli: fakeCli(() => ({
        code: 5,
        delayMs: 3_000,
        json: { ok: false, error: { code: 5, kind: 'person-gate', message: 'Stop' } },
      })),
      answerWaitMs: 1_000,
    });
    await coordinator.sync([plan({ a: gateRun() })]);
    const raised = inbox?.raised.length ?? 0;
    const answer = coordinator.handle(event(key));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await answer).toEqual({ keepOpen: true, message: SENDING_TEXT });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(inbox?.raised.length).toBe(raised + 1);
  });

  // DOR-3718: a refusal is not "someone else answered". Nothing was recorded, so
  // the row stays, and the person isn't told their answer was a duplicate.
  it.each<[string, string, object]>([
    ['question', 'question:3f2a00000000:DOR-2401', { action: 'choice', choiceId: 'c2' }],
    ['review', 'review:3f2a00000000:DOR-2387', { action: 'approve' }],
  ])('keeps a %s open when the person gate refuses the click', async (kind, key, action) => {
    const { coordinator } = setup({
      stops: { questions: 'tell' },
      cli: fakeCli(() => ({
        code: 5,
        json: { ok: false, error: { code: 5, kind: 'person-gate', message: 'Stop: an agent' } },
      })),
    });
    await coordinator.sync([plan({ a: kind === 'question' ? questionRun() : gateRun() })]);
    const result = await coordinator.handle(event(key, action as never));
    expect(result).toEqual({
      keepOpen: true,
      message: expect.stringContaining('started from inside an agent'),
    });
    expect(JSON.stringify(result)).not.toContain('already answered');
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

  // DOR-3718: the words go on standard input, so no file ever holds them.
  it('posts a chip or a reply as the answer, on standard input', async () => {
    const { coordinator, cli } = setup({ stops: { questions: 'tell' } });
    await coordinator.sync([plan({ a: questionRun() })]);
    const qkey = 'question:3f2a00000000:DOR-2401';
    expect(await coordinator.handle(event(qkey, { action: 'choice', choiceId: 'c2' }))).toEqual({
      resolve: 'answered',
    });
    expect(cli.calls[0].args.slice(0, 4)).toEqual(['answer', 'DOR-2401', '--text-file', '-']);
    expect(cli.calls[0].file).toBe('Remove it');
  });

  // Purpose (DOR-3712): `flow answer --text` refuses a shell inside an agent.
  // The person who clicked is the one answering, so the verb runs without the
  // agent markers or a session id DorkOS's own process may carry (a DorkOS
  // started from inside a Claude session). Fails if they reach the verb.
  it("runs the person's answer without any agent's markers or session", async () => {
    const markers = {
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 's-1',
      CODEX_THREAD_ID: 't-1',
      CODEX_SANDBOX: 'seatbelt',
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
      OPENCODE: '1',
      FLOW_RUNTIME: 'claude-code',
      FLOW_SESSION_ID: 'agent-session',
      DORKOS_AGENT_TOKEN: 'tok',
    };
    for (const [name, value] of Object.entries(markers)) vi.stubEnv(name, value);
    try {
      const { coordinator, cli } = setup({ stops: { questions: 'tell' } });
      await coordinator.sync([plan({ a: questionRun() })]);
      const qkey = 'question:3f2a00000000:DOR-2401';
      await coordinator.handle(event(qkey, { action: 'choice', choiceId: 'c2' }));
      const env = cli.calls[0].env;
      expect(env).toBeDefined();
      for (const name of Object.keys(markers)) expect(env).not.toHaveProperty(name);
      // Everything else the verb needs still reaches it.
      expect(env?.PATH).toBe(process.env.PATH);
    } finally {
      vi.unstubAllEnvs();
    }
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
    await ask.coordinator.sync([plan({ a: questionRun({ decideBy: null }) })]);
    expect(
      await ask.coordinator.handle(event(qkey, { action: 'choice', decidedBy: 'deadline' }))
    ).toEqual({
      keepOpen: true,
    });
    // A deadline flow ask stored stands even if the dial moved to Ask me first since.
    const moved = setup({ stops: { questions: 'ask' } });
    await moved.coordinator.sync([plan({ a: questionRun() })]);
    expect(
      await moved.coordinator.handle(
        event(qkey, { action: 'choice', decidedBy: 'deadline', pendingActionId: null })
      )
    ).toEqual({ resolve: 'answered' });
  });

  it('settles quietly when the question was answered elsewhere first', async () => {
    const qkey = 'question:3f2a00000000:DOR-2401';
    const settled = () => ({
      code: 5,
      json: { ok: false, error: { code: 5, kind: 'settled', message: 'already answered' } },
    });
    const deadline = setup({ stops: { questions: 'tell' }, cli: fakeCli(settled) });
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
    const person = setup({ stops: { questions: 'tell' }, cli: fakeCli(settled) });
    await person.coordinator.sync([plan({ a: questionRun() })]);
    expect(
      await person.coordinator.handle(event(qkey, { action: 'choice', choiceId: 'c1' }))
    ).toEqual({
      keepOpen: true,
      message: SETTLED_TEXT,
    });
    expect(person.inbox?.resolved.at(-1)).toEqual({ key: qkey, opts: { outcome: 'cleared' } });
  });

  // DOR-3775: only a refusal that says someone answered may clear the row. Any
  // other, or none that can be read, keeps it: a person's answer that wasn't
  // recorded must not look recorded.
  describe('a refusal that does not say someone answered', () => {
    const qkey = 'question:3f2a00000000:DOR-2401';
    const choice = { action: 'choice', choiceId: 'c1' } as const;
    const refusal = (kind?: string, message = 'DOR-2401 has no open question') => ({
      code: 5,
      json: { ok: false, error: { code: 5, ...(kind === undefined ? {} : { kind }), message } },
    });

    it("keeps a person's row and says why", async () => {
      const { coordinator, inbox } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => refusal()),
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      expect(await coordinator.handle(event(qkey, choice))).toEqual({
        keepOpen: true,
        message: "Flow didn't record this: DOR-2401 has no open question",
      });
      expect(inbox?.resolved).toEqual([]);
      expect(inbox?.open.has(qkey)).toBe(true);
    });

    it('keeps the row when the output cannot be read', async () => {
      const { coordinator, inbox } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => ({ code: 5 })),
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      expect(await coordinator.handle(event(qkey, choice))).toEqual({
        keepOpen: true,
        message: SEND_FAILED_TEXT,
      });
      expect(inbox?.resolved).toEqual([]);
    });

    it('keeps the row at a deadline, without calling it answered', async () => {
      const { coordinator, inbox } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => refusal(undefined, 'its pick cannot stand yet')),
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      expect(
        await coordinator.handle(event(qkey, { action: 'choice', decidedBy: 'deadline' }))
      ).toEqual({ keepOpen: true });
      expect(inbox?.resolved).toEqual([]);
      expect(inbox?.open.has(qkey)).toBe(true);
    });

    it.each<[string, string, Record<string, unknown>, object, string]>([
      ['question', qkey, questionRun({ decideBy: null }), choice, BUSY_ANSWER_TEXT],
      [
        'review',
        'review:3f2a00000000:DOR-2387',
        gateRun(),
        { action: 'approve' },
        BUSY_REVIEW_TEXT,
      ],
    ])(
      'says to try again when the store is busy on a %s',
      async (_kind, key, run, action, text) => {
        const { coordinator, inbox } = setup({
          stops: { questions: 'tell' },
          cli: fakeCli(() => refusal('busy', '/secret/path stayed locked')),
        });
        await coordinator.sync([plan({ a: run })]);
        const result = await coordinator.handle(event(key, action as never));
        expect(result).toEqual({ keepOpen: true, message: text });
        expect(text).toContain('Try again');
        expect(JSON.stringify(result)).not.toContain('/secret/path');
        expect(inbox?.resolved).toEqual([]);
        expect(inbox?.open.has(key)).toBe(true);
      }
    );

    // Core marks a deadline answered on any answer that returns, keep-open included,
    // so only a failed call leaves it standing; core then says to try again.
    it('fails the call when a person meets a busy store on a question with a deadline', async () => {
      const { coordinator, inbox, log } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => refusal('busy', 'the store stayed locked')),
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      await expect(coordinator.handle(event(qkey, choice))).rejects.toThrow(qkey);
      expect(inbox?.resolved).toEqual([]);
      expect(inbox?.open.has(qkey)).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('the store stayed locked'));
    });

    // A spend has no deadline to retry at: a deadline call after a person's busy
    // click runs no pick and marks nothing answered.
    it("takes no pick on a spend at a deadline call after a person's busy click", async () => {
      const cli = fakeCli(() => refusal('busy', 'the store stayed locked'));
      const { coordinator, inbox } = setup({ stops: { questions: 'tell' }, cli });
      await coordinator.sync([
        plan({
          a: questionRun({
            floor: ['secrets-or-spend'],
            decideBy: '2026-09-28T17:00:00.000Z',
          }),
        }),
      ]);
      expect(await coordinator.handle(event(qkey, choice))).toEqual({
        keepOpen: true,
        message: BUSY_ANSWER_TEXT,
      });
      const deadline = event(qkey, { action: 'choice', decidedBy: 'deadline' });
      expect(await coordinator.handle(deadline)).toEqual({ keepOpen: true });
      expect(await coordinator.handle(deadline)).toEqual({ keepOpen: true });
      expect(cli.calls).toHaveLength(1);
      expect(JSON.stringify(cli.calls)).not.toContain('--pick');
      expect(inbox?.resolved).toEqual([]);
      expect(inbox?.open.has(qkey)).toBe(true);
    });

    // A slow answer already said "Sending…", so the row itself has to say it.
    it('says on the row that a slow answer met a busy store', async () => {
      vi.useFakeTimers();
      const { coordinator, inbox } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => ({ ...refusal('busy'), delayMs: 3_000 })),
        answerWaitMs: 1_000,
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      const raised = inbox?.raised.length ?? 0;
      const answer = coordinator.handle(event(qkey, choice));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await answer).toEqual({ keepOpen: true, message: SENDING_TEXT });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(inbox?.raised.length).toBe(raised + 1);
      expect(inbox?.resolved).toEqual([]);
    });

    it('says on the row that a slow review met a busy store', async () => {
      vi.useFakeTimers();
      const { coordinator, inbox } = setup({
        cli: fakeCli(() => ({ ...refusal('busy'), delayMs: 3_000 })),
        answerWaitMs: 1_000,
      });
      await coordinator.sync([plan({ a: gateRun() })]);
      const raised = inbox?.raised.length ?? 0;
      const answer = coordinator.handle(event('review:3f2a00000000:DOR-2387'));
      await vi.advanceTimersByTimeAsync(1_000);
      await answer;
      await vi.advanceTimersByTimeAsync(2_500);
      expect(inbox?.raised.length).toBe(raised + 1);
    });

    // Past the wait the verb may yet meet the lock, and core keeps no deadline it
    // was told to keep open, so the call fails and core asks again.
    it('fails a slow deadline call, leaves the row alone, and answers the next call', async () => {
      vi.useFakeTimers();
      const cli = fakeCli(() => ({ ...refusal('busy'), delayMs: 3_000 }));
      const { coordinator, inbox } = setup({
        stops: { questions: 'tell' },
        cli,
        answerWaitMs: 1_000,
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      const raised = inbox?.raised.length ?? 0;
      const deadline = event(qkey, { action: 'choice', decidedBy: 'deadline' });
      const first = coordinator.handle(deadline);
      const failed = expect(first).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      await failed;
      // Still running: a second call neither starts another nor keeps the row open.
      await expect(coordinator.handle(deadline)).rejects.toThrow();
      expect(cli.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(inbox?.raised.length).toBe(raised);
      expect(inbox?.resolved).toEqual([]);
      const third = coordinator.handle(deadline);
      const refused = expect(third).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      await refused;
      expect(cli.calls).toHaveLength(2);
    });

    // The pick is running, so "Sending…" would be untrue of the person's words.
    it("fails a person's answer while a slow deadline call is running", async () => {
      vi.useFakeTimers();
      const { coordinator } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => ({ code: 0, delayMs: 3_000 })),
        answerWaitMs: 1_000,
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      const first = coordinator.handle(event(qkey, { action: 'choice', decidedBy: 'deadline' }));
      const failed = expect(first).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      await failed;
      await expect(coordinator.handle(event(qkey, choice))).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(2_500);
    });

    it("still says Sending to a person's second click on their own slow answer", async () => {
      vi.useFakeTimers();
      const { coordinator } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => ({ code: 0, delayMs: 3_000 })),
        answerWaitMs: 1_000,
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      const first = coordinator.handle(event(qkey, choice));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await first).toEqual({ keepOpen: true, message: SENDING_TEXT });
      expect(await coordinator.handle(event(qkey, choice))).toEqual({
        keepOpen: true,
        message: SENDING_TEXT,
      });
      await vi.advanceTimersByTimeAsync(2_500);
    });

    it("fails a deadline call while a person's slow answer is running", async () => {
      vi.useFakeTimers();
      const { coordinator } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => ({ code: 0, delayMs: 3_000 })),
        answerWaitMs: 1_000,
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      const first = coordinator.handle(event(qkey, choice));
      await vi.advanceTimersByTimeAsync(1_000);
      await first;
      await expect(
        coordinator.handle(event(qkey, { action: 'choice', decidedBy: 'deadline' }))
      ).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(2_500);
    });

    it('credits a slow pick that stood to the deadline', async () => {
      vi.useFakeTimers();
      const { coordinator, inbox } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => ({ code: 0, delayMs: 3_000 })),
        answerWaitMs: 1_000,
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      const first = coordinator.handle(
        event(qkey, { action: 'choice', decidedBy: 'deadline', pendingActionId: null })
      );
      const failed = expect(first).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      await failed;
      await vi.advanceTimersByTimeAsync(2_500);
      expect(inbox?.resolved.at(-1)).toEqual({
        key: qkey,
        opts: { outcome: 'answered', by: { kind: 'deadline' } },
      });
    });

    it('clears a row at a deadline without calling it answered when nobody answered', async () => {
      const { coordinator, inbox } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => refusal('not-waiting', 'DOR-2401 was not found')),
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      expect(
        await coordinator.handle(event(qkey, { action: 'choice', decidedBy: 'deadline' }))
      ).toEqual({ settled: true });
      expect(inbox?.resolved.at(-1)).toEqual({ key: qkey, opts: { outcome: 'cleared' } });
    });

    it("clears a person's row when the item stopped waiting, saying it wasn't recorded", async () => {
      const { coordinator, inbox } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => refusal('not-waiting', 'DOR-2401 was not found')),
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      expect(await coordinator.handle(event(qkey, choice))).toEqual({
        keepOpen: true,
        message: SETTLED_TEXT,
      });
      expect(inbox?.resolved.at(-1)).toEqual({ key: qkey, opts: { outcome: 'cleared' } });
    });

    it("keeps a retry row: 'settled' clears only a question", async () => {
      const retry = {
        identifier: 'DOR-2410',
        status: 'running',
        drain: { v: 1, phase: 'parked', parkedReason: CHECKS_FAILED_REASON, parkedAt: 'p1' },
      };
      const { coordinator, inbox } = setup({
        stops: { retry: 'ask' },
        cli: fakeCli(() => refusal('settled', 'already answered')),
      });
      await coordinator.sync([plan({ a: retry })]);
      expect(await coordinator.handle(event('retry:3f2a00000000:DOR-2410'))).toEqual({
        keepOpen: true,
        message: SEND_FAILED_TEXT,
      });
      expect(inbox?.resolved).toEqual([]);
    });

    it('says on the row that a slow answer was refused for another reason', async () => {
      vi.useFakeTimers();
      const { coordinator, inbox } = setup({
        stops: { questions: 'tell' },
        cli: fakeCli(() => ({ ...refusal(), delayMs: 3_000 })),
        answerWaitMs: 1_000,
      });
      await coordinator.sync([plan({ a: questionRun() })]);
      const raised = inbox?.raised.length ?? 0;
      const answer = coordinator.handle(event(qkey, choice));
      await vi.advanceTimersByTimeAsync(1_000);
      await answer;
      await vi.advanceTimersByTimeAsync(2_500);
      expect(inbox?.raised.length).toBe(raised + 1);
    });
  });

  // DOR-3775, from the click to the row through the real `flow answer`, with the
  // real store's lock held as another flow command holds it.
  describe('a held lock, through the real verb', () => {
    let project: WriteProject;
    const lockFile = () => path.join(project.dir, '.dork', 'flow', 'flow-state.json.lock');
    const hold = () =>
      writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const release = () => rmSync(lockFile(), { force: true });
    const ASKED = '2026-09-28T09:00:00.000Z';
    const question = {
      text: 'Should the old API keep working?',
      choices: [
        { id: 'c1', label: 'Keep it' },
        { id: 'c2', label: 'Remove it' },
      ],
      pick: 'c1',
      why: "It's changing how sessions load.",
      askedAt: ASKED,
      decideBy: '2026-09-28T17:00:00.000Z',
      floor: [] as string[],
      answeredBy: 'person',
      checkAfter: null,
    };
    let tracker: FakeTracker;

    /** A runner that gives flow's real `main` what `verb()` gives the real process. */
    function realVerb(): ExecFileLike {
      return (_file, args, opts, callback) => {
        const stdout: string[] = [];
        let write: (text: string) => void = () => undefined;
        const words = new Promise<string>((resolve) => {
          write = resolve;
        });
        const running = main(args.slice(2), {
          env: opts.env as Record<string, string>,
          cwd: opts.cwd as string,
          now: () => new Date('2026-09-28T18:00:00.000Z'),
          stdout: { write: (chunk: string) => stdout.push(chunk) },
          stderr: { write: () => undefined },
          createAdapter: async () => tracker.adapter,
          // The gate's read of the process list: never this test's real chain.
          runProcess: async (cmd, rest, runOpts) =>
            cmd === '/bin/ps'
              ? { code: 1, stdout: '', stderr: '' }
              : realProcessRunner(cmd, rest, runOpts),
          io: { sleep: async () => undefined, stdin: { isTTY: false, read: () => words } },
        });
        void running.then((code) => {
          const out = stdout.join('');
          if (code === 0) callback(null, out, '');
          else callback(Object.assign(new Error('exit'), { code }), out, '');
        });
        return {
          once: (_event: string, listener: () => void) => queueMicrotask(listener),
          stdin: { on: () => undefined, end: (text?: string) => write(text ?? '') },
        };
      };
    }

    const comments = () => tracker.writes.filter((call) => call.method === 'comment');
    const key = () => 'question:b1b1b1b1b1b1:FAKE-1';
    const realSetup = async (answerWaitMs: number) => {
      const made = setup({
        stops: { questions: 'tell' },
        cli: { calls: [], execFile: realVerb() },
        answerWaitMs,
      });
      await made.coordinator.sync([
        plan(
          {
            'id-FAKE-1': {
              identifier: 'FAKE-1',
              title: 'Old API',
              status: 'running',
              stage: 'execute',
              question,
            },
          },
          { root: project.dir }
        ),
      ]);
      return made;
    };

    beforeEach(() => {
      project = makeProject();
      tracker = new FakeTracker({
        user: AGENT_USER,
        items: [
          item('FAKE-1', {
            stateCategory: 'started',
            labels: ['type/task', 'agent/claimed', 'agent/needs-input'],
            agentDisposition: 'needs-input',
          }),
        ],
      });
      project.writeRuns({
        'id-FAKE-1': {
          issueId: 'id-FAKE-1',
          identifier: 'FAKE-1',
          sessionId: 'session-1',
          worktreePath: project.dir,
          branch: 'work',
          stage: 'execute',
          status: 'running',
          attemptCount: 0,
          workerPid: 1,
          startedAt: '2026-09-28T08:00:00.000Z',
          question,
        },
      });
    });

    afterEach(() => {
      release();
      project.cleanup();
    });

    it('keeps the row and its deadline, records nothing, and the retry records it', async () => {
      const { coordinator, inbox } = await realSetup(10_000);
      hold();
      await expect(
        coordinator.handle(event(key(), { action: 'choice', choiceId: 'c2' }))
      ).rejects.toThrow(key());
      expect(inbox?.resolved).toEqual([]);
      expect(inbox?.open.has(key())).toBe(true);
      expect(project.runs()['id-FAKE-1'].question?.answer).toBeUndefined();
      expect(comments()).toEqual([]);

      release();
      const retry = await coordinator.handle(event(key(), { action: 'choice', choiceId: 'c2' }));
      expect(retry).toMatchObject({ resolve: 'answered' });
      expect(project.runs()['id-FAKE-1'].question?.answer).toMatchObject({
        text: 'Remove it',
        by: 'person',
      });
      expect(comments()).toHaveLength(1);
    });

    it('keeps the row past the wait too, when "Sending…" was already shown', async () => {
      const { coordinator, inbox } = await realSetup(50);
      hold();
      const raised = inbox?.raised.length ?? 0;
      expect(await coordinator.handle(event(key(), { action: 'choice', choiceId: 'c2' }))).toEqual({
        keepOpen: true,
        message: SENDING_TEXT,
      });
      await vi.waitFor(() => expect(inbox?.raised.length).toBe(raised + 1), { timeout: 8_000 });
      expect(inbox?.resolved).toEqual([]);
      expect(inbox?.open.has(key())).toBe(true);
      expect(project.runs()['id-FAKE-1'].question?.answer).toBeUndefined();
    });

    // Core tries again only after a call that failed: a kept-open row never
    // fires its deadline again, and this lock is about to free.
    it('fails the deadline call so core tries again, and the retry takes the pick', async () => {
      const { coordinator, inbox } = await realSetup(10_000);
      const deadline = event(key(), { action: 'choice', decidedBy: 'deadline' });
      hold();
      await expect(coordinator.handle(deadline)).rejects.toThrow();
      expect(inbox?.resolved).toEqual([]);
      expect(inbox?.open.has(key())).toBe(true);
      expect(project.runs()['id-FAKE-1'].question?.answer).toBeUndefined();

      release();
      expect(await coordinator.handle(deadline)).toMatchObject({ resolve: 'answered' });
      expect(project.runs()['id-FAKE-1'].question?.answer?.by).toBe('agent-default');
    });

    it('still clears the row when someone really did answer first', async () => {
      const { coordinator, inbox } = await realSetup(10_000);
      project.writeRuns({
        'id-FAKE-1': {
          ...project.runs()['id-FAKE-1'],
          question: { ...question, answer: { text: 'Keep it', at: ASKED, by: 'person' } },
        },
      });
      expect(await coordinator.handle(event(key(), { action: 'choice', choiceId: 'c2' }))).toEqual({
        keepOpen: true,
        message: SETTLED_TEXT,
      });
      expect(inbox?.resolved.at(-1)).toEqual({ key: key(), opts: { outcome: 'cleared' } });
      expect(comments()).toEqual([]);
    });
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

  it('tells the person once when flow dropped their answer, whatever the stops, and never old history', async () => {
    const line = (ts: string, item: string) => ({ v: 1, ts, kind: 'answer.dropped', item });
    const old = line('2026-09-27T00:00:00.000Z', 'DOR-1');
    const root = projectWithJournal([old]);
    const { coordinator, inbox } = setup({ stops: { ship: 'ask' } });
    const store = { a: { identifier: 'DOR-9', title: 'New sidebar', status: 'running' } };
    await coordinator.sync([plan(store, { root })]);
    expect(inbox?.recorded).toEqual([]);
    writeFileSync(
      path.join(root, '.dork', 'flow', 'journal.jsonl'),
      [
        old,
        line('2026-09-28T11:00:00.000Z', 'DOR-9'),
        { ...line('2026-09-28T11:01:00.000Z', 'x'), item: undefined },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    );
    await coordinator.sync([plan(store, { root })]);
    await coordinator.sync([plan(store, { root })]);
    expect(inbox?.recorded).toEqual([
      expect.objectContaining({
        title: "Your answer on New sidebar wasn't used",
        by: { kind: 'rule', label: 'Flow' },
        choiceLabel: 'Not used',
        detail: 'DOR-9',
        tell: true,
        outcome: 'answered',
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

describe('the review round (adversarial fixes)', () => {
  const key = 'review:3f2a00000000:DOR-2387';
  const moved = () =>
    gateRun({ drain: { ...gateRun().drain, reviewedSha: 'fff9999aaa', pushedSha: 'fff9999aaa' } });

  it('ships only the commit the row showed: a newer head that could not be raised is refused', async () => {
    const storage = { value: null as unknown };
    const inbox = fakeInbox();
    const first = setup({ inbox, storage });
    await first.coordinator.sync([plan({ a: gateRun() })]);
    // New commits land, and the inbox is full: core's row still shows abc1234.
    inbox.refuseWith(() =>
      Object.assign(new Error('full'), { code: 'inbox_limit', limit: 'open' })
    );
    await first.coordinator.sync([plan({ a: moved() })]);
    expect(await first.coordinator.handle(event(key))).toEqual({
      keepOpen: true,
      message: CHANGED_TEXT,
    });
    expect(first.cli.calls).toEqual([]);
    // After a restart, the same: flow remembers what the row showed.
    const second = setup({ inbox, storage });
    const started = second.coordinator.start();
    await second.coordinator.sync([plan({ a: moved() })]);
    await started;
    expect(await second.coordinator.handle(event(key))).toEqual({
      keepOpen: true,
      message: CHANGED_TEXT,
    });
    expect(second.cli.calls).toEqual([]);
    // Once the row shows the new commit, 👍 ships exactly that one.
    inbox.refuseWith(null);
    await second.coordinator.sync([plan({ a: moved() })]);
    await second.coordinator.handle(event(key));
    expect(second.cli.calls[0].args).toContain('fff9999aaa');
  });

  it('still updates rows already open when the inbox is full, and adds no new ones', async () => {
    const inbox = fakeInbox();
    const { coordinator } = setup({ inbox, stops: { questions: 'ask' } });
    await coordinator.sync([plan({ b: questionRun({ decideBy: null }) })]);
    // Full: nothing new may open, but the open row may change its words.
    inbox.refuseWith((input) =>
      inbox.open.has(input.key)
        ? null
        : Object.assign(new Error('full'), { code: 'inbox_limit', limit: 'open' })
    );
    // A new review gate (raised first, refused) and the open question, reworded.
    await coordinator.sync([
      plan({
        a: gateRun(),
        b: questionRun({ decideBy: null, text: 'Should the old API keep working for now?' }),
      }),
    ]);
    expect(inbox.raised.map((r) => r.title)).toEqual([
      'Should the old API keep working?',
      'Should the old API keep working for now?',
    ]);
  });

  it('ships nothing from a row whose commit flow never recorded', async () => {
    const storage = { value: null as unknown };
    const first = setup({ storage });
    await first.coordinator.sync([plan({ a: gateRun() })]);
    const raised = (storage.value as Record<string, Record<string, Record<string, unknown>>>)
      .inboxRaised;
    delete raised[key].head;
    // Read fresh, as after a restart: the row's words match, but its commit is unknown.
    const second = setup({ storage });
    await second.coordinator.sync([plan({ a: gateRun() })]);
    expect(await second.coordinator.handle(event(key))).toEqual({
      keepOpen: true,
      message: CHANGED_TEXT,
    });
    expect(second.cli.calls).toEqual([]);
  });

  it('takes no answer before its first pass, so none is lost as "already settled"', async () => {
    const inbox = fakeInbox();
    const { coordinator } = setup({ inbox, stops: { questions: 'tell' } });
    const started = coordinator.start();
    await Promise.resolve();
    expect(inbox.inbox.onAction).not.toHaveBeenCalled();
    await coordinator.sync([plan({ a: questionRun() })]);
    await started;
    expect(inbox.inbox.onAction).toHaveBeenCalledTimes(1);
    const overdue = await (inbox.handler() as (e: DecisionActionEvent) => Promise<unknown>)(
      event('question:3f2a00000000:DOR-2401', {
        action: 'choice',
        decidedBy: 'deadline',
        pendingActionId: null,
      })
    );
    expect(overdue).toEqual({ resolve: 'answered' });
  });

  it('offers nothing after a floor question, and a spend is never handed over', async () => {
    const floor = setup({ stops: { questions: 'ask' } });
    await floor.coordinator.sync([
      plan({ a: questionRun({ floor: ['outward-facing'], decideBy: null }) }),
    ]);
    expect(
      await floor.coordinator.handle(
        event('question:3f2a00000000:DOR-2401', { action: 'choice', choiceId: 'c1' })
      )
    ).toEqual({ resolve: 'answered' });
    const plain = setup({ stops: { questions: 'ask' } });
    await plain.coordinator.sync([plan({ a: questionRun({ decideBy: null }) })]);
    expect(
      await plain.coordinator.handle(
        event('question:3f2a00000000:DOR-2401', { action: 'choice', choiceId: 'c1' })
      )
    ).toHaveProperty('offer');
  });

  it('sends a floor question answered on flow’s page to the Inbox', async () => {
    const { coordinator, cli } = setup();
    await coordinator.sync([
      plan({ a: questionRun({ floor: ['outward-facing'], decideBy: null }) }),
    ]);
    expect(
      await coordinator.handle(
        event('question:3f2a00000000:DOR-2401', {
          action: 'choice',
          choiceId: 'c1',
          pendingActionId: null,
        })
      )
    ).toEqual({ keepOpen: true, message: ANSWER_IN_INBOX_TEXT });
    expect(cli.calls).toEqual([]);
  });

  it('answers on flow’s own route only the ask the page showed', async () => {
    const { coordinator, cli } = setup({ inbox: null, stops: { retry: 'ask' } });
    const run = {
      identifier: 'DOR-2410',
      status: 'running',
      drain: { v: 1, phase: 'parked', parkedReason: CHECKS_FAILED_REASON, parkedAt: 'p1' },
    };
    await coordinator.sync([plan({ a: run })]);
    const [shown] = coordinator.decisions();
    const rkey = 'retry:3f2a00000000:DOR-2410';
    expect(await coordinator.handle(event(rkey), 'local', 'something else')).toEqual({
      keepOpen: true,
      message: CHANGED_TEXT,
    });
    expect(cli.calls).toEqual([]);
    expect(await coordinator.handle(event(rkey), 'local', shown.shown)).toMatchObject({
      resolve: 'approved',
    });
  });

  it('holds a row open while a slow answer is sent, even if the ask goes meanwhile', async () => {
    vi.useFakeTimers();
    const { coordinator, inbox } = setup({
      cli: fakeCli(() => ({ code: 0, delayMs: 3_000 })),
      answerWaitMs: 1_000,
    });
    await coordinator.sync([plan({ a: gateRun() })]);
    const answer = coordinator.handle(event(key));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await answer).toEqual({ keepOpen: true, message: SENDING_TEXT });
    // The run leaves the gate before the command finishes: not "resolved on its own".
    await coordinator.sync([plan({})]);
    expect(inbox?.resolved).toEqual([]);
    // A second click meanwhile runs nothing twice.
    expect(await coordinator.handle(event(key))).toMatchObject({ keepOpen: true });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(inbox?.resolved.at(-1)).toMatchObject({
      key,
      opts: { outcome: 'approved', answering: 'pending-1' },
    });
  });

  it('says a failed slow answer on the row, keeps what it was about, and can be answered again', async () => {
    vi.useFakeTimers();
    let code = 4;
    const { coordinator, inbox, cli } = setup({
      cli: fakeCli(() => ({ code, delayMs: 3_000 })),
      answerWaitMs: 1_000,
    });
    await coordinator.sync([plan({ a: gateRun() })]);
    const answer = coordinator.handle(event(key));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await answer).toEqual({ keepOpen: true, message: SENDING_TEXT });
    const failed = inbox?.raised.at(-1);
    expect(failed?.detail).toBe(
      `${DID_NOT_GO_THROUGH} · DOR-2387 · PR #12 · at abc1234`.replace('#12', '#2303')
    );
    code = 0;
    const again = coordinator.handle(event(key));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await again).toEqual({ keepOpen: true, message: SENDING_TEXT });
    expect(cli.calls).toHaveLength(2);
    // The next pass puts the row's own words back.
    await coordinator.sync([plan({ a: gateRun() })]);
  });
});
