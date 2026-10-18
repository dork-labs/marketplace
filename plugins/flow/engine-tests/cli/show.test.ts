/**
 * `flow show <identifier>`: one item as the adapter reads it, description
 * included, so a stage skill can read the item's `## On Completion` (DOR-3063).
 */

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
      readyItem('FAKE-2', {
        title: 'Add a greeting command',
        description: 'Add it.\n\n## On Completion\n\n- File a follow-up: translate it.',
      }),
    ],
  };
}

describe('flow show', () => {
  it('prints the item with its description, as JSON and as text', async () => {
    const json = await runFlow(['show', 'FAKE-2', '--json'], temp, backlog());
    expect(json.code).toBe(EXIT.ok);
    const item = JSON.parse(json.stdout).item;
    expect(item.identifier).toBe('FAKE-2');
    expect(item.description).toContain('## On Completion');

    const text = await runFlow(['show', 'FAKE-2'], temp, backlog());
    expect(text.stdout).toContain('FAKE-2: Add a greeting command');
    expect(text.stdout).toContain('File a follow-up');
  });

  it('needs an identifier', async () => {
    const result = await runFlow(['show'], temp, backlog());
    expect(result.code).toBe(EXIT.usage);
  });
});
