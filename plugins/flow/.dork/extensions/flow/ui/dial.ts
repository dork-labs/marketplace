/**
 * "How much it does on its own" (spec `flow-multiproject` §7.7, V10, N11):
 * one dial per project, **Ask me first | Tell me after | Just do it**, with a
 * line per kind of ask saying what the stop does there, and **Customize…**,
 * which sets each kind on its own.
 *
 * The dial lives in DorkOS's per-project settings for flow, and the browser's
 * `api.projectSettings.set` is the only thing anywhere that writes it, behind
 * DorkOS's person bar. flow's server half and every agent it runs can only
 * read it. A "Next time, on its own?" Yes in the inbox writes the same value,
 * built by the same `withKind` Customize uses.
 *
 * Whatever the stop, someone checks: at Just do it the reviewer agent or a
 * safe default answers, never nobody. Shipping can't leave Ask me first
 * without a reviewer agent, and the dial says so.
 *
 * @module @dorkos/flow/extension/ui/dial
 */

import {
  AUTONOMY_KINDS,
  DEFAULT_QUESTION_DEADLINE_MINUTES,
  NEW_PROJECT_DIAL,
  NO_COPY_DIAL,
  isCustom,
  parseAutonomyCopy,
  resolveAutonomy,
  withDial,
  withKind,
  type AutonomyCopy,
  type AutonomyKind,
  type AutonomyStop,
} from '../../../../scripts/autonomy-dial.ts';
import type { ClientApi } from '../lib/host-types.ts';
import type { FlowProject } from '../lib/model.ts';
import { BUTTON, MUTED } from './parts.ts';
import { h, useEffect, useId, useState, type Node } from './react.ts';
import { SegmentedControl, type SegmentOption } from './segmented.ts';
import { ALERT, FIELD } from './styles.ts';

/** The three stops, as the dial shows them. */
export const STOP_OPTIONS: readonly SegmentOption<AutonomyStop>[] = [
  { value: 'ask', label: 'Ask me first' },
  { value: 'tell', label: 'Tell me after' },
  { value: 'auto', label: 'Just do it' },
];

/** Each kind's name. */
export const KIND_LABELS: Readonly<Record<AutonomyKind, string>> = {
  ship: 'Ship finished work',
  questions: 'Agent questions',
  sort: 'Sort new ideas',
  retry: 'Retry and fix problems',
};

/** What each stop does for each kind (V10's table). */
export const STOP_WORDS: Readonly<Record<AutonomyKind, Readonly<Record<AutonomyStop, string>>>> = {
  ship: {
    ask: 'Asks you',
    tell: "The reviewer agent approves it, and you're told",
    auto: 'The reviewer agent approves it',
  },
  questions: {
    ask: 'Waits for you',
    tell: "The agent goes with its pick at the deadline, and you're told",
    auto: 'The agent goes with its pick and writes down why',
  },
  sort: {
    ask: 'Asks you',
    tell: "Every morning, and you're told",
    auto: 'Every morning',
  },
  retry: {
    ask: 'Asks you',
    tell: "On its own, and you're told",
    auto: 'On its own',
  },
};

/** What shipping says when no reviewer agent checks the repo's work. */
export const NO_REVIEWER_TEXT = "Asks you, because no reviewer agent checks this repo's work";

/** DorkOS's own line under a setting only a person should change, when Require login is off. */
export const REQUIRE_LOGIN_TEXT =
  'Anyone on this computer can change this. Turn on Require login so only you can.';

/** Said on a project whose flow cannot read the dial yet. */
export const DIAL_NEEDS_NEWER_FLOW_TEXT = 'Update flow in this project to choose this.';

/** Said on a DorkOS that does not keep per-project settings. */
export const DIAL_NEEDS_NEWER_DORKOS_TEXT = 'Update DorkOS to choose this here.';

/** Said on a project flow already knew and whose dial nobody chose yet. */
export const NOT_CHOSEN_TEXT =
  'Flow asks you first here until you choose. It still fixes failing checks on its own, as it always has.';

/** How long an agent waits for your answer at Tell me after. */
export const DEADLINE_OPTIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 60, label: '1 hour' },
  { minutes: DEFAULT_QUESTION_DEADLINE_MINUTES, label: '4 hours' },
  { minutes: 24 * 60, label: 'A day' },
];

/** The stored value, as read: still loading, none, or a dial. */
type Stored = { state: 'loading' } | { state: 'none' } | { state: 'set'; copy: AutonomyCopy };

/**
 * The dial in force for a project: what a person stored, else the default
 * flow computes (Tell me after for a project it first saw with no history,
 * else the engine's "no copy" rule, Ask me first).
 *
 * @param stored - The stored dial, or `null`.
 * @param project - The project, for how flow first saw it.
 * @returns The dial in force.
 */
export function dialInForce(stored: AutonomyCopy | null, project: FlowProject): AutonomyCopy {
  if (stored !== null) return stored;
  return project.autonomy?.firstSeen === 'new' ? NEW_PROJECT_DIAL : NO_COPY_DIAL;
}

/** What {@link AutonomyDial} takes. */
export interface AutonomyDialProps {
  /** The project. */
  project: FlowProject;
  /** The host API: its per-project settings and its state. */
  api: Pick<ClientApi, 'projectSettings' | 'getState'>;
  /** Whether a reviewer agent checks this repo's work (`review.adversarial`). */
  reviewerAgent: boolean;
}

/**
 * The dial, its table, and Customize.
 *
 * @param props - See {@link AutonomyDialProps}.
 * @returns The field.
 */
export function AutonomyDial(props: AutonomyDialProps): Node {
  const { project, api } = props;
  const settings = api.projectSettings;
  const [stored, setStored] = useState<Stored>({ state: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [customize, setCustomize] = useState(false);
  const labelId = useId();
  const noteId = useId();
  const panelId = useId();
  const tooOld = project.version.behaviour < 1;

  useEffect(() => {
    let live = true;
    setStored({ state: 'loading' });
    setError(null);
    if (settings === undefined || typeof settings.get !== 'function') return;
    settings.get(project.root).then(
      (value) => {
        if (!live) return;
        if (value === null || value === undefined) setStored({ state: 'none' });
        // A stored value that is not a dial reads as Ask me first for everything, as the engine reads it.
        else
          setStored({
            state: 'set',
            copy: parseAutonomyCopy(value) ?? { ...NO_COPY_DIAL, kinds: {} },
          });
      },
      (failure: unknown) => {
        if (live) setError(messageOf(failure, "Flow couldn't read this setting. Try again in a moment."));
      }
    );
    return () => {
      live = false;
    };
  }, [project.root, settings]);

  const requireLogin = api.getState?.().requireLogin;
  const loginNote =
    requireLogin === false ? h('p', { style: { ...MUTED, marginTop: '4px' } }, REQUIRE_LOGIN_TEXT) : null;
  const label = h('span', { id: labelId, style: { fontWeight: 600 } }, 'How much it does on its own');

  if (settings === undefined || typeof settings.set !== 'function') {
    return h('div', null, label, h('p', { style: MUTED }, DIAL_NEEDS_NEWER_DORKOS_TEXT));
  }
  if (stored.state === 'loading') {
    return h(
      'div',
      null,
      label,
      error === null
        ? h('p', { 'aria-busy': true, style: MUTED }, 'Loading…')
        : h('p', { role: 'alert', style: ALERT }, error)
    );
  }

  const copy = stored.state === 'set' ? stored.copy : null;
  const inForce = dialInForce(copy, project);
  const unchosen = copy === null && project.autonomy?.firstSeen !== 'new';
  const custom = !unchosen && isCustom(inForce);
  const stopOf = (kind: AutonomyKind) =>
    resolveAutonomy(inForce, kind, { reviewerAgent: props.reviewerAgent });

  const save = (next: AutonomyCopy) => {
    const before = stored;
    setStored({ state: 'set', copy: next });
    setError(null);
    settings.set(project.root, next).catch((failure: unknown) => {
      setStored(before);
      setError(messageOf(failure, "Flow couldn't save this. Nothing was changed; try again."));
    });
  };

  const disabled = tooOld;
  const kindRow = (kind: AutonomyKind) => {
    const stop = stopOf(kind);
    const blocked = kind === 'ship' && !props.reviewerAgent && (inForce.kinds.ship ?? inForce.dial) !== 'ask';
    const words = blocked ? NO_REVIEWER_TEXT : STOP_WORDS[kind][stop];
    const rowLabel = `${project.name}: ${KIND_LABELS[kind]}`;
    return h(
      'div',
      { key: kind, role: 'row', style: { padding: '3px 0' } },
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'baseline' } },
        h('span', { role: 'rowheader', style: { minWidth: '11rem', fontSize: '12px' } }, KIND_LABELS[kind]),
        h('span', { role: 'cell', style: { ...MUTED, flex: 1, minWidth: '10rem' } }, words)
      ),
      customize
        ? h(
            'div',
            { style: { margin: '4px 0 2px' } },
            h(SegmentedControl<AutonomyStop>, {
              options: STOP_OPTIONS,
              value: inForce.kinds[kind] ?? inForce.dial,
              label: rowLabel,
              disabled,
              wrap: true,
              onChange: (next) => save(withKind(copy ?? inForce, kind, next)),
            })
          )
        : null,
      kind === 'questions' && stop === 'tell'
        ? h(
            'label',
            {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                margin: '4px 0 0',
                fontSize: '12px',
              },
            },
            'An agent waits for your answer for',
            h(
              'select',
              {
                value: String(inForce.questionDeadlineMinutes),
                disabled,
                style: FIELD,
                onChange: (event: { target: HTMLSelectElement }) =>
                  save({ ...inForce, questionDeadlineMinutes: Number(event.target.value) }),
              },
              ...deadlineOptions(inForce.questionDeadlineMinutes).map((option) =>
                h('option', { key: option.minutes, value: String(option.minutes) }, option.label)
              )
            )
          )
        : null
    );
  };

  return h(
    'div',
    null,
    label,
    h(
      'div',
      { style: { margin: '6px 0 4px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' } },
      h(SegmentedControl<AutonomyStop>, {
        options: STOP_OPTIONS,
        // Custom: the kinds differ, so no single stop is chosen.
        value: (custom ? 'custom' : unchosen ? 'ask' : inForce.dial) as AutonomyStop,
        labelledBy: labelId,
        describedBy: noteId,
        disabled,
        wrap: true,
        onChange: (next) => save(withDial(copy, next)),
      }),
      custom ? h('span', { style: MUTED }, 'Custom') : null
    ),
    h(
      'p',
      { id: noteId, style: { ...MUTED, margin: '0 0 4px' } },
      tooOld
        ? DIAL_NEEDS_NEWER_FLOW_TEXT
        : unchosen
          ? NOT_CHOSEN_TEXT
          : 'Whatever you pick, someone checks: you, the reviewer agent, or a safe default at a deadline.'
    ),
    h(
      'div',
      {
        id: panelId,
        role: 'table',
        'aria-label': `What each kind of ask does in ${project.name}`,
      },
      ...AUTONOMY_KINDS.map(kindRow)
    ),
    h(
      'button',
      {
        type: 'button',
        style: { ...BUTTON, marginTop: '4px' },
        'aria-expanded': customize,
        'aria-controls': panelId,
        disabled,
        onClick: () => setCustomize((open) => !open),
      },
      customize ? 'Done' : 'Customize…'
    ),
    error === null ? null : h('p', { role: 'alert', style: ALERT }, error),
    loginNote
  );
}

/** The deadline choices, with a stored value that is none of them kept as it is. */
function deadlineOptions(current: number): { minutes: number; label: string }[] {
  if (DEADLINE_OPTIONS.some((option) => option.minutes === current)) return [...DEADLINE_OPTIONS];
  const label = current % 60 === 0 ? `${current / 60} hours` : `${current} minutes`;
  return [...DEADLINE_OPTIONS, { minutes: current, label }].sort((a, b) => a.minutes - b.minutes);
}

/**
 * The words for a failed read or write: DorkOS's own sentence when it gave
 * one (such as "Only a person can change this." from its person bar), else
 * the fallback.
 */
function messageOf(failure: unknown, fallback: string): string {
  if (!(failure instanceof Error) || failure.message === '') return fallback;
  // DorkOS's client says "<method> failed: <status>" when the server gave no sentence.
  if (/^projectSettings\.\w+ failed:/.test(failure.message)) {
    return (failure as { status?: number }).status === 403 ? 'Only a person can change this.' : fallback;
  }
  return failure.message;
}
