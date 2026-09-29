/**
 * The shape of a project's Flow settings page (spec `flow-multiproject` §8.2):
 * the view `GET /settings/:name` answers and the limits both halves check.
 * Pure, with no imports, so the browser half uses the same definitions as the
 * server half (`settings.ts`, which re-exports them).
 *
 * @module @dorkos/flow/extension/settings-shape
 */

/** How long a pause lasts when the menu opens: the three choices (§5.3). */
export const PAUSE_DEFAULTS = ['tomorrow', 'hour', 'resume'] as const;

/** One pause default. */
export type PauseDefault = (typeof PAUSE_DEFAULTS)[number];

/** The most drain workers the page offers. */
export const MAX_PARALLEL = 8;

/** A bare label, as `groom.unnamespacedLabels` takes it (`BareLabelSchema`). */
export const BARE_LABEL = /^[^/\s](?:[^/]*[^/\s])?$/;

/** Said for a key a project's older flow would refuse (§8.3 step 1). */
export const UPDATE_FLOW_TEXT = 'Update flow in this project to change this.';

/** Where a value came from. */
export type SettingSource = 'shared' | 'local' | 'default';

/** One field as the page shows it. */
export interface SettingField<T> {
  /** The value in force. */
  value: T;
  /** Which file set it, or `default` when neither did. */
  source: SettingSource;
  /** Why it cannot be changed here, or `null`. */
  locked: string | null;
}

/** The fields in the "Shared with the repo" box. */
export interface SharedSettings {
  /** `review.adversarial`: another agent reviews every change before its PR opens. */
  reviewerAgent: SettingField<boolean>;
  /** `gates.review.mergeOnApproval`: merge when you approve. */
  mergeOnApproval: SettingField<boolean>;
  /** `drain.armAutoMerge`: merge by itself when checks pass. */
  armAutoMerge: SettingField<boolean>;
  /** `groom.unnamespacedLabels`: labels flow accepts without a group. */
  labels: SettingField<string[]>;
}

/** The file fields in the "Just me" box. */
export interface LocalSettings {
  /** `autonomy.default`: start work on its own, or only when you start it. */
  startsOnItsOwn: SettingField<'auto' | 'manual'>;
  /** `drain.parallel`: at most this many at once (`0`, sequential, reads as 1). */
  parallel: SettingField<number>;
}

/** The `GET /settings/:name` body. */
export interface ProjectSettingsView {
  /** Core's name for the project. */
  project: string;
  /** Its main checkout. */
  root: string;
  /** Its own flow's behaviour level (§9.3). */
  behaviour: number;
  /** The two files, relative to the project. */
  files: { shared: string; local: string };
  /** The tracker, as the shared file names it. */
  tracker: { label: string; team: string | null } | null;
  /** "Shared with the repo". */
  shared: SharedSettings;
  /** "Just me", the file half. */
  local: LocalSettings;
  /** The pause menu's highlighted choice for this project. */
  pauseDefault: PauseDefault;
  /** False on a DorkOS that cannot tell a person from an agent: nothing here can be saved. */
  canChange: boolean;
}

