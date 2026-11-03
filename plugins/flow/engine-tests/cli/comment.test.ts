/**
 * `flow comment` (DOR-3707): an agent's comment goes out signed, because on a
 * shared tracker account the signature is all that tells it from the person's.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import type { FakeBacklog } from '../../scripts/tracker/fake.ts';
import { item, makeProject, runFlow, type WriteProject } from './write-harness.ts';

let project: WriteProject;

beforeEach(() => {
  project = makeProject();
});

afterEach(() => project.cleanup());

/** One item, with its comments so far. */
function backlog(bodies: string[] = []): FakeBacklog {
  return {
    user: { id: 'agent-1' },
    members: ['agent-1'],
    items: [item('FAKE-1')],
    comments: {
      'FAKE-1': bodies.map((body, i) => ({
        id: `c${i}`,
        author: 'agent-1',
        authorIsTrusted: true,
        body,
        createdAt: `2026-09-26T11:0${i}:00.000Z`,
      })),
    },
  };
}

/** The comments the verb posted. */
function posted(result: Awaited<ReturnType<typeof runFlow>>): string[] {
  return result.tracker.writes.flatMap((call) =>
    call.method === 'comment' ? [(call as { body: string }).body] : []
  );
}

describe('flow comment', () => {
  // Purpose: a bare agent comment on a shared account reads as the person, and
  // flow acts on it. Fails if the verb posts without the marker or the line.
  it('posts the text with the marker and the hidden line last', async () => {
    const result = await runFlow(project, backlog(), [
      'comment',
      'FAKE-1',
      '--text',
      'Spec is at specs/x.',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.json).toMatchObject({ identifier: 'FAKE-1', posted: true });
    expect(posted(result)).toEqual([
      expect.stringMatching(
        /^Spec is at specs\/x\.\n\n— 🤖 \/flow\n<!-- agent:provenance \{.*\} -->$/
      ),
    ]);
  });

  it('reads a scratch file and removes it once posted', async () => {
    const dir = path.join(project.dir, '.dork', 'flow', 'tmp');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'c.md');
    writeFileSync(file, 'From a file.\n');
    const result = await runFlow(project, backlog(), [
      'comment',
      'FAKE-1',
      '--text-file',
      '.dork/flow/tmp/c.md',
    ]);
    expect(posted(result)[0]).toMatch(/^From a file\.\n\n/);
    expect(existsSync(file)).toBe(false);
  });

  it('a retry of the same words posts nothing', async () => {
    const result = await runFlow(project, backlog(['Same words.\n\n— 🤖 /flow']), [
      'comment',
      'FAKE-1',
      '--text',
      'Same words.',
    ]);
    expect(result.json).toMatchObject({ posted: false });
    expect(posted(result)).toEqual([]);
  });

  it('--dry-run posts nothing', async () => {
    const result = await runFlow(project, backlog(), [
      'comment',
      'FAKE-1',
      '--text',
      'Hello.',
      '--dry-run',
    ]);
    expect(result.json).toMatchObject({ dryRun: true, posted: true });
    expect(posted(result)).toEqual([]);
  });

  it.each([
    ['no text', []],
    ['empty text', ['--text', '   ']],
  ])('refuses %s', async (_name, flags) => {
    const result = await runFlow(project, backlog(), ['comment', 'FAKE-1', ...flags]);
    expect(result.code).toBe(EXIT.usage);
    expect(posted(result)).toEqual([]);
  });
});
