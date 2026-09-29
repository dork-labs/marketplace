/**
 * Reading each project's tracker (spec `flow-multiproject` §2.2, §7.1), with a
 * fake `execFile`: exit 0, 4 and 3 map to answered, not answering (or a gone
 * sign-in, twice in a row) and a settings problem; only the adapter flow ships
 * is read on the timer, never over `mcp`; one read per project and at most
 * two at once; and a project a Flow tab looks at is read again once its last
 * read is over a minute old.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecError, ExecFileLike } from '../lib/advisor.ts';
import type { FlowProjectEntry } from '../lib/projects.ts';
import {
  MAX_READS_AT_ONCE,
  READ_INTERVAL_MS,
  RETRY_AFTER_MS,
  STALE_ON_VIEW_MS,
  TrackerReader,
  canReadOnTimer,
  projectIdOf,
} from '../lib/tracker-reads.ts';

let dorkHome: string;

beforeEach(() => {
  dorkHome = mkdtempSync(path.join(tmpdir(), 'flow-reads-'));
});

afterEach(() => {
  rmSync(dorkHome, { recursive: true, force: true });
});

/** A project on the cli transport with the adapter flow ships. */
function project(root: string, overrides: Partial<FlowProjectEntry> = {}): FlowProjectEntry {
  return {
    root,
    name: path.basename(root),
    setup: 'ready',
    tracker: { id: 'linear', label: 'Linear', team: 'DOR', transport: 'cli', adapter: 'shipped' },
    version: { flow: null, behaviour: 1, olderBehaviour: null },
    ...overrides,
  };
}

/** One scripted answer: an exit code and what the command printed. */
interface Answer {
  code: number;
  stdout?: string;
}

/**
 * A fake `execFile` that answers `snapshot` and `next` from the script, holds
 * each call until `release`, and writes the snapshot file a real snapshot would.
 */
function fakeExec(script: (verb: string, root: string) => Answer, opts: { hold?: boolean } = {}) {
  const calls: { verb: string; root: string; args: string[] }[] = [];
  const held: (() => void)[] = [];
  const exec: ExecFileLike = (_file, args, _opts, callback) => {
    const verb = args[2];
    const root = args[args.indexOf('--project') + 1];
    calls.push({ verb, root, args: [...args] });
    const answer = script(verb, root);
    const finish = () => {
      if (verb === 'snapshot' && answer.code === 0) {
        const out = args[args.indexOf('--out') + 1];
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(
          out,
          JSON.stringify({ team: { key: 'DOR', url: 'https://linear.app/t/DOR' } })
        );
      }
      const error =
        answer.code === 0
          ? null
          : (Object.assign(new Error('exit'), { code: answer.code }) as ExecError);
      callback(error, answer.stdout ?? '', '');
    };
    if (opts.hold) held.push(finish);
    else queueMicrotask(finish);
    return undefined;
  };
  return {
    exec,
    calls,
    release: () => {
      for (const finish of held.splice(0)) finish();
    },
  };
}

/** `flow next --json` saying three are ready and seven eligible. */
const NEXT = JSON.stringify({
  v: 1,
  picked: [
    { identifier: 'DOR-1', title: 'One' },
    { identifier: 'DOR-2', title: 'Two' },
    { identifier: 'DOR-3', title: 'Three' },
  ],
  eligibleCount: 7,
  shapeableCount: 2,
  starved: false,
  atWipCap: false,
});

/** A reader over a fake clock. */
function reader(exec: ExecFileLike, clock: { now: number }) {
  const onChange = vi.fn();
  const log = vi.fn();
  const instance = new TrackerReader({
    dorkHome,
    flowRoot: '/flow',
    execFile: exec,
    now: () => new Date(clock.now),
    log,
    onChange,
  });
  return { instance, onChange, log };
}

/** Let queued microtasks and callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const T0 = Date.parse('2026-09-28T09:00:00.000Z');

describe('canReadOnTimer', () => {
  it('reads only a set-up cli project with the adapter flow ships', () => {
    const base = project('/p');
    const tracker = base.tracker!;
    expect(canReadOnTimer(base)).toBe(true);
    expect(canReadOnTimer(project('/p', { tracker: { ...tracker, transport: 'mcp' } }))).toBe(
      false
    );
    expect(canReadOnTimer(project('/p', { tracker: { ...tracker, adapter: 'project' } }))).toBe(
      false
    );
    expect(canReadOnTimer(project('/p', { setup: 'not-set-up', tracker: null }))).toBe(false);
  });
});

describe('TrackerReader', () => {
  it('reads Up next through flow’s own CLI, and caches the snapshot per project', async () => {
    const fake = fakeExec((verb) => (verb === 'next' ? { code: 0, stdout: NEXT } : { code: 0 }));
    const clock = { now: T0 };
    const { instance, onChange } = reader(fake.exec, clock);
    expect(instance.latest('/p')).toBeNull();
    instance.tick([project('/p')]);
    await settle();
    const file = path.join(dorkHome, 'flow', 'cache', projectIdOf('/p'), 'snapshot.json');
    expect(fake.calls.map((call) => call.args)).toEqual([
      [
        '--experimental-strip-types',
        path.join('/flow', 'scripts', 'flow.ts'),
        'snapshot',
        '--json',
        '--out',
        file,
        '--project',
        '/p',
      ],
      [
        '--experimental-strip-types',
        path.join('/flow', 'scripts', 'flow.ts'),
        'next',
        '--count',
        '3',
        '--json',
        '--no-account',
        '--manual',
        '--snapshot',
        file,
        '--project',
        '/p',
      ],
    ]);
    expect(instance.latest('/p')).toEqual({
      at: new Date(T0).toISOString(),
      queue: {
        next: [
          { identifier: 'DOR-1', title: 'One' },
          { identifier: 'DOR-2', title: 'Two' },
          { identifier: 'DOR-3', title: 'Three' },
        ],
        more: 4,
      },
      teamUrl: 'https://linear.app/t/DOR',
      facts: { eligibleCount: 7, shapeableCount: 2, starved: false, atWipCap: false },
      failure: null,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(projectIdOf('/p')).toMatch(/^[0-9a-f]{12}$/);

    // Not again until five minutes have passed.
    clock.now = T0 + READ_INTERVAL_MS - 1;
    instance.tick([project('/p')]);
    await settle();
    expect(fake.calls).toHaveLength(2);
    clock.now = T0 + READ_INTERVAL_MS;
    instance.tick([project('/p')]);
    await settle();
    expect(fake.calls).toHaveLength(4);
  });

  it('never reads over mcp, or with the project’s own adapter', async () => {
    const fake = fakeExec(() => ({ code: 0, stdout: NEXT }));
    const { instance } = reader(fake.exec, { now: T0 });
    const tracker = project('/p').tracker!;
    instance.tick([
      project('/a', { tracker: { ...tracker, transport: 'mcp' } }),
      project('/b', { tracker: { ...tracker, adapter: 'project' } }),
    ]);
    instance.view('/a');
    instance.tick([project('/a', { tracker: { ...tracker, transport: 'mcp' } })]);
    await settle();
    expect(fake.calls).toEqual([]);
  });

  it('retries a tracker that does not answer after 1, 2, then 5 minutes', async () => {
    const fake = fakeExec(() => ({
      code: 4,
      stdout: JSON.stringify({
        v: 1,
        ok: false,
        error: { code: 4, message: 'timeout', kind: 'unreachable' },
      }),
    }));
    const clock = { now: T0 };
    const { instance } = reader(fake.exec, clock);
    instance.tick([project('/p')]);
    await settle();
    for (const wait of [
      RETRY_AFTER_MS[0],
      RETRY_AFTER_MS[1],
      RETRY_AFTER_MS[2],
      RETRY_AFTER_MS[2],
    ]) {
      const before = fake.calls.length;
      const last = clock.now;
      clock.now = last + wait - 1;
      instance.tick([project('/p')]);
      await settle();
      expect(fake.calls).toHaveLength(before);
      clock.now = last + wait;
      instance.tick([project('/p')]);
      await settle();
      expect(fake.calls).toHaveLength(before + 1);
    }
    expect(instance.latest('/p')?.failure).toEqual({
      kind: 'unreachable',
      since: new Date(T0).toISOString(),
    });
  });

  it('calls a refused sign-in gone only when it is refused twice in a row', async () => {
    let kind = 'auth';
    const fake = fakeExec(() => ({
      code: 4,
      stdout: JSON.stringify({ v: 1, ok: false, error: { code: 4, message: 'no', kind } }),
    }));
    const clock = { now: T0 };
    const { instance } = reader(fake.exec, clock);
    instance.tick([project('/p')]);
    await settle();
    expect(instance.latest('/p')?.failure?.kind).toBe('unreachable');
    clock.now += RETRY_AFTER_MS[0];
    instance.tick([project('/p')]);
    await settle();
    expect(instance.latest('/p')?.failure).toEqual({
      kind: 'auth',
      since: new Date(T0).toISOString(),
    });
    // A blip in between starts the count again.
    kind = 'unreachable';
    clock.now += RETRY_AFTER_MS[1];
    instance.tick([project('/p')]);
    await settle();
    expect(instance.latest('/p')?.failure?.kind).toBe('unreachable');
  });

  it('says a settings problem on exit 3, and only logs any other failure', async () => {
    let code = 3;
    const fake = fakeExec(() => ({ code }));
    const clock = { now: T0 };
    const { instance, log } = reader(fake.exec, clock);
    instance.tick([project('/p')]);
    await settle();
    expect(instance.latest('/p')?.failure?.kind).toBe('settings');
    code = 6;
    const other = project('/q');
    instance.tick([other]);
    await settle();
    expect(instance.latest('/q')).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not read the tracker of q/));
  });

  it('clears a failure once the tracker answers again', async () => {
    let failing = true;
    const fake = fakeExec((verb) =>
      failing ? { code: 4, stdout: '' } : verb === 'next' ? { code: 0, stdout: NEXT } : { code: 0 }
    );
    const clock = { now: T0 };
    const { instance } = reader(fake.exec, clock);
    instance.tick([project('/p')]);
    await settle();
    expect(instance.latest('/p')?.failure).not.toBeNull();
    failing = false;
    clock.now += RETRY_AFTER_MS[0];
    instance.tick([project('/p')]);
    await settle();
    expect(instance.latest('/p')?.failure).toBeNull();
  });

  it('reads at most two projects at once, and never one project twice', async () => {
    const fake = fakeExec(() => ({ code: 0, stdout: NEXT }), { hold: true });
    const { instance } = reader(fake.exec, { now: T0 });
    const all = ['/a', '/b', '/c'].map((root) => project(root));
    instance.tick(all);
    instance.tick(all);
    await settle();
    expect(fake.calls.map((call) => call.root)).toEqual(['/a', '/b']);
    expect(MAX_READS_AT_ONCE).toBe(2);
    fake.release();
    await settle();
    fake.release();
    await settle();
    instance.tick(all);
    await settle();
    expect(fake.calls.map((call) => call.root)).toContain('/c');
  });

  it('reads a project a Flow tab looks at once its last read is over a minute old', async () => {
    const fake = fakeExec((verb) => (verb === 'next' ? { code: 0, stdout: NEXT } : { code: 0 }));
    const clock = { now: T0 };
    const { instance } = reader(fake.exec, clock);
    instance.tick([project('/p')]);
    await settle();
    expect(fake.calls).toHaveLength(2);
    clock.now = T0 + STALE_ON_VIEW_MS;
    instance.view('/p');
    instance.tick([project('/p')]);
    await settle();
    expect(fake.calls).toHaveLength(2);
    clock.now = T0 + STALE_ON_VIEW_MS + 1;
    instance.view('/p');
    instance.tick([project('/p')]);
    await settle();
    expect(fake.calls).toHaveLength(4);
  });

  it('starts nothing once disposed', async () => {
    const fake = fakeExec(() => ({ code: 0, stdout: NEXT }));
    const { instance } = reader(fake.exec, { now: T0 });
    instance.dispose();
    instance.tick([project('/p')]);
    await settle();
    expect(fake.calls).toEqual([]);
  });
});
