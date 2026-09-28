/**
 * The Flow panel in DorkOS's right-side panel (spec `claude-account-ui` §8.5):
 * `flow fleet` made visual. Each account's usage, what flow is running and in
 * what state, and a button to pause or resume flow.
 *
 * It loads `GET /api/ext/flow/panel` on mount and then follows the server's
 * `ext:flow:panel` event on DorkOS's `/api/events` stream, re-reading every
 * 30 s instead if that stream fails.
 *
 * @module @dorkos/flow/extension/ui/flow-panel
 */

import type { ComponentType } from 'react';
import type { PanelAccount, PanelModel, PanelRun, PanelWindow } from '../lib/panel.ts';
import { UNREACHABLE_MESSAGE, getPanel, pauseFlow, resolveApiBaseUrl, resumeFlow } from './api.ts';
import {
  PILL_TEXT,
  TONE_VARIABLE,
  accountStateText,
  barFill,
  barTone,
  barsSentence,
  planName,
  windowDetail,
} from './panel-format.ts';
import { h, useEffect, useRef, useState, type Node, type Style } from './react.ts';
import { ALERT, CHIP, hostColor } from './styles.ts';

/** Shown when the panel could not read flow's status. */
export const PANEL_LOAD_FAILED_TEXT = "Couldn't load Flow's status. Try again in a moment.";

/** The action beside {@link PANEL_LOAD_FAILED_TEXT}. */
export const PANEL_RETRY_TEXT = 'Retry';

/** Shown under "Running" when flow runs nothing (Q24, decided). */
export const NOTHING_RUNNING_TEXT = 'Nothing is running.';

/** The footer button while flow runs anywhere (Q25, decided). */
export const PAUSE_TEXT = 'Pause flow';

/** The footer button while flow is paused everywhere (Q25, decided). */
export const RESUME_TEXT = 'Resume flow';

/** The slots text while flow is paused everywhere (Q25, decided). */
export const PAUSED_TEXT = 'paused';

/** Shown after a resume that could not turn DorkOS schedules back on (Q28, decided). */
export const SCHEDULES_OFF_TEXT = "Turn flow's schedules back on in Tasks.";

/** How often the panel re-reads its model when the live stream fails, in ms. */
export const FALLBACK_POLL_MS = 30_000;

/** The host event the server's `ctx.emit('panel', …)` arrives as. */
export const PANEL_EVENT = 'ext:flow:panel';

/** The slots text: "2 of 3 slots busy". */
export function slotsText(slots: PanelModel['slots']): string {
  return `${slots.busy} of ${slots.total} slots busy`;
}

/** What the panel needs from DorkOS's client extension API. */
export interface PanelHostApi {
  /** Go to a client route. */
  navigate(path: string): void;
  /** The host's state; the panel reads the folder of the chat it sits beside. */
  getState?(): { currentCwd: string | null };
}

/**
 * The route that opens a run's session: `/session?session=<id>&dir=<folder>`.
 *
 * @param run - The run, with a session.
 * @returns The route.
 */
export function sessionRoute(run: PanelRun & { sessionId: string }): string {
  return `/session?session=${encodeURIComponent(run.sessionId)}&dir=${encodeURIComponent(run.cwd)}`;
}

const ROOT: Style = {
  position: 'relative',
  padding: '10px 12px',
  color: hostColor('foreground'),
  fontSize: '12px',
  lineHeight: 1.5,
};

const CAPTION: Style = {
  margin: '8px 0 3px',
  color: hostColor('muted-foreground'),
  fontSize: '10px',
  fontWeight: 400,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};

/** A row that is a button, reset to look like the mockup's row. */
const ROW_BUTTON: Style = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  width: '100%',
  margin: 0,
  border: 0,
  borderRadius: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

const ACCOUNT_ROW: Style = { ...ROW_BUTTON, padding: '3px 0' };

const RUN_ROW: Style = {
  ...ROW_BUTTON,
  padding: '4px 0',
  borderBottom: `1px solid ${hostColor('muted')}`,
};

const DOT: Style = { flex: 'none', width: '8px', height: '8px', borderRadius: '50%' };

const GROW: Style = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const MUTED: Style = { color: hostColor('muted-foreground'), fontSize: '11px' };

const BARS: Style = {
  display: 'flex',
  flex: 'none',
  flexDirection: 'column',
  gap: '2px',
  width: '70px',
};

const TRACK: Style = {
  height: '4px',
  borderRadius: '2px',
  overflow: 'hidden',
  background: hostColor('border'),
};

const PILL: Style = {
  flex: 'none',
  padding: '0 6px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: '9999px',
  color: hostColor('foreground'),
  fontSize: '10px',
  whiteSpace: 'nowrap',
};

const FOOTER: Style = { marginTop: '8px' };

const FOOTER_BUTTON: Style = {
  display: 'inline-block',
  padding: '2px 8px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: '6px',
  background: hostColor('background'),
  color: hostColor('foreground'),
  fontSize: '11px',
  fontFamily: 'inherit',
  cursor: 'pointer',
};

/** The account popover: the host `Popover`'s surface. */
const POPOVER: Style = {
  position: 'absolute',
  left: '12px',
  right: '12px',
  zIndex: 10,
  padding: '10px 12px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: '0.375rem',
  background: hostColor('popover'),
  color: hostColor('popover-foreground'),
  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
};

/** Focus rings for the panel's own buttons, which inline styles cannot express. */
const FOCUS_CSS = `
.flow-panel button:focus-visible,
.flow-panel [role='dialog']:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 1px;
}
.flow-panel button[data-row]:hover { background: hsl(var(--muted) / 0.5); }
`;

/** An account's color dot, hidden from screen readers (the row names the account). */
function Dot(props: { color: string | undefined }): Node {
  return h('span', {
    'aria-hidden': true,
    style: { ...DOT, background: props.color ?? hostColor('muted-foreground') },
  });
}

/** One horizontal bar track, filled in the window's tone. */
function Track(props: { entry: PanelWindow | null; height: string }): Node {
  const tone = barTone(props.entry);
  const fill = barFill(props.entry);
  return h(
    'div',
    { 'data-tone': tone, style: { ...TRACK, height: props.height } },
    tone === 'unknown'
      ? null
      : h('b', {
          style: {
            display: 'block',
            height: props.height,
            width: `${fill}%`,
            background: hostColor(TONE_VARIABLE[tone]),
          },
        })
  );
}

/** An account's two stacked mini bars, 5-hour then weekly. */
function MiniBars(props: { windows: PanelAccount['windows'] }): Node {
  return h(
    'div',
    { role: 'img', 'aria-label': barsSentence(props.windows), style: BARS },
    h(Track, { entry: props.windows.five_hour, height: '4px' }),
    h(Track, { entry: props.windows.seven_day, height: '4px' })
  );
}

/** The popover's windows, labelled as the host's account popover labels them. */
const POPOVER_WINDOWS: readonly { key: keyof PanelAccount['windows']; label: string }[] = [
  { key: 'five_hour', label: '5-hour' },
  { key: 'seven_day', label: 'This week' },
];

/** The account popover: name and plan, then one bar per readable window. */
function AccountPopover(props: {
  account: PanelAccount;
  top: number;
  /** The row that opened it: a press on it toggles, so it must not also close from outside. */
  opener: HTMLElement | undefined;
  onClose: (returnFocus: boolean) => void;
}): Node {
  const { account } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const now = new Date();
  const plan = planName(account.plan);

  useEffect(() => {
    ref.current?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as globalThis.Node;
      if (props.opener?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) {
        props.onClose(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, []);

  return h(
    'div',
    {
      ref,
      role: 'dialog',
      'aria-label': account.label,
      tabIndex: -1,
      style: { ...POPOVER, top: `${props.top}px` },
      onKeyDown: (event: { key: string; preventDefault(): void }) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          props.onClose(true);
        }
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
      h(Dot, { color: account.color }),
      h('span', { style: { ...GROW, fontWeight: 600 } }, account.label),
      plan === null ? null : h('span', { style: MUTED }, plan)
    ),
    ...POPOVER_WINDOWS.flatMap(({ key, label }) => {
      const entry = account.windows[key];
      if (entry === null) return [];
      return [
        h(
          'div',
          { key, style: { marginTop: '6px' } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                gap: '8px',
                fontSize: '11px',
              },
            },
            h('span', null, label),
            h('span', { style: { color: hostColor('muted-foreground') } }, windowDetail(entry, now))
          ),
          h(
            'div',
            {
              role: 'img',
              'aria-label': `${label}: ${windowDetail(entry, now)}`,
              style: { marginTop: '3px' },
            },
            h(Track, { entry, height: '6px' })
          )
        ),
      ];
    })
  );
}

/** The panel's loading state. */
type Phase = { kind: 'loading' } | { kind: 'failed'; failures: number } | { kind: 'ready' };

/** `EventSource.OPEN`, spelled out so a stand-in without the constant still compares. */
const OPEN_STATE = 1;

/**
 * Open the host's event stream and replace the model on each panel event;
 * read the model again whenever the stream opens, and every 30 s while it is
 * not open.
 */
function useLiveModel(
  apply: (model: PanelModel) => void,
  refetch: () => void,
  enabled: boolean
): void {
  useEffect(() => {
    if (!enabled) return;
    let poll: ReturnType<typeof setInterval> | null = null;
    let source: EventSource | null = null;
    // Re-read on a timer only while the stream is down; the browser keeps
    // reconnecting it, and polling stops once it is open again.
    const startPolling = () => {
      poll ??= setInterval(refetch, FALLBACK_POLL_MS);
    };
    const stopPolling = () => {
      if (poll !== null) clearInterval(poll);
      poll = null;
    };
    if (typeof EventSource === 'function') {
      const stream = new EventSource(`${resolveApiBaseUrl()}/events`);
      source = stream;
      source.addEventListener(PANEL_EVENT, (event) => {
        try {
          apply(JSON.parse((event as MessageEvent<string>).data) as PanelModel);
        } catch {
          // A frame that is not a model is ignored; the next one replaces it.
        }
      });
      stream.addEventListener('error', () => {
        if (stream.readyState !== OPEN_STATE) startPolling();
      });
      // Events sent while the stream was down are lost, and the server sends
      // nothing for an unchanged model, so read it once whenever it opens.
      stream.addEventListener('open', () => {
        stopPolling();
        refetch();
      });
    } else {
      startPolling();
    }
    return () => {
      source?.close();
      stopPolling();
    };
  }, [enabled]);
}

/**
 * Build the Flow panel over DorkOS's client API.
 *
 * @param api - The host API (`navigate`, `getState`).
 * @returns The panel component.
 */
export function createFlowPanel(api: PanelHostApi): ComponentType {
  function FlowPanel(): Node {
    const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
    const [model, setModel] = useState<PanelModel | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [retrying, setRetrying] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState<{ key: string; top: number } | null>(null);
    const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const cwd = api.getState?.().currentCwd ?? null;

    const load = () => getPanel(cwd);

    useEffect(() => {
      let live = true;
      load().then(
        (next) => {
          if (!live) return;
          setModel(next);
          setRetrying(false);
          setPhase({ kind: 'ready' });
        },
        () => {
          if (!live) return;
          setRetrying(false);
          // Counts failures that landed, so the alert remounts (and is
          // announced again) only when a retry has failed too.
          setPhase((current) => ({
            kind: 'failed',
            failures: current.kind === 'failed' ? current.failures + 1 : 1,
          }));
        }
      );
      return () => {
        live = false;
      };
    }, [attempt]);

    useLiveModel(
      setModel,
      () => {
        load().then(setModel, () => {});
      },
      phase.kind === 'ready'
    );

    const root = (...children: Node[]): Node =>
      h('div', { className: 'flow-panel', style: ROOT }, h('style', null, FOCUS_CSS), ...children);

    if (phase.kind === 'failed') {
      return root(
        h(
          'p',
          { key: `load-failed-${phase.failures}`, role: 'alert', style: ALERT },
          PANEL_LOAD_FAILED_TEXT
        ),
        h(
          'button',
          {
            type: 'button',
            style: { ...CHIP, marginTop: '6px', cursor: retrying ? 'progress' : 'pointer' },
            'aria-disabled': retrying,
            onClick: () => {
              if (retrying) return;
              setRetrying(true);
              setAttempt((n) => n + 1);
            },
          },
          PANEL_RETRY_TEXT
        )
      );
    }
    if (phase.kind === 'loading' || model === null) return root(h('div', { 'aria-busy': true }));

    const now = new Date();
    const colorOf = (key: string) => model.accounts.find((a) => a.key === key)?.color;
    const pausedAll = model.paused === 'all';

    const closePopover = (returnFocus: boolean) => {
      const key = open?.key;
      setOpen(null);
      if (returnFocus && key !== undefined) rowRefs.current.get(key)?.focus();
    };

    const accountRow = (account: PanelAccount): Node => {
      const state = accountStateText(account, now);
      const expanded = open?.key === account.key;
      return h(
        'button',
        {
          key: account.key,
          type: 'button',
          'data-row': 'account',
          ref: (el: HTMLButtonElement | null) => {
            if (el) rowRefs.current.set(account.key, el);
            else rowRefs.current.delete(account.key);
          },
          'aria-haspopup': 'dialog',
          'aria-expanded': expanded,
          'aria-label': [account.label, state, barsSentence(account.windows)]
            .filter(Boolean)
            .join(', '),
          style: ACCOUNT_ROW,
          onClick: (event: { currentTarget: HTMLElement }) => {
            if (expanded) {
              setOpen(null);
              return;
            }
            const row = event.currentTarget;
            setOpen({ key: account.key, top: row.offsetTop + row.offsetHeight + 2 });
          },
        },
        h(Dot, { color: account.color }),
        h(
          'span',
          { style: GROW },
          account.label,
          state === null ? null : h('span', { style: MUTED }, ` ${state}`)
        ),
        h(MiniBars, { windows: account.windows })
      );
    };

    const runRow = (run: PanelRun, index: number): Node => {
      const name = run.title === null ? run.identifier : `${run.identifier} ${run.title}`;
      const children = [
        h(Dot, { key: 'dot', color: colorOf(run.accountKey) }),
        h('span', { key: 'name', style: GROW }, name),
        h('span', { key: 'pill', style: PILL }, PILL_TEXT[run.state]),
      ];
      const key = `${run.identifier}:${index}`;
      if (run.sessionId === null) {
        return h('div', { key, style: { ...RUN_ROW, cursor: 'default' } }, ...children);
      }
      const withSession = run as PanelRun & { sessionId: string };
      return h(
        'button',
        {
          key,
          type: 'button',
          'data-row': 'run',
          'aria-label': `${name}, ${PILL_TEXT[run.state]}`,
          style: RUN_ROW,
          onClick: () => api.navigate(sessionRoute(withSession)),
        },
        ...children
      );
    };

    const toggle = () => {
      if (busy || !model.canPause) return;
      setBusy(true);
      setError(null);
      (pausedAll ? resumeFlow() : pauseFlow()).then(
        (next) => {
          setModel(next);
          setBusy(false);
        },
        (failure: unknown) => {
          setBusy(false);
          // The panel always says the one approved sentence; flow's own words go to the console.
          console.error('[flow] pause/resume failed:', failure);
          setError(UNREACHABLE_MESSAGE);
        }
      );
    };

    const openAccount = open === null ? undefined : model.accounts.find((a) => a.key === open.key);

    return root(
      h('div', { key: 'cap-accounts', style: { ...CAPTION, marginTop: 0 } }, 'Accounts'),
      ...model.accounts.map(accountRow),
      h('div', { key: 'cap-running', style: CAPTION }, 'Running'),
      ...(model.runs.length === 0
        ? [h('p', { key: 'none', style: { ...MUTED, margin: 0 } }, NOTHING_RUNNING_TEXT)]
        : model.runs.map(runRow)),
      h(
        'div',
        { key: 'footer', style: FOOTER },
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': pausedAll,
            disabled: !model.canPause,
            'aria-disabled': busy || undefined,
            style: {
              ...FOOTER_BUTTON,
              cursor: !model.canPause ? 'not-allowed' : busy ? 'progress' : 'pointer',
              opacity: model.canPause ? 1 : 0.5,
            },
            onClick: toggle,
          },
          pausedAll ? RESUME_TEXT : PAUSE_TEXT
        ),
        model.canPause
          ? h('span', { style: MUTED }, ` · ${pausedAll ? PAUSED_TEXT : slotsText(model.slots)}`)
          : null
      ),
      error === null ? null : h('p', { key: 'error', role: 'alert', style: ALERT }, error),
      model.schedulesOff
        ? h('p', { key: 'schedules', style: { ...MUTED, margin: '6px 0 0' } }, SCHEDULES_OFF_TEXT)
        : null,
      openAccount === undefined || open === null
        ? null
        : h(AccountPopover, {
            key: `popover-${openAccount.key}`,
            account: openAccount,
            top: open.top,
            opener: rowRefs.current.get(openAccount.key),
            onClose: closePopover,
          })
    );
  }
  return FlowPanel as ComponentType;
}
