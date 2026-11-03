/**
 * The fake tracker's code adapter (adapter contract 2.2.0): the module the flow
 * CLI's loader imports when a project's tracker is `fake`.
 *
 * The tracker lives in the JSON file {@link FAKE_BACKLOG_ENV} names, and every
 * write is saved back to it, so a test or a self-test run can seed it before a
 * `flow` command and read it afterwards. Every call re-reads the file, so two
 * processes see each other's writes, as with a real tracker. The behavior is
 * `FakeTracker`'s (`scripts/tracker/fake.ts`).
 *
 * A project uses it by LINKING this folder to `.agents/flow/adapters/fake/`
 * (a copy would break the relative import below) and setting `tracker` to
 * `fake`. It reaches no real tracker.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { ConfigError } from '../../../scripts/errors.ts';
import {
  FAKE_BACKLOG_ENV,
  FAKE_CONTRACT_VERSION,
  FakeTracker,
  type FakeBacklog,
} from '../../../scripts/tracker/fake.ts';
import type { AdapterContext, CodeAdapter } from '../../../scripts/tracker/types.ts';

/** The adapter contract version this adapter targets. */
export const CONTRACT_VERSION = FAKE_CONTRACT_VERSION;

/**
 * Build the adapter over the backlog file `FLOW_FAKE_BACKLOG` names.
 *
 * @param _ctx - The CLI's context; the fake needs none of it.
 * @returns The adapter.
 * @throws {ConfigError} When `FLOW_FAKE_BACKLOG` is not set: a fake tracker
 *   with no file would read as an empty backlog, which is never what a run meant.
 */
export function createAdapter(_ctx: AdapterContext): CodeAdapter {
  const file = process.env[FAKE_BACKLOG_ENV];
  if (file === undefined || file === '') {
    throw new ConfigError(
      `the fake tracker reads its backlog from a JSON file; set ${FAKE_BACKLOG_ENV} to its path`
    );
  }
  const load = (): FakeBacklog => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as FakeBacklog;
    } catch (error) {
      throw new ConfigError(
        `the fake tracker could not read its backlog file ${file}: ${(error as Error).message}`
      );
    }
  };
  const tracker = new FakeTracker(load(), {
    // Renamed into place, so another process's read never sees half a file.
    persist: (state) => {
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(temp, file);
    },
  });
  // In place: the tracker holds this object, and keeps its own state across calls.
  const refresh = (): FakeBacklog => {
    const fresh = load();
    const live = tracker.backlog as unknown as Record<string, unknown>;
    for (const key of Object.keys(live)) delete live[key];
    Object.assign(live, fresh);
    return fresh;
  };
  const { adapter } = tracker;
  return {
    capabilities: adapter.capabilities,
    getCurrentUser: async () => {
      refresh();
      return adapter.getCurrentUser();
    },
    getBacklogSnapshot: async (options) => {
      refresh();
      return adapter.getBacklogSnapshot(options);
    },
    getItem: async (identifier, options) => {
      const wait = refresh().getItemDelayMs;
      const item = await adapter.getItem(identifier, options);
      const delay = typeof wait === 'number' ? wait : (wait?.[identifier] ?? 0);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return item;
    },
    getInbox: async (options) => {
      refresh();
      return adapter.getInbox!(options);
    },
    applyWorkState: async (item, change) => {
      refresh();
      return adapter.applyWorkState(item, change);
    },
    comment: async (item, body) => {
      refresh();
      return adapter.comment(item, body);
    },
    createItem: async (spec) => {
      refresh();
      return adapter.createItem!(spec);
    },
  };
}
