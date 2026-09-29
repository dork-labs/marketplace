/**
 * Pausing and resuming from the command palette (spec `flow-multiproject`
 * §5.4): "Flow: Pause this project" and "Flow: Pause all projects" open the
 * pause menu in a dialog, so every pause still asks how long; "Flow: Resume
 * this project" and "Flow: Resume all projects" act at once and say what
 * happened in a toast. They go through flow's person-only routes, like the
 * Flow tab's buttons.
 *
 * @module @dorkos/flow/extension/ui/palette
 */

import type { ComponentType } from 'react';
import type { FlowModel } from '../lib/model.ts';
import type { ClientApi } from '../lib/host-types.ts';
import { UNREACHABLE_MESSAGE, pauseFlow, resumeFlow, type PauseTarget } from './api.ts';
import { chatProject } from './flow-tab.ts';
import { formatWhen } from './panel-format.ts';
import { PauseMenu } from './pause-menu.ts';
import { BUTTON, FOCUS_CSS, Hint, MUTED, PANEL } from './parts.ts';
import { h, useEffect, useState, type Node } from './react.ts';
import { useStore, type FlowStore } from './store.ts';
import { ALERT, hostColor } from './styles.ts';

/** The palette's command labels. */
export const COMMANDS = {
  pauseProject: 'Flow: Pause this project',
  pauseAll: 'Flow: Pause all projects',
  resumeProject: 'Flow: Resume this project',
  resumeAll: 'Flow: Resume all projects',
} as const;

/** Said when the chat is in no flow project. */
export const NOT_IN_PROJECT_TEXT = "This chat isn't in a flow project.";

/** Said on a DorkOS that cannot tell a person from an agent. */
export const FROM_CHAT_TEXT =
  "Pause and resume from a chat in the project: this DorkOS can't yet tell you apart from an agent.";

/** Behind ⓘ beside {@link FROM_CHAT_TEXT}: the only place the commands appear. */
export const FROM_CHAT_HINT = 'Type /flow:pause or /flow:resume in a chat in the project.';

/**
 * What a toast says after a pause.
 *
 * @param who - The project's name, or `null` for all projects.
 * @param until - The end, or `null`.
 * @param now - The clock.
 * @returns The words.
 */
export function pausedToast(who: string | null, until: string | null, now: Date): string {
  const where = who === null ? 'every project' : who;
  return until === null
    ? `Flow is paused in ${where} until you resume it.`
    : `Flow is paused in ${where} until ${formatWhen(until, now)}.`;
}

/**
 * Names in a sentence: "dorkos", "dorkos and blintz", "a, b and c".
 *
 * @param names - The names.
 * @returns The words.
 */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Which dialog: one project or all of them. */
type Scope = 'project' | 'all';

/**
 * Whether one pause dialog is showing. DorkOS draws every registered dialog all
 * the time and passes `open`, but the `open()` it hands back does not reach
 * that prop (DorkOS 0.92), so flow keeps the dialog's own open state here and
 * shows it when either says so.
 */
interface Controls {
  /** Whether flow opened it. */
  shown: boolean;
  /** Re-render the open dialog. */
  listeners: Set<() => void>;
  /** Tell DorkOS it closed; filled in once DorkOS registers the dialog. */
  hostClose: () => void;
}

/** A fresh, closed dialog state. */
function newControls(): Controls {
  return { shown: false, listeners: new Set(), hostClose: () => {} };
}

/** Show or hide a dialog. */
function setShown(controls: Controls, shown: boolean): void {
  controls.shown = shown;
  for (const listener of controls.listeners) listener();
}

/** What DorkOS passes every dialog it draws. */
interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** The dimmed layer under an open dialog. */
const BACKDROP = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'hsl(0 0% 0% / 0.4)',
} as const;

/**
 * The pause dialog for one scope.
 *
 * @param api - The host API (toasts).
 * @param store - The live store.
 * @param scope - This project or all.
 * @param controls - Its open state.
 * @returns The dialog's component: nothing until it is opened.
 */
function createPauseDialog(
  api: Pick<ClientApi, 'notify'>,
  store: FlowStore,
  scope: Scope,
  controls: Controls
): ComponentType {
  function PauseDialog(props: DialogProps): Node {
    const [mode, setMode] = useState<Scope>(scope);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [, redraw] = useState(0);
    // Follows the store, so the dialog never acts on a model that has moved on.
    const snapshot = useStore(store);
    const shown = props.open === true || controls.shown;
    const close = () => {
      setShown(controls, false);
      setMode(scope);
      setError(null);
      props.onOpenChange?.(false);
      controls.hostClose();
    };
    useEffect(() => {
      const listener = () => redraw((n) => n + 1);
      controls.listeners.add(listener);
      return () => {
        controls.listeners.delete(listener);
      };
    }, []);
    useEffect(() => {
      if (!shown) return undefined;
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') close();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    });
    if (!shown) return null;
    const model = snapshot.model;
    const project = model === null ? null : chatProject(snapshot, model);
    const root = (...children: Node[]) =>
      h(
        'div',
        {
          style: BACKDROP,
          onClick: (event: { target: unknown; currentTarget: unknown }) => {
            if (event.target === event.currentTarget) close();
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': true,
            'aria-label': mode === 'all' ? COMMANDS.pauseAll : COMMANDS.pauseProject,
            className: 'flow-tab',
            style: {
              ...PANEL,
              minWidth: '240px',
              padding: '14px 16px',
              borderRadius: '0.5rem',
              border: `1px solid ${hostColor('border')}`,
              background: hostColor('popover'),
              boxShadow: '0 8px 24px hsl(0 0% 0% / 0.2)',
            },
          },
          h('style', null, FOCUS_CSS),
          ...children
        )
      );
    if (model === null) return root(h('p', { style: MUTED }, 'Loading…'));
    if (!model.canChange) {
      return root(h('p', { style: MUTED }, FROM_CHAT_TEXT, h(Hint, { text: FROM_CHAT_HINT })));
    }
    if (mode === 'project' && project === null) {
      return root(
        h('p', { style: { margin: '0 0 8px' } }, NOT_IN_PROJECT_TEXT),
        h(
          'button',
          { type: 'button', style: BUTTON, onClick: () => setMode('all') },
          'Pause all projects instead'
        )
      );
    }
    const target: PauseTarget =
      mode === 'project' && project !== null ? { project: project.name } : { all: true };
    const who = 'project' in target ? target.project : null;
    return root(
      h(
        'b',
        { style: { display: 'block', marginBottom: '6px' } },
        who === null ? 'Pause all projects' : `Pause flow in ${who}`
      ),
      h(PauseMenu, {
        label: who === null ? 'Pause all projects' : `Pause flow in ${who}`,
        // A project's own default; "Until tomorrow 9am" for every project (V4).
        defaultChoice: who === null || project === null ? 'tomorrow' : project.pauseDefault,
        onChoose: (until) => {
          // One pause at a time: a second click while the first is on its way does nothing.
          if (busy) return;
          setBusy(true);
          setError(null);
          pauseFlow(target, until).then(
            (next) => {
              setBusy(false);
              store.apply(next);
              api.notify?.(pausedToast(who, until, new Date()), { type: 'success' });
              close();
            },
            (failure: unknown) => {
              setBusy(false);
              setError(failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE);
            }
          );
        },
        onClose: close,
      }),
      error === null ? null : h('p', { role: 'alert', style: ALERT }, error)
    );
  }
  return PauseDialog as ComponentType<DialogProps>;
}

/**
 * Resume from the palette, at once, and say what happened.
 *
 * @param api - The host API (toasts).
 * @param store - The live store.
 * @param scope - This project or all.
 */
async function resumeNow(
  api: Pick<ClientApi, 'notify'>,
  store: FlowStore,
  scope: Scope
): Promise<void> {
  const snapshot = store.get();
  const model: FlowModel | null = snapshot.model;
  if (model === null) return;
  if (!model.canChange) {
    api.notify?.(FROM_CHAT_TEXT, { type: 'info' });
    return;
  }
  let target: PauseTarget = { all: true };
  let who: string;
  if (scope === 'all') {
    const paused = model.projects.filter((project) => project.pause !== null);
    if (paused.length === 0) {
      api.notify?.('Nothing was paused.', { type: 'info' });
      return;
    }
    who = listNames(paused.map((project) => project.name));
  } else {
    const project = chatProject(snapshot, model);
    if (project === null) {
      api.notify?.(NOT_IN_PROJECT_TEXT, { type: 'info' });
      return;
    }
    if (project.pause === null) {
      api.notify?.(`Flow isn't paused in ${project.name}.`, { type: 'info' });
      return;
    }
    target = { project: project.name };
    who = project.name;
  }
  try {
    store.apply(await resumeFlow(target));
    api.notify?.(`Flow is running again in ${who}.`, { type: 'success' });
  } catch (failure) {
    api.notify?.(failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE, {
      type: 'error',
    });
  }
}

/**
 * Register the four palette commands and the two pause dialogs, where the
 * host has the seams for them.
 *
 * @param api - The host API.
 * @param store - The live store.
 * @returns A function that removes them.
 */
export function registerPalette(
  api: Pick<ClientApi, 'registerCommand' | 'registerDialog' | 'notify'>,
  store: FlowStore
): () => void {
  if (typeof api.registerCommand !== 'function') return () => {};
  const removers: (() => void)[] = [];
  if (typeof api.registerDialog === 'function') {
    for (const [scope, id, label] of [
      ['project', 'pause-project', COMMANDS.pauseProject],
      ['all', 'pause-all', COMMANDS.pauseAll],
    ] as const) {
      const controls = newControls();
      const dialog = api.registerDialog(
        id,
        createPauseDialog(api, store, scope, controls) as ComponentType
      );
      controls.hostClose = dialog.close;
      removers.push(
        api.registerCommand(id, label, () => {
          setShown(controls, true);
          dialog.open();
        })
      );
    }
  }
  removers.push(
    api.registerCommand('resume-project', COMMANDS.resumeProject, () => {
      void resumeNow(api, store, 'project');
    }),
    api.registerCommand('resume-all', COMMANDS.resumeAll, () => {
      void resumeNow(api, store, 'all');
    })
  );
  return () => {
    for (const remove of removers) remove();
  };
}
