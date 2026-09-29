/**
 * The project lens (spec `flow-multiproject` §3.2, V3 A): one flow project in
 * one scroll. Its name and tracker with Pause; what is wrong with it; what is
 * running, and in what state; what is up next; and a link to its tracker.
 *
 * @module @dorkos/flow/extension/ui/project-lens
 */

import type { FlowCondition, FlowModel, FlowProject, FlowRunRow } from '../lib/model.ts';
import type { StartKind } from '../lib/start-words.ts';
import { UNREACHABLE_MESSAGE, allowAdapter, pauseFlow, resumeFlow } from './api.ts';
import { StartButton, hasInbox, type AnswerApi } from './answers.ts';
import { DecisionRow } from './page-parts.ts';
import { HOME_PATH, SETTINGS_TAB_LINK, settingsPath, webHref } from './links.ts';
import { PILL_TEXT, clockTime, pausedText, runningCaption } from './panel-format.ts';
import { PauseMenu } from './pause-menu.ts';
import { BUTTON, CAPTION, CONDITION, Dot, GROW, Hint, LINK, MUTED, PILL, ROW } from './parts.ts';
import { h, useEffect, useRef, useState, type Node, type Style } from './react.ts';
import type { FlowStore } from './store.ts';
import { ALERT, hostColor } from './styles.ts';

/** Shown under "Running" when the project runs nothing. */
export const NOTHING_RUNNING_TEXT = 'Nothing is running.';

/** Shown after a resume when DorkOS would not switch flow's schedules back on. */
export const SCHEDULES_OFF_TEXT =
  "DorkOS didn't let flow switch its schedules back on after the pause, so they are still off. Turn them on in Schedules.";

/**
 * Shown while a finished pause's schedules wait to be switched back on: only
 * a DorkOS page open in a browser can do it, as the person.
 *
 * @param name - The project's name.
 * @returns The words.
 */
export function schedulesWaitingText(name: string): string {
  return `Schedules for ${name} stay off until DorkOS is open. Flow switches them back on as soon as it is.`;
}

/** Hidden from sight, read by screen readers. */
const SR_ONLY: Style = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

/** The not-set-up line (§3.2 item 6). */
export const NOT_SET_UP_TEXT = "Flow is installed but doesn't know where your work lives yet.";

/** The line for a project flow saw before the dial existed (§7.7), until a person chooses. */
export const CHOOSE_AUTONOMY_TEXT = 'Flow can do more on its own now.';

/** The line when the morning's sorting could not start by 13:00 (§7.9). */
export const SORT_WAITS_TEXT = 'Sorting waits until tomorrow: flow is busy.';

/** The words where Pause would be, on a DorkOS that cannot tell a person from an agent. */
export const PAUSE_FROM_CHAT_TEXT = 'Pause from a chat in this project.';

/** The route that opens the Marketplace, where flow is updated or installed. */
export const MARKETPLACE_ROUTE = '/marketplace';

/**
 * The route that opens a run's session: `/session?session=<id>&dir=<folder>`.
 *
 * @param run - The run, with a session.
 * @returns The route.
 */
export function sessionRoute(run: Pick<FlowRunRow, 'cwd'> & { sessionId: string }): string {
  return `/session?session=${encodeURIComponent(run.sessionId)}&dir=${encodeURIComponent(run.cwd)}`;
}

/** The tracker's name, for the words ("Linear"), or "the tracker". */
function trackerName(project: FlowProject): string {
  return project.tracker?.label ?? 'the tracker';
}

/**
 * A condition's line in the lens, with the ⓘ a button would stand in for, or
 * `null` for one the lens shows elsewhere (paused is in the header).
 *
 * @param condition - The condition.
 * @param project - Its project.
 * @param locale - The locale for times (default: the browser's).
 * @returns The words and the hint, or `null`.
 */
export function conditionLine(
  condition: FlowCondition,
  project: FlowProject,
  locale?: string
): {
  text: string;
  hint: string | null;
  /** The button that fixes it by starting work in a new chat (§7.9), when there is one. */
  start?: { kind: StartKind; label: string; count: number | null };
} | null {
  const tracker = trackerName(project);
  switch (condition.kind) {
    case 'tracker-unreachable':
      return {
        text: `${tracker} hasn't answered since ${clockTime(new Date(condition.since), locale)}. Flow keeps trying. Nothing is lost.`,
        hint: null,
      };
    case 'sign-in':
      return {
        text: `Sign in to ${tracker} again. Flow can't read or update ${project.name}'s work in ${tracker} until you do. Nothing is lost; it's waiting.`,
        hint: `In a chat in ${project.name}, type /flow:init and ask it to reconnect ${tracker}.`,
        start: { kind: 'sign-in', label: 'Sign in', count: null },
      };
    case 'settings-problem':
      return {
        text: `Flow's settings in ${project.name} have a problem, so it can't read ${tracker}.`,
        hint: `In a chat in ${project.name}, type /flow:status to see what is wrong.`,
      };
    case 'nothing-ready':
      return {
        text: `${condition.detail.untriaged ?? 'Some'} new ideas haven't been sorted. Flow has had nothing ready to work on in ${project.name} for a day.`,
        hint: `In a chat in ${project.name}, type /flow:triage to sort them.`,
        start: { kind: 'sort', label: 'Sort them', count: condition.detail.untriaged ?? null },
      };
    default:
      return null;
  }
}

/**
 * Why "Up next" is not shown, or `null` when it is (or simply not read yet).
 *
 * @param project - The project.
 * @returns The words, or `null`.
 */
export function upNextNote(project: FlowProject): string | null {
  if (project.queue !== null || project.setup !== 'ready') return null;
  if (project.upNext === 'agent-only') {
    return `Up next is shown when flow can reach ${trackerName(project)} from here.`;
  }
  if (project.upNext === 'own-code') {
    return `Read ${trackerName(project)} with this project's own adapter? It runs code from this repo.`;
  }
  return null;
}

/**
 * The version line (§9.3): only when the project's flow is older in a way
 * that changes what it does.
 *
 * @param project - The project.
 * @returns The words, or `null`.
 */
export function versionLine(project: FlowProject): string | null {
  const { flow, olderBehaviour } = project.version;
  if (olderBehaviour === null) return null;
  const which = flow === null ? 'an older flow' : `an older flow (${flow})`;
  // Each level's effect says what the newer engine does ("timed pauses end on
  // time"); the line says the older one may not.
  const lacking = / end on time$/.test(olderBehaviour)
    ? olderBehaviour.replace(/ end on time$/, ' may not end on time')
    : `it may not do this yet: ${olderBehaviour}`;
  return `${project.name} runs ${which}, so ${lacking}.`;
}

const HEADER: Style = { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' };

const FOOTER: Style = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  marginTop: '10px',
  paddingTop: '8px',
  borderTop: `1px solid ${hostColor('muted')}`,
  fontSize: '11px',
};

/**
 * The ⚙ button's accessible name.
 *
 * @param name - The project's name.
 * @returns The words.
 */
export function settingsLabel(name: string): string {
  return `Flow settings for ${name}`;
}

/**
 * The project lens.
 *
 * @param props - The project, the model it came from, the host API, the store,
 *   whether this DorkOS shows flow's pages, and how to show every project
 *   instead where it does not.
 * @returns The lens.
 */
export function ProjectLens(props: {
  project: FlowProject;
  model: FlowModel;
  api: AnswerApi;
  store: FlowStore;
  schedulesStuck?: boolean;
  /** Whether flow's pages exist: then ⚙ and "need you elsewhere" open them. */
  pages?: boolean;
  onShowAll?: () => void;
  /**
   * Whether the project's asks show at the top: by default only on a DorkOS
   * without the inbox, where the lens is where they are answered (§3.2, §7.6).
   */
  decisionsOnTop?: boolean;
}): Node {
  const { project, model, api, store } = props;
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focusHeader, setFocusHeader] = useState(false);
  const headerButton = useRef<HTMLButtonElement | null>(null);
  // After the menu closes or a pause lands, focus goes back to Pause (or the
  // Resume that replaced it), never to the top of the page.
  useEffect(() => {
    if (!focusHeader || busy) return;
    headerButton.current?.focus();
    setFocusHeader(false);
  }, [focusHeader, busy]);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();
  const target = { project: project.name };

  const act = (write: () => Promise<FlowModel>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMenu(false);
    write().then(
      (next) => {
        store.apply(next);
        setBusy(false);
        setFocusHeader(true);
      },
      (failure: unknown) => {
        setBusy(false);
        setFocusHeader(true);
        setError(failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE);
      }
    );
  };

  const header = (): Node => {
    const children: Node[] = [h('b', { key: 'name', style: { fontSize: '13px' } }, project.name)];
    if (project.tracker !== null) {
      const team = project.tracker.team === null ? '' : ` ${project.tracker.team}`;
      children.push(
        h('span', { key: 'tracker', style: MUTED }, `· ${project.tracker.label}${team}`)
      );
    }
    children.push(h('span', { key: 'gap', style: { flex: 1 } }));
    if (project.setup === 'ready') {
      if (!model.canChange) {
        children.push(
          h(
            'span',
            { key: 'pause-hint', style: MUTED },
            project.pause === null ? PAUSE_FROM_CHAT_TEXT : pausedText(project.pause, now),
            h(Hint, {
              text:
                project.pause === null
                  ? `Type /flow:pause in a chat in ${project.name}. This DorkOS can't yet tell you apart from an agent, so the button is off.`
                  : `Type /flow:resume in a chat in ${project.name}.`,
            })
          )
        );
      } else if (project.pause !== null) {
        children.push(
          h('span', { key: 'paused', style: MUTED }, pausedText(project.pause, now)),
          h(
            'button',
            {
              key: 'resume',
              ref: headerButton,
              type: 'button',
              style: { ...BUTTON, cursor: busy ? 'progress' : 'pointer' },
              'aria-disabled': busy || undefined,
              onClick: () => act(() => resumeFlow(target)),
            },
            'Resume'
          )
        );
      } else {
        children.push(
          h(
            'button',
            {
              key: 'pause',
              ref: headerButton,
              type: 'button',
              style: { ...BUTTON, cursor: busy ? 'progress' : 'pointer' },
              'aria-haspopup': 'menu',
              'aria-expanded': menu,
              'aria-disabled': busy || undefined,
              onClick: () => setMenu((open: boolean) => !open && !busy),
            },
            'Pause'
          )
        );
      }
    }
    children.push(
      h(
        'button',
        {
          key: 'settings',
          type: 'button',
          title: 'Settings',
          'aria-label': settingsLabel(project.name),
          style: BUTTON,
          // Without pages, Settings → Flow is the only settings flow has.
          onClick: () =>
            api.navigate(props.pages === true ? settingsPath(project.name) : SETTINGS_TAB_LINK),
        },
        '⚙'
      )
    );
    return h('div', { key: 'header', style: HEADER }, ...children);
  };

  const runRow = (run: FlowRunRow, index: number): Node => {
    const name = run.title === null ? run.identifier : `${run.identifier} ${run.title}`;
    const children = [
      h(Dot, { key: 'dot', color: run.account.color }),
      h('span', { key: 'name', style: GROW }, name),
      h('span', { key: 'pill', style: PILL }, PILL_TEXT[run.state]),
    ];
    const key = `${run.identifier}:${index}`;
    if (run.sessionId === null) {
      return h(
        'div',
        { key, style: ROW },
        ...children,
        h('span', { key: 'account', style: SR_ONLY }, `, on ${run.account.label}`)
      );
    }
    const sessionId = run.sessionId;
    return h(
      'button',
      {
        key,
        type: 'button',
        'data-row': 'run',
        'aria-label': `${name}, ${PILL_TEXT[run.state]}, on ${run.account.label}. Open its chat`,
        style: { ...ROW, cursor: 'pointer' },
        onClick: () => api.navigate(sessionRoute({ sessionId, cwd: run.cwd })),
      },
      ...children
    );
  };

  const body: Node[] = [header()];
  if (menu && model.canChange && project.pause === null) {
    body.push(
      h(
        'div',
        {
          key: 'menu',
          style: { position: 'absolute', right: '12px', zIndex: 10, marginTop: '4px' },
        },
        h(PauseMenu, {
          label: `Pause flow in ${project.name}`,
          onChoose: (until) => act(() => pauseFlow(target, until)),
          opener: () => headerButton.current,
          onClose: (returnFocus) => {
            setMenu(false);
            if (returnFocus) setFocusHeader(true);
          },
        })
      )
    );
  }
  if (error !== null) body.push(h('p', { key: 'error', role: 'alert', style: ALERT }, error));
  if (project.restoreSchedules.length > 0) {
    body.push(
      h(
        'p',
        { key: 'schedules', style: CONDITION },
        props.schedulesStuck === true ? SCHEDULES_OFF_TEXT : schedulesWaitingText(project.name)
      )
    );
  }

  const canStart = typeof api.startWork === 'function';
  const place = { name: project.name, root: project.root, tracker: project.tracker?.label ?? null };
  if (props.decisionsOnTop ?? !hasInbox(api)) {
    for (const decision of model.decisions.filter((d) => d.project === project.name)) {
      body.push(
        h(DecisionRow, {
          key: `ask-${decision.key}`,
          decision,
          showProject: false,
          api,
          root: project.root,
          store,
        })
      );
    }
  }
  if (project.setup === 'not-set-up') {
    body.push(
      h(
        'p',
        { key: 'setup', style: CONDITION },
        NOT_SET_UP_TEXT,
        canStart
          ? h(StartButton, { kind: 'connect', label: 'Connect a tracker', project: place, api })
          : h(Hint, { text: `Type /flow:init in a chat in ${project.name} to connect a tracker.` })
      )
    );
  } else {
    for (const condition of project.conditions) {
      const line = conditionLine(condition, project);
      if (line === null) continue;
      body.push(
        h(
          'p',
          { key: `condition-${condition.kind}`, style: CONDITION },
          line.text,
          line.start !== undefined && canStart
            ? h(StartButton, {
                kind: line.start.kind,
                label: line.start.label,
                project: place,
                count: line.start.count,
                api,
              })
            : line.hint === null
              ? null
              : h(Hint, { text: line.hint })
        )
      );
    }
    if (project.sortWaits) {
      body.push(h('p', { key: 'sort-waits', style: CONDITION }, SORT_WAITS_TEXT));
    }
    const dial = project.autonomy;
    if (dial !== null && !dial.chosen && dial.firstSeen === 'existing') {
      body.push(
        h(
          'p',
          { key: 'autonomy', style: { ...MUTED, marginTop: '6px' } },
          `${CHOOSE_AUTONOMY_TEXT} `,
          h(
            'button',
            {
              type: 'button',
              style: LINK,
              onClick: () =>
                api.navigate(props.pages === true ? settingsPath(project.name) : SETTINGS_TAB_LINK),
            },
            'Choose how much →'
          )
        )
      );
    }
    const running = project.runs.filter((run) => run.state !== 'done');
    body.push(h('div', { key: 'cap-running', style: CAPTION }, runningCaption(project.capacity)));
    if (running.length === 0) {
      body.push(h('p', { key: 'none', style: MUTED }, NOTHING_RUNNING_TEXT));
    } else {
      body.push(...running.map(runRow));
    }
    if (project.queue !== null) {
      body.push(h('div', { key: 'cap-next', style: CAPTION }, 'Up next'));
      if (project.queue.next.length === 0) {
        body.push(h('p', { key: 'next-none', style: MUTED }, 'Nothing ready to work on.'));
      }
      project.queue.next.forEach((item, index) => {
        body.push(
          h(
            'div',
            {
              key: `next-${item.identifier}`,
              style: { ...ROW, borderBottom: 0, padding: '2px 0' },
            },
            h('span', { style: { ...MUTED, flex: 'none', width: '12px' } }, String(index + 1)),
            h('span', { style: GROW }, `${item.identifier} ${item.title}`.trim())
          )
        );
      });
      if (project.queue.more > 0) {
        body.push(h('p', { key: 'more', style: MUTED }, `+ ${project.queue.more} more`));
      }
    } else {
      const note = upNextNote(project);
      if (note !== null) {
        const allow =
          project.upNext === 'own-code' && model.canChange
            ? h(
                'button',
                {
                  type: 'button',
                  style: { ...LINK, marginLeft: '4px' },
                  onClick: () => act(() => allowAdapter(project.name)),
                },
                'Allow'
              )
            : null;
        body.push(h('p', { key: 'next-note', style: { ...MUTED, marginTop: '8px' } }, note, allow));
      }
    }
  }

  const version = versionLine(project);
  if (version !== null) {
    body.push(
      h(
        'p',
        { key: 'version', style: { ...MUTED, marginTop: '10px' } },
        `${version} `,
        h(
          'button',
          { type: 'button', style: LINK, onClick: () => api.navigate(MARKETPLACE_ROUTE) },
          'Update flow here'
        )
      )
    );
  }

  const elsewhere = model.decisions.filter((decision) => decision.project !== project.name).length;
  const showElsewhere =
    props.pages === true ? () => api.navigate(HOME_PATH) : (props.onShowAll ?? null);
  const trackerUrl = webHref(project.tracker?.url);
  if ((elsewhere > 0 && showElsewhere !== null) || trackerUrl !== null) {
    body.push(
      h(
        'div',
        { key: 'footer', style: FOOTER },
        elsewhere > 0 && showElsewhere !== null
          ? h(
              'button',
              { type: 'button', style: LINK, onClick: showElsewhere },
              `${elsewhere} need${elsewhere === 1 ? 's' : ''} you elsewhere →`
            )
          : h('span'),
        trackerUrl === null
          ? null
          : h(
              'a',
              {
                href: trackerUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: { ...LINK, color: 'inherit' },
              },
              `Open in ${trackerName(project)} ↗`
            )
      )
    );
  }
  return h('div', null, ...body);
}
