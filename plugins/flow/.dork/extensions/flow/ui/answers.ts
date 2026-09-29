/**
 * Answering flow's asks from flow's own pages (spec `flow-multiproject` §7.4,
 * §7.6, §7.9), and the buttons that start work in a new chat.
 *
 * - On a DorkOS with the inbox, an ask is answered through core's
 *   `api.answerDecision`, so the inbox and flow's pages always agree. A review
 *   gate and a floor question go to Activity instead: DorkOS credits an answer
 *   on flow's page to Flow, and those must be credited to you.
 * - On a DorkOS without the inbox, flow's own person-only route answers it.
 * - A button that needs an agent ("Sign in", "Sort them", "Connect a
 *   tracker", "Set up flow here") starts the work in a new chat with
 *   `api.startWork`, and then says "Sorting 12 ideas… · Watch". On a DorkOS
 *   without it, the caller shows what to type instead.
 *
 * @module @dorkos/flow/extension/ui/answers
 */

import type {
  ClientApi,
  DecisionActions,
  DecisionAnswer,
  ExtensionDecisionView,
} from '../lib/host-types.ts';
import type { FlowDecision } from '../lib/model.ts';
import { isStartRefusal, startRefusal, startWords, type StartKind } from '../lib/start-words.ts';
import { UNREACHABLE_MESSAGE, answerHere } from './api.ts';
import { BUTTON, MUTED } from './parts.ts';
import { h, useState, type Node } from './react.ts';
import type { FlowStore } from './store.ts';
import { ALERT, CHIP } from './styles.ts';

/** The host calls an answer may use. */
export type AnswerApi = Pick<
  ClientApi,
  'navigate' | 'listDecisions' | 'answerDecision' | 'startWork'
>;

/** What an answer came to. */
export interface AnswerOutcome {
  /** Whether it settled the ask. */
  resolved: boolean;
  /** Something to tell the person, or `null`. */
  message: string | null;
  /** A chat started for it, or `null`. */
  watch: { sessionId: string; label: string } | null;
}

/** Shown when an ask was settled before the answer arrived. */
export const ALREADY_SETTLED_TEXT = 'This was already settled.';

/** Shown when a start failed for no reason DorkOS gave. */
export const START_FAILED_TEXT = "Flow couldn't start that. Try again.";

/** The note above asks answered on flow's pages, where DorkOS credits them to Flow. */
export const ANSWERED_IN_FLOW_NOTE =
  'Answers you give here show in Activity as answered in Flow. Shipping, and checks only you can make, are answered in Activity so they count as yours.';

/**
 * Whether this DorkOS has the inbox, seen from the page.
 *
 * @param api - The host API.
 * @returns True when it can list and answer flow's asks.
 */
export function hasInbox(api: Pick<ClientApi, 'listDecisions' | 'answerDecision'>): boolean {
  return typeof api.listDecisions === 'function' && typeof api.answerDecision === 'function';
}

/**
 * Whether an ask is answered in place on flow's pages, not in Activity.
 *
 * @param decision - The ask.
 * @param api - The host API.
 * @returns True for in place.
 */
export function answeredHere(
  decision: FlowDecision,
  api: Pick<ClientApi, 'listDecisions' | 'answerDecision'>
): boolean {
  return !hasInbox(api) || decision.answerIn === 'flow';
}

/** Shown when the ask changed since the page showed it. */
export const CHANGED_TEXT = 'This question changed. Take another look.';

/** An action's shape without the deadline, which core may have moved to its floor. */
function actionShape(actions: DecisionActions): unknown {
  if (actions.kind !== 'choice') return actions;
  return { ...actions, decideBy: undefined };
}

/**
 * Whether core's row still says what flow's page showed: the same headline,
 * why line and buttons.
 *
 * @param view - Core's row.
 * @param decision - What the page showed.
 * @returns True when they match.
 */
export function sameAsk(
  view: Pick<ExtensionDecisionView, 'title' | 'why' | 'actions'>,
  decision: Pick<FlowDecision, 'title' | 'why' | 'actions'>
): boolean {
  return (
    view.title === decision.title &&
    view.why === decision.why &&
    JSON.stringify(actionShape(view.actions)) === JSON.stringify(actionShape(decision.actions))
  );
}

/**
 * Send one answer: through core where it has the inbox, else flow's route.
 *
 * @param api - The host API.
 * @param decision - The ask.
 * @param answer - What was chosen.
 * @param store - The store, to show the new model at once.
 * @returns What happened.
 */
export async function sendAnswer(
  api: AnswerApi,
  decision: FlowDecision,
  answer: DecisionAnswer,
  store?: FlowStore
): Promise<AnswerOutcome> {
  const list = api.listDecisions;
  const answerDecision = api.answerDecision;
  if (typeof list === 'function' && typeof answerDecision === 'function') {
    const view = (await list()).find((open) => open.key === decision.key);
    if (view === undefined) return { resolved: false, message: ALREADY_SETTLED_TEXT, watch: null };
    // Answer only what the person saw: core's row must still say the same.
    if (!sameAsk(view, decision)) return { resolved: false, message: CHANGED_TEXT, watch: null };
    const result = await answerDecision(view.id, answer);
    if (result.resolved) void store?.refresh();
    return { resolved: result.resolved, message: result.message, watch: result.watch };
  }
  const reply = await answerHere(decision.key, answer, decision.shown);
  store?.apply(reply.model);
  return { resolved: reply.resolved, message: reply.message, watch: reply.watch };
}

/**
 * The route of a chat flow started in a project.
 *
 * @param sessionId - The chat.
 * @param root - The project's folder, or `null`.
 * @returns `/session?session=<id>&dir=<root>`.
 */
export function watchRoute(sessionId: string, root: string | null): string {
  const dir = root === null ? '' : `&dir=${encodeURIComponent(root)}`;
  return `/session?session=${encodeURIComponent(sessionId)}${dir}`;
}

/** "Sorting 12 ideas… · Watch". */
function WatchLine(props: {
  watch: { sessionId: string; label: string };
  root: string | null;
  api: Pick<ClientApi, 'navigate'>;
}): Node {
  return h(
    'span',
    { style: MUTED, role: 'status' },
    `${props.watch.label} · `,
    h(
      'button',
      {
        type: 'button',
        style: { ...CHIP, cursor: 'pointer' },
        onClick: () => props.api.navigate(watchRoute(props.watch.sessionId, props.root)),
      },
      'Watch'
    )
  );
}

/**
 * An ask's buttons on flow's pages: 👎/👍 labelled as their outcomes (with a
 * note where 👎 asks for one), one word button (with a text field where it
 * asks for one), or a question's chips with the agent's pick marked and
 * "Reply…".
 *
 * @param props - The ask, its project's folder, the host API and the store.
 * @returns The buttons, then what the answer came to.
 */
export function DecisionAnswers(props: {
  decision: FlowDecision;
  root: string | null;
  api: AnswerApi;
  store?: FlowStore;
}): Node {
  const { decision, api } = props;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AnswerOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = (answer: DecisionAnswer) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    sendAnswer(api, decision, answer, props.store).then(
      (result) => {
        setBusy(false);
        setOutcome(result);
        setNote(null);
        setReply(null);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE);
      }
    );
  };

  if (outcome !== null && (outcome.resolved || outcome.watch !== null)) {
    return h(
      'div',
      { style: { flex: 'none' } },
      outcome.watch !== null
        ? h(WatchLine, { watch: outcome.watch, root: props.root, api })
        : h('span', { style: MUTED, role: 'status' }, outcome.message ?? 'Done.')
    );
  }

  const button = (
    key: string,
    label: string,
    onClick: () => void,
    extra: Record<string, unknown> = {}
  ): Node =>
    h(
      'button',
      {
        key,
        type: 'button',
        style: { ...BUTTON, cursor: busy ? 'progress' : 'pointer' },
        'aria-disabled': busy || undefined,
        onClick,
        ...extra,
      },
      label
    );

  const field = (
    value: string,
    set: (next: string) => void,
    label: string,
    submit: string,
    onSubmit: () => void
  ): Node =>
    h(
      'div',
      { key: 'field', style: { display: 'flex', gap: '6px', width: '100%' } },
      h('input', {
        type: 'text',
        'aria-label': label,
        placeholder: label,
        maxLength: 2000,
        value,
        onChange: (event: { target: { value: string } }) => set(event.target.value),
        style: { flex: 1, minWidth: 0, fontSize: '12px' },
      }),
      button('submit', submit, () => {
        if (value.trim() !== '') onSubmit();
      })
    );

  const actions = decision.actions;
  const children: Node[] = [];
  if (actions.kind === 'yes-no') {
    const asksNote = actions.rejectAsksForNote === true;
    children.push(
      button(
        'reject',
        `👎 ${actions.rejectLabel}`,
        () => (asksNote ? setNote(note === null ? '' : null) : send({ action: 'reject' })),
        asksNote ? { 'aria-expanded': note !== null } : {}
      ),
      button('approve', `👍 ${actions.approveLabel}`, () => send({ action: 'approve' }))
    );
    if (note !== null) {
      children.push(
        field(note, setNote, 'What should change?', actions.rejectLabel, () =>
          send({ action: 'reject', note: note.trim() })
        )
      );
    }
  } else if (actions.kind === 'word') {
    if (actions.input !== undefined) {
      const typed = reply ?? '';
      children.push(
        field(typed, setReply, actions.input.placeholder, actions.label, () =>
          send({ action: 'word', text: typed.trim() })
        )
      );
    } else {
      children.push(button('word', actions.label, () => send({ action: 'word' })));
    }
  } else {
    for (const choice of actions.choices) {
      const pick = choice.id === actions.defaultChoice;
      children.push(
        button(choice.id, pick ? `${choice.label} · agent's pick` : choice.label, () =>
          send({ action: 'choice', choiceId: choice.id })
        )
      );
    }
    if (actions.allowReply === true) {
      children.push(
        button('reply', 'Reply…', () => setReply(reply === null ? '' : null), {
          'aria-expanded': reply !== null,
        })
      );
      if (reply !== null) {
        children.push(
          field(reply, setReply, 'Your answer', 'Send', () =>
            send({ action: 'choice', text: reply.trim() })
          )
        );
      }
    }
  }
  const said = error ?? outcome?.message ?? null;
  return h(
    'div',
    { style: { flex: 'none', display: 'flex', flexWrap: 'wrap', gap: '6px', maxWidth: '100%' } },
    ...children,
    said === null
      ? null
      : h(
          'p',
          {
            key: 'said',
            role: error === null ? 'status' : 'alert',
            style: error === null ? MUTED : ALERT,
          },
          said
        )
  );
}

/**
 * A button that starts work in a new chat (§7.9), or `null` on a DorkOS that
 * cannot start one (the caller then says what to type).
 *
 * @param props - What it starts, for which project, and the host API.
 * @returns The button, or the chat it started.
 */
export function StartButton(props: {
  kind: StartKind;
  label: string;
  project: { name: string; root: string; tracker?: string | null };
  count?: number | null;
  api: Pick<ClientApi, 'navigate' | 'startWork'>;
}): Node {
  const { api } = props;
  const [busy, setBusy] = useState(false);
  const [watch, setWatch] = useState<{ sessionId: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startWork = api.startWork;
  if (typeof startWork !== 'function') return null;
  if (watch !== null) return h(WatchLine, { watch, root: props.project.root, api });
  const words = startWords(props.kind, {
    name: props.project.name,
    tracker: props.project.tracker ?? null,
    count: props.count ?? null,
  });
  const start = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    startWork({
      project: props.project.root,
      prompt: words.prompt,
      title: words.title,
      reason: words.reason,
    }).then(
      ({ sessionId }) => {
        setBusy(false);
        setWatch({ sessionId, label: words.watch });
      },
      (failure: unknown) => {
        setBusy(false);
        setError(
          isStartRefusal(failure)
            ? startRefusal(failure.code, failure.message, props.project.name)
            : START_FAILED_TEXT
        );
      }
    );
  };
  return h(
    'span',
    null,
    h(
      'button',
      {
        type: 'button',
        style: { ...CHIP, cursor: busy ? 'progress' : 'pointer', marginLeft: '4px' },
        'aria-disabled': busy || undefined,
        onClick: start,
      },
      props.label
    ),
    error === null
      ? null
      : h('span', { role: 'alert', style: { ...ALERT, display: 'block' } }, error)
  );
}
