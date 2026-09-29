/**
 * Flow's full pages (spec `flow-multiproject` §4, V4, N8):
 *
 * - **Flow home** at `/x/flow`: every project in three bands, what needs you,
 *   what's off, and what's fine, with a project filter kept in the page's
 *   address (`?project=<name>`) so it can be bookmarked and shared, "Pause all
 *   projects", and a second tab, "Capacity this week" (`?tab=capacity`). With
 *   one project it shows that project's page instead, so no link ever lands
 *   on an empty home.
 * - **A project's page** at `/x/flow/p/<name>`: the project lens, full width,
 *   under its open decisions. On a phone, which has no side panel, this is
 *   where a project is looked at.
 * - **A project's settings** at `/x/flow/p/<name>/settings` (`project-settings.ts`).
 *
 * All three read the one live store. They are registered only on a DorkOS
 * that has pages.
 *
 * @module @dorkos/flow/extension/ui/home-page
 */

import type { ComponentType } from 'react';
import type { FlowDecision, FlowModel, FlowProject } from '../lib/model.ts';
import type { ClientApi, ExtensionPageProps } from '../lib/host-types.ts';
import { UNREACHABLE_MESSAGE, pauseFlow, resumeFlow } from './api.ts';
import { CapacityTab } from './capacity-view.ts';
import { FlowIcon } from './flow-icon.ts';
import { HOME_PATH, PAGE_PATHS, projectPath } from './links.ts';
import {
  MARKETPLACE_ROUTE,
  ProjectLens,
  conditionLine,
  schedulesWaitingText,
} from './project-lens.ts';
import { ProjectSettings } from './project-settings.ts';
import { ANSWERED_IN_FLOW_NOTE, answeredHere, hasInbox, type AnswerApi } from './answers.ts';
import { BAND, BAND_ROW, DecisionRow, SR_ONLY, loadingState, pageRoot } from './page-parts.ts';
import { pausedText } from './panel-format.ts';
import { FROM_CHAT_HINT, FROM_CHAT_TEXT } from './palette.ts';
import { PauseMenu } from './pause-menu.ts';
import { BUTTON, Hint, LINK, MUTED } from './parts.ts';
import { h, useEffect, useRef, useState, type Node, type Style } from './react.ts';
import { useStore, type FlowStore } from './store.ts';
import { ALERT } from './styles.ts';

/** Said when no project on this computer has flow. */
export const HOME_EMPTY_TEXT = "Flow isn't set up in any project yet.";

/** The filter's "every project" choice. */
export const ALL_PROJECTS_TEXT = 'All projects';

/**
 * Said above the bands when the address names a project that is gone.
 *
 * @param name - The name in the address.
 * @returns The words.
 */
export function missingFilterText(name: string): string {
  return `No project is called ${name} any more.`;
}

/**
 * Said on a project page for a name flow does not know.
 *
 * @param name - The name in the address.
 * @returns The words.
 */
export function unknownProjectText(name: string): string {
  return `No flow project is called ${name} on this computer.`;
}

/** A project with something wrong: its words, whether it is paused, and how to fix it by hand. */
export interface OffLine {
  /** The project. */
  project: FlowProject;
  /** What is wrong. */
  text: string;
  /** Whether Resume fixes it. */
  paused: boolean;
  /** The ⓘ text, or `null`. */
  hint: string | null;
}

/** A quiet project and its one line. */
export interface FineLine {
  /** The project. */
  project: FlowProject;
  /** "2 running · 4 up next", "Nothing ready to work on". */
  text: string;
  /** The ⓘ text, or `null`. */
  hint: string | null;
}

/** Flow home's three bands. */
export interface HomeBands {
  /** Open decisions, oldest first. */
  needsYou: FlowDecision[];
  /** Projects with a live condition. */
  off: OffLine[];
  /** Every other project. */
  fine: FineLine[];
}

/** The conditions from most to least urgent. */
const CONDITION_ORDER: Readonly<Record<string, number>> = {
  'sign-in': 0,
  'settings-problem': 1,
  'tracker-unreachable': 2,
  'nothing-ready': 3,
  paused: 4,
};

/**
 * A quiet project's line: what is running and what is next, in facts.
 *
 * @param project - The project.
 * @returns The words and any ⓘ.
 */
export function fineLine(project: FlowProject): FineLine {
  if (project.setup === 'not-set-up') {
    return {
      project,
      text: "Flow isn't set up here yet",
      hint: `Type /flow:init in a chat in ${project.name} to connect a tracker.`,
    };
  }
  const running = project.runs.filter((run) => run.state !== 'done').length;
  const next = project.queue === null ? null : project.queue.next.length + project.queue.more;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (next !== null && next > 0) parts.push(`${next} up next`);
  if (parts.length > 0) return { project, text: parts.join(' · '), hint: null };
  return {
    project,
    text: next === null ? 'Nothing running' : 'Nothing ready to work on',
    hint: null,
  };
}

/**
 * Sort the model into Flow home's bands, narrowed to one project when the
 * filter names one.
 *
 * @param model - The model.
 * @param filter - A project's name, or `null` for all.
 * @param now - The clock, for pause ends.
 * @param locale - The locale for times (default: the browser's).
 * @returns The bands.
 */
export function homeBands(
  model: FlowModel,
  filter: string | null,
  now: Date,
  locale?: string
): HomeBands {
  const shown = (name: string) => filter === null || name === filter;
  const needsYou = model.decisions
    .filter((decision) => shown(decision.project))
    .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  const off: OffLine[] = [];
  const fine: FineLine[] = [];
  for (const project of model.projects) {
    if (!shown(project.name)) continue;
    const worst = [...project.conditions].sort(
      (a, b) => CONDITION_ORDER[a.kind] - CONDITION_ORDER[b.kind]
    )[0];
    const paused = project.pause !== null;
    const pauseWords =
      paused && project.pause !== null ? pausedText(project.pause, now, locale) : null;
    if (worst === undefined && project.restoreSchedules.length === 0) {
      fine.push(fineLine(project));
      continue;
    }
    let text: string;
    let hint: string | null = null;
    if (worst === undefined || worst.kind === 'paused') {
      text = pauseWords ?? schedulesWaitingText(project.name);
    } else if (worst.kind === 'sign-in') {
      text = `Sign in to ${project.tracker?.label ?? 'the tracker'} again`;
      hint = conditionLine(worst, project, locale)?.hint ?? null;
    } else {
      const line = conditionLine(worst, project, locale);
      text = line?.text ?? '';
      hint = line?.hint ?? null;
    }
    if (pauseWords !== null && worst !== undefined && worst.kind !== 'paused') {
      text = `${text} · ${pauseWords}`;
    }
    off.push({ project, text, paused, hint });
  }
  off.sort(
    (a, b) =>
      CONDITION_ORDER[worstKind(a.project)] - CONDITION_ORDER[worstKind(b.project)] ||
      a.project.name.localeCompare(b.project.name)
  );
  return { needsYou, off, fine };
}

/** A project's most urgent condition's kind, `paused` when it has none. */
function worstKind(project: FlowProject): string {
  return (
    [...project.conditions].sort((a, b) => CONDITION_ORDER[a.kind] - CONDITION_ORDER[b.kind])[0]
      ?.kind ?? 'paused'
  );
}

/** How "Pause all projects" reads now. */
export type PauseAllState =
  { kind: 'none' } | { kind: 'pause' } | { kind: 'paused'; text: string; resume: string };

/**
 * What the home's pause control is: "Pause all projects", or, when every
 * set-up project is paused, "Paused until 9:00" (one end) or "Paused" (several)
 * with Resume.
 *
 * @param model - The model.
 * @param now - The clock.
 * @param locale - The locale (default: the browser's).
 * @returns The state.
 */
export function pauseAllState(model: FlowModel, now: Date, locale?: string): PauseAllState {
  const ready = model.projects.filter((project) => project.setup === 'ready');
  if (ready.length === 0) return { kind: 'none' };
  if (!ready.every((project) => project.pause !== null)) return { kind: 'pause' };
  const ends = new Set(ready.map((project) => project.pause?.until ?? null));
  if (ends.size === 1) {
    const [pause] = ready.map((project) => project.pause!);
    return { kind: 'paused', text: pausedText(pause, now, locale), resume: 'Resume' };
  }
  return { kind: 'paused', text: 'Paused', resume: 'Resume all' };
}

/** A row's left column: the project's name, which opens its page. */
function ProjectName(props: { name: string; api: Pick<ClientApi, 'navigate'> }): Node {
  return h(
    'button',
    {
      type: 'button',
      className: 'flow-pcol',
      style: {
        ...LINK,
        fontSize: 'inherit',
        fontWeight: 600,
        textAlign: 'left',
        textDecoration: 'none',
      },
      onClick: () => props.api.navigate(projectPath(props.name)),
    },
    props.name
  );
}

/** Where the pause menu opens, under the control. */
const MENU_AT: Style = {
  position: 'absolute',
  right: 0,
  top: '100%',
  zIndex: 10,
  marginTop: '4px',
};

/**
 * "Pause all projects ▾", or the paused state with Resume.
 *
 * @param props - The model and the store.
 * @returns The control, or nothing when no project is set up.
 */
function PauseAll(props: { model: FlowModel; store: FlowStore }): Node {
  const { model, store } = props;
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const state = pauseAllState(model, new Date());
  if (state.kind === 'none') return null;
  if (!model.canChange) {
    return h('span', { style: MUTED }, FROM_CHAT_TEXT, h(Hint, { text: FROM_CHAT_HINT }));
  }
  const act = (write: () => Promise<FlowModel>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMenu(false);
    write().then(
      (next) => {
        store.apply(next);
        setBusy(false);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE);
      }
    );
  };
  const control =
    state.kind === 'paused'
      ? [
          h('span', { key: 'text', style: MUTED }, state.text),
          h(
            'button',
            {
              key: 'resume',
              type: 'button',
              style: { ...BUTTON, cursor: busy ? 'progress' : 'pointer' },
              'aria-disabled': busy || undefined,
              onClick: () => act(() => resumeFlow({ all: true })),
            },
            state.resume
          ),
        ]
      : [
          h(
            'button',
            {
              key: 'pause',
              ref: opener,
              type: 'button',
              style: { ...BUTTON, cursor: busy ? 'progress' : 'pointer' },
              'aria-haspopup': 'menu',
              'aria-expanded': menu,
              'aria-disabled': busy || undefined,
              onClick: () => setMenu((open: boolean) => !open && !busy),
            },
            'Pause all projects ▾'
          ),
        ];
  return h(
    'div',
    {
      style: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
      },
    },
    ...control,
    menu
      ? h(
          'div',
          { style: MENU_AT },
          h(PauseMenu, {
            label: 'Pause all projects',
            defaultChoice: 'tomorrow',
            opener: () => opener.current,
            onChoose: (until) => act(() => pauseFlow({ all: true }, until)),
            onClose: (returnFocus) => {
              setMenu(false);
              if (returnFocus) opener.current?.focus();
            },
          })
        )
      : null,
    error === null ? null : h('p', { role: 'alert', style: { ...ALERT, flexBasis: '100%' } }, error)
  );
}

/** The home's two tabs, in order. */
const TAB_IDS = ['projects', 'capacity'] as const;

/** The id of the home's tab panel, which both tabs control. */
export const HOME_PANEL_ID = 'flow-home-panel';

/**
 * A tab's element id.
 *
 * @param id - The tab.
 * @returns Its id.
 */
export function homeTabId(id: (typeof TAB_IDS)[number]): string {
  return `flow-home-tab-${id}`;
}

/** A tab the arrow keys just moved to, focused once it has drawn. */
let focusNext: string | null = null;

/**
 * The home's tabs, Projects and Capacity this week. The chosen one lives in
 * the page's address. Left and right arrows move between them, as tabs do.
 */
function Tabs(props: {
  tab: 'projects' | 'capacity';
  setSearch: ExtensionPageProps['setSearch'];
}): Node {
  useEffect(() => {
    if (focusNext === null) return;
    document.getElementById(focusNext)?.focus();
    focusNext = null;
  });
  const choose = (id: (typeof TAB_IDS)[number]) =>
    props.setSearch({ tab: id === 'capacity' ? 'capacity' : null });
  const tab = (id: (typeof TAB_IDS)[number], label: string) =>
    h(
      'button',
      {
        key: id,
        id: homeTabId(id),
        type: 'button',
        role: 'tab',
        'aria-selected': props.tab === id,
        'aria-controls': HOME_PANEL_ID,
        tabIndex: props.tab === id ? 0 : -1,
        style: {
          padding: '0 0 5px',
          border: 0,
          borderBottom: `2px solid ${props.tab === id ? 'currentColor' : 'transparent'}`,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontWeight: props.tab === id ? 600 : 400,
          opacity: props.tab === id ? 1 : 0.7,
          cursor: 'pointer',
        },
        onClick: () => choose(id),
        onKeyDown: (event: { key: string; preventDefault(): void }) => {
          const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (step === 0) return;
          event.preventDefault();
          const next = TAB_IDS[(TAB_IDS.indexOf(id) + step + TAB_IDS.length) % TAB_IDS.length];
          focusNext = homeTabId(next);
          choose(next);
        },
      },
      label
    );
  return h(
    'div',
    {
      role: 'tablist',
      'aria-label': 'Flow home',
      style: {
        display: 'flex',
        gap: '16px',
        margin: '12px 0 4px',
        borderBottom: '1px solid hsl(var(--muted))',
      },
    },
    tab('projects', 'Projects'),
    tab('capacity', 'Capacity this week')
  );
}

/**
 * The note above asks answered on flow's pages (§4.2): shown once, only on a
 * DorkOS with the inbox (where such answers are credited to Flow), and only
 * when at least one ask here is answered in place.
 *
 * @param decisions - The asks shown.
 * @param api - The host API.
 * @returns The note, or `null`.
 */
function answeredInFlowNote(decisions: readonly FlowDecision[], api: AnswerApi): Node {
  if (!hasInbox(api) || !decisions.some((decision) => answeredHere(decision, api))) return null;
  return h(
    'p',
    { key: 'answered-in-flow', style: { ...MUTED, margin: '0 0 4px' } },
    ANSWERED_IN_FLOW_NOTE
  );
}

/**
 * A project's lens as a page: its open decisions first (a phone has no inbox
 * beside it), then the lens full width.
 */
function LensPage(props: {
  project: FlowProject;
  model: FlowModel;
  api: AnswerApi;
  store: FlowStore;
  schedulesStuck: boolean;
  /** Shown under the lens: the way to Capacity at one project. */
  footer?: Node;
}): Node {
  const { project, model, api } = props;
  const decisions = model.decisions.filter((decision) => decision.project === project.name);
  return pageRoot(
    model.projects.length > 1
      ? h(
          'button',
          { type: 'button', style: LINK, onClick: () => api.navigate(HOME_PATH) },
          '← Flow home'
        )
      : null,
    decisions.length > 0
      ? h(
          'section',
          { 'aria-label': 'Needs you', style: { marginTop: '8px' } },
          h('h2', { style: BAND }, `Needs you · ${decisions.length}`),
          answeredInFlowNote(decisions, api),
          ...decisions.map((decision) =>
            h(DecisionRow, {
              key: decision.key,
              decision,
              showProject: false,
              api,
              root: project.root,
              store: props.store,
            })
          )
        )
      : null,
    h(
      'div',
      { style: { position: 'relative', marginTop: '10px', fontSize: '13px' } },
      h(ProjectLens, {
        project,
        model,
        api,
        store: props.store,
        schedulesStuck: props.schedulesStuck,
        pages: true,
        // The page shows the project's asks in its own band above.
        decisionsOnTop: false,
      })
    ),
    props.footer ?? null
  );
}

/**
 * Build the three page components over the live store.
 *
 * @param api - The host API.
 * @param store - The live store.
 * @returns The home, a project's page, and its settings page.
 */
export function createPages(
  api: AnswerApi,
  store: FlowStore
): {
  home: ComponentType<ExtensionPageProps>;
  project: ComponentType<ExtensionPageProps>;
  settings: ComponentType<ExtensionPageProps>;
} {
  function HomePage(props: ExtensionPageProps): Node {
    const snapshot = useStore(store);
    const waiting = loadingState(snapshot, store);
    if (waiting !== null) return waiting;
    const model = snapshot.model!;
    const tab = props.search.tab === 'capacity' ? 'capacity' : 'projects';
    if (model.projects.length === 0) {
      return pageRoot(
        h('h1', { style: SR_ONLY }, 'Flow'),
        h('p', { style: { margin: '12px 0 4px' } }, HOME_EMPTY_TEXT),
        h(
          'button',
          { type: 'button', style: LINK, onClick: () => api.navigate(MARKETPLACE_ROUTE) },
          'Find flow in the Marketplace →'
        )
      );
    }
    if (model.projects.length === 1 && tab === 'projects') {
      const [only] = model.projects;
      return h(LensPage, {
        project: only,
        model,
        api,
        store,
        schedulesStuck: snapshot.schedulesStuck.has(only.name),
        footer: h(
          'p',
          { style: { margin: '14px 0 0' } },
          h(
            'button',
            { type: 'button', style: LINK, onClick: () => props.setSearch({ tab: 'capacity' }) },
            'Capacity this week →'
          )
        ),
      });
    }
    // An empty ?project= is no filter at all.
    const asked = props.search.project || null;
    const known = asked !== null && model.projects.some((project) => project.name === asked);
    const filter = known ? asked : null;
    const header = h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
      // DorkOS's bar over the page already shows "Flow"; the heading stays for screen readers.
      h('h1', { style: SR_ONLY }, 'Flow'),
      h('span', { style: { flex: 1 } }),
      h(PauseAll, { model, store })
    );
    const filterControl =
      model.projects.length > 1
        ? h(
            'select',
            {
              'aria-label': 'Show projects',
              value: filter ?? '',
              style: { ...BUTTON, padding: '2px 6px', fontSize: '12px', marginTop: '8px' },
              onChange: (event: { target: { value: string } }) =>
                props.setSearch({ project: event.target.value === '' ? null : event.target.value }),
            },
            h('option', { value: '' }, ALL_PROJECTS_TEXT),
            ...model.projects.map((project) =>
              h('option', { key: project.name, value: project.name }, project.name)
            )
          )
        : null;
    const missing =
      asked !== null && !known
        ? h(
            'p',
            { role: 'status', style: { ...MUTED, marginTop: '6px' } },
            missingFilterText(asked)
          )
        : null;
    if (tab === 'capacity') {
      return pageRoot(
        header,
        h(Tabs, { tab, setSearch: props.setSearch }),
        filterControl,
        missing,
        h(
          'div',
          {
            role: 'tabpanel',
            id: HOME_PANEL_ID,
            'aria-labelledby': homeTabId('capacity'),
          },
          h(CapacityTab, { project: filter })
        )
      );
    }
    const bands = homeBands(model, filter, new Date());
    const band = (label: string, count: number, rows: Node[]) =>
      count === 0
        ? null
        : h(
            'section',
            { key: label, 'aria-label': label },
            h('h2', { style: BAND }, `${label} · ${count}`),
            ...rows
          );
    return pageRoot(
      header,
      h(Tabs, { tab, setSearch: props.setSearch }),
      filterControl,
      missing,
      h(
        'div',
        { role: 'tabpanel', id: HOME_PANEL_ID, 'aria-labelledby': homeTabId('projects') },
        band('Needs you', bands.needsYou.length, [
          answeredInFlowNote(bands.needsYou, api),
          ...bands.needsYou.map((decision) =>
            h(DecisionRow, {
              key: decision.key,
              decision,
              showProject: true,
              api,
              root: model.projects.find((p) => p.name === decision.project)?.root ?? null,
              store,
            })
          ),
        ]),
        band(
          "Something's off",
          bands.off.length,
          bands.off.map((line) =>
            h(
              'div',
              { key: line.project.root, className: 'flow-drow', style: BAND_ROW },
              h(ProjectName, { name: line.project.name, api }),
              h(
                'span',
                { style: { flex: 1, minWidth: 0 } },
                line.text,
                line.hint === null ? null : h(Hint, { text: line.hint })
              ),
              line.paused && model.canChange
                ? h(ResumeButton, { project: line.project.name, store })
                : null
            )
          )
        ),
        band(
          'All fine',
          bands.fine.length,
          bands.fine.map((line) =>
            h(
              'div',
              { key: line.project.root, className: 'flow-drow', style: BAND_ROW },
              h(ProjectName, { name: line.project.name, api }),
              h(
                'span',
                { style: { ...MUTED, fontSize: '12px', flex: 1, minWidth: 0 } },
                line.text,
                line.hint === null ? null : h(Hint, { text: line.hint })
              )
            )
          )
        )
      )
    );
  }

  function ProjectPage(props: ExtensionPageProps): Node {
    const snapshot = useStore(store);
    const waiting = loadingState(snapshot, store);
    if (waiting !== null) return waiting;
    const model = snapshot.model!;
    const name = props.params.name ?? '';
    const project = model.projects.find((candidate) => candidate.name === name);
    if (project === undefined) return unknownProject(name, api);
    return h(LensPage, {
      project,
      model,
      api,
      store,
      schedulesStuck: snapshot.schedulesStuck.has(project.name),
    });
  }

  function SettingsPage(props: ExtensionPageProps): Node {
    const snapshot = useStore(store);
    const waiting = loadingState(snapshot, store);
    if (waiting !== null) return waiting;
    const name = props.params.name ?? '';
    const project = snapshot.model!.projects.find((candidate) => candidate.name === name);
    if (project === undefined) return unknownProject(name, api);
    return pageRoot(h(ProjectSettings, { project, api }));
  }

  return {
    home: HomePage as ComponentType<ExtensionPageProps>,
    project: ProjectPage as ComponentType<ExtensionPageProps>,
    settings: SettingsPage as ComponentType<ExtensionPageProps>,
  };
}

/** A project page for a name flow does not know. */
function unknownProject(name: string, api: Pick<ClientApi, 'navigate'>): Node {
  return pageRoot(
    h('p', { style: { margin: '0 0 6px' } }, unknownProjectText(name)),
    h(
      'button',
      { type: 'button', style: LINK, onClick: () => api.navigate(HOME_PATH) },
      'Open Flow home →'
    )
  );
}

/** Resume one paused project from the home's "Something's off" band. */
function ResumeButton(props: { project: string; store: FlowStore }): Node {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return h(
    'span',
    { style: { flex: 'none' } },
    h(
      'button',
      {
        type: 'button',
        style: { ...BUTTON, cursor: busy ? 'progress' : 'pointer' },
        'aria-label': `Resume flow in ${props.project}`,
        'aria-disabled': busy || undefined,
        onClick: () => {
          if (busy) return;
          setBusy(true);
          setError(null);
          resumeFlow({ project: props.project }).then(
            (next) => {
              props.store.apply(next);
              setBusy(false);
            },
            (failure: unknown) => {
              setBusy(false);
              setError(failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE);
            }
          );
        },
      },
      'Resume'
    ),
    error === null
      ? null
      : h('span', { role: 'alert', style: { ...ALERT, display: 'block' } }, error)
  );
}

/**
 * Register Flow home, a project's page and its settings page, where DorkOS has
 * pages. Home is listed in the palette and the phone's Add-ons menu; the two
 * pages that need a project's name are not.
 *
 * @param api - The host API.
 * @param store - The live store.
 * @returns A function that removes them.
 */
export function registerPages(
  api: AnswerApi & Pick<ClientApi, 'registerPage'>,
  store: FlowStore
): () => void {
  const registerPage = api.registerPage;
  if (typeof registerPage !== 'function') return () => {};
  const pages = createPages(api, store);
  const removers = [
    registerPage.call(api, PAGE_PATHS.home, pages.home, { title: 'Flow', icon: FlowIcon }),
    registerPage.call(api, PAGE_PATHS.project, pages.project, {
      title: 'Flow project',
      icon: FlowIcon,
      menu: false,
    }),
    registerPage.call(api, PAGE_PATHS.settings, pages.settings, {
      title: 'Flow settings',
      icon: FlowIcon,
      menu: false,
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
