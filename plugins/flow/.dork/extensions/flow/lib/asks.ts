/**
 * The words on every ask flow raises (spec `flow-multiproject` §7.3, V8), and
 * the "While you were away" rows it leaves when it settles something itself
 * (§7.10), and the one-time "Next time, on its own?" offers (§7.8).
 *
 * Three rules, checked by {@link askProblem} before anything is raised:
 *
 * 1. The headline says what will happen, as an outcome or a question. Never a
 *    command, a stage name or an item id: the id goes in `detail`.
 * 2. Every ask has a why line (1-300 characters): what happens, why now, what
 *    "no" means. A builder that cannot fill it raises nothing.
 * 3. Every ask a person can hand over has an offer to do it on its own next
 *    time. Signing in never does: only a person can sign in.
 *
 * Pure: no I/O and no clock (callers pass the facts).
 *
 * @module @dorkos/flow/extension/asks
 */

import type { AutonomyKind, AutonomyStop } from '../../../../scripts/autonomy.ts';
import type { DecisionActions, DecisionInput, RecordedDecisionInput } from './host-types.ts';
import { clip } from './start-words.ts';

/** The longest headline DorkOS takes. */
export const MAX_TITLE = 120;

/** The longest why line DorkOS takes. */
export const MAX_WHY = 300;

/** The longest detail DorkOS takes. */
export const MAX_DETAIL = 500;

/** The longest note or written answer, on both sides. */
export const MAX_NOTE = 2000;

/** The kinds of ask flow raises. */
export type AskKind = 'review' | 'question' | 'sign-in' | 'ideas' | 'retry';

/** The order flow raises in: what is most urgent first (§7.2). */
export const ASK_PRIORITY: Readonly<Record<AskKind, number>> = {
  review: 0,
  question: 1,
  retry: 2,
  'sign-in': 3,
  ideas: 4,
};

/** The key's first part for each kind (§7.2). */
const KEY_PREFIX: Readonly<Record<AskKind, string>> = {
  review: 'review',
  question: 'question',
  retry: 'retry',
  'sign-in': 'tracker',
  ideas: 'idle',
};

/** The dial's kind each ask belongs to; signing in belongs to none (N11). */
export const ASK_AUTONOMY: Readonly<Record<AskKind, AutonomyKind | null>> = {
  review: 'ship',
  question: 'questions',
  retry: 'retry',
  'sign-in': null,
  ideas: 'sort',
};

/** One ask, ready to raise. */
export interface Ask {
  /** flow's key, before core namespaces it. */
  key: string;
  /** What kind of ask. */
  kind: AskKind;
  /** The item, for review, question and retry. */
  identifier: string | null;
  /** The project's name and root. */
  project: { name: string; root: string };
  /** What DorkOS is given. */
  input: DecisionInput;
  /**
   * What the ask is about, so an answered ask is not raised again for the
   * same thing: a review's head, a question's time, a park's time.
   */
  marker: string;
  /** Where a person answers it: only in Activity (credited to them), or on flow's pages too. */
  answerIn: 'activity' | 'flow';
  /** A review gate: the commit the ask showed, which a 👍 arms. */
  head: string | null;
  /** A question: whether it is on the calibration floor. */
  floor: boolean;
  /** A question: only a person may answer it (`secrets-or-spend`). */
  personOnly: boolean;
  /**
   * A question: the deadline at which the agent's pick stands, as `flow ask`
   * stored it; `null` when none (a floor question, or one that waits for you).
   */
  deadline: string | null;
  /** A question's choices, by id. */
  choices: { id: string; label: string }[];
}

/** The project facts every ask carries. */
export interface AskProject {
  /** Core's project name. */
  name: string;
  /** Its main checkout. */
  root: string;
  /** Its short id (§7.2). */
  id: string;
  /** The heading's muted label ("Linear DOR"), or `null`. */
  label: string | null;
  /** The tracker's name ("Linear"), or `null`. */
  tracker: string | null;
  /** The project's page in flow (`/x/flow/p/<name>`). */
  link: string;
}

/** An item id as it may appear in a key. */
function keyPart(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
}

/**
 * An ask's key: `<kind>:<projectId>[:<identifier>]` (§7.2).
 *
 * @param kind - The ask.
 * @param projectId - The project's short id.
 * @param identifier - The item, for an item's ask.
 * @returns The key.
 */
export function askKey(kind: AskKind, projectId: string, identifier?: string | null): string {
  const base = `${KEY_PREFIX[kind]}:${projectId}`;
  return identifier ? `${base}:${keyPart(identifier)}` : base;
}

/** Tracker ids look like `DOR-2387`; a headline must never carry one. */
const ITEM_ID = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;

/** Every tracker id in a text, for taking them all out. */
const ITEM_IDS = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/**
 * flow's own stage labels, which a headline must never show: the engine's
 * uppercase names (`EXECUTE`, `REVIEW`) and the tracker label form
 * (`stage/review`). Ordinary words ("Are we done…?", "Should I review…?")
 * are not labels and are never matched.
 */
const STAGE_LABELS =
  /\b(CAPTURE|TRIAGE|IDEATE|SPECIFY|DECOMPOSE|EXECUTE|VERIFY|REVIEW|DONE)\b|\bstage\/[a-z-]+/;

/** The kinds whose headline carries an agent's own words or an item's title. */
const OWN_WORDS_KINDS: ReadonlySet<AskKind> = new Set(['review', 'question', 'retry']);

/**
 * Why an ask may not be raised as it is, or `null` when it may: a headline
 * that is empty, too long, a command, or carries an item id or one of flow's
 * stage labels; a why line that is missing or too long.
 *
 * @param input - What would be raised.
 * @param opts - `stages: false` skips the stage-label check, for a headline
 *   that carries an agent's own question or an item's title (their words are
 *   theirs, never flow's labels).
 * @returns The problem, or `null`.
 */
export function askProblem(
  input: Pick<DecisionInput, 'title' | 'why' | 'detail'>,
  opts: { stages?: boolean } = {}
): string | null {
  const title = input.title.trim();
  if (title === '') return 'the headline is empty';
  if (title.length > MAX_TITLE) return `the headline is longer than ${MAX_TITLE} characters`;
  if (title.startsWith('/')) return 'the headline is a command';
  if (ITEM_ID.test(title)) return 'the headline carries an item id';
  if (opts.stages !== false && STAGE_LABELS.test(title)) return 'the headline names a stage';
  const why = input.why.trim();
  if (why === '') return 'the ask has no why line';
  if (why.length > MAX_WHY) return `the why line is longer than ${MAX_WHY} characters`;
  if ((input.detail ?? '').length > MAX_DETAIL) {
    return `the detail is longer than ${MAX_DETAIL} characters`;
  }
  return null;
}

/** An item's title fit for a headline: its ids taken out, and short enough. */
function itemTitle(title: string | null, room: number): string | null {
  const plain = (title ?? '').replace(ITEM_IDS, '').replace(/\s+/g, ' ').trim();
  if (plain === '') return null;
  return clip(plain.replace(/[?.!]+$/, ''), room);
}

/** The fields every ask carries. */
function base(
  project: AskProject,
  input: Omit<DecisionInput, 'project' | 'projectLabel' | 'link'>
): DecisionInput {
  return {
    ...input,
    title: clip(input.title.trim(), MAX_TITLE),
    why: clip(input.why.trim(), MAX_WHY),
    ...(input.detail === undefined ? {} : { detail: clip(input.detail, MAX_DETAIL) }),
    project: project.root,
    ...(project.label === null ? {} : { projectLabel: project.label }),
    link: project.link,
  };
}

/** A word button that opens the project's page (where a tracker link lives, or the command to type). */
function openAction(project: AskProject, label: string): DecisionActions {
  return { kind: 'word', label, href: project.link };
}

/** A review gate's facts. */
export interface ReviewFacts {
  /** The item. */
  identifier: string;
  /** Its title, or `null`. */
  title: string | null;
  /** The commit the ask shows, or `null` when flow does not know it. */
  head: string | null;
  /** The PR, or `null`. */
  pr: number | null;
  /** The reviewer agent's verdict at that commit, and after how many rounds. */
  review: { verdict: 'clean' | 'changes' | null; rounds: number } | null;
  /** The checks, when flow knows them. */
  checks: 'passed' | 'running' | null;
  /**
   * Whether flow can act on it from here (the `cli` transport, and an adapter
   * it may run). Otherwise the row opens the project's page, which links to
   * the tracker.
   */
  actionable: boolean;
}

/**
 * The review gate (§7.3): "Ship <item title>?" with 👍 Ship it / 👎 Send it back.
 *
 * @param project - The project.
 * @param facts - The run's facts.
 * @returns The ask.
 */
export function reviewAsk(project: AskProject, facts: ReviewFacts): Ask {
  const named = itemTitle(facts.title, MAX_TITLE - 6);
  const title = named === null ? 'Ship this change?' : `Ship ${named}?`;
  const built = facts.checks === 'passed' ? "It's built, tests pass" : "It's built";
  let why: string;
  if (facts.checks === 'running') {
    why = "It's built; tests are still running. Shipping merges it once they pass.";
  } else if (facts.review?.verdict === 'clean' && facts.review.rounds > 1) {
    why = `${built}. The reviewer agent raised points and they were fixed. Shipping merges it into the app.`;
  } else if (facts.review?.verdict === 'clean') {
    why = `${built}, and the reviewer agent found nothing. Shipping merges it into the app.`;
  } else {
    why = `${built} and waits for you. Shipping merges it into the app; sending it back asks for changes.`;
  }
  const detail = [
    facts.identifier,
    facts.pr === null ? null : `PR #${facts.pr}`,
    facts.head === null ? null : `at ${facts.head.slice(0, 7)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return {
    key: askKey('review', project.id, facts.identifier),
    kind: 'review',
    identifier: facts.identifier,
    project: { name: project.name, root: project.root },
    input: base(project, {
      key: askKey('review', project.id, facts.identifier),
      title,
      why,
      detail,
      actions: facts.actionable
        ? {
            kind: 'yes-no',
            approveLabel: 'Ship it',
            rejectLabel: 'Send it back',
            rejectAsksForNote: true,
          }
        : openAction(project, 'Open'),
    }),
    marker: facts.head ?? 'unknown',
    answerIn: 'activity',
    head: facts.head,
    floor: false,
    personOnly: false,
    deadline: null,
    choices: [],
  };
}

/** A question's facts, from the run's `question` block (or none, from an older engine). */
export interface QuestionFacts {
  /** The item. */
  identifier: string;
  /** Its title, or `null`. */
  title: string | null;
  /** The structured question, or `null` from an engine that wrote none. */
  question: {
    text: string;
    choices: { id: string; label: string }[];
    pick: string;
    why: string;
    askedAt: string;
    decideBy: string | null;
    floor: string[];
    /** Who answers it first, as `flow ask` stored it (`person`, `reviewer-agent`). */
    answeredBy: string | null;
    /** When the reviewer agent may check a floor question's pick, as stored; `null` for never. */
    checkAfter: string | null;
  } | null;
  /** When the run parked, for an older engine's question. */
  parkedAt: string | null;
  /** Whether flow can post an answer from here. */
  actionable: boolean;
}

/**
 * An agent's question (§7.3): the agent's own words, its pick and, only for a
 * question off the floor that `flow ask` gave one, a deadline. Who answers is
 * read from what `flow ask` stored when it asked, never from the dial now: a
 * dial moved since changes the next question, not this one, and the engine
 * settles this one by what it stored.
 *
 * @param project - The project.
 * @param facts - The question's facts.
 * @returns The ask.
 */
export function questionAsk(project: AskProject, facts: QuestionFacts): Ask {
  const key = askKey('question', project.id, facts.identifier);
  const q = facts.question;
  if (q === null) {
    const named = itemTitle(facts.title, MAX_TITLE - 30);
    return {
      key,
      kind: 'question',
      identifier: facts.identifier,
      project: { name: project.name, root: project.root },
      input: base(project, {
        key,
        title: named === null ? 'An agent needs an answer' : `An agent needs an answer on ${named}`,
        why: "It stopped to ask you something and won't go ahead until someone answers. The question is on the item.",
        detail: facts.identifier,
        actions: facts.actionable
          ? {
              kind: 'word',
              label: 'Reply',
              input: { placeholder: 'Your answer', maxLength: MAX_NOTE },
            }
          : openAction(project, 'Open'),
      }),
      marker: facts.parkedAt ?? 'unknown',
      answerIn: 'flow',
      head: null,
      floor: false,
      personOnly: false,
      deadline: null,
      choices: [],
    };
  }
  const personOnly = q.floor.includes('secrets-or-spend');
  const floor = q.floor.length > 0;
  const pick = q.choices.find((choice) => choice.id === q.pick) ?? null;
  const deadline = !floor && q.decideBy !== null && pick !== null ? q.decideBy : null;
  // DorkOS shows the deadline's time in the viewer's own zone beside the chips.
  const tail = personOnly
    ? ' Only you can answer this one.'
    : deadline !== null
      ? ` If you don't answer by the deadline, it goes with "${pick?.label}".`
      : floor && q.checkAfter !== null
        ? q.answeredBy === 'reviewer-agent'
          ? " The reviewer agent checks the agent's pick unless you answer first."
          : " If you don't answer, the reviewer agent checks the agent's pick."
        : floor
          ? " It won't go ahead until someone checks."
          : " It won't go ahead until you answer.";
  const why = `${clip(q.why.trim(), MAX_WHY - tail.length)}${tail}`;
  const firstLine = q.text.trim().split('\n')[0];
  const title = firstLine.replace(ITEM_IDS, 'this').replace(/\s+/g, ' ');
  const actions: DecisionActions = facts.actionable
    ? {
        kind: 'choice',
        choices: q.choices.map((choice) => ({ id: choice.id, label: clip(choice.label, 40) })),
        allowReply: true,
        ...(deadline !== null && pick !== null
          ? { defaultChoice: pick.id, decideBy: deadline }
          : {}),
      }
    : openAction(project, 'Open');
  return {
    key,
    kind: 'question',
    identifier: facts.identifier,
    project: { name: project.name, root: project.root },
    input: base(project, {
      key,
      title,
      why,
      detail: facts.title === null ? facts.identifier : `${facts.identifier} · ${facts.title}`,
      actions,
    }),
    marker: q.askedAt,
    answerIn: floor ? 'activity' : 'flow',
    head: null,
    floor,
    personOnly,
    deadline,
    choices: q.choices,
  };
}

/**
 * "Sign in to Linear again" (§7.1): only a person can sign in, so it reaches
 * the inbox at once and never has an offer.
 *
 * @param project - The project.
 * @param since - When the sign-in stopped working.
 * @param startable - Whether DorkOS can start the sign-in in a new chat;
 *   otherwise the button opens the project's page, which says what to type.
 * @returns The ask.
 */
export function signInAsk(project: AskProject, since: string, startable: boolean): Ask {
  const tracker = project.tracker ?? 'the tracker';
  const key = askKey('sign-in', project.id);
  return {
    key,
    kind: 'sign-in',
    identifier: null,
    project: { name: project.name, root: project.root },
    input: base(project, {
      key,
      title: `Sign in to ${tracker} again`,
      why: `Flow can't read or update ${project.name}'s work in ${tracker} until you do. Nothing is lost; it's waiting.`,
      since,
      actions: startable ? { kind: 'word', label: 'Sign in' } : openAction(project, 'Sign in'),
    }),
    marker: since,
    answerIn: 'flow',
    head: null,
    floor: false,
    personOnly: false,
    deadline: null,
    choices: [],
  };
}

/** "12 new ideas", "1 new idea". */
function ideaCount(count: number): string {
  return count === 1 ? '1 new idea' : `${count} new ideas`;
}

/**
 * "12 new ideas haven't been sorted" (§7.1): only at Ask me first, after a day
 * with nothing ready to work on and room to work.
 *
 * @param project - The project.
 * @param count - Ideas waiting.
 * @param since - When the project went idle.
 * @param startable - Whether DorkOS can start the sorting in a new chat.
 * @returns The ask.
 */
export function ideasAsk(
  project: AskProject,
  count: number,
  since: string,
  startable: boolean
): Ask {
  const key = askKey('ideas', project.id);
  return {
    key,
    kind: 'ideas',
    identifier: null,
    project: { name: project.name, root: project.root },
    input: base(project, {
      key,
      title: `${ideaCount(count)} ${count === 1 ? "hasn't" : "haven't"} been sorted`,
      why: `Flow has had nothing ready to work on in ${project.name} for a day. Sorting them lets it pick up the good ones.`,
      since,
      actions: startable ? { kind: 'word', label: 'Sort them' } : openAction(project, 'Sort them'),
    }),
    marker: since,
    answerIn: 'flow',
    head: null,
    floor: false,
    personOnly: false,
    deadline: null,
    choices: [],
  };
}

/**
 * "Try fixing the failing checks on <item title>?" (§7.3): at Ask me first,
 * when the drain parked a run on red checks.
 *
 * @param project - The project.
 * @param facts - The item, its title, when it parked, and whether flow can answer from here.
 * @returns The ask.
 */
export function retryAsk(
  project: AskProject,
  facts: { identifier: string; title: string | null; parkedAt: string | null; actionable: boolean }
): Ask {
  const key = askKey('retry', project.id, facts.identifier);
  const named = itemTitle(facts.title, MAX_TITLE - 34);
  return {
    key,
    kind: 'retry',
    identifier: facts.identifier,
    project: { name: project.name, root: project.root },
    input: base(project, {
      key,
      title:
        named === null
          ? 'Try fixing the failing checks?'
          : `Try fixing the failing checks on ${named}?`,
      why: 'The checks failed after the last change. Flow can look at why and push a fix; no means it waits for you.',
      detail: facts.identifier,
      actions: facts.actionable
        ? { kind: 'yes-no', approveLabel: 'Fix it', rejectLabel: 'Leave it' }
        : openAction(project, 'Open'),
    }),
    marker: facts.parkedAt ?? 'unknown',
    answerIn: 'flow',
    head: null,
    floor: false,
    personOnly: false,
    deadline: null,
    choices: [],
  };
}

/**
 * Why an ask's words break a rule, or `null`: a headline built from an agent's
 * question or an item's title is not checked for stage labels.
 *
 * @param ask - The ask.
 * @returns The problem, or `null`.
 */
export function problemOf(ask: Ask): string | null {
  return askProblem(ask.input, { stages: !OWN_WORDS_KINDS.has(ask.kind) });
}

/**
 * An ask whose words break a rule is never dropped: a spend question must
 * always reach a person. Its headline or why line is replaced with plain,
 * safe words, and the agent's own words move behind ⓘ.
 *
 * @param ask - The ask as built.
 * @returns The ask, fit to raise.
 */
export function safeAsk(ask: Ask): Ask {
  const problem = problemOf(ask);
  if (problem === null) return ask;
  const stages = !OWN_WORDS_KINDS.has(ask.kind);
  const headlineOk = askProblem({ title: ask.input.title, why: 'x' }, { stages }) === null;
  const whyOk = askProblem({ title: 'x', why: ask.input.why }) === null;
  const generic: Record<AskKind, string> = {
    review: `Finished work in ${ask.project.name} waits for you`,
    question: `A question needs you in ${ask.project.name}`,
    retry: `Checks failed in ${ask.project.name}`,
    'sign-in': 'Sign in again',
    ideas: `New ideas wait in ${ask.project.name}`,
  };
  const moved = [headlineOk ? null : ask.input.title, ask.input.detail ?? null]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
  const input: DecisionInput = {
    ...ask.input,
    title: headlineOk ? ask.input.title : clip(generic[ask.kind], MAX_TITLE),
    why: whyOk
      ? ask.input.why
      : `Flow needs someone to look at this in ${ask.project.name}. The details are behind ⓘ.`,
    ...(moved === '' ? {} : { detail: clip(moved, MAX_DETAIL) }),
  };
  return { ...ask, input };
}

/** The answer a person gives to "Fix it", posted on the item so the drain goes back to fixing. */
export const FIX_IT_ANSWER = 'Go ahead: look at why the checks failed and push a fix.';

/** "Next time, on its own?" (§7.8), by kind. */
export const OFFER_TEXT: Readonly<Record<AutonomyKind, string>> = {
  ship: 'Shipped. Next time, ship on its own when the reviewer agent approves?',
  questions:
    "Answered. Next time, let the agent go with its pick if you haven't answered by the deadline?",
  sort: 'Sorting. Next time, sort new ideas every morning on its own?',
  retry: 'Fixing. Next time, fix failing checks on its own?',
};

/**
 * What an accepted offer tells the person.
 *
 * @param name - The project's name.
 * @returns The words.
 */
export function offerDoneText(name: string): string {
  return `Done. Change it any time in ${name}'s Flow settings.`;
}

/** Who a stop's history row names. */
export function ruleLabel(stop: AutonomyStop): string {
  return stop === 'auto' ? "your 'Just do it' setting" : "your 'Tell me after' setting";
}

/** The reviewer agent, as history names it. */
export const REVIEWER_AGENT = 'the reviewer agent';

/**
 * The "While you were away" row for work the reviewer agent shipped (§7.10).
 *
 * @param project - The project.
 * @param facts - The item, its title, and the stop that let it ship.
 * @returns The record.
 */
export function shipRecord(
  project: AskProject,
  facts: { identifier: string; title: string | null; stop: AutonomyStop }
): RecordedDecisionInput {
  const named = itemTitle(facts.title, MAX_TITLE - 6);
  return recordBase(project, {
    key: `shipped:${project.id}:${keyPart(facts.identifier)}`,
    title: named === null ? 'Ship this change?' : `Ship ${named}?`,
    why: 'The reviewer agent checked it and found it clean, and your settings let it ship on its own.',
    detail: facts.identifier,
    outcome: 'approved',
    by: { kind: 'agent', label: REVIEWER_AGENT },
    choiceLabel: 'Shipped',
    tell: facts.stop === 'tell',
  });
}

/**
 * The row for new ideas flow started sorting by itself (§7.10).
 *
 * @param project - The project.
 * @param stop - The "Sort new ideas" stop.
 * @param count - Ideas waiting, when known.
 * @returns The record.
 */
export function sortRecord(
  project: AskProject,
  stop: AutonomyStop,
  count: number | null
): RecordedDecisionInput {
  const title =
    count !== null && count > 0
      ? `${ideaCount(count)} ${count === 1 ? "hasn't" : "haven't"} been sorted`
      : "New ideas haven't been sorted";
  return recordBase(project, {
    key: `sorted:${project.id}`,
    title,
    why: 'Your settings sort new ideas every morning, so flow started sorting them in a new chat.',
    outcome: 'approved',
    by: { kind: 'rule', label: ruleLabel(stop) },
    choiceLabel: 'Sorting',
    tell: stop === 'tell',
  });
}

/**
 * The row for failing checks flow went back to fix by itself (§7.10).
 *
 * @param project - The project.
 * @param facts - The item, its title, and the "Retry and fix problems" stop.
 * @returns The record.
 */
export function retryRecord(
  project: AskProject,
  facts: { identifier: string; title: string | null; stop: AutonomyStop }
): RecordedDecisionInput {
  const named = itemTitle(facts.title, MAX_TITLE - 34);
  return recordBase(project, {
    key: `fixing:${project.id}:${keyPart(facts.identifier)}`,
    title:
      named === null
        ? 'Try fixing the failing checks?'
        : `Try fixing the failing checks on ${named}?`,
    why: 'The checks failed after the last change, and your settings let flow fix them on its own.',
    detail: facts.identifier,
    outcome: 'approved',
    by: { kind: 'rule', label: ruleLabel(facts.stop) },
    choiceLabel: 'Fixing',
    tell: facts.stop === 'tell',
  });
}

/** The fields every record carries. */
function recordBase(
  project: AskProject,
  input: Omit<RecordedDecisionInput, 'project' | 'projectLabel' | 'link'>
): RecordedDecisionInput {
  return {
    ...input,
    title: clip(input.title, MAX_TITLE),
    why: clip(input.why, MAX_WHY),
    project: project.root,
    ...(project.label === null ? {} : { projectLabel: project.label }),
    link: project.link,
  };
}
