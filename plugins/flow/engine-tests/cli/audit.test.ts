/**
 * `flow audit` (spec `flow-cli-core` §6, task 3.1): the groom invariant oracle
 * over one backlog pull, from the tracker or a saved `--snapshot` file.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { INVARIANTS } from '../../scripts/audit-backlog.ts';
import { EXIT } from '../../scripts/errors.ts';
import type { FakeBacklog } from '../fixtures/cli/fake-adapter/adapter.ts';
import { readyItem, runFlow, tempProject, type TempProject } from './read-verb-harness.ts';

let temp: TempProject | undefined;

afterEach(() => temp?.cleanup());

/** A backlog every invariant passes, when the agent is `flow-bot`. */
function cleanBacklog(): FakeBacklog {
  return {
    user: { id: 'flow-bot' },
    items: [
      readyItem('FAKE-1'),
      // Ready and assigned to the agent itself: passes GRM-8 only when the
      // agent identity reaches the oracle.
      readyItem('FAKE-2', { assignee: 'flow-bot' }),
      readyItem('FAKE-3', {
        stateCategory: 'backlog',
        labels: ['type/idea'],
        relations: { blocks: [], blockedBy: ['FAKE-9'], children: [], relatedTo: [] },
      }),
    ],
    closed: [{ identifier: 'FAKE-9', title: 'Shipped', stateCategory: 'completed' }],
  };
}

/** The clean backlog with FAKE-1's size removed, which breaks GRM-4. */
function failingBacklog(): FakeBacklog {
  const backlog = cleanBacklog();
  delete backlog.items[0].size;
  return backlog;
}

describe('flow audit', () => {
  it('exits 0 on a clean backlog and says every invariant holds', async () => {
    // Purpose: a healthy backlog is exit 0, and the human line names the
    // invariant range from the oracle's own list.
    temp = tempProject({ tracker: 'fake', identity: { agent: 'flow-bot' } });
    const result = await runFlow(['audit'], temp, cleanBacklog());
    expect(result.code).toBe(EXIT.ok);
    const last = INVARIANTS[INVARIANTS.length - 1].id;
    expect(result.stdout).toContain(`every invariant holds (GRM-1 to ${last})`);

    const json = await runFlow(['audit', '--json'], temp, cleanBacklog());
    expect(JSON.parse(json.stdout)).toEqual({ v: 1, ok: true, failures: [] });
  });

  it('exits 1 on a failing invariant and names the item', async () => {
    // Purpose: the audit is a gate; a breach must fail the run and point at
    // the offending item in both output modes.
    temp = tempProject({ tracker: 'fake', identity: { agent: 'flow-bot' } });
    const human = await runFlow(['audit'], temp, failingBacklog());
    expect(human.code).toBe(EXIT.findings);
    expect(human.stdout).toContain('GRM-4  a ready item has a size (1)');
    expect(human.stdout).toMatch(/\n {2}- FAKE-1\b/);

    const json = await runFlow(['audit', '--json'], temp, failingBacklog());
    expect(json.code).toBe(EXIT.findings);
    const verdict = JSON.parse(json.stdout);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatchObject({ invariant: 'GRM-4' });
    expect(verdict.failures[0].detail).toContain('FAKE-1');
  });

  it('resolves identity.agent "auto" to the tracker\'s current user', async () => {
    // Purpose: GRM-8 lets a ready item be assigned to the agent; with
    // identity.agent "auto" that account must come from getCurrentUser, or
    // FAKE-2 would fail as assigned to someone else.
    temp = tempProject({ tracker: 'fake' });
    const result = await runFlow(['audit', '--json'], temp, cleanBacklog());
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });

    const stranger = await runFlow(['audit', '--json'], temp, {
      ...cleanBacklog(),
      user: { id: 'someone-else' },
    });
    expect(JSON.parse(stranger.stdout).failures[0]).toMatchObject({ invariant: 'GRM-8' });
  });

  it('audits a --snapshot file without calling the adapter', async () => {
    // Purpose: a drain reuses one pull across next, audit and status; with
    // --snapshot the tracker must not be touched at all.
    temp = tempProject({ tracker: 'fake', identity: { agent: 'flow-bot' } });
    const saved = path.join(temp.project, 'snap.json');
    const pull = await runFlow(['snapshot', '--json', '--include-closed'], temp, failingBacklog());
    writeFileSync(saved, pull.stdout);

    const result = await runFlow(['audit', '--json', '--snapshot', saved], temp, {
      items: [],
      failReads: 'the tracker must not be read',
    });
    expect(result.adapterBuilds).toBe(0);
    expect(result.code).toBe(EXIT.findings);
    expect(JSON.parse(result.stdout).failures[0]).toMatchObject({ invariant: 'GRM-4' });
  });

  it('exits 2 when --snapshot is not a flow snapshot', async () => {
    // Purpose: a wrong file is the caller's mistake (usage), never an empty,
    // passing backlog.
    temp = tempProject({ tracker: 'fake', identity: { agent: 'flow-bot' } });
    const saved = path.join(temp.project, 'not-a-snapshot.json');
    writeFileSync(saved, JSON.stringify([{ identifier: 'FAKE-1' }]));
    const result = await runFlow(['audit', '--json', '--snapshot', saved], temp, { items: [] });
    expect(result.code).toBe(EXIT.usage);
    expect(JSON.parse(result.stdout).error.message).toMatch(/not the output of "flow snapshot/);
  });

  it('exits 3 when flow is not configured in the project', async () => {
    // Purpose: audit reads the project's identity, so an unconfigured folder
    // must say so rather than audit with a guessed identity.
    temp = tempProject({ tracker: 'fake' });
    const bare = { ...temp, project: path.dirname(temp.plugin) };
    const result = await runFlow(['audit', '--json'], bare, cleanBacklog());
    expect(result.code).toBe(EXIT.config);
  });
});
