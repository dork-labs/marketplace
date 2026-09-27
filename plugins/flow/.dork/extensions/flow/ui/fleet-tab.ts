/**
 * The Flow tab in DorkOS Settings (spec `claude-account-ui` §8.3): which
 * accounts flow may use, grouped by runtime, the main account's reserve, the
 * repos a kept-out account may serve, and what happens when an account runs out.
 *
 * Every change writes at once and shows at once; if flow refuses it, the tab
 * puts the last saved state back and says why under the control. After each
 * write, the body flow answers is what the tab shows (choosing a new Main shows
 * the old one as Rotation).
 *
 * @module @dorkos/flow/extension/ui/fleet-tab
 */

import type { FleetAccount, FleetView } from '../lib/fleet.ts';
import {
  FleetRequestError,
  HostTooOldError,
  UNREACHABLE_MESSAGE,
  getFleet,
  putAccount,
  putCrossRuntime,
  putHandoff,
  type AccountPatch,
} from './api.ts';
import { FleetNotice, pickNotice } from './notice.ts';
import { h, useEffect, useId, useRef, useState, type Node } from './react.ts';
import { RepoChips } from './repo-chips.ts';
import { SegmentedControl, type SegmentOption } from './segmented.ts';
import {
  ALERT,
  CHIP,
  DOT,
  FIELD,
  FOCUS_CSS,
  GROUP_CAPTION,
  HEADING,
  INSET,
  MUTED,
  RANGE_CLASS,
  ROOT,
  ROW,
  ROW_LABEL,
  rangeStyle,
} from './styles.ts';

/** Shown on a DorkOS without what the Flow tab needs. */
export const HOST_TOO_OLD_TEXT = 'Update DorkOS to choose how flow uses your accounts.';

/** Shown when the tab could not read flow's settings and flow gave no reason. */
export const LOAD_FAILED_TEXT = "Couldn't load Flow's settings. Try again in a moment.";

/** The action beside {@link LOAD_FAILED_TEXT} that loads the settings again. */
export const RETRY_TEXT = 'Retry';

/** Shown when DorkOS knows no account at all. */
export const NO_ACCOUNTS_TEXT = 'Add Claude accounts in Settings → Runtimes first.';

/** The spend-down choices, in hours. */
export const SPEND_DOWN_HOURS = [6, 12, 24, 48, 72] as const;

/** The role choices. */
const ROLE_OPTIONS: readonly SegmentOption<FleetAccount['role']>[] = [
  { value: 'main', label: 'Main' },
  { value: 'rotation', label: 'Rotation' },
  { value: 'kept-out', label: 'Kept out' },
];

/** The handoff choices. */
const HANDOFF_OPTIONS: readonly SegmentOption<FleetView['handoff']>[] = [
  { value: 'auto', label: 'Hand off automatically' },
  { value: 'ask', label: 'Ask me' },
];

/** The cross-runtime choices. */
const CROSS_RUNTIME_OPTIONS: readonly SegmentOption<FleetView['crossRuntimeFallback']>[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
];

/** Where a write's error shows: an account's key, or a fleet-wide row. */
type Scope = string;

/** The error line under a control, when it has one. */
function ErrorLine(props: { message: string | undefined }): Node {
  return props.message ? h('p', { role: 'alert', style: ALERT }, props.message) : null;
}

/**
 * `body` with one account changed the way the server will change it: a new
 * Main demotes the runtime's old Main to Rotation.
 *
 * @param body - The body to change.
 * @param key - The account's policy key.
 * @param patch - The change.
 * @returns The changed body.
 */
export function applyAccountPatch(body: FleetView, key: string, patch: AccountPatch): FleetView {
  return {
    ...body,
    groups: body.groups.map((group) => {
      if (!group.accounts.some((account) => account.key === key)) return group;
      return {
        ...group,
        accounts: group.accounts.map((account) => {
          if (account.key !== key) {
            return patch.role === 'main' && account.role === 'main'
              ? { ...account, role: 'rotation' as const }
              : account;
          }
          return {
            ...account,
            ...(patch.role ? { role: patch.role } : {}),
            ...(typeof patch.reservePct === 'number' ? { reservePct: patch.reservePct } : {}),
            ...(typeof patch.spendDownWindowHours === 'number'
              ? { spendDownWindowHours: patch.spendDownWindowHours }
              : {}),
            ...(Array.isArray(patch.repos) ? { repos: patch.repos } : {}),
          };
        }),
      };
    }),
  };
}

/** What {@link MainPanel} takes. */
interface MainPanelProps {
  account: FleetAccount;
  onPatch: (patch: AccountPatch) => void;
}

/**
 * The inset under a Main row: how much of the week to keep, and how close to
 * the reset flow may spend it anyway. The slider writes when released
 * (`change`); dragging (`input`) only moves the number.
 */
function MainPanel(props: MainPanelProps): Node {
  const { account } = props;
  const [draft, setDraft] = useState(account.reservePct);
  const range = useRef<HTMLInputElement>(null);
  const commit = useRef(props.onPatch);
  commit.current = props.onPatch;
  const stored = useRef(account.reservePct);

  useEffect(() => {
    stored.current = account.reservePct;
    setDraft(account.reservePct);
  }, [account.reservePct]);

  useEffect(() => {
    const input = range.current;
    if (!input) return;
    // React's onChange fires on every drag step; the native `change` is the release.
    const onRelease = (): void => {
      const value = Number(input.value);
      if (value !== stored.current) commit.current({ reservePct: value });
    };
    input.addEventListener('change', onRelease);
    return () => input.removeEventListener('change', onRelease);
  }, []);

  const hours: number[] = [...SPEND_DOWN_HOURS];
  if (!hours.includes(account.spendDownWindowHours)) {
    hours.push(account.spendDownWindowHours);
    hours.sort((a, b) => a - b);
  }

  return h(
    'div',
    { style: INSET },
    h('span', null, 'Keep ', h('b', null, `${draft}%`), ' for me'),
    h('input', {
      ref: range,
      type: 'range',
      min: 0,
      max: 100,
      step: 5,
      value: draft,
      'aria-label': 'Share of the weekly limit kept for you',
      'aria-valuetext': `${draft}%`,
      className: RANGE_CLASS,
      style: rangeStyle(draft),
      onChange: (event: { target: HTMLInputElement }) => setDraft(Number(event.target.value)),
    }),
    h(
      'label',
      { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
      '· Use it all in the last',
      h(
        'select',
        {
          value: String(account.spendDownWindowHours),
          style: FIELD,
          onChange: (event: { target: HTMLSelectElement }) =>
            props.onPatch({ spendDownWindowHours: Number(event.target.value) }),
        },
        ...hours.map((value) => h('option', { key: value, value: String(value) }, `${value} hours`))
      ),
      'before it resets'
    )
  );
}

/** The inset under a Kept out row: the repos it may still serve. */
function KeptOutPanel(props: MainPanelProps): Node {
  const labelId = useId();
  return h(
    'div',
    { style: INSET },
    h('span', { id: labelId }, 'Only for these repos:'),
    h(RepoChips, {
      repos: props.account.repos,
      labelledBy: labelId,
      onChange: (repos: string[]) => props.onPatch({ repos }),
    })
  );
}

/** One account: its dot, its name, its role, and the inset its role brings. */
function AccountRow(props: {
  account: FleetAccount;
  error: string | undefined;
  onPatch: (patch: AccountPatch) => void;
}): Node {
  const { account } = props;
  return h(
    'div',
    { 'data-account': account.key },
    h(
      'div',
      { style: ROW },
      h('span', {
        role: 'img',
        'aria-label': account.label,
        style: { ...DOT, background: account.color },
      }),
      h('span', { style: ROW_LABEL }, account.label),
      h(SegmentedControl<FleetAccount['role']>, {
        options: ROLE_OPTIONS,
        value: account.role,
        label: account.label,
        onChange: (role) => props.onPatch({ role }),
      })
    ),
    account.role === 'main' ? h(MainPanel, { account, onPatch: props.onPatch }) : null,
    account.role === 'kept-out' ? h(KeptOutPanel, { account, onPatch: props.onPatch }) : null,
    h(ErrorLine, { message: props.error })
  );
}

/** A fleet-wide setting: its words and a segmented control. */
function SettingRow<T extends string>(props: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  error: string | undefined;
  children?: Node;
  /** The tab's last row, which has no rule under it (the mockup's `:last-child`). */
  last?: boolean;
}): Node {
  const labelId = useId();
  return h(
    'div',
    null,
    h(
      'div',
      { style: props.last ? { ...ROW, borderBottom: 0 } : ROW },
      h('span', { id: labelId, style: ROW_LABEL }, props.label),
      h(SegmentedControl<T>, {
        options: props.options,
        value: props.value,
        labelledBy: labelId,
        onChange: props.onChange,
      })
    ),
    props.children,
    h(ErrorLine, { message: props.error })
  );
}

/**
 * The "When an account runs out" row: hand off automatically, or ask.
 *
 * @param props - The mode, its writer and its error.
 * @returns The row.
 */
export function HandoffRow(props: {
  value: FleetView['handoff'];
  onChange: (value: FleetView['handoff']) => void;
  error?: string;
}): Node {
  return h(SettingRow<FleetView['handoff']>, {
    label: 'When an account runs out',
    options: HANDOFF_OPTIONS,
    value: props.value,
    onChange: props.onChange,
    error: props.error,
  });
}

/**
 * The "Cross-runtime fallback" row (Q16): one fleet-wide Off/On.
 *
 * @param props - The setting, its writer and its error.
 * @returns The row.
 */
export function CrossRuntimeRow(props: {
  value: FleetView['crossRuntimeFallback'];
  onChange: (value: FleetView['crossRuntimeFallback']) => void;
  error?: string;
}): Node {
  return h(
    SettingRow<FleetView['crossRuntimeFallback']>,
    {
      label: 'Cross-runtime fallback',
      last: true,
      options: CROSS_RUNTIME_OPTIONS,
      value: props.value,
      onChange: props.onChange,
      error: props.error,
    },
    h(
      'p',
      { style: { ...MUTED, margin: '4px 0 0' } },
      "When every account of a runtime is out, continue the task on another runtime from flow's checkpoint."
    )
  );
}

/** The tab's loading state. */
type Phase =
  | { kind: 'loading' }
  | { kind: 'too-old' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready' };

/**
 * The Flow settings tab.
 *
 * @returns The tab.
 */
export function FleetTab(): Node {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [body, setBody] = useState<FleetView | null>(null);
  const [errors, setErrors] = useState<Record<Scope, string>>({});
  // The last body flow answered, which a failed write rolls back to.
  const saved = useRef<FleetView | null>(null);
  // The write whose answer `saved` holds; an older write's answer never replaces it.
  const savedSeq = useRef(0);
  // Only the newest write's answer is shown, so an older answer never
  // overwrites a newer choice that is still on its way.
  const latest = useRef(0);

  // Bumped by the Retry action on a failed load, which runs the load again.
  const [attempt, setAttempt] = useState(0);
  // The load-failure alert is keyed by the attempt, so a repeated failure
  // mounts a new alert and screen readers announce it again even though the
  // words match.
  // True while a retried load is on its way. The failed view stays up (Retry
  // marked busy, not removed) so keyboard focus stays on the button.
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let live = true;
    getFleet().then(
      (fleet) => {
        if (!live) return;
        saved.current = fleet;
        setBody(fleet);
        setRetrying(false);
        setPhase({ kind: 'ready' });
      },
      (error: unknown) => {
        if (!live) return;
        setRetrying(false);
        if (error instanceof HostTooOldError) setPhase({ kind: 'too-old' });
        else setPhase({ kind: 'failed', message: LOAD_FAILED_TEXT });
      }
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const write = (
    scope: Scope,
    optimistic: (current: FleetView) => FleetView,
    request: () => Promise<FleetView>
  ): void => {
    const seq = ++latest.current;
    setErrors((current) => without(current, scope));
    setBody((current) => (current ? optimistic(current) : current));
    request().then(
      (fleet) => {
        if (seq > savedSeq.current) {
          saved.current = fleet;
          savedSeq.current = seq;
        }
        if (seq === latest.current) setBody(fleet);
      },
      (error: unknown) => {
        if (seq === latest.current) setBody(saved.current);
        setErrors((current) => ({ ...current, [scope]: messageOf(error) }));
      }
    );
  };

  const root = (...children: Node[]): Node =>
    h(
      'div',
      { className: 'flow-fleet-tab', style: ROOT },
      h('style', null, FOCUS_CSS),
      ...children
    );

  if (phase.kind === 'too-old') return root(h('p', { style: MUTED }, HOST_TOO_OLD_TEXT));
  if (phase.kind === 'failed') {
    return root(
      h('p', { key: `load-failed-${attempt}`, role: 'alert', style: ALERT }, phase.message),
      h(
        'button',
        {
          type: 'button',
          style: { ...CHIP, cursor: retrying ? 'progress' : 'pointer' },
          'aria-disabled': retrying,
          onClick: () => {
            if (retrying) return;
            setRetrying(true);
            setAttempt((n) => n + 1);
          },
        },
        RETRY_TEXT
      )
    );
  }
  if (phase.kind === 'loading' || body === null) return root(h('div', { 'aria-busy': true }));

  const header = [
    h('h3', { key: 'h', style: HEADING }, 'Which accounts flow may use'),
    h(
      'p',
      { key: 'intro', style: { ...MUTED, marginBottom: '4px' } },
      'Flow spends the account whose unused time expires soonest, and saves Main for last.'
    ),
    body.warnings.length > 0
      ? h(
          'ul',
          { key: 'warnings', style: { ...MUTED, paddingLeft: '1.1rem', margin: '0 0 4px' } },
          ...body.warnings.map((warning, index) => h('li', { key: index }, warning))
        )
      : null,
  ];

  if (body.groups.every((group) => group.accounts.length === 0)) {
    return root(...header, h('p', { style: MUTED }, NO_ACCOUNTS_TEXT));
  }

  const notice = pickNotice(body);
  const patchAccount = (key: string) => (patch: AccountPatch) =>
    write(
      key,
      (current) => applyAccountPatch(current, key, patch),
      () => putAccount(key, patch)
    );

  return root(
    ...header,
    notice ? h(FleetNotice, { kind: notice }) : null,
    ...body.groups
      .filter((group) => group.accounts.length > 0)
      .map((group) =>
        h(
          'section',
          { key: group.runtime, 'aria-label': group.label },
          h('div', { style: GROUP_CAPTION }, group.label),
          ...group.accounts.map((account) =>
            h(AccountRow, {
              key: account.key,
              account,
              error: errors[account.key],
              onPatch: patchAccount(account.key),
            })
          )
        )
      ),
    h(HandoffRow, {
      value: body.handoff,
      error: errors.handoff,
      onChange: (handoff) =>
        write(
          'handoff',
          (current) => ({ ...current, handoff }),
          () => putHandoff(handoff)
        ),
    }),
    h(CrossRuntimeRow, {
      value: body.crossRuntimeFallback,
      error: errors['cross-runtime'],
      onChange: (crossRuntimeFallback) =>
        write(
          'cross-runtime',
          (current) => ({ ...current, crossRuntimeFallback }),
          () => putCrossRuntime(crossRuntimeFallback)
        ),
    })
  );
}

/** The words to show for a failed request. */
function messageOf(error: unknown): string {
  return error instanceof FleetRequestError && error.refusedByFlow
    ? error.message
    : UNREACHABLE_MESSAGE;
}

/** `record` without `key`. */
function without(record: Record<Scope, string>, key: Scope): Record<Scope, string> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}
