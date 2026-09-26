/**
 * The fake tracker's code adapter (adapter contract 1.4.0): the module the flow
 * CLI's loader imports when a project's tracker is `fake`.
 *
 * The tracker lives in the JSON file {@link FAKE_BACKLOG_ENV} names, and every
 * write is saved back to it, so a test or a self-test run can seed it before a
 * `flow` command and read it afterwards. The behavior is `FakeTracker`'s
 * (`scripts/tracker/fake.ts`).
 *
 * A project uses it by LINKING this folder to `.agents/flow/adapters/fake/`
 * (a copy would break the relative import below) and setting `tracker` to
 * `fake`. It reaches no real tracker.
 */

import { readFileSync, writeFileSync } from 'node:fs';

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
  let backlog: FakeBacklog;
  try {
    backlog = JSON.parse(readFileSync(file, 'utf8')) as FakeBacklog;
  } catch (error) {
    throw new ConfigError(
      `the fake tracker could not read its backlog file ${file}: ${(error as Error).message}`
    );
  }
  const tracker = new FakeTracker(backlog, {
    persist: (state) => writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`),
  });
  return tracker.adapter;
}
