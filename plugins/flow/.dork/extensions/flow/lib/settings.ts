/**
 * A project's Flow settings, split by who a change reaches (spec
 * `flow-multiproject` §8.2-§8.3, V6): what the settings page reads with
 * `GET /settings/:name` and writes with the person-only `PUT /settings/:name`.
 *
 * - **Shared with the repo** lives in `<root>/.agents/flow/config.json`, a
 *   committed file: a change reaches everyone on the repo once it is committed.
 * - **Just me** lives in `<root>/.agents/flow/config.local.json`, which git
 *   ignores, and the pause default lives in the extension's storage (a new key
 *   in the strict config schema would break every project on an older flow).
 *   The dial is not here at all: it is DorkOS's per-project setting, written
 *   only by a person from the browser (§7.7), and this server half never
 *   writes it.
 *
 * Reads are lenient, the way `drain-settings.ts` reads: a missing or odd value
 * reads as the schema's default, and each field says which file its value came
 * from. A write changes only the keys it names and leaves every other key as
 * it was, then checks the two files with this extension's own flow
 * (`config-files.ts check`, which runs nothing from the project). If the check
 * finds a problem the write caused, both files are put back as they were.
 *
 * Bundled by DorkOS, so zod-free: flow's own validator runs as a subprocess.
 *
 * @module @dorkos/flow/extension/settings
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile, updateJsonFile } from '../../../../scripts/atomic-json.ts';
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  PROJECT_CONFIG_DIR,
} from '../../../../scripts/config-names.ts';
import type { ExecFileLike } from './advisor.ts';
import { RouteError } from './fleet.ts';
import type { FlowProjectEntry } from './projects.ts';
import type { SharedStorage } from './shared-storage.ts';
import {
  BARE_LABEL,
  MAX_PARALLEL,
  PAUSE_DEFAULTS,
  UPDATE_FLOW_TEXT,
  type LocalSettings,
  type PauseDefault,
  type ProjectSettingsView,
  type SettingField,
  type SharedSettings,
} from './settings-shape.ts';

export * from './settings-shape.ts';

/** The storage key: each project root's pause default. */
export const PAUSE_DEFAULTS_KEY = 'pauseDefaults';

/** A field the page can write. */
export type SettingKey = keyof SharedSettings | keyof LocalSettings;

/** How one field is read and written. */
interface KeySpec<T> {
  /** Which file it is written to. */
  file: 'shared' | 'local';
  /** Its path in the file. */
  path: readonly string[];
  /** The first flow behaviour level whose engine accepts this key (§8.3). */
  level: number;
  /** The schema's default. */
  fallback: T;
  /** A stored value, or `undefined` when it is not one. */
  read(value: unknown): T | undefined;
  /** What a person sent, or a thrown message. */
  check(value: unknown): T;
}

/** A plain-words refusal. */
function refuse(message: string): never {
  throw new RouteError(400, message);
}

const boolean = (fallback: boolean, words: string): Omit<KeySpec<boolean>, 'file' | 'path'> => ({
  level: 0,
  fallback,
  read: (value) => (typeof value === 'boolean' ? value : undefined),
  check: (value) => (typeof value === 'boolean' ? value : refuse(words)),
});

/**
 * Every key the page can write, with the flow behaviour level that first
 * understood it. Every file key is level 0: any flow since the settings file
 * existed accepts it. A later key that an older engine's strict schema would
 * reject goes in at the level that added it.
 */
export const SETTING_KEYS: { readonly [K in SettingKey]: KeySpec<SettingValue<K>> } = {
  reviewerAgent: {
    file: 'shared',
    path: ['review', 'adversarial'],
    ...boolean(true, 'Say whether another agent reviews every change.'),
  },
  mergeOnApproval: {
    file: 'shared',
    path: ['gates', 'review', 'mergeOnApproval'],
    ...boolean(true, 'Say whether flow merges when you approve.'),
  },
  armAutoMerge: {
    file: 'shared',
    path: ['drain', 'armAutoMerge'],
    ...boolean(false, 'Say whether flow merges by itself when checks pass.'),
  },
  labels: {
    file: 'shared',
    path: ['groom', 'unnamespacedLabels'],
    level: 0,
    fallback: [],
    read: (value) =>
      Array.isArray(value) && value.every((label) => typeof label === 'string')
        ? (value as string[])
        : undefined,
    check: (value) => {
      if (!Array.isArray(value)) return refuse('Send the labels as a list.');
      const labels: string[] = [];
      for (const label of value) {
        if (typeof label !== 'string' || !BARE_LABEL.test(label)) {
          return refuse('A label has no "/" and no space at either end.');
        }
        if (!labels.includes(label)) labels.push(label);
      }
      return labels;
    },
  },
  startsOnItsOwn: {
    file: 'local',
    path: ['autonomy', 'default'],
    level: 0,
    fallback: 'auto',
    read: (value) => (value === 'auto' || value === 'manual' ? value : undefined),
    check: (value) =>
      value === 'auto' || value === 'manual'
        ? value
        : refuse('Choose whether flow starts work on its own.'),
  },
  parallel: {
    file: 'local',
    path: ['drain', 'parallel'],
    level: 0,
    fallback: 1,
    // 0 is flow's sequential default: one at a time.
    read: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? Math.max(1, value)
        : undefined,
    check: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PARALLEL
        ? value
        : refuse(`Choose between 1 and ${MAX_PARALLEL} at once.`),
  },
};

/** The value type of each key. */
type SettingValue<K extends SettingKey> = K extends keyof SharedSettings
  ? SharedSettings[K]['value']
  : K extends keyof LocalSettings
    ? LocalSettings[K]['value']
    : never;

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at `keys` in `object`, or `undefined`. */
function at(object: unknown, keys: readonly string[]): unknown {
  let current = object;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** `object` with `value` at `keys`, creating objects on the way; other keys stay. */
function withValue(
  object: unknown,
  keys: readonly string[],
  value: unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(object) ? { ...object } : {};
  const [first, ...rest] = keys;
  out[first] = rest.length === 0 ? value : withValue(out[first], rest, value);
  return out;
}

/** A project's two settings files. */
export function settingsFiles(root: string): { shared: string; local: string } {
  const dir = path.join(root, PROJECT_CONFIG_DIR);
  return { shared: path.join(dir, CONFIG_FILE), local: path.join(dir, LOCAL_CONFIG_FILE) };
}

/** Read one field from the two parsed files: local over shared over the default. */
function field<K extends SettingKey>(
  key: K,
  files: { shared: unknown; local: unknown },
  behaviour: number
): SettingField<SettingValue<K>> {
  const spec = SETTING_KEYS[key] as KeySpec<SettingValue<K>>;
  const locked = spec.level > behaviour ? UPDATE_FLOW_TEXT : null;
  const local = spec.read(at(files.local, spec.path));
  if (local !== undefined) return { value: local, source: 'local', locked };
  const shared = spec.read(at(files.shared, spec.path));
  if (shared !== undefined) return { value: shared, source: 'shared', locked };
  return { value: spec.fallback, source: 'default', locked };
}

/** A stored pause default, or the menu's own first choice. */
function pauseDefaultOf(stored: unknown, root: string): PauseDefault {
  const value = isObject(stored) ? stored[root] : undefined;
  return (PAUSE_DEFAULTS as readonly unknown[]).includes(value)
    ? (value as PauseDefault)
    : 'tomorrow';
}

/**
 * Each project's pause default, from the extension's storage.
 *
 * @param storage - The extension's storage.
 * @returns A lookup by root (`tomorrow` when none was chosen).
 */
export async function pauseDefaults(
  storage: Pick<SharedStorage, 'get'>
): Promise<(root: string) => PauseDefault> {
  const stored = await storage.get(PAUSE_DEFAULTS_KEY);
  return (root) => pauseDefaultOf(stored, root);
}

/**
 * Read a project's settings, leniently.
 *
 * @param entry - The project.
 * @param opts - Its pause default and whether a person can save here.
 * @returns The page's view.
 */
export function readProjectSettings(
  entry: FlowProjectEntry,
  opts: { pauseDefault: PauseDefault; canChange: boolean }
): ProjectSettingsView {
  const paths = settingsFiles(entry.root);
  const files = {
    shared: readJsonFile(paths.shared).value,
    local: readJsonFile(paths.local).value,
  };
  const behaviour = entry.version.behaviour;
  return {
    project: entry.name,
    root: entry.root,
    behaviour,
    files: {
      shared: `${PROJECT_CONFIG_DIR}/${CONFIG_FILE}`,
      local: `${PROJECT_CONFIG_DIR}/${LOCAL_CONFIG_FILE}`,
    },
    tracker:
      entry.tracker === null ? null : { label: entry.tracker.label, team: entry.tracker.team },
    shared: {
      reviewerAgent: field('reviewerAgent', files, behaviour),
      mergeOnApproval: field('mergeOnApproval', files, behaviour),
      armAutoMerge: field('armAutoMerge', files, behaviour),
      labels: field('labels', files, behaviour),
    },
    local: {
      startsOnItsOwn: field('startsOnItsOwn', files, behaviour),
      parallel: field('parallel', files, behaviour),
    },
    pauseDefault: opts.pauseDefault,
    canChange: opts.canChange,
  };
}

/** A checked `PUT /settings/:name` body. */
export interface SettingsPatch {
  /** Keys for config.json. */
  shared: Partial<Record<SettingKey, unknown>>;
  /** Keys for config.local.json. */
  local: Partial<Record<SettingKey, unknown>>;
  /** The pause default, when it changes. */
  pauseDefault?: PauseDefault;
}

/**
 * Check a `PUT /settings/:name` body: `{ shared?, local?, pauseDefault? }`.
 * A key that belongs to the other box, a key the page does not write, a value
 * of the wrong shape, and a key the project's flow is too old for (§8.3 step
 * 1) are each refused before anything is written.
 *
 * @param body - The request body.
 * @param behaviour - The project's own flow behaviour level.
 * @returns The patch.
 * @throws {RouteError} 400 in plain words.
 */
export function parseSettingsPatch(body: unknown, behaviour: number): SettingsPatch {
  if (!isObject(body)) refuse('Send the settings to change.');
  const patch: SettingsPatch = { shared: {}, local: {} };
  for (const box of ['shared', 'local'] as const) {
    const given = body[box];
    if (given === undefined) continue;
    if (!isObject(given)) refuse('Send the settings to change.');
    for (const [key, value] of Object.entries(given)) {
      const spec = (SETTING_KEYS as Record<string, KeySpec<unknown>>)[key];
      if (spec === undefined || spec.file !== box)
        refuse(`Flow's settings page can't change "${key}".`);
      if (spec.level > behaviour) refuse(UPDATE_FLOW_TEXT);
      patch[box][key as SettingKey] = spec.check(value);
    }
  }
  if (body.pauseDefault !== undefined) {
    if (!(PAUSE_DEFAULTS as readonly unknown[]).includes(body.pauseDefault)) {
      refuse('Choose one of the pause menu’s choices.');
    }
    patch.pauseDefault = body.pauseDefault as PauseDefault;
  }
  return patch;
}

/** What a settings write needs. */
export interface SettingsWriteDeps {
  /** Runs flow's CLI with no shell. */
  execFile: ExecFileLike;
  /** This extension's own flow (never the project's). */
  flowRoot: string;
  /** The extension's storage. */
  storage: Pick<SharedStorage, 'update'>;
}

/** One problem `config-files.ts check` reported. */
interface Issue {
  path: string;
  message: string;
}

/** Run one of flow's `config-files.ts` commands and parse the JSON it prints, even on exit 1. */
function configFiles(
  deps: SettingsWriteDeps,
  command: 'check' | 'prepare',
  root: string
): Promise<Record<string, unknown> | null> {
  const script = path.join(deps.flowRoot, 'scripts', 'config-files.ts');
  return new Promise((resolve) => {
    deps.execFile(
      'node',
      ['--experimental-strip-types', script, command, '--project', root],
      { timeout: 15_000, shell: false, encoding: 'utf8' },
      (_error, stdout) => {
        try {
          const parsed: unknown = JSON.parse((stdout ?? '').trim().split('\n').pop() ?? '');
          resolve(isObject(parsed) ? parsed : null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/** The problems a check found, or `null` when flow could not run it. */
async function problems(deps: SettingsWriteDeps, root: string): Promise<Issue[] | null> {
  const result = await configFiles(deps, 'check', root);
  if (result === null || !Array.isArray(result.errors)) return null;
  return result.errors.filter(
    (issue): issue is Issue =>
      isObject(issue) && typeof issue.path === 'string' && typeof issue.message === 'string'
  );
}

/** A file's bytes, to put back after a failed check; `null` when it does not exist. */
function snapshot(file: string): Buffer | null {
  return existsSync(file) ? readFileSync(file) : null;
}

/** Put a file back the way {@link snapshot} found it. */
function restore(file: string, bytes: Buffer | null): void {
  if (bytes === null) rmSync(file, { force: true });
  else writeFileSync(file, bytes);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Write a project's settings: only the named keys, in each file under its
 * lock, then check both files with this extension's own flow. A problem the
 * write caused puts both files back and is refused with flow's words; a
 * problem that was already there before is not this write's to block. Writes
 * run one at a time.
 *
 * @param deps - The command runner, flow's folder and storage.
 * @param entry - The project.
 * @param patch - The checked patch ({@link parseSettingsPatch}).
 * @throws {RouteError} 400 when the check fails or the local file cannot be kept out of git;
 *   502 when flow could not check at all (nothing is left changed).
 */
export function writeProjectSettings(
  deps: SettingsWriteDeps,
  entry: FlowProjectEntry,
  patch: SettingsPatch
): Promise<void> {
  const run = queue.then(() => write(deps, entry, patch));
  queue = run.catch(() => {});
  return run;
}

async function write(
  deps: SettingsWriteDeps,
  entry: FlowProjectEntry,
  patch: SettingsPatch
): Promise<void> {
  const files = settingsFiles(entry.root);
  const boxes = (['shared', 'local'] as const).filter((box) => Object.keys(patch[box]).length > 0);
  if (boxes.length > 0) {
    if (!existsSync(files.shared)) {
      throw new RouteError(400, `${entry.name} has no flow settings yet. Set flow up there first.`);
    }
    const before = await problems(deps, entry.root);
    if (before === null)
      throw new RouteError(
        502,
        `Flow couldn't check ${entry.name}'s settings. Nothing was changed.`
      );
    if (boxes.includes('local') && !existsSync(files.local)) {
      const prepared = await configFiles(deps, 'prepare', entry.root);
      if (prepared?.ok !== true) {
        throw new RouteError(
          400,
          `Flow couldn't keep ${LOCAL_CONFIG_FILE} out of git in ${entry.name}, so it saved nothing.`
        );
      }
    }
    const saved = { shared: snapshot(files.shared), local: snapshot(files.local) };
    const putBack = () => {
      restore(files.shared, saved.shared);
      restore(files.local, saved.local);
    };
    try {
      for (const box of boxes) {
        const result = await updateJsonFile(
          files[box],
          (current) => {
            let next: unknown = current;
            for (const [key, value] of Object.entries(patch[box])) {
              next = withValue(next, SETTING_KEYS[key as SettingKey].path, value);
            }
            return next;
          },
          { onUnparsable: 'throw' }
        );
        if (result.status === 'dropped') {
          throw new RouteError(
            502,
            `${entry.name}'s settings were busy. Nothing was changed; try again.`
          );
        }
      }
    } catch (error) {
      putBack();
      if (error instanceof RouteError) throw error;
      throw new RouteError(
        400,
        `Flow couldn't save ${entry.name}'s settings: ${String(error instanceof Error ? error.message : error)}`
      );
    }
    const after = await problems(deps, entry.root);
    const known = new Set(before.map((issue) => `${issue.path}\n${issue.message}`));
    const fresh = after?.filter((issue) => !known.has(`${issue.path}\n${issue.message}`));
    if (after === null || (fresh !== undefined && fresh.length > 0)) {
      putBack();
      throw new RouteError(
        after === null ? 502 : 400,
        after === null
          ? `Flow couldn't check ${entry.name}'s settings, so it put them back.`
          : `Flow didn't save that: ${fresh![0].message}`
      );
    }
  }
  if (patch.pauseDefault !== undefined) {
    const choice = patch.pauseDefault;
    await deps.storage.update(PAUSE_DEFAULTS_KEY, (current) => ({
      ...(isObject(current) ? current : {}),
      [entry.root]: choice,
    }));
  }
}
