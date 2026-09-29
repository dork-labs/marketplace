/**
 * A project's Flow settings, split by who a change reaches (spec
 * `flow-multiproject` §8, V6). One component, `ProjectFlowSettings`, used in
 * two places with nothing else different: the project's own settings page
 * (`/x/flow/p/<name>/settings`, from ⚙) and Settings → Flow, under a project
 * switcher.
 *
 * - **Shared with the repo** ("everyone on this repo"): reviews, merging and
 *   labels, saved to the project's committed `.agents/flow/config.json`. The
 *   box names the file before a save, and after one says to commit it; flow
 *   never commits. The tracker and the schedules are shown, not edited here.
 * - **Just me** ("only this computer"): how much flow does on its own (the
 *   dial, which lives in DorkOS and only a person writes), whether it starts
 *   work on its own and how much at once (the project's git-ignored
 *   `config.local.json`), the pause menu's default, and the accounts the
 *   project may use (DorkOS's rule, written from the browser).
 *
 * Every change saves at once. If flow or DorkOS refuses it, the control goes
 * back to the saved value and says why under it.
 *
 * @module @dorkos/flow/extension/ui/project-settings
 */

import type { ClientApi } from '../lib/host-types.ts';
import type { FlowProject } from '../lib/model.ts';
import {
  MAX_PARALLEL,
  BARE_LABEL,
  type PauseDefault,
  type ProjectSettingsView,
  type SettingField,
} from '../lib/settings-shape.ts';
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  PROJECT_CONFIG_DIR,
} from '../../../../scripts/config-names.ts';
import { AccountCheckboxes } from './account-checkboxes.ts';
import {
  FleetRequestError,
  HostTooOldError,
  UNREACHABLE_MESSAGE,
  getSettings,
  putSettings,
  type SettingsWrite,
} from './api.ts';
import { AutonomyDial } from './dial.ts';
import { PAUSE_CHOICES } from './pause-menu.ts';
import { BUTTON, Hint, LINK, MUTED, PILL } from './parts.ts';
import { h, useEffect, useId, useState, type Node, type Style } from './react.ts';
import { RepoChips, type ChipRule } from './repo-chips.ts';
import { SegmentedControl } from './segmented.ts';
import { ALERT, hostColor } from './styles.ts';

/** Where the shared settings live, relative to the project. */
export const SHARED_FILE = `${PROJECT_CONFIG_DIR}/${CONFIG_FILE}`;

/** Where this computer's settings for the project live, relative to the project. */
export const LOCAL_FILE = `${PROJECT_CONFIG_DIR}/${LOCAL_CONFIG_FILE}`;

/** The note in the shared box, before a save. */
export const SHARED_NOTE = `Saving changes ${SHARED_FILE} in this repo.`;

/** Said after a shared save: flow never commits. */
export const SHARED_SAVED_TEXT = `Saved. Commit ${SHARED_FILE} to share it.`;

/** Said on a DorkOS that can't tell a person from an agent: nothing can be saved here. */
export const READ_ONLY_TEXT =
  "This DorkOS can't tell you from an agent, so these settings can be read here but not changed. Update DorkOS to change them.";

/** Said when a value set on this computer wins over the repo's. */
export const LOCAL_WINS_TEXT = "This computer's own setting wins over this one.";

/** Shown when the settings could not be read. */
export const SETTINGS_LOAD_FAILED_TEXT =
  "Couldn't load this project's settings. Try again in a moment.";

/** DorkOS's Tasks page, where flow's schedules are. */
export const TASKS_ROUTE = '/tasks';

/** The labels chips' rule: a bare label, no group. */
const LABEL_RULE: ChipRule = {
  pattern: BARE_LABEL,
  placeholder: 'label',
  invalidText: 'A label here has no "/" and no space at either end.',
};

const MONO: Style = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  wordBreak: 'break-all',
};

const BOX: Style = {
  margin: '12px 0 0',
  padding: '10px 12px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: 'var(--radius, 0.5rem)',
};

const FIELD_ROW: Style = {
  padding: '8px 0',
  borderBottom: `1px solid ${hostColor('muted')}`,
};

/** One labelled box with who a change there reaches. */
function Box(props: { title: string; who: string; children: Node[] }): Node {
  const id = useId();
  return h(
    'section',
    { 'aria-labelledby': id, style: BOX },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
      h('h2', { id, style: { margin: 0, fontSize: '13px', fontWeight: 600 } }, props.title),
      h('span', { style: PILL }, props.who)
    ),
    ...props.children
  );
}

/** A switch (`role="switch"`) with its label beside it. */
function Switch(props: {
  label: string;
  description?: string;
  field: SettingField<boolean>;
  disabled: boolean;
  onChange: (value: boolean) => void;
  error?: string;
}): Node {
  const labelId = useId();
  const descId = useId();
  const on = props.field.value;
  return h(
    'div',
    { style: FIELD_ROW },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      h('span', { id: labelId, style: { flex: 1, minWidth: 0 } }, props.label),
      h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          'aria-labelledby': labelId,
          'aria-describedby': props.description === undefined ? undefined : descId,
          disabled: props.disabled || props.field.locked !== null,
          onClick: () => props.onChange(!on),
          style: {
            ...BUTTON,
            minWidth: '3.25rem',
            minHeight: '28px',
            background: on ? hostColor('foreground') : hostColor('background'),
            color: on ? hostColor('background') : hostColor('foreground'),
          },
        },
        on ? 'On' : 'Off'
      )
    ),
    props.description === undefined
      ? null
      : h('p', { id: descId, style: { ...MUTED, margin: '2px 0 0' } }, props.description),
    fieldNotes(props.field, props.error)
  );
}

/** The notes under a field: its lock, a local override, and an error. */
function fieldNotes(field: SettingField<unknown>, error?: string): Node {
  return [
    field.locked === null ? null : h('p', { key: 'l', style: MUTED }, field.locked),
    field.source === 'local' && field.locked === null
      ? h('p', { key: 'o', style: MUTED }, LOCAL_WINS_TEXT)
      : null,
    error === undefined ? null : h('p', { key: 'e', role: 'alert', style: ALERT }, error),
  ];
}

/** A labelled field whose control sits under its label, so it fits a phone. */
function Field(props: { label: string; children?: Node; notes?: Node }): Node {
  const labelId = useId();
  return h(
    'div',
    { role: 'group', 'aria-labelledby': labelId, style: FIELD_ROW },
    h(
      'span',
      { id: labelId, style: { display: 'block', fontWeight: 600, marginBottom: '4px' } },
      props.label
    ),
    props.children,
    props.notes ?? null
  );
}

/** "At most at once": a 1-8 stepper. */
function Stepper(props: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}): Node {
  const step = (by: number) => {
    const next = Math.min(MAX_PARALLEL, Math.max(1, props.value + by));
    if (next !== props.value) props.onChange(next);
  };
  return h(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
    h(
      'button',
      {
        type: 'button',
        style: { ...BUTTON, minWidth: '28px', minHeight: '28px' },
        'aria-label': 'One fewer at once',
        disabled: props.disabled || props.value <= 1,
        onClick: () => step(-1),
      },
      '−'
    ),
    h(
      'output',
      { 'aria-live': 'polite', style: { minWidth: '1.5em', textAlign: 'center' } },
      String(props.value)
    ),
    h(
      'button',
      {
        type: 'button',
        style: { ...BUTTON, minWidth: '28px', minHeight: '28px' },
        'aria-label': 'One more at once',
        disabled: props.disabled || props.value >= MAX_PARALLEL,
        onClick: () => step(1),
      },
      '+'
    )
  );
}

/** What {@link ProjectFlowSettings} takes. */
export interface ProjectFlowSettingsProps {
  /** The project. */
  project: FlowProject;
  /** The host API. */
  api: Pick<ClientApi, 'navigate' | 'projectSettings' | 'getState'>;
}

/** The loading state. */
type Phase = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready' };

/**
 * One project's Flow settings: the shared box and the just-me box.
 *
 * @param props - See {@link ProjectFlowSettingsProps}.
 * @returns The two boxes.
 */
export function ProjectFlowSettings(props: ProjectFlowSettingsProps): Node {
  const { project, api } = props;
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [view, setView] = useState<ProjectSettingsView | null>(null);
  const [saved, setSaved] = useState<ProjectSettingsView | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sharedSaved, setSharedSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setPhase({ kind: 'loading' });
    setErrors({});
    setSharedSaved(false);
    getSettings(project.name).then(
      (next) => {
        if (!live) return;
        setView(next);
        setSaved(next);
        setPhase({ kind: 'ready' });
      },
      (failure: unknown) => {
        if (!live) return;
        setPhase({
          kind: 'failed',
          message:
            failure instanceof HostTooOldError
              ? 'Update DorkOS to change flow’s settings here.'
              : failure instanceof FleetRequestError && failure.refusedByFlow
                ? failure.message
                : SETTINGS_LOAD_FAILED_TEXT,
        });
      }
    );
    return () => {
      live = false;
    };
  }, [project.name, attempt]);

  if (phase.kind === 'failed') {
    return h(
      'div',
      null,
      h('p', { role: 'alert', style: ALERT }, phase.message),
      h(
        'button',
        { type: 'button', style: BUTTON, onClick: () => setAttempt((n) => n + 1) },
        'Retry'
      )
    );
  }
  if (phase.kind === 'loading' || view === null) return h('div', { 'aria-busy': true });

  const locked = !view.canChange;
  const write = (scope: string, optimistic: ProjectSettingsView, body: SettingsWrite) => {
    setErrors((current) => {
      const next = { ...current };
      delete next[scope];
      return next;
    });
    setView(optimistic);
    putSettings(project.name, body).then(
      (answer) => {
        setView(answer);
        setSaved(answer);
        if (body.shared !== undefined) setSharedSaved(true);
      },
      (failure: unknown) => {
        setView(saved);
        setErrors((current) => ({
          ...current,
          [scope]: failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE,
        }));
      }
    );
  };
  const setShared = <K extends keyof ProjectSettingsView['shared']>(
    key: K,
    value: ProjectSettingsView['shared'][K]['value']
  ) =>
    write(
      key,
      {
        ...view,
        shared: { ...view.shared, [key]: { ...view.shared[key], value, source: 'shared' } },
      },
      { shared: { [key]: value } }
    );
  const setLocal = <K extends keyof ProjectSettingsView['local']>(
    key: K,
    value: ProjectSettingsView['local'][K]['value']
  ) =>
    write(
      key,
      { ...view, local: { ...view.local, [key]: { ...view.local[key], value, source: 'local' } } },
      { local: { [key]: value } }
    );

  const tracker =
    view.tracker === null
      ? 'Not set up yet'
      : `${view.tracker.label}${view.tracker.team === null ? '' : ` · team ${view.tracker.team}`}`;

  return h(
    'div',
    null,
    locked
      ? h('p', { role: 'status', style: { ...MUTED, margin: '8px 0 0' } }, READ_ONLY_TEXT)
      : null,
    h(Box, {
      title: 'Shared with the repo',
      who: 'everyone on this repo',
      children: [
        h(
          'div',
          { key: 'tracker', style: FIELD_ROW },
          h('span', { style: { fontWeight: 600 } }, 'Tracker and team'),
          h(
            'p',
            { style: { margin: '2px 0 0' } },
            tracker,
            ' ',
            h(Hint, { text: 'To change it, type /flow:init in a chat in this project.' })
          )
        ),
        h(Switch, {
          key: 'review',
          label: 'Review before a PR opens',
          description: 'Another agent reviews every change before the PR opens.',
          field: view.shared.reviewerAgent,
          disabled: locked,
          error: errors.reviewerAgent,
          onChange: (value) => setShared('reviewerAgent', value),
        }),
        h(Switch, {
          key: 'merge',
          label: 'Merge when I approve',
          field: view.shared.mergeOnApproval,
          disabled: locked,
          error: errors.mergeOnApproval,
          onChange: (value) => setShared('mergeOnApproval', value),
        }),
        h(Switch, {
          key: 'auto-merge',
          label: 'Merge by itself when checks pass',
          field: view.shared.armAutoMerge,
          disabled: locked,
          error: errors.armAutoMerge,
          onChange: (value) => setShared('armAutoMerge', value),
        }),
        h(
          Field,
          {
            key: 'labels',
            label: 'Labels flow accepts without a group',
            notes: fieldNotes(view.shared.labels, errors.labels),
          },
          h(RepoChips, {
            repos: view.shared.labels.value,
            rule: LABEL_RULE,
            readOnly: locked || view.shared.labels.locked !== null,
            onChange: (labels: string[]) => setShared('labels', labels),
          })
        ),
        h(
          'div',
          { key: 'schedules', style: { ...FIELD_ROW, borderBottom: 0 } },
          h('span', { style: { fontWeight: 600 } }, 'Schedules'),
          h(
            'p',
            { style: { margin: '2px 0 0' } },
            h('span', { style: MUTED }, "Flow's sorting and tidying run as DorkOS schedules. "),
            h(
              'button',
              { type: 'button', style: LINK, onClick: () => api.navigate(TASKS_ROUTE) },
              'Change in Tasks →'
            )
          )
        ),
        h(
          'p',
          { key: 'note', style: { ...MONO, ...MUTED, marginTop: '6px' } },
          sharedSaved ? SHARED_SAVED_TEXT : SHARED_NOTE
        ),
      ],
    }),
    h(Box, {
      title: 'Just me',
      who: 'only this computer',
      children: [
        h(
          'div',
          { key: 'dial', style: FIELD_ROW },
          h(AutonomyDial, {
            project,
            api,
            reviewerAgent: view.shared.reviewerAgent.value,
          })
        ),
        h(
          Field,
          {
            key: 'starts',
            label: 'Starts work on its own',
            notes: fieldNotes(view.local.startsOnItsOwn, errors.startsOnItsOwn),
          },
          h(SegmentedControl<'auto' | 'manual'>, {
            options: [
              { value: 'auto', label: "Yes, when there's something ready" },
              { value: 'manual', label: 'Only when I start it' },
            ],
            value: view.local.startsOnItsOwn.value,
            label: 'Starts work on its own',
            disabled: locked || view.local.startsOnItsOwn.locked !== null,
            wrap: true,
            onChange: (value) => setLocal('startsOnItsOwn', value),
          })
        ),
        h(
          Field,
          {
            key: 'parallel',
            label: 'At most at once',
            notes: fieldNotes(view.local.parallel, errors.parallel),
          },
          h(Stepper, {
            value: view.local.parallel.value,
            disabled: locked || view.local.parallel.locked !== null,
            onChange: (value) => setLocal('parallel', value),
          })
        ),
        h(
          Field,
          {
            key: 'pause',
            label: 'When you pause, the menu starts on',
            notes:
              errors.pauseDefault === undefined
                ? null
                : h('p', { role: 'alert', style: ALERT }, errors.pauseDefault),
          },
          h(SegmentedControl<PauseDefault>, {
            options: PAUSE_CHOICES.map((choice) => ({ value: choice.id, label: choice.label })),
            value: view.pauseDefault,
            label: 'When you pause, the menu starts on',
            disabled: locked,
            wrap: true,
            onChange: (value) =>
              write('pauseDefault', { ...view, pauseDefault: value }, { pauseDefault: value }),
          })
        ),
        h(
          'div',
          { key: 'accounts', style: { padding: '8px 0 0' } },
          h(AccountCheckboxes, {
            root: project.root,
            projectName: project.name,
            navigate: (path: string) => api.navigate(path),
            canChange: !locked,
          })
        ),
        h(
          'p',
          { key: 'local-note', style: { ...MONO, ...MUTED, marginTop: '6px' } },
          `Saved in ${LOCAL_FILE}, which git ignores, and in DorkOS on this computer.`
        ),
      ],
    })
  );
}
