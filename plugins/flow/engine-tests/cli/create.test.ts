/**
 * `flow create` (DOR-2433): one new item through the adapter's `createItem`,
 * signed, idempotent with a key, refused before any tracker call when the
 * request is malformed or the item is not triaged (DOR-4546), and refused
 * when an open item nearly matches it. Against the reference fake tracker, in a throwaway
 * git project configured for it.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkedLine, keyMarker } from '../../scripts/cli/create.ts';
import { EXIT } from '../../scripts/errors.ts';
import { main } from '../../scripts/flow.ts';
import { FakeTracker, type FakeBacklog } from '../../scripts/tracker/fake.ts';
import type { Capability, WorkItem } from '../../scripts/tracker/types.ts';

const NOW = new Date('2026-09-26T12:00:00.000Z');

/** The project every test item is filed in. */
const REPORTS = { id: 'proj-1', name: 'Reports', stateCategory: 'started' as const };

/** The two sections every new item's description carries. */
const SECTIONS =
  '\n\n## Proof\n\nThree people asked for it in support this week.' +
  '\n\n## Done when\n\n- The monthly report downloads as a CSV file.';

/** A complete description. */
const BODY = `People want the monthly report as a CSV file.${SECTIONS}`;

/** The fields besides title and description that make an item complete. */
const REST = ['--label', 'type/idea', '--priority', '3', '--size', '2', '--for-project', 'Reports'];

/** The flags {@link createArgs} fills, by name. */
type Field = 'title' | 'description' | 'priority' | 'size' | 'for-project';

/**
 * A complete `flow create` argv, with fields replaced (`null` leaves one out).
 *
 * @param over - The fields to replace or drop.
 * @param labels - The labels.
 * @returns The argv.
 */
function createArgs(
  over: Partial<Record<Field, string | null>> = {},
  labels: readonly string[] = ['type/idea', 'origin/human']
): string[] {
  const fields: Record<Field, string | null> = {
    title: 'Export the monthly report as CSV',
    description: BODY,
    priority: '3',
    size: '2',
    'for-project': 'Reports',
    ...over,
  };
  return [
    'create',
    ...Object.entries(fields).flatMap(([name, value]) =>
      value === null ? [] : [`--${name}`, value]
    ),
    ...labels.flatMap((label) => ['--label', label]),
  ];
}

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-create-')));
  execFileSync('git', ['init', '-q'], { cwd: project });
  mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
  writeFileSync(
    path.join(project, '.agents', 'flow', 'config.json'),
    JSON.stringify({ tracker: 'fake', identity: { agent: 'user-flow-agent' } })
  );
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

/** An open item already in the tracker. */
function existing(identifier: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    description: '',
    type: 'idea',
    stateCategory: 'backlog',
    stateName: 'Triage',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['type/idea', 'origin/human'],
    ...over,
  };
}

/** A fake whose every call is counted, reads included. */
function tracker(backlog: FakeBacklog = { items: [] }) {
  const fake = new FakeTracker({ projects: [REPORTS], ...backlog }, { now: () => NOW });
  const calls: string[] = [];
  const counted = new Proxy(fake.adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fake, calls, adapter: counted };
}

/** Run `flow <argv> --json` in the project. */
async function flow(argv: string[], t: ReturnType<typeof tracker>, json = true) {
  let out = '';
  let err = '';
  const code = await main(json ? [...argv, '--json'] : argv, {
    env: { FLOW_SESSION_ID: 'session-abc', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/h/.claude-work' },
    cwd: project,
    now: () => NOW,
    stdout: { write: (text: string) => ((out += text), true) },
    stderr: { write: (text: string) => ((err += text), true) },
    createAdapter: async () => t.adapter,
    runProcess: async () => ({ code: 1, stdout: '', stderr: '' }),
  });
  const parsed = json && out.trim().startsWith('{') ? JSON.parse(out) : undefined;
  return { code, out, err, json: parsed as Record<string, unknown> };
}

/** The items the fake holds now that it did not hold before. */
function added(t: ReturnType<typeof tracker>, before: readonly string[]): WorkItem[] {
  return t.fake.backlog.items.filter((i) => !before.includes(i.identifier));
}

const CAPTURE = createArgs();

describe('flow create', () => {
  it('files one item with the labels, in triage, and prints the v1 JSON shape', async () => {
    // Purpose: the capture write lands as asked, and the output is the stable contract.
    const t = tracker({ items: [existing('FAKE-1')] });
    const run = await flow(CAPTURE, t);
    expect(run.code).toBe(EXIT.ok);
    expect(run.json).toEqual({
      v: 1,
      ok: true,
      created: true,
      identifier: 'FAKE-2',
      title: 'Export the monthly report as CSV',
      url: 'https://fake.tracker/FAKE-2',
    });
    const [item] = added(t, ['FAKE-1']);
    expect(item).toMatchObject({
      title: 'Export the monthly report as CSV',
      labels: ['type/idea', 'origin/human'],
      stateName: 'Triage',
      type: 'idea',
    });
    expect(item).toMatchObject({ priority: 3, size: 2, project: { id: 'proj-1' } });
  });

  it('prints one line of text: identifier, title, url', async () => {
    const t = tracker();
    const run = await flow(CAPTURE, t, false);
    expect(run.code).toBe(EXIT.ok);
    expect(run.out).toBe('FAKE-1 Export the monthly report as CSV https://fake.tracker/FAKE-1\n');
  });

  it('signs the description with the identity marker and a provenance line', async () => {
    // Purpose: every flow write is signed, so comment-response rules and
    // provenance routing see the item as the agent's.
    const t = tracker();
    await flow(CAPTURE, t);
    const description = t.fake.backlog.items[0].description;
    expect(description.startsWith(BODY)).toBe(true);
    expect(description.slice(BODY.length)).toMatch(
      /^\n\n— 🤖 \/flow\n<!-- agent:provenance \{"v":1,"harness":"claude-code","sessionId":"session-abc","account":"claude-work",.*\} -->$/
    );
  });

  it('passes project, parent, priority and size through', async () => {
    const t = tracker({ items: [existing('FAKE-1')] });
    const run = await flow([...createArgs({ priority: '1', size: '5' }), '--parent', 'FAKE-1'], t);
    expect(run.code).toBe(EXIT.ok);
    const [item] = added(t, ['FAKE-1']);
    expect(item).toMatchObject({
      priority: 1,
      size: 5,
      parent: 'FAKE-1',
      project: { id: 'proj-1' },
    });
  });

  it('returns the open item a key already filed, and creates nothing', async () => {
    // Purpose: a repeat with the same key (a retried capture) never files twice.
    const t = tracker();
    const first = await flow([...CAPTURE, '--key', 'capture-csv'], t);
    expect(first.json).toMatchObject({ created: true, identifier: 'FAKE-1' });
    expect(t.fake.backlog.items[0].description).toContain(keyMarker('capture-csv'));
    const second = await flow([...CAPTURE, '--key', 'capture-csv'], t);
    expect(second.code).toBe(EXIT.ok);
    expect(second.json).toMatchObject({ created: false, identifier: 'FAKE-1' });
    expect(t.fake.writes.map((w) => w.method)).toEqual(['createItem']);
    expect(t.fake.backlog.items).toHaveLength(1);
  });

  it("says a repeat was already captured, with the first item's own title", async () => {
    // Purpose: two ideas sharing a key must not read as the new idea filed under the old id.
    const t = tracker({
      items: [existing('FAKE-4', { title: 'An older idea', description: keyMarker('csv') })],
    });
    const json = await flow([...CAPTURE, '--key', 'csv'], t);
    expect(json.json).toMatchObject({
      created: false,
      identifier: 'FAKE-4',
      title: 'An older idea',
    });
    const text = await flow([...CAPTURE, '--key', 'csv'], t, false);
    expect(text.out).toBe('Already captured as FAKE-4 - An older idea\n');
  });

  it('reports created: false when the adapter hands back an item that was already open', async () => {
    // Purpose: an item the key made before the marker existed is not new.
    const t = tracker({
      items: [existing('FAKE-3', { title: 'Filed by key alone' })],
      createdKeys: { 'team-fake:k9': 'FAKE-3' },
    });
    const run = await flow([...CAPTURE, '--key', 'k9'], t);
    expect(run.json).toMatchObject({
      created: false,
      identifier: 'FAKE-3',
      title: 'Filed by key alone',
    });
    expect(t.fake.backlog.items).toHaveLength(1);
  });

  it('journals the item it filed on the verb line', async () => {
    const t = tracker();
    await flow(CAPTURE, t);
    const lines = readFileSync(path.join(project, '.dork', 'flow', 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ kind: 'verb', verb: 'create', item: 'FAKE-1' })
    );
  });

  it('finds a keyed item by its marker even when the tracker lost the key', async () => {
    // Purpose: the snapshot check, not only the adapter's key, stops the duplicate.
    const t = tracker({
      items: [existing('FAKE-4', { description: `Earlier.\n\n${keyMarker('k1')}\n\nsig` })],
    });
    const run = await flow([...CAPTURE, '--key', 'k1'], t);
    expect(run.json).toMatchObject({ created: false, identifier: 'FAKE-4' });
    expect(t.calls).not.toContain('createItem');
  });

  it('files again once the keyed item is closed: a key names one open item', async () => {
    const t = tracker();
    await flow([...CAPTURE, '--key', 'k2'], t);
    Object.assign(t.fake.backlog.items[0], { stateCategory: 'completed', stateName: 'Done' });
    const again = await flow([...CAPTURE, '--key', 'k2'], t);
    expect(again.json).toMatchObject({ created: true, identifier: 'FAKE-2' });
  });

  it('reads the description from --description-file', async () => {
    writeFileSync(path.join(project, 'idea.md'), `From a file.${SECTIONS}\n`);
    const t = tracker();
    const run = await flow(['create', '--title', 'T', '--description-file', 'idea.md', ...REST], t);
    expect(run.code).toBe(EXIT.ok);
    expect(t.fake.backlog.items[0].description.startsWith('From a file.\n\n— 🤖 /flow')).toBe(true);
  });

  it('removes a description file under .dork/flow/tmp once filed, and keeps one elsewhere', async () => {
    // Purpose: the capture's scratch file never lingers where git could pick it up,
    // and flow never deletes a file the operator keeps.
    const scratch = path.join(project, '.dork', 'flow', 'tmp', 'idea.md');
    mkdirSync(path.dirname(scratch), { recursive: true });
    writeFileSync(scratch, `Scratch idea.${SECTIONS}\n`);
    writeFileSync(path.join(project, 'kept.md'), `Kept idea.${SECTIONS}\n`);
    // A look-alike outside the scratch folder is kept.
    mkdirSync(path.join(project, '.dork', 'flow', 'tmp-not'), { recursive: true });
    writeFileSync(path.join(project, '.dork', 'flow', 'tmp-not', 'x.md'), `Near miss.${SECTIONS}\n`);
    const t = tracker();
    const args = (file: string) => ['create', '--title', 'T', ...REST, '--description-file', file];

    const dry = await flow([...args('.dork/flow/tmp/idea.md'), '--dry-run'], t);
    expect(dry.code).toBe(EXIT.ok);
    expect(existsSync(scratch)).toBe(true);

    expect((await flow(args('.dork/flow/tmp/idea.md'), t)).code).toBe(EXIT.ok);
    expect(existsSync(scratch)).toBe(false);
    expect(t.fake.backlog.items[0].description.startsWith('Scratch idea.')).toBe(true);

    expect((await flow(args('kept.md'), t)).code).toBe(EXIT.ok);
    expect(existsSync(path.join(project, 'kept.md'))).toBe(true);
    expect((await flow(args('.dork/flow/tmp-not/x.md'), t)).code).toBe(EXIT.ok);
    expect(existsSync(path.join(project, '.dork', 'flow', 'tmp-not', 'x.md'))).toBe(true);
  });

  it('never deletes through a link: a scratch folder or file that points out of the project is kept', async () => {
    // Purpose: the scratch check compares real paths, so a linked .dork, .dork/flow/tmp
    // or a linked file never makes flow delete a file outside the project.
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-create-outside-')));
    try {
      writeFileSync(path.join(outside, 'real.md'), `Outside.${SECTIONS}\n`);
      const t = tracker();
      const args = ['create', '--title', 'T', ...REST, '--description-file'];

      // .dork/flow/tmp is a link to a folder outside the project.
      mkdirSync(path.join(project, '.dork', 'flow'), { recursive: true });
      symlinkSync(outside, path.join(project, '.dork', 'flow', 'tmp'));
      expect((await flow([...args, '.dork/flow/tmp/real.md'], t)).code).toBe(EXIT.ok);
      expect(existsSync(path.join(outside, 'real.md'))).toBe(true);
      rmSync(path.join(project, '.dork', 'flow', 'tmp'));

      // .dork itself is a link out.
      rmSync(path.join(project, '.dork'), { recursive: true, force: true });
      mkdirSync(path.join(outside, 'flow', 'tmp'), { recursive: true });
      writeFileSync(path.join(outside, 'flow', 'tmp', 'deep.md'), `Deep.${SECTIONS}\n`);
      symlinkSync(outside, path.join(project, '.dork'));
      expect((await flow([...args, '.dork/flow/tmp/deep.md'], t)).code).toBe(EXIT.ok);
      expect(existsSync(path.join(outside, 'flow', 'tmp', 'deep.md'))).toBe(true);
      rmSync(path.join(project, '.dork'));

      // A real scratch folder holding a link to a file outside.
      mkdirSync(path.join(project, '.dork', 'flow', 'tmp'), { recursive: true });
      symlinkSync(
        path.join(outside, 'real.md'),
        path.join(project, '.dork', 'flow', 'tmp', 'link.md')
      );
      expect((await flow([...args, '.dork/flow/tmp/link.md'], t)).code).toBe(EXIT.ok);
      expect(existsSync(path.join(outside, 'real.md'))).toBe(true);

      // Only a regular file is deleted: a link, even to another scratch file, is not.
      const tmpDir = path.join(project, '.dork', 'flow', 'tmp');
      writeFileSync(path.join(tmpDir, 'target.md'), `Target.${SECTIONS}\n`);
      symlinkSync(path.join(tmpDir, 'target.md'), path.join(tmpDir, 'inner.md'));
      expect((await flow([...args, '.dork/flow/tmp/inner.md'], t)).code).toBe(EXIT.ok);
      expect(existsSync(path.join(tmpDir, 'target.md'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps .dork/flow/tmp out of git when it reads a scratch file there', async () => {
    // Purpose: a scratch file kept for a retry (here, after a refused create) can never be committed.
    const scratch = path.join(project, '.dork', 'flow', 'tmp', 'idea.md');
    mkdirSync(path.dirname(scratch), { recursive: true });
    writeFileSync(scratch, `Scratch idea.${SECTIONS}\n`);
    const t = tracker();
    const run = await flow(
      ['create', '--title', 'T', '--description-file', scratch, ...REST, '--label', 'area/none'],
      t
    );
    expect(run.code).toBe(EXIT.tracker);
    expect(existsSync(scratch)).toBe(true);
    const exclude = readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n')).toContain('.dork/flow/tmp/');
    const ignored = spawnSync('git', ['check-ignore', '-q', '.dork/flow/tmp/idea.md'], {
      cwd: project,
    });
    expect(ignored.status).toBe(0);
  });

  it('adds no exclude line on --dry-run', async () => {
    // Purpose: a dry run writes nothing for the scratch file, not even git's exclude.
    const scratch = path.join(project, '.dork', 'flow', 'tmp', 'idea.md');
    mkdirSync(path.dirname(scratch), { recursive: true });
    writeFileSync(scratch, `Scratch idea.${SECTIONS}\n`);
    const t = tracker();
    const run = await flow(
      ['create', '--title', 'T', '--description-file', scratch, ...REST, '--dry-run'],
      t
    );
    expect(run.code).toBe(EXIT.ok);
    const file = path.join(project, '.git', 'info', 'exclude');
    const exclude = existsSync(file) ? readFileSync(file, 'utf8') : '';
    expect(exclude.split('\n')).not.toContain('.dork/flow/tmp/');
  });

  it('checks the scratch folder again before deleting: one swapped for a link meanwhile is not followed', async () => {
    // Purpose: .dork/flow/tmp replaced by a link out of the project during the
    // tracker call must not make flow delete the file the link reaches.
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-create-swap-')));
    try {
      const tmpDir = path.join(project, '.dork', 'flow', 'tmp');
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(path.join(tmpDir, 'idea.md'), `Scratch idea.${SECTIONS}\n`);
      writeFileSync(path.join(outside, 'idea.md'), 'Outside, same name.\n');
      const t = tracker();
      const create = t.adapter.createItem as NonNullable<typeof t.adapter.createItem>;
      const swapping = {
        ...t.adapter,
        capabilities: t.adapter.capabilities,
        createItem: async (spec: Parameters<typeof create>[0]) => {
          const created = await create(spec);
          renameSync(tmpDir, `${tmpDir}-aside`);
          symlinkSync(outside, tmpDir);
          return created;
        },
      };
      const run = await flow(
        ['create', '--title', 'T', '--description-file', '.dork/flow/tmp/idea.md', ...REST],
        { ...t, adapter: swapping }
      );
      expect(run.code).toBe(EXIT.ok);
      expect(existsSync(path.join(outside, 'idea.md'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps the scratch file when the create fails, for the retry', async () => {
    const scratch = path.join(project, '.dork', 'flow', 'tmp', 'idea.md');
    mkdirSync(path.dirname(scratch), { recursive: true });
    writeFileSync(scratch, `Scratch idea.${SECTIONS}\n`);
    const t = tracker();
    const run = await flow(
      ['create', '--title', 'T', '--description-file', scratch, ...REST, '--label', 'area/none'],
      t
    );
    expect(run.code).toBe(EXIT.tracker);
    expect(existsSync(scratch)).toBe(true);
  });

  it.each([
    ['an empty title', ['create', '--title', '  ', '--description', 'd']],
    ['no description', ['create', '--title', 't']],
    [
      'both descriptions',
      ['create', '--title', 't', '--description', 'd', '--description-file', 'f'],
    ],
    ['an agent/* label', [...CAPTURE, '--label', 'agent/ready']],
    ['two labels in one group', [...CAPTURE, '--label', 'type/task']],
    ['a priority above 4', createArgs({ priority: '5' })],
    ['a priority that is not a number', createArgs({ priority: 'high' })],
    ['priority 0 (none)', createArgs({ priority: '0' })],
    ['a size of 0', createArgs({ size: '0' })],
    ['a size that is neither points nor a t-shirt size', createArgs({ size: 'huge' })],
    ['an empty --not-duplicate-of', [...CAPTURE, '--not-duplicate-of', ' ']],
    ['a --not-duplicate-of that is not an identifier', [...CAPTURE, '--not-duplicate-of', 'a b!']],
    ['a key that could close its marker', [...CAPTURE, '--key', 'a -->']],
    [
      'a title ending in a capture tag without agent/from-outside',
      [
        'create',
        '--title',
        'Export as CSV [acme/app#7]',
        '--description',
        'd',
        '--label',
        'type/idea',
      ],
    ],
  ])('refuses %s with exit 2 before any tracker call', async (_what, argv) => {
    // Purpose: a malformed request never reaches the tracker, not even as a read.
    const t = tracker({ items: [], failReads: 'the tracker must not be reached' });
    const run = await flow(argv, t);
    expect(run.code).toBe(EXIT.usage);
    expect(t.calls).toEqual([]);
    expect(t.fake.writes).toEqual([]);
  });

  it('files an item captured from outside with agent/from-outside, the one agent/* label it takes', async () => {
    // Purpose: a captured GitHub issue is never readied unattended (DOR-3258).
    const t = tracker({ items: [existing('FAKE-1')] });
    const captured = await flow(
      createArgs({ title: 'Let people export the report as CSV [acme/app#7]' }, [
        'type/idea',
        'agent/from-outside',
      ]),
      t
    );
    expect(captured.code).toBe(EXIT.ok);
    expect(added(t, ['FAKE-1'])[0].labels).toEqual(['type/idea', 'agent/from-outside']);
  });

  it('writes nothing on --dry-run and prints the planned item', async () => {
    const t = tracker();
    const run = await flow([...createArgs({ priority: '4' }), '--dry-run'], t);
    expect(run.code).toBe(EXIT.ok);
    expect(run.json).toMatchObject({
      ok: true,
      created: false,
      dryRun: true,
      identifier: null,
      item: {
        title: 'Export the monthly report as CSV',
        labels: ['type/idea', 'origin/human'],
        priority: 4,
        size: 2,
        project: 'Reports',
      },
    });
    expect(t.calls).not.toContain('createItem');
    expect(t.fake.backlog.items).toEqual([]);
  });

  it('exits 3 naming createItem when the adapter cannot create', async () => {
    const noCreate: Capability[] = [
      'getCurrentUser',
      'getBacklogSnapshot',
      'getItem',
      'applyWorkState',
      'comment',
    ];
    const t = tracker({ items: [], capabilities: noCreate });
    const run = await flow(CAPTURE, t);
    expect(run.code).toBe(EXIT.config);
    expect(JSON.stringify(run.json)).toContain('createItem');
    expect(t.fake.writes).toEqual([]);
  });

  it('exits 4 when the team has no such label, and creates nothing', async () => {
    // Purpose: flow never creates labels; the adapter's refusal comes through.
    const t = tracker();
    const run = await flow([...CAPTURE, '--label', 'area/reports'], t);
    expect(run.code).toBe(EXIT.tracker);
    expect(t.fake.backlog.items).toEqual([]);
  });
});

describe('flow create files only a triaged item (DOR-4546)', () => {
  /** Run a create that must be refused before the tracker is reached. */
  async function refused(argv: string[]) {
    const t = tracker({ items: [], failReads: 'the tracker must not be reached' });
    const run = await flow(argv, t);
    expect(run.code).toBe(EXIT.usage);
    expect(t.calls).toEqual([]);
    expect(t.fake.writes).toEqual([]);
    return JSON.stringify(run.json) + run.err;
  }

  /** The phrase each missing field is named by. */
  const NAMES = {
    type: 'a type (--label type/',
    priority: 'a priority (--priority',
    size: 'a size (--size',
    project: 'a project (--for-project)',
    proof: '\\"## Proof\\" section',
    done: '\\"## Done when\\" section',
  } as const;

  it.each([
    ['type', createArgs({}, ['origin/human'])],
    ['priority', createArgs({ priority: null })],
    ['size', createArgs({ size: null })],
    ['project', createArgs({ 'for-project': null })],
    [
      'proof',
      createArgs({
        description: 'People want a CSV.\n\n## Done when\n\n- It downloads as CSV.',
      }),
    ],
    ['done', createArgs({ description: 'People want a CSV.\n\n## Proof\n\nThree asked.' })],
  ] as const)('refuses an item with no %s, naming only that', async (field, argv) => {
    // Purpose: each required field alone is enough to stop the filing.
    const message = await refused([...argv]);
    expect(message).toContain(NAMES[field]);
    expect(message).toContain('Fix this:');
    for (const [other, phrase] of Object.entries(NAMES)) {
      if (other !== field) expect(message).not.toContain(phrase);
    }
  });

  it('names every missing field in one refusal', async () => {
    // Purpose: the filer fixes everything in one go, not one error at a time.
    const message = await refused([
      'create',
      '--title',
      'Export the monthly report as CSV',
      '--description',
      'Just a thought.',
    ]);
    expect(message).toContain('Fix these 6:');
    for (const phrase of Object.values(NAMES)) expect(message).toContain(phrase);
    expect(message).toContain('Nothing was filed');
  });

  it('collects malformed values into the same one refusal', async () => {
    // Purpose: a bad priority, a bad size and a missing project are fixed in one go.
    const message = await refused(
      createArgs({ priority: '9', size: 'huge', 'for-project': null }, [
        'type/idea',
        'agent/ready',
      ])
    );
    expect(message).toContain('Fix these 4:');
    expect(message).toContain('--priority must be 1 to 4');
    expect(message).toContain('--size takes');
    expect(message).toContain('agent/* label');
    expect(message).toContain(NAMES.project);
    // Given but malformed is not also reported missing.
    expect(message).not.toContain(NAMES.priority);
    expect(message).not.toContain(NAMES.size);
  });

  it('reads no heading inside a code fence, and keeps a sub-heading inside its section', async () => {
    const fenced = await refused(
      createArgs({
        description: 'Body.\n\n```\n## Proof\n\nnot really\n```\n\n## Done when\n\n- Ok.',
      })
    );
    expect(fenced).toContain(NAMES.proof);
    expect(fenced).not.toContain(NAMES.done);

    const t = tracker();
    const nested = await flow(
      createArgs({
        description: 'Body.\n\n## Proof\n\n### The log\n\nA line.\n\n## Done when\n\n- Ok.',
      }),
      t
    );
    expect(nested.code).toBe(EXIT.ok);
    // A sub-heading alone is not proof.
    const bare = await refused(
      createArgs({ description: 'Body.\n\n## Proof\n\n### The log\n\n## Done when\n\n- Ok.' })
    );
    expect(bare).toContain(NAMES.proof);
  });

  it('names the title and description too when nothing at all is given', async () => {
    const message = await refused(['create']);
    expect(message).toContain('a title (--title)');
    expect(message).toContain('a description (--description or --description-file)');
    expect(message).toContain(NAMES.type);
    expect(message).toContain(NAMES.project);
  });

  it('refuses priority 0 and says which numbers are which bucket', async () => {
    const message = await refused(createArgs({ priority: '0' }));
    expect(message).toMatch(/0 means none/);
    expect(message).toMatch(/1 or 2 \(Must\), 3 \(Should\) or 4 \(Could\)/);
  });

  it('refuses an empty section: a heading with nothing under it is not proof', async () => {
    const message = await refused(
      createArgs({ description: 'People want a CSV.\n\n## Proof\n\n## Done when\n\n- It downloads.' })
    );
    expect(message).toContain(NAMES.proof);
    expect(message).not.toContain(NAMES.done);
  });

  it.each([
    ['other heading levels and a colon', '# proof:\n\nSeen in the log.\n\n### Done when:\n\n- Ok.'],
    ['bold labels', '**Proof:** the failing command.\n**Done-when:** the command passes.'],
    ['Evidence and Acceptance criteria', '## Evidence\n\nA log line.\n\n## Acceptance criteria\n\n- Ok.'],
    ['Validation criteria', '## Proof\n\nA log line.\n\n## Validation criteria\n\n- Ok.'],
  ])('accepts %s', async (_what, description) => {
    const t = tracker();
    const run = await flow(createArgs({ description: `Body.\n\n${description}` }), t);
    expect(run.code).toBe(EXIT.ok);
    expect(t.fake.backlog.items).toHaveLength(1);
  });

  it('accepts a t-shirt size where the tracker uses them', async () => {
    const t = tracker();
    const run = await flow(createArgs({ size: 'MD' }), t);
    expect(run.code).toBe(EXIT.ok);
    expect(t.fake.backlog.items[0].size).toBe('md');
  });

  it('exits 3 naming the contract when the adapter is older than 3.1.0 and would drop the size', async () => {
    const t = tracker();
    const old = { ...t.adapter, capabilities: t.adapter.capabilities, contractVersion: '3.0.0' };
    const run = await flow(CAPTURE, { ...t, adapter: old });
    expect(run.code).toBe(EXIT.config);
    expect(JSON.stringify(run.json)).toContain('contract 3.0.0');
    expect(t.fake.writes).toEqual([]);
    const current = { ...old, contractVersion: '3.1.0' };
    expect((await flow(CAPTURE, { ...t, adapter: current })).code).toBe(EXIT.ok);
  });

  it('exits 3 naming getBacklogSnapshot when the adapter cannot read the backlog', async () => {
    // Purpose: no duplicate check, no filing.
    const t = tracker({
      items: [],
      capabilities: ['getCurrentUser', 'getItem', 'applyWorkState', 'comment', 'createItem'],
    });
    const run = await flow(CAPTURE, t);
    expect(run.code).toBe(EXIT.config);
    expect(JSON.stringify(run.json)).toContain('getBacklogSnapshot');
    expect(t.fake.writes).toEqual([]);
  });
});

describe('flow create checks for a duplicate first (DOR-4546)', () => {
  const NEAR = 'Let people export the monthly report as a CSV file';

  it('refuses a near match with its identifier and title, and files nothing', async () => {
    // Purpose: new detail goes on the item that already exists.
    const t = tracker({ items: [existing('FAKE-7', { title: NEAR })] });
    const run = await flow(CAPTURE, t);
    expect(run.code).toBe(EXIT.precondition);
    expect(run.json).toMatchObject({
      ok: false,
      created: false,
      nearMatches: [{ identifier: 'FAKE-7', title: NEAR, score: 0.8 }],
    });
    expect(String(run.json.message)).toContain('--not-duplicate-of FAKE-7');
    expect(t.calls).not.toContain('createItem');
    expect(t.fake.backlog.items).toHaveLength(1);
    // The text mode's first line says what it is, whatever the exit code.
    const text = await flow(CAPTURE, t, false);
    expect(text.out.startsWith(`near duplicate: FAKE-7 - ${NEAR}`)).toBe(true);
  });

  it('leaves the --parent out of the check: a sub-item shares its words', async () => {
    const t = tracker({ items: [existing('FAKE-7', { title: NEAR })] });
    const run = await flow([...CAPTURE, '--parent', 'FAKE-7'], t);
    expect(run.code).toBe(EXIT.ok);
    expect(added(t, ['FAKE-7'])[0].parent).toBe('FAKE-7');
  });

  it('refuses on --dry-run too', async () => {
    const t = tracker({ items: [existing('FAKE-7', { title: NEAR })] });
    const run = await flow([...CAPTURE, '--dry-run'], t);
    expect(run.code).toBe(EXIT.precondition);
  });

  it('files once --not-duplicate-of names every near match, and records the check', async () => {
    const t = tracker({
      items: [
        existing('FAKE-7', { title: NEAR }),
        existing('FAKE-8', { title: 'Export the monthly report as a CSV' }),
      ],
    });
    const partial = await flow([...CAPTURE, '--not-duplicate-of', 'FAKE-7'], t);
    expect(partial.code).toBe(EXIT.precondition);
    expect((partial.json.nearMatches as { identifier: string }[]).map((m) => m.identifier)).toEqual([
      'FAKE-8',
    ]);

    const run = await flow([...CAPTURE, '--not-duplicate-of', 'fake-7, FAKE-8'], t);
    expect(run.code).toBe(EXIT.ok);
    const [item] = added(t, ['FAKE-7', 'FAKE-8']);
    expect(item.description).toContain(checkedLine(['FAKE-7', 'FAKE-8']));
  });

  it('files past an item that only shares a theme, and past a closed near match', async () => {
    const t = tracker({
      items: [
        existing('FAKE-2', { title: 'Flaky test in the relay unit suite' }),
        existing('FAKE-3', { title: NEAR, stateCategory: 'completed', stateName: 'Done' }),
      ],
    });
    const flaky = await flow(createArgs({ title: 'Flaky test in the rooms e2e suite' }), t);
    expect(flaky.code).toBe(EXIT.ok);
    const csv = await flow(CAPTURE, t);
    expect(csv.code).toBe(EXIT.ok);
  });

  it('returns the keyed item before it checks for duplicates', async () => {
    // Purpose: a retried capture finds its own item, never a refusal against it.
    const t = tracker();
    await flow([...CAPTURE, '--key', 'csv-1'], t);
    const again = await flow([...CAPTURE, '--key', 'csv-1'], t);
    expect(again.code).toBe(EXIT.ok);
    expect(again.json).toMatchObject({ created: false, identifier: 'FAKE-1' });
  });
});
