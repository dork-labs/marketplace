/**
 * `flow snapshot` (spec `flow-cli-core` §6, task 3.1): one backlog pull through
 * the adapter, summarized for a person, printed whole with `--json`, and saved
 * with `--out` for `--snapshot` reuse.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import type { FakeBacklog } from '../fixtures/cli/fake-adapter/adapter.ts';
import { readyItem, runFlow, tempProject, type TempProject } from './read-verb-harness.ts';

let temp: TempProject;

beforeEach(() => {
  temp = tempProject({ tracker: 'fake' });
});

afterEach(() => temp.cleanup());

function backlog(): FakeBacklog {
  return {
    team: { key: 'FAKE', id: 'team-1' },
    items: [
      readyItem('FAKE-1'),
      readyItem('FAKE-2', { labels: ['type/bug', 'agent/ready', 'stage/verify'] }),
      readyItem('FAKE-3', {
        stateCategory: 'started',
        labels: ['type/task', 'agent/claimed'],
      }),
      readyItem('FAKE-4', { stateCategory: 'backlog', labels: ['type/idea'] }),
    ],
    closed: [{ identifier: 'FAKE-9', title: 'Shipped', stateCategory: 'completed' }],
    projects: [{ id: 'proj-1', name: 'Widgets', stateCategory: 'started' }],
  };
}

describe('flow snapshot', () => {
  it('prints counts by state category and by label family', async () => {
    // Purpose: the human summary is how a person sees the backlog's shape; the
    // counts must be right per state and per label leaf within each family.
    const result = await runFlow(['snapshot'], temp, backlog());
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain('Open items: 4');
    expect(result.stdout).toMatch(/backlog\s+1\n\s+unstarted\s+2\n\s+started\s+1/);
    expect(result.stdout).toMatch(/agent\s+claimed 1, ready 2/);
    expect(result.stdout).toMatch(/stage\s+execute 1, verify 1/);
    expect(result.stdout).toMatch(/type\s+bug 1, idea 1, task 2/);
    expect(result.stdout).not.toContain('Closed items');
  });

  it('prints the whole snapshot under --json and asks for closed items only with --include-closed', async () => {
    // Purpose: --json is the BacklogSnapshot itself (the input --snapshot reads);
    // closed titles are a separate, opt-in pull.
    const plain = JSON.parse((await runFlow(['snapshot', '--json'], temp, backlog())).stdout);
    expect(plain).toMatchObject({ v: 1, tracker: 'fake', team: { key: 'FAKE' } });
    expect(plain.items.map((item: { identifier: string }) => item.identifier)).toEqual([
      'FAKE-1',
      'FAKE-2',
      'FAKE-3',
      'FAKE-4',
    ]);
    expect(plain.closed).toEqual([]);

    const withClosed = await runFlow(['snapshot', '--json', '--include-closed'], temp, backlog());
    expect(JSON.parse(withClosed.stdout).closed).toEqual([
      { identifier: 'FAKE-9', title: 'Shipped', stateCategory: 'completed' },
    ]);
    const human = await runFlow(['snapshot', '--include-closed'], temp, backlog());
    expect(human.stdout).toContain('Closed items: 1');
  });

  it('writes the same JSON to --out that --json prints', async () => {
    // Purpose: the saved file is what `next`, `audit` and `status` read with
    // --snapshot, so it must be exactly the --json output.
    const out = path.join(temp.project, 'saved', 'snap.json');
    const result = await runFlow(['snapshot', '--json', '--out', out], temp, backlog());
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(JSON.parse(result.stdout));
  });

  it('resolves a relative --out against the working folder', async () => {
    // Purpose: a person types `--out snap.json` and expects it where they are.
    await runFlow(['snapshot', '--out', 'snap.json'], temp, backlog());
    expect(JSON.parse(readFileSync(path.join(temp.project, 'snap.json'), 'utf8')).v).toBe(1);
  });

  it('exits 3 naming the capability when the adapter cannot pull a snapshot', async () => {
    // Purpose: an adapter without getBacklogSnapshot must fail as a config
    // problem that names the missing method, not as a crash.
    const result = await runFlow(['snapshot', '--json'], temp, {
      ...backlog(),
      capabilities: ['getCurrentUser', 'getItem'],
    });
    expect(result.code).toBe(EXIT.config);
    expect(JSON.parse(result.stdout).error.message).toMatch(/getBacklogSnapshot/);
  });
});
