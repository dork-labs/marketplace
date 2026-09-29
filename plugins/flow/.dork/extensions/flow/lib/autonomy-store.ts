/**
 * How much flow does on its own in each project, as the extension reads it
 * (spec `flow-multiproject` §7.7, N11).
 *
 * **Where the dial lives.** In DorkOS's per-project settings for flow, which
 * only a person writes (`api.projectSettings.set` behind the person bar, or
 * core applying an offer the person said Yes to). This module only reads it:
 * `ctx.projectSettings` has no setter, and nothing here writes the stored
 * value. So neither this server half nor any agent it runs can move the dial.
 *
 * **The engine's copy.** The CLI cannot reach DorkOS's storage, so the stop in
 * force is written to `<dorkHome>/flow/autonomy/<projectId>.json`, the file
 * `scripts/autonomy.ts` reads. It is rewritten whenever a person changes the
 * dial, and checked on every poll: a copy that differs from what it should be
 * (edited by anything else) is rewritten and the change logged.
 *
 * **Defaults are computed, never stored.** A project flow first sees with no
 * history reads as Tell me after (V10's default for a new setup), and its copy
 * says so. A project first seen with history has no copy at all until the
 * person chooses, which keeps it exactly as it was (the engine's "no copy"
 * rule: ask for everything, except that failing checks are still fixed as the
 * committed `recovery` settings say). A stored value that is not a dial reads
 * as Ask me first for every kind.
 *
 * On a DorkOS without per-project settings nothing is read or written: the
 * engine keeps its "no copy" behaviour.
 *
 * @module @dorkos/flow/extension/autonomy-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_QUESTION_DEADLINE_MINUTES,
  autonomyCopyPath,
  parseAutonomyCopy,
  resolveAutonomy,
  type AutonomyCopy,
  type AutonomyKind,
  type AutonomyStop,
} from '../../../../scripts/autonomy.ts';
import { NEW_PROJECT_DIAL, NO_COPY_DIAL, withKind } from '../../../../scripts/autonomy-dial.ts';

export { NEW_PROJECT_DIAL, NO_COPY_DIAL };
import { JOURNAL_FILE, RUN_FILES_DIR } from '../../../../scripts/config-names.ts';
import { readRunStore } from '../../../../scripts/fleet/sessions.ts';
import type { ProjectSettingsReader } from './host-types.ts';
import type { SharedStorage } from './shared-storage.ts';

/** The storage key: each project root, as flow first saw it (`new` or `existing`). */
export const FIRST_SEEN_KEY = 'autonomyFirstSeen';

/** How often the stored dial is read again even without a change event, in ms. */
export const REREAD_MS = 60_000;

/** One project's dial, as flow acts on it. */
export interface ProjectAutonomy {
  /** The dial in force, or `null` for "no copy" (the project was never set). */
  copy: AutonomyCopy | null;
  /** Whether a person chose it (a stored value exists). */
  chosen: boolean;
  /** How flow first saw the project. */
  firstSeen: 'new' | 'existing';
}

/** What a stored value that is not a dial reads as: Ask me first for everything. */
const BROKEN_DIAL: AutonomyCopy = {
  dial: 'ask',
  kinds: {},
  questionDeadlineMinutes: DEFAULT_QUESTION_DEADLINE_MINUTES,
};

/**
 * Whether a project has history: runs in its store, or a journal.
 *
 * @param root - The project's main checkout.
 * @returns True when flow has worked there before.
 */
export function hasHistory(root: string): boolean {
  const store = readRunStore(root) ?? {};
  if (Object.keys(store).length > 0) return true;
  return existsSync(path.join(root, RUN_FILES_DIR, JOURNAL_FILE));
}

/**
 * The stop in force for a kind: the copy's answer, or, with no copy, the
 * engine's "no copy" rule (ask, except retry follows the committed settings).
 *
 * @param copy - The dial, or `null`.
 * @param kind - The kind of ask.
 * @param reviewerAgent - Whether a reviewer agent checks this repo's work.
 * @returns The stop.
 */
export function stopOf(
  copy: AutonomyCopy | null,
  kind: AutonomyKind,
  reviewerAgent: boolean
): AutonomyStop {
  if (copy === null) return kind === 'retry' ? 'tell' : 'ask';
  return resolveAutonomy(copy, kind, { reviewerAgent });
}

/**
 * The patch an accepted "Next time, on its own?" offer asks core to apply:
 * that one kind moves to Tell me after, everything else stays as it is in
 * force now. It is built by the same `withKind` the settings page's Customize
 * writes with, so an offer and a person's own choice store the same value.
 * Core merges it shallowly, so the whole `kinds` is sent, and a project with no
 * copy keeps retry as it was (the committed `recovery` settings fix failing
 * checks on their own).
 *
 * @param copy - The dial in force, or `null`.
 * @param kind - The kind to move.
 * @returns The patch.
 */
export function offerPatch(copy: AutonomyCopy | null, kind: AutonomyKind): Record<string, unknown> {
  const value = withKind(copy, kind, 'tell', NO_COPY_DIAL);
  // Core merges shallowly: the stored deadline stays as it is.
  return { dial: value.dial, kinds: value.kinds };
}

/** The copy's file contents for a dial. */
function copyText(copy: AutonomyCopy): string {
  return `${JSON.stringify(copy, null, 2)}\n`;
}

/** What the store needs. */
export interface AutonomyStoreDeps {
  /** The DorkOS home. */
  dorkHome: string;
  /** Core's reader, when the host has one. */
  settings?: ProjectSettingsReader;
  /** The extension's storage. */
  storage: SharedStorage;
  /** Where to log. */
  log: (message: string) => void;
  /** The clock, in ms. */
  now?: () => number;
}

/** Reads each project's dial and keeps the engine's copy of it. */
export class AutonomyStore {
  private readonly dials = new Map<string, ProjectAutonomy>();
  private readonly readAt = new Map<string, number>();
  private readonly stale = new Set<string>();
  private readonly stopListening: () => void;

  /**
   * @param deps - The host's reader, storage and a logger.
   */
  constructor(private readonly deps: AutonomyStoreDeps) {
    this.stopListening =
      deps.settings?.onChange((root) => {
        this.stale.add(root);
      }) ?? (() => {});
  }

  /** Whether this DorkOS keeps flow's per-project settings. */
  get available(): boolean {
    return this.deps.settings !== undefined;
  }

  /**
   * Read every project's dial where it is due, and make each copy match.
   *
   * @param roots - Every flow project's main checkout.
   * @returns Whether any project's dial changed.
   */
  async sync(roots: readonly string[]): Promise<boolean> {
    const settings = this.deps.settings;
    if (settings === undefined) return false;
    const now = (this.deps.now ?? Date.now)();
    const firstSeen = await this.firstSeen(roots);
    let changed = false;
    for (const root of roots) {
      const due =
        this.stale.has(root) ||
        !this.dials.has(root) ||
        now - (this.readAt.get(root) ?? 0) >= REREAD_MS;
      if (due) {
        this.stale.delete(root);
        let stored: unknown = null;
        try {
          stored = await settings.get(root);
        } catch (error) {
          this.deps.log(`[flow] could not read the Flow settings for ${root}: ${String(error)}`);
          continue;
        }
        this.readAt.set(root, now);
        const next = this.dialOf(stored, firstSeen.get(root) ?? 'existing', root);
        if (JSON.stringify(next) !== JSON.stringify(this.dials.get(root))) changed = true;
        this.dials.set(root, next);
      }
      this.keepCopy(root);
    }
    return changed;
  }

  /**
   * One project's dial as flow acts on it, or `null` before it was read (or
   * on a DorkOS without per-project settings).
   *
   * @param root - The project's main checkout.
   * @returns The dial.
   */
  of(root: string): ProjectAutonomy | null {
    return this.dials.get(root) ?? null;
  }

  /**
   * The stop in force for one kind in one project.
   *
   * @param root - The project's main checkout.
   * @param kind - The kind of ask.
   * @param reviewerAgent - Whether a reviewer agent checks this repo's work.
   * @returns The stop.
   */
  stop(root: string, kind: AutonomyKind, reviewerAgent: boolean): AutonomyStop {
    return stopOf(this.dials.get(root)?.copy ?? null, kind, reviewerAgent);
  }

  /** Stop listening for changes. */
  dispose(): void {
    this.stopListening();
  }

  /** The dial from the stored value. */
  private dialOf(stored: unknown, firstSeen: 'new' | 'existing', root: string): ProjectAutonomy {
    if (stored === null || stored === undefined) {
      return { copy: firstSeen === 'new' ? NEW_PROJECT_DIAL : null, chosen: false, firstSeen };
    }
    const copy = parseAutonomyCopy(stored);
    if (copy === null) {
      this.deps.log(
        `[flow] the Flow settings for ${root} are not a dial flow can read, so it asks you first for everything`
      );
      return { copy: BROKEN_DIAL, chosen: true, firstSeen };
    }
    return { copy, chosen: true, firstSeen };
  }

  /** Record how flow first saw each new root, once. */
  private async firstSeen(roots: readonly string[]): Promise<Map<string, 'new' | 'existing'>> {
    const stored = await this.deps.storage.get(FIRST_SEEN_KEY);
    const known = new Map<string, 'new' | 'existing'>();
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
      for (const [root, value] of Object.entries(stored)) {
        if (value === 'new' || value === 'existing') known.set(root, value);
      }
    }
    const fresh = roots.filter((root) => !known.has(root));
    if (fresh.length === 0) return known;
    for (const root of fresh) known.set(root, hasHistory(root) ? 'existing' : 'new');
    try {
      await this.deps.storage.update(FIRST_SEEN_KEY, (current) => {
        const next =
          typeof current === 'object' && current !== null && !Array.isArray(current)
            ? { ...(current as Record<string, unknown>) }
            : {};
        for (const root of fresh) next[root] ??= known.get(root);
        return next;
      });
    } catch (error) {
      this.deps.log(`[flow] could not remember new projects: ${String(error)}`);
    }
    return known;
  }

  /** Make the engine's copy of one project's dial say what it should. */
  private keepCopy(root: string): void {
    const dial = this.dials.get(root);
    if (dial === undefined) return;
    const file = autonomyCopyPath(this.deps.dorkHome, root);
    let current: string | null = null;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = null;
    }
    if (dial.copy === null) {
      if (current === null) return;
      this.deps.log(
        `[flow] removed a copy of the Flow settings for ${root} that DorkOS did not write`
      );
      rmSync(file, { force: true });
      return;
    }
    const want = copyText(dial.copy);
    if (current === want) return;
    if (current !== null) {
      this.deps.log(
        `[flow] the copy of the Flow settings for ${root} was changed; rewrote it from DorkOS`
      );
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, want);
    renameSync(temp, file);
  }
}
