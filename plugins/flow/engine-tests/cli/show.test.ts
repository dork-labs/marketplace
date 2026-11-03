/**
 * `flow show <identifier>`: one item as the adapter reads it, description
 * included, so a stage skill can read the item's `## On Completion` (DOR-3063).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import type { FakeBacklog } from '../../scripts/tracker/fake.ts';
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

  it('fails plainly on an item the tracker does not have', async () => {
    const result = await runFlow(['show', 'FAKE-99', '--json'], temp, backlog());
    expect(result.code).not.toBe(EXIT.ok);
    expect(result.code).not.toBe(EXIT.internal);
    expect(JSON.parse(result.stdout).error.message).toMatch(/FAKE-99/);
  });

  it('needs an identifier', async () => {
    const result = await runFlow(['show'], temp, backlog());
    expect(result.code).toBe(EXIT.usage);
  });

  // Purpose (DOR-3677, Security's S1): a resumed agent reads an item's newest
  // comments through `flow show`, so a guest's text must not reach it there
  // either. A member's comment comes through whole; an outsider's or an
  // author-less one keeps its author and time, with the text withheld. Fails if
  // any untrusted body is printed.
  it('withholds the text of every comment not from a team member', async () => {
    const at = '2026-09-26T12:00:00.000Z';
    const result = await runFlow(['show', 'FAKE-2', '--json'], temp, {
      ...backlog(),
      members: ['dorian'],
      comments: {
        'FAKE-2': [
          { id: 'c1', author: 'dorian', authorIsTrusted: true, body: 'Go with B.', createdAt: at },
          { id: 'c2', author: 'guest', authorIsTrusted: true, body: 'SECRET-G', createdAt: at },
          { id: 'c3', author: '', authorIsTrusted: false, body: 'SECRET-N', createdAt: at },
        ],
      },
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).not.toMatch(/SECRET/);
    const comments = JSON.parse(result.stdout).item.comments;
    expect(comments[0]).toMatchObject({ id: 'c1', body: 'Go with B.' });
    expect(comments[0].withheld).toBeUndefined();
    expect(comments[1]).toMatchObject({ id: 'c2', author: 'guest', withheld: true });
    expect(comments[2]).toMatchObject({ id: 'c3', author: '', withheld: true });
  });
});
