/**
 * flow's asks in DorkOS's inbox (spec `flow-multiproject` §7): what to raise,
 * when to settle it, and what a person's answer does.
 *
 * **What is raised** (§7.1, §7.3), each only when only a person can help or
 * the project's dial says to ask:
 *
 * - a review gate, when a run waits at review, will not merge by itself, and
 *   "Ship finished work" is at Ask me first;
 * - an agent's question, from the run's `question` block (or a drain run
 *   parked for a person, from an older engine); a question on the floor is not
 *   raised at Just do it (the reviewer agent checks it), except a spend, which
 *   always waits for a person;
 * - "Try fixing the failing checks?", when "Retry and fix problems" is at Ask
 *   me first and the drain parked a run on red checks;
 * - "Sign in to Linear again", at once, when the sign-in is really gone;
 * - "12 new ideas haven't been sorted", at Ask me first after a day idle.
 *
 * **Keys and limits** (§7.2): one key per project and condition (per item for
 * an item's ask), so a flapping condition updates one row. Asks are raised in
 * priority order and only when their words changed, so core's hourly limit is
 * spent on news. A limit that stops a raise stops the pass; what was not
 * raised still shows in the model and on flow's pages.
 *
 * **Settling** (§7.3, §7.4): an ask that is no longer true is resolved
 * `cleared` ("resolved on its own"), `cancelled` when its project is gone. An
 * answered ask is not raised again for the same thing (the same head, the same
 * question, the same park), and ideas answered with "Sort them" wait a day.
 *
 * **Answers** (§7.4): one handler for core's inbox, flow's pages (through
 * core's `answerDecision`) and, on a DorkOS without the inbox, flow's own
 * person-only route. A person's 👍 on a review gate runs `flow review
 * --approve --head <the commit the ask showed>`; 👎 sends the note with
 * `--changes`; a question's chip or reply runs `flow answer`; a deadline takes
 * the agent's pick for a question off the floor, and never settles one on it.
 * A command slower than core's bound answers "Sending…" and settles the row
 * when it finishes, crediting the person.
 *
 * @module @dorkos/flow/extension/decisions
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AutonomyKind, AutonomyStop } from '../../../../scripts/autonomy.ts';
import { JOURNAL_FILE, RUN_FILES_DIR } from '../../../../scripts/config-names.ts';
import { ACTIVE_RUN_STATUSES } from '../../../../scripts/fleet/sessions.ts';
import type { ExecError, ExecFileLike } from './advisor.ts';
import {
  ASK_AUTONOMY,
  ASK_PRIORITY,
  FIX_IT_ANSWER,
  MAX_NOTE,
  OFFER_TEXT,
  REVIEWER_AGENT,
  askProblem,
  ideasAsk,
  offerDoneText,
  questionAsk,
  retryAsk,
  retryRecord,
  reviewAsk,
  shipRecord,
  signInAsk,
  type Ask,
  type AskProject,
} from './asks.ts';
import { offerPatch, type AutonomyStore } from './autonomy-store.ts';
import type {
  DecisionActionEvent,
  DecisionActionResult,
  DecisionActor,
  DecisionOffer,
  DecisionOutcome,
  DecisionWatch,
  InboxApi,
  RecordedDecisionInput,
  SessionsApi,
} from './host-types.ts';
import type { FlowDecision, FlowProject } from './model.ts';
import type { SharedStorage } from './shared-storage.ts';
import { isStartRefusal, startRefusal, startWords, type StartKind } from './start-words.ts';
import type { TrackerRead } from './tracker-reads.ts';

/**
 * Why the drain parks a run on red checks at Ask me first. The drain's own
 * words (`PARK_REASONS.checksFailed` in `scripts/drain/drain-step.ts`);
 * `engine-tests/extension-asks.test.ts` keeps the two the same.
 */
export const CHECKS_FAILED_REASON =
  "the PR's checks failed, and this project's settings ask you before flow fixes failing checks";

/** How long an answer's command may run before the row says "Sending…", in ms (core allows 5 s). */
export const ANSWER_WAIT_MS = 4_000;

/** How long one command of flow's CLI may run at most, in ms. */
const VERB_TIMEOUT_MS = 180_000;

/** How long "Sort them" keeps the ideas ask quiet, in ms: if ideas still wait a day later, it asks again. */
export const SORT_QUIET_MS = 24 * 60 * 60_000;

/** How often the same offer may be made for one project and kind, in ms. */
export const OFFER_EVERY_MS = 30 * 24 * 60 * 60_000;

/** The behaviour level a project's flow needs to honour a dial (F0's engine). */
export const DIAL_BEHAVIOUR = 1;

/** flow's exit code for "someone got there first" (`EXIT.precondition`). */
const EXIT_PRECONDITION = 5;

/** What a failed answer says. */
export const SEND_FAILED_TEXT = "Flow couldn't send that. Try again.";

/** What the row says while a slow answer is sent. */
export const SENDING_TEXT = 'Sending…';

/** What a slow answer that failed leaves in the row's detail. */
export const DID_NOT_GO_THROUGH = "That didn't go through. Try again.";

/** The storage keys. */
const RAISED_KEY = 'inboxRaised';
const SETTLED_KEY = 'inboxSettled';
const OFFERS_KEY = 'inboxOffers';
const RECORDED_KEY = 'inboxRecorded';
const JOURNAL_SEEN_KEY = 'journalSeen';

/** How many recorded markers are kept. */
const RECORDED_KEPT = 500;

/** One project as the coordinator plans over it. */
export interface PlanProject {
  /** The built project (runs, conditions, pause, capacity). */
  project: FlowProject;
  /** Its raw run store. */
  store: Record<string, unknown>;
  /** Its last tracker read. */
  read: TrackerRead | null;
  /** Whether a reviewer agent checks this repo's work (`review.adversarial`). */
  reviewerAgent: boolean;
  /** Whether flow can post to its tracker from here (cli transport, an adapter it may run). */
  actionable: boolean;
  /** Ideas waiting, and whether the ideas ask is due. */
  ideas: { waiting: number | null; due: boolean; idleSince: string | null };
  /** The words every ask carries. */
  ask: AskProject;
}

/** What is kept for a raised ask. */
interface RaisedMeta {
  fp: string;
  root: string;
  kind: Ask['kind'];
}

/** What a finished command came to. */
interface VerbResult {
  code: number | null;
  json: Record<string, unknown> | null;
}

/** What the coordinator needs. */
export interface DecisionDeps {
  /** Core's inbox, when the host has one. */
  inbox?: InboxApi;
  /** Starting work in a new chat, when the host has it. */
  sessions?: SessionsApi;
  /** The extension's storage. */
  storage: SharedStorage;
  /** This extension's flow folder. */
  flowRoot: string;
  /** The DorkOS home, for answers' temporary files. */
  dorkHome: string;
  /** Runs a command with no shell. */
  execFile: ExecFileLike;
  /** The clock. */
  now: () => Date;
  /** Where to log. */
  log: (message: string) => void;
  /** Each project's dial. */
  autonomy: AutonomyStore;
  /** Called when the asks changed, so the model is sent again. */
  onChange: () => void;
  /** Called after work was started, so its limits are counted. */
  onStarted?: (root: string) => void;
  /** How long an answer waits before "Sending…" (tests). */
  answerWaitMs?: number;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field, or `null`. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** An object field read leniently. */
function obj(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

/** The drain phases in which a drain run's work waits at the review gate. */
const GATE_PHASES = new Set(['pr-ready', 'watching']);

/**
 * Whether a run waits at the review gate and will not merge by itself.
 *
 * @param run - The run as stored.
 * @returns True at the gate, unarmed.
 */
export function waitsAtGate(run: Record<string, unknown>): boolean {
  if (typeof run.status !== 'string' || !ACTIVE_RUN_STATUSES.has(run.status)) return false;
  const drain = isObject(run.drain) ? run.drain : null;
  const atGate = run.stage === 'review' || (drain !== null && GATE_PHASES.has(String(drain.phase)));
  if (!atGate) return false;
  if (isObject(run.question) && run.question.answer === undefined) return false;
  return !(drain !== null && isObject(drain.pr) && drain.pr.armed === true);
}

/** The commit a review gate shows: the reviewed one, else none. */
function gateHead(run: Record<string, unknown>): string | null {
  const drain = obj(run.drain);
  const review = obj(run.review);
  return text(drain.reviewedSha) ?? (review.verdict === 'clean' ? text(review.reviewedSha) : null);
}

/** How the reviewer agent's last verdict came out, and after how many rounds. */
function reviewFacts(
  run: Record<string, unknown>
): { verdict: 'clean' | 'changes' | null; rounds: number } | null {
  const drain = obj(run.drain);
  if (drain.verdict === 'clean' || drain.verdict === 'changes') {
    return {
      verdict: drain.verdict,
      rounds: typeof drain.reviewRound === 'number' ? drain.reviewRound : 1,
    };
  }
  const review = obj(run.review);
  if (review.verdict === 'clean' || review.verdict === 'changes') {
    return { verdict: review.verdict, rounds: 1 };
  }
  return null;
}

/** A run's open question, read leniently, or `null`. */
function openQuestion(run: Record<string, unknown>) {
  const q = run.question;
  if (!isObject(q) || q.answer !== undefined) return null;
  const choices = Array.isArray(q.choices)
    ? q.choices.flatMap((choice) =>
        isObject(choice) && typeof choice.id === 'string' && typeof choice.label === 'string'
          ? [{ id: choice.id, label: choice.label }]
          : []
      )
    : [];
  if (typeof q.text !== 'string' || choices.length < 2 || typeof q.pick !== 'string') return null;
  return {
    text: q.text,
    choices,
    pick: q.pick,
    why: typeof q.why === 'string' ? q.why : '',
    askedAt: typeof q.askedAt === 'string' ? q.askedAt : '',
    decideBy: text(q.decideBy),
    floor: Array.isArray(q.floor) ? q.floor.filter((t): t is string => typeof t === 'string') : [],
  };
}

/** The deadline in words, as the server's clock reads it ("5:00 PM"). */
function when(iso: string): string {
  const at = new Date(iso);
  return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Every ask one project needs now, before answered ones are left out.
 *
 * @param input - The project and how its dial reads.
 * @returns The asks, most urgent first.
 */
export function planProject(input: {
  plan: PlanProject;
  stop: (kind: AutonomyKind) => AutonomyStop;
  startable: boolean;
}): Ask[] {
  const { plan, stop } = input;
  const asks: Ask[] = [];
  if (plan.project.setup !== 'ready') return asks;
  for (const run of Object.values(plan.store)) {
    if (!isObject(run) || typeof run.identifier !== 'string') continue;
    if (typeof run.status !== 'string' || !ACTIVE_RUN_STATUSES.has(run.status)) continue;
    const identifier = run.identifier;
    const title = text(run.title);
    const drain = obj(run.drain);
    if (waitsAtGate(run) && stop('ship') === 'ask') {
      asks.push(
        reviewAsk(plan.ask, {
          identifier,
          title,
          head: gateHead(run),
          pr: isObject(drain.pr) && typeof drain.pr.number === 'number' ? drain.pr.number : null,
          review: reviewFacts(run),
          checks: null,
          actionable: plan.actionable,
        })
      );
      continue;
    }
    const question = openQuestion(run);
    if (question !== null) {
      const questionsStop = stop('questions');
      const personOnly = question.floor.includes('secrets-or-spend');
      // At Just do it a floor question goes to the reviewer agent at once;
      // only a spend still waits for a person.
      if (questionsStop === 'auto' && !personOnly) continue;
      asks.push(
        questionAsk(plan.ask, {
          identifier,
          title,
          question,
          stop: questionsStop,
          parkedAt: text(drain.parkedAt),
          actionable: plan.actionable,
          when,
        })
      );
      continue;
    }
    if (drain.phase === 'parked' && drain.parkedFor === 'person' && !isObject(run.question)) {
      asks.push(
        questionAsk(plan.ask, {
          identifier,
          title,
          question: null,
          stop: stop('questions'),
          parkedAt: text(drain.parkedAt),
          actionable: plan.actionable,
          when,
        })
      );
      continue;
    }
    if (
      drain.phase === 'parked' &&
      drain.parkedReason === CHECKS_FAILED_REASON &&
      stop('retry') === 'ask'
    ) {
      asks.push(
        retryAsk(plan.ask, {
          identifier,
          title,
          parkedAt: text(drain.parkedAt),
          actionable: plan.actionable,
        })
      );
    }
  }
  const failure = plan.read?.failure;
  if (failure?.kind === 'auth') asks.push(signInAsk(plan.ask, failure.since, input.startable));
  if (plan.ideas.due && plan.ideas.waiting !== null && plan.ideas.idleSince !== null) {
    asks.push(ideasAsk(plan.ask, plan.ideas.waiting, plan.ideas.idleSince, input.startable));
  }
  return asks;
}

/** The kind of ask a key names (§7.2), for rows found open after a restart. */
function kindOfKey(key: string): Ask['kind'] {
  const prefix = key.split(':')[0];
  if (prefix === 'question') return 'question';
  if (prefix === 'retry') return 'retry';
  if (prefix === 'tracker') return 'sign-in';
  if (prefix === 'idle') return 'ideas';
  return 'review';
}

/** An ask as the model shows it. */
function toFlowDecision(ask: Ask, raisedAt: string): FlowDecision {
  const actions = ask.input.actions;
  return {
    key: ask.key,
    project: ask.project.name,
    kind: ask.kind,
    title: ask.input.title,
    why: ask.input.why,
    detail: ask.input.detail ?? null,
    identifier: ask.identifier,
    raisedAt,
    actions,
    answerIn: ask.answerIn,
    defaultChoice: actions.kind === 'choice' ? (actions.defaultChoice ?? null) : null,
    decideBy: actions.kind === 'choice' ? (actions.decideBy ?? null) : null,
  };
}

/** Plans, raises, settles and answers flow's asks. */
export class DecisionCoordinator {
  private asks: Ask[] = [];
  private readonly firstSeen = new Map<string, string>();
  private plans = new Map<string, PlanProject>();
  private readonly loggedLimits = new Set<string>();
  private stopHandler: () => void = () => {};
  private started = false;

  /**
   * @param deps - The host, storage, command runner, clock and dial.
   */
  constructor(private readonly deps: DecisionDeps) {}

  /** Whether DorkOS has an inbox flow raises in. */
  get hasInbox(): boolean {
    return this.deps.inbox !== undefined;
  }

  /** Whether DorkOS can start work in a new chat. */
  get canStart(): boolean {
    return typeof this.deps.sessions?.start === 'function';
  }

  /**
   * Register the answer handler, and take over what is open in the inbox from
   * before a restart.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const inbox = this.deps.inbox;
    if (inbox === undefined) return;
    this.stopHandler = inbox.onAction((event) => this.handle(event));
    try {
      const open = await inbox.list();
      await this.deps.storage.update(RAISED_KEY, (current) => {
        const raised = obj(current) as Record<string, RaisedMeta>;
        for (const decision of open) {
          raised[decision.key] ??= {
            fp: '',
            root: decision.project?.root ?? '',
            kind: kindOfKey(decision.key),
          };
        }
        return raised;
      });
    } catch (error) {
      this.deps.log(`[flow] could not read flow's open asks from DorkOS: ${String(error)}`);
    }
  }

  /** Stop answering. */
  dispose(): void {
    this.stopHandler();
  }

  /**
   * The open asks, for the model.
   *
   * @returns Every ask flow has now, oldest first.
   */
  decisions(): FlowDecision[] {
    return this.asks.map((ask) => toFlowDecision(ask, this.firstSeen.get(ask.key) ?? ''));
  }

  /**
   * The keys of the asks that are open now.
   *
   * @returns The keys.
   */
  keys(): Set<string> {
    return new Set(this.asks.map((ask) => ask.key));
  }

  /**
   * One pass: work out the asks, leave out the answered ones, raise what is
   * new or changed, and settle what is no longer true.
   *
   * @param plans - Every flow project.
   */
  async sync(plans: readonly PlanProject[]): Promise<void> {
    const now = this.deps.now();
    this.plans = new Map(plans.map((plan) => [plan.project.root, plan]));
    const settled = obj(await this.deps.storage.get(SETTLED_KEY));
    const planned: Ask[] = [];
    const all: Ask[] = [];
    for (const plan of plans) {
      const stop = (kind: AutonomyKind) =>
        this.deps.autonomy.stop(plan.project.root, kind, plan.reviewerAgent);
      all.push(...planProject({ plan, stop, startable: this.canStart }));
    }
    // An answered ask is kept quiet only while it is still true.
    const live = new Set(all.map((ask) => ask.key));
    if (Object.keys(settled).some((key) => !live.has(key))) {
      await this.deps.storage.update(SETTLED_KEY, (current) =>
        Object.fromEntries(Object.entries(obj(current)).filter(([key]) => live.has(key)))
      );
    }
    for (const ask of all) {
      const quiet = obj(settled[ask.key]);
      const until = typeof quiet.until === 'string' ? Date.parse(quiet.until) : Number.NaN;
      if (quiet.marker === ask.marker && (!Number.isFinite(until) || now.getTime() < until)) {
        continue;
      }
      const problem = askProblem(ask.input);
      if (problem !== null) {
        this.logOnce(`words:${ask.key}`, `[flow] not raising ${ask.key}: ${problem}`);
        continue;
      }
      planned.push(ask);
    }
    for (const ask of planned) {
      if (!this.firstSeen.has(ask.key)) this.firstSeen.set(ask.key, now.toISOString());
    }
    planned.sort(
      (a, b) =>
        ASK_PRIORITY[a.kind] - ASK_PRIORITY[b.kind] ||
        (this.firstSeen.get(a.key) ?? '').localeCompare(this.firstSeen.get(b.key) ?? '')
    );
    const before = JSON.stringify(this.asks.map((ask) => ask.input));
    this.asks = planned;
    const wanted = new Set(planned.map((ask) => ask.key));
    for (const key of [...this.firstSeen.keys()]) if (!wanted.has(key)) this.firstSeen.delete(key);
    if (this.deps.inbox !== undefined) {
      await this.raiseAll(this.deps.inbox, planned);
      await this.settleGone(this.deps.inbox, wanted, plans);
      await this.recordAway(this.deps.inbox, plans);
    }
    if (JSON.stringify(planned.map((ask) => ask.input)) !== before) this.deps.onChange();
  }

  /** Log a message once per key. */
  private logOnce(key: string, message: string): void {
    if (this.loggedLimits.has(key)) return;
    this.loggedLimits.add(key);
    this.deps.log(message);
  }

  /** Raise every ask whose words changed, most urgent first, until a limit stops the pass. */
  private async raiseAll(inbox: InboxApi, asks: readonly Ask[]): Promise<void> {
    const raised = obj(await this.deps.storage.get(RAISED_KEY)) as Record<string, RaisedMeta>;
    const fresh: Record<string, RaisedMeta> = {};
    for (const ask of asks) {
      const fp = JSON.stringify(ask.input);
      if (raised[ask.key]?.fp === fp) continue;
      try {
        await inbox.raise(ask.input);
        fresh[ask.key] = { fp, root: ask.project.root, kind: ask.kind };
      } catch (error) {
        const code = obj(error).code;
        const limit = obj(error).limit;
        if (code === 'inbox_limit' && (limit === 'open' || limit === 'rate')) {
          this.logOnce(
            `limit:${String(limit)}`,
            `[flow] DorkOS's inbox is full for flow (${String(limit)}); the rest show on flow's pages until something is answered`
          );
          break;
        }
        this.logOnce(`raise:${ask.key}`, `[flow] could not raise ${ask.key}: ${String(error)}`);
      }
    }
    if (Object.keys(fresh).length > 0) {
      await this.deps.storage.update(RAISED_KEY, (current) => ({ ...obj(current), ...fresh }));
    }
  }

  /** Settle every raised ask that is no longer true. */
  private async settleGone(
    inbox: InboxApi,
    wanted: ReadonlySet<string>,
    plans: readonly PlanProject[]
  ): Promise<void> {
    const raised = obj(await this.deps.storage.get(RAISED_KEY)) as Record<string, RaisedMeta>;
    const roots = new Set(plans.map((plan) => plan.project.root));
    const gone: string[] = [];
    for (const [key, meta] of Object.entries(raised)) {
      if (wanted.has(key)) continue;
      let outcome: DecisionOutcome = 'cleared';
      let by: DecisionActor | undefined;
      if (meta.root !== '' && !roots.has(meta.root)) outcome = 'cancelled';
      else if (meta.kind === 'question') {
        const answeredBy = this.answeredBy(key, meta.root);
        if (answeredBy === 'reviewer-agent') {
          outcome = 'answered';
          by = { kind: 'agent', label: REVIEWER_AGENT };
        } else if (answeredBy === 'agent-default') {
          outcome = 'answered';
          by = { kind: 'deadline' };
        }
      }
      try {
        // False when nothing was open (a person's answer already settled it).
        await inbox.resolve(key, by === undefined ? { outcome } : { outcome, by });
      } catch (error) {
        this.deps.log(`[flow] could not settle ${key}: ${String(error)}`);
        continue;
      }
      gone.push(key);
    }
    if (gone.length > 0) {
      await this.deps.storage.update(RAISED_KEY, (current) => {
        const next = { ...obj(current) };
        for (const key of gone) delete next[key];
        return next;
      });
    }
  }

  /** Who answered the question behind a key, from its run's record. */
  private answeredBy(key: string, root: string): string | null {
    const plan = this.plans.get(root);
    if (plan === undefined) return null;
    const suffix = key.split(':').slice(2).join(':');
    for (const run of Object.values(plan.store)) {
      if (!isObject(run) || typeof run.identifier !== 'string') continue;
      if (run.identifier.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) !== suffix) continue;
      const answer = obj(obj(run.question).answer);
      return typeof answer.by === 'string' ? answer.by : null;
    }
    return null;
  }

  /**
   * Leave "While you were away" rows (§7.10) for what flow settled without
   * asking: work the reviewer agent shipped, and failing checks flow went
   * back to fix. Each event is recorded once.
   */
  private async recordAway(inbox: InboxApi, plans: readonly PlanProject[]): Promise<void> {
    const recorded = obj(await this.deps.storage.get(RECORDED_KEY));
    const seen = obj(await this.deps.storage.get(JOURNAL_SEEN_KEY));
    const newMarkers: string[] = [];
    const newSeen: Record<string, string> = {};
    for (const plan of plans) {
      const root = plan.project.root;
      const titles = new Map<string, string | null>();
      for (const run of Object.values(plan.store)) {
        if (isObject(run) && typeof run.identifier === 'string') {
          titles.set(run.identifier, text(run.title));
        }
      }
      const shipStop = this.deps.autonomy.stop(root, 'ship', plan.reviewerAgent);
      const retryStop = this.deps.autonomy.stop(root, 'retry', plan.reviewerAgent);
      // Shipped by the reviewer agent: `review.approved` lines the journal gained.
      const since = typeof seen[root] === 'string' ? (seen[root] as string) : null;
      const { lines, last } = readJournalSince(root, since);
      if (last !== null) newSeen[root] = last;
      if (since !== null && shipStop !== 'ask') {
        for (const line of lines) {
          if (line.kind !== 'review.approved' || line.by !== 'reviewer-agent') continue;
          const identifier = text(line.item);
          if (identifier === null) continue;
          const marker = `ship:${root}:${identifier}:${String(line.ts)}`;
          if (recorded[marker] !== undefined) continue;
          await this.record(
            inbox,
            shipRecord(plan.ask, {
              identifier,
              title: titles.get(identifier) ?? null,
              stop: shipStop,
            }),
            marker,
            newMarkers
          );
        }
      }
      // Went back to fix failing checks on its own: a drain run in fixing-ci.
      // Only a dial a person chose (or the new-project default) fixes "on its
      // own"; without one, fixing checks is what flow always did, not news.
      const copy = this.deps.autonomy.of(root)?.copy;
      if (retryStop !== 'ask' && copy !== null && copy !== undefined) {
        for (const run of Object.values(plan.store)) {
          if (!isObject(run) || typeof run.identifier !== 'string') continue;
          const drain = obj(run.drain);
          if (drain.phase !== 'fixing-ci') continue;
          const marker = `fix:${root}:${run.identifier}:${String(drain.pushedSha ?? drain.rev ?? '')}`;
          if (recorded[marker] !== undefined) continue;
          await this.record(
            inbox,
            retryRecord(plan.ask, {
              identifier: run.identifier,
              title: text(run.title),
              stop: retryStop,
            }),
            marker,
            newMarkers
          );
        }
      }
    }
    if (newMarkers.length > 0) await this.remember(newMarkers);
    if (Object.keys(newSeen).length > 0) {
      await this.deps.storage.update(JOURNAL_SEEN_KEY, (current) => ({
        ...obj(current),
        ...newSeen,
      }));
    }
  }

  /** Write one history row; history is a courtesy, so a refusal is logged and passed over. */
  private async record(
    inbox: InboxApi,
    input: RecordedDecisionInput,
    marker: string,
    into: string[]
  ): Promise<void> {
    try {
      await inbox.record(input);
      into.push(marker);
    } catch (error) {
      const code = obj(error).code;
      if (code === 'inbox_limit') {
        into.push(marker);
        this.logOnce(`record:${marker}`, `[flow] DorkOS's inbox took no more history for now`);
        return;
      }
      this.logOnce(`record:${marker}`, `[flow] could not record ${input.key}: ${String(error)}`);
    }
  }

  /**
   * Remember recorded events, keeping the newest.
   *
   * @param markers - The events recorded now.
   */
  async remember(markers: readonly string[]): Promise<void> {
    const at = this.deps.now().toISOString();
    await this.deps.storage.update(RECORDED_KEY, (current) => {
      const next = { ...obj(current) };
      for (const marker of markers) next[marker] = at;
      const kept = Object.entries(next).slice(-RECORDED_KEPT);
      return Object.fromEntries(kept);
    });
  }

  /**
   * Record a "While you were away" row flow wrote about its own start (the
   * daily sort), once per marker.
   *
   * @param input - The record.
   * @param marker - What makes it one event.
   */
  async recordOnce(input: RecordedDecisionInput, marker: string): Promise<void> {
    const inbox = this.deps.inbox;
    if (inbox === undefined) return;
    const recorded = obj(await this.deps.storage.get(RECORDED_KEY));
    if (recorded[marker] !== undefined) return;
    const into: string[] = [];
    await this.record(inbox, input, marker, into);
    if (into.length > 0) await this.remember(into);
  }

  /** The ask behind a key now. */
  private askOf(key: string): Ask | null {
    return this.asks.find((ask) => ask.key === key) ?? null;
  }

  /**
   * Answer one decision: core's inbox calls this, and so does flow's own route
   * on a DorkOS without the inbox.
   *
   * @param event - What the person (or the deadline) chose.
   * @returns What the row should do.
   */
  async handle(event: DecisionActionEvent): Promise<DecisionActionResult> {
    const ask = this.askOf(event.key);
    if (event.action === 'offer') {
      const name = ask?.project.name ?? event.project?.name ?? 'this project';
      return { resolve: 'approved', message: offerDoneText(name) };
    }
    if (ask === null) {
      // No longer asked: the deadline, the tracker or another answer got there first.
      if (event.decidedBy === 'deadline') return { settled: true };
      await this.deps.inbox?.resolve(event.key, { outcome: 'cleared' }).catch(() => false);
      return { keepOpen: true, message: 'This was already settled.' };
    }
    switch (ask.kind) {
      case 'review':
        return this.answerReview(ask, event);
      case 'question':
        return this.answerQuestion(ask, event);
      case 'retry':
        return this.answerRetry(ask, event);
      case 'sign-in':
        return this.startFrom(ask, 'sign-in', event);
      case 'ideas':
        return this.startFrom(ask, 'sort', event);
    }
  }

  /** 👍 ships the commit the ask showed; 👎 sends it back with the note. */
  private async answerReview(ask: Ask, event: DecisionActionEvent): Promise<DecisionActionResult> {
    if (event.action === 'approve') {
      const args = ['review', ask.identifier ?? '', '--approve', '--by', 'person'];
      if (ask.head !== null) args.push('--head', ask.head);
      return this.runAnswer(ask, event, args, null, 'approved');
    }
    if (event.action === 'reject') {
      const note = (event.note ?? '').trim();
      if (note === '')
        return { keepOpen: true, message: 'Say what should change, then send it back.' };
      if (note.length > MAX_NOTE) {
        return { keepOpen: true, message: `Keep the note under ${MAX_NOTE} characters.` };
      }
      return this.runAnswer(
        ask,
        event,
        ['review', ask.identifier ?? '', '--changes', '--note-file'],
        note,
        'rejected'
      );
    }
    return { keepOpen: true, message: SEND_FAILED_TEXT };
  }

  /** A chip or a reply posts the answer; the deadline takes the agent's pick, never for a floor question. */
  private async answerQuestion(
    ask: Ask,
    event: DecisionActionEvent
  ): Promise<DecisionActionResult> {
    if (event.decidedBy === 'deadline') {
      const stop = this.stopFor(ask, 'questions');
      if (ask.floor || stop !== 'tell') return { keepOpen: true };
      return this.runAnswer(
        ask,
        event,
        ['answer', ask.identifier ?? '', '--pick', '--by', 'agent-default'],
        null,
        'answered'
      );
    }
    const chosen =
      event.choiceId === null
        ? null
        : (ask.choices.find((c) => c.id === event.choiceId)?.label ?? null);
    const answer = (event.text ?? chosen ?? '').trim();
    if (answer === '') return { keepOpen: true, message: 'Pick an answer, or write one.' };
    if (answer.length > MAX_NOTE) {
      return { keepOpen: true, message: `Keep the answer under ${MAX_NOTE} characters.` };
    }
    return this.runAnswer(
      ask,
      event,
      ['answer', ask.identifier ?? '', '--text-file'],
      answer,
      'answered'
    );
  }

  /** "Fix it" posts the go-ahead, so the drain goes back to fixing; "Leave it" leaves it parked. */
  private async answerRetry(ask: Ask, event: DecisionActionEvent): Promise<DecisionActionResult> {
    if (event.action === 'reject') {
      await this.settle(ask);
      return { resolve: 'rejected' };
    }
    return this.runAnswer(
      ask,
      event,
      ['answer', ask.identifier ?? '', '--text-file'],
      FIX_IT_ANSWER,
      'approved'
    );
  }

  /** The stop in force for an ask's kind. */
  private stopFor(ask: Ask, kind: AutonomyKind): AutonomyStop {
    const plan = this.plans.get(ask.project.root);
    return this.deps.autonomy.stop(ask.project.root, kind, plan?.reviewerAgent ?? false);
  }

  /** Keep an answered ask from being raised again for the same thing. */
  private async settle(ask: Ask, quietMs?: number): Promise<void> {
    const entry: Record<string, string> = { marker: ask.marker };
    if (quietMs !== undefined) {
      entry.until = new Date(this.deps.now().getTime() + quietMs).toISOString();
    }
    await this.deps.storage.update(SETTLED_KEY, (current) => ({
      ...obj(current),
      [ask.key]: entry,
    }));
    await this.deps.storage.update(RAISED_KEY, (current) => {
      const next = { ...obj(current) };
      delete next[ask.key];
      return next;
    });
    this.asks = this.asks.filter((other) => other.key !== ask.key);
    this.deps.onChange();
  }

  /**
   * The one-time offer to do this kind on its own next time (§7.8): only for a
   * person's answer core credits to them, only at Ask me first, at most once a
   * month per project and kind, never where the project's flow could not keep
   * it, and for shipping only where a reviewer agent checks the work.
   */
  private async offerFor(ask: Ask, event: DecisionActionEvent): Promise<DecisionOffer | undefined> {
    const kind = ASK_AUTONOMY[ask.kind];
    if (kind === null || event.decidedBy !== 'person' || event.pendingActionId === null)
      return undefined;
    const plan = this.plans.get(ask.project.root);
    if (plan === undefined || !this.deps.autonomy.available) return undefined;
    if (this.stopFor(ask, kind) !== 'ask') return undefined;
    if (kind === 'ship' && !plan.reviewerAgent) return undefined;
    if (plan.project.version.behaviour < DIAL_BEHAVIOUR) return undefined;
    const slot = `${plan.ask.id}:${kind}`;
    const offers = obj(await this.deps.storage.get(OFFERS_KEY));
    const last = typeof offers[slot] === 'string' ? Date.parse(offers[slot] as string) : Number.NaN;
    const now = this.deps.now().getTime();
    if (Number.isFinite(last) && now - last < OFFER_EVERY_MS) return undefined;
    await this.deps.storage.update(OFFERS_KEY, (current) => ({
      ...obj(current),
      [slot]: new Date(now).toISOString(),
    }));
    return {
      text: OFFER_TEXT[kind],
      offerId: slot.slice(0, 64),
      settingsPatch: {
        project: ask.project.root,
        patch: offerPatch(this.deps.autonomy.of(ask.project.root)?.copy ?? null, kind),
      },
    };
  }

  /**
   * Run an answer's command within core's bound: done in time, the row
   * settles now; slower, the row says "Sending…" and settles when it finishes,
   * crediting the person who answered.
   */
  private async runAnswer(
    ask: Ask,
    event: DecisionActionEvent,
    args: string[],
    file: string | null,
    outcome: 'approved' | 'rejected' | 'answered'
  ): Promise<DecisionActionResult> {
    const run = this.verb(ask.project.root, args, file);
    // Without the inbox (flow's own route) nothing bounds the answer: wait for it.
    if (this.deps.inbox === undefined) return this.finish(ask, event, await run, outcome);
    const wait = this.deps.answerWaitMs ?? ANSWER_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), wait);
    });
    const first = await Promise.race([run, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (first !== 'slow') return this.finish(ask, event, first, outcome);
    void run.then(async (result) => {
      const answer = await this.finish(ask, event, result, outcome);
      const inbox = this.deps.inbox;
      if (inbox === undefined) return;
      try {
        if ('resolve' in answer) {
          await inbox.resolve(ask.key, {
            outcome: answer.resolve,
            ...(event.pendingActionId === null ? {} : { answering: event.pendingActionId }),
            ...(answer.offer === undefined || event.pendingActionId === null
              ? {}
              : { offer: answer.offer }),
          });
        } else if ('settled' in answer) {
          // Resolved by finish() already.
        } else if (answer.message === SEND_FAILED_TEXT) {
          await inbox.raise({ ...ask.input, detail: DID_NOT_GO_THROUGH });
        }
      } catch (error) {
        this.deps.log(`[flow] could not settle ${ask.key} after sending: ${String(error)}`);
      }
    });
    return { keepOpen: true, message: SENDING_TEXT };
  }

  /** What a finished command means for the row. */
  private async finish(
    ask: Ask,
    event: DecisionActionEvent,
    result: VerbResult,
    outcome: 'approved' | 'rejected' | 'answered'
  ): Promise<DecisionActionResult> {
    if (result.code === 0) {
      await this.settle(ask);
      if (event.decidedBy === 'deadline') return { resolve: outcome };
      const offer = outcome === 'rejected' ? undefined : await this.offerFor(ask, event);
      return offer === undefined ? { resolve: outcome } : { resolve: outcome, offer };
    }
    if (result.code === EXIT_PRECONDITION && ask.kind === 'question') {
      // Already settled: the engine's deadline pass or a tracker reply got there first.
      await this.settle(ask);
      if (event.decidedBy === 'deadline') {
        await this.deps.inbox
          ?.resolve(ask.key, { outcome: 'answered', by: { kind: 'deadline' } })
          .catch(() => false);
        return { settled: true };
      }
      await this.deps.inbox?.resolve(ask.key, { outcome: 'cleared' }).catch(() => false);
      return { keepOpen: true, message: 'This was already answered on the tracker.' };
    }
    if (result.code === EXIT_PRECONDITION && ask.kind === 'review') {
      const message = obj(result.json?.error).message;
      const said = typeof message === 'string' && message !== '' ? message : null;
      return {
        keepOpen: true,
        message: said === null ? SEND_FAILED_TEXT : `Flow didn't ship it: ${said}`,
      };
    }
    this.deps.log(`[flow] answering ${ask.key} failed (exit ${String(result.code)})`);
    return { keepOpen: true, message: SEND_FAILED_TEXT };
  }

  /**
   * Start the work a word button names in a new chat (§7.9): signing in keeps
   * the row open until the next read succeeds; sorting settles it.
   */
  private async startFrom(
    ask: Ask,
    kind: StartKind,
    event: DecisionActionEvent
  ): Promise<DecisionActionResult> {
    const plan = this.plans.get(ask.project.root);
    const words = startWords(kind, {
      name: ask.project.name,
      tracker: plan?.ask.tracker ?? null,
      count: kind === 'sort' ? (plan?.ideas.waiting ?? null) : null,
    });
    const sessions = this.deps.sessions;
    if (sessions === undefined || typeof sessions.start !== 'function') {
      return {
        keepOpen: true,
        message: `In a chat in ${ask.project.name}, type ${words.command}.`,
      };
    }
    let sessionId: string;
    try {
      ({ sessionId } = await sessions.start({
        project: ask.project.root,
        prompt: words.prompt,
        title: words.title,
        reason: words.reason,
      }));
    } catch (error) {
      if (isStartRefusal(error)) {
        return {
          keepOpen: true,
          message: startRefusal(error.code, error.message, ask.project.name),
        };
      }
      this.deps.log(`[flow] could not start ${kind} for ${ask.project.name}: ${String(error)}`);
      return { keepOpen: true, message: "Flow couldn't start that. Try again." };
    }
    this.deps.onStarted?.(ask.project.root);
    const watch: DecisionWatch = { sessionId, label: words.watch };
    if (kind === 'sign-in') return { keepOpen: true, watch };
    await this.settle(ask, SORT_QUIET_MS);
    const offer = await this.offerFor(ask, event);
    return offer === undefined
      ? { resolve: 'answered', watch }
      : { resolve: 'answered', watch, offer };
  }

  /**
   * Run one command of flow's CLI against a project, with an answer's text in
   * a temporary file (never on the command line), deleted after.
   */
  private verb(root: string, args: string[], file: string | null): Promise<VerbResult> {
    const script = path.join(this.deps.flowRoot, 'scripts', 'flow.ts');
    let temp: string | null = null;
    const full = [...args];
    if (file !== null) {
      const dir = path.join(this.deps.dorkHome, 'flow', 'tmp');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      temp = path.join(dir, `answer-${randomUUID()}.txt`);
      writeFileSync(temp, file, { mode: 0o600 });
      full.push(temp);
    }
    full.push('--json', '--project', root);
    return new Promise((resolve) => {
      this.deps.execFile(
        'node',
        ['--experimental-strip-types', script, ...full],
        { timeout: VERB_TIMEOUT_MS, shell: false, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        (error: ExecError | null, stdout: string) => {
          if (temp !== null) rmSync(temp, { force: true });
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(stdout.trim().split('\n').pop() ?? '');
            json = isObject(parsed) ? parsed : null;
          } catch {
            json = null;
          }
          if (error === null) resolve({ code: 0, json });
          else resolve({ code: typeof error.code === 'number' ? error.code : null, json });
        }
      );
    });
  }
}

/** One journal line, read leniently. */
type JournalLine = Record<string, unknown>;

/**
 * The journal lines written after `since`, and the newest line's time. With
 * `since` null only the newest time is found (the first look starts the
 * watermark, so old history is never recorded as new).
 *
 * @param root - The project's main checkout.
 * @param since - The last time already seen, or `null`.
 * @returns The new lines and the newest time.
 */
export function readJournalSince(
  root: string,
  since: string | null
): { lines: JournalLine[]; last: string | null } {
  const file = path.join(root, RUN_FILES_DIR, JOURNAL_FILE);
  let body: string;
  try {
    // A journal is rotated at a size limit, so reading the current file is bounded.
    if (statSync(file).size > 16 * 1024 * 1024) return { lines: [], last: null };
    body = readFileSync(file, 'utf8');
  } catch {
    return { lines: [], last: since === null ? new Date(0).toISOString() : null };
  }
  const lines: JournalLine[] = [];
  let last: string | null = null;
  for (const raw of body.split('\n')) {
    if (raw.trim() === '') continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(line) || typeof line.ts !== 'string') continue;
    if (last === null || line.ts > last) last = line.ts;
    if (since !== null && line.ts > since) lines.push(line);
  }
  return { lines, last: last ?? (since === null ? new Date(0).toISOString() : null) };
}
