/**
 * Which projects run flow and what each is called (spec `flow-multiproject`
 * §9): candidates from core's registry, flow's own discovery and storage; the
 * install check; core's names used as given; the folder-name fallback with
 * core's clash rule; reporting roots core does not list; and version skew.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTALL_DIR,
  ProjectDirectory,
  SEEN_KEY,
  fallbackNames,
  flowSetupOf,
  readBehaviour,
  readTracker,
  versionOf,
  type Behaviour,
} from '../lib/projects.ts';
import { SharedStorage } from '../lib/shared-storage.ts';
import { fakeProjects, git, makeWorld, runRecord, writeRuns, type World } from './fixtures.ts';

let world: World;

beforeEach(() => {
  world = makeWorld();
});

afterEach(() => {
  world.cleanup();
});

/** A git repo at `dir`. */
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  return dir;
}

/** Write a project's committed flow settings. */
function configure(root: string, config: Record<string, unknown> = {}): void {
  mkdirSync(path.join(root, '.agents', 'flow'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'flow', 'config.json'), JSON.stringify(config));
}

/** Put a copy of flow in a project. */
function install(root: string, version: string, behaviour?: number): void {
  const dir = path.join(root, INSTALL_DIR);
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  if (behaviour !== undefined) {
    writeFileSync(
      path.join(dir, 'behaviour.json'),
      JSON.stringify({ v: 1, behaviour, changes: [] })
    );
  }
}

/** A flow folder with a behaviour file and a shipped Linear adapter. */
function flowRoot(): string {
  const dir = path.join(world.root, 'flow');
  mkdirSync(path.join(dir, 'skills', 'linear-adapter'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', 'linear-adapter', 'adapter.ts'), '');
  writeFileSync(
    path.join(dir, 'behaviour.json'),
    JSON.stringify({
      v: 1,
      behaviour: 1,
      changes: [{ level: 1, effect: 'timed pauses end on time' }],
    })
  );
  return dir;
}

/** An in-memory storage. */
function storage(initial: unknown = null) {
  const box = { data: initial };
  const shared = new SharedStorage({
    loadData: async <T>() => box.data as T | null,
    saveData: async <T>(data: T) => {
      box.data = JSON.parse(JSON.stringify(data));
    },
  });
  return { box, shared };
}

describe('flowSetupOf', () => {
  it('knows a flow project by its settings, its copy of flow or its runs', () => {
    expect(flowSetupOf(world.main)).toBeNull();
    install(world.main, '0.49.0');
    expect(flowSetupOf(world.main)).toBe('not-set-up');
    configure(world.main);
    expect(flowSetupOf(world.main)).toBe('ready');
    const other = repo(path.join(world.root, 'runs-only'));
    writeRuns({ ...world, main: other }, { a: runRecord(world) });
    expect(flowSetupOf(other)).toBe('not-set-up');
  });
});

describe('fallbackNames', () => {
  it("applies core's clash rule, the same way every time", () => {
    const names = fallbackNames([
      '/Volumes/y/work/dorkos',
      '/Users/kai/dev/dorkos',
      '/Users/kai/client work/dorkos',
      '/Volumes/x/work/dorkos',
      '/Users/kai/dev/my app',
    ]);
    expect(Object.fromEntries(names)).toEqual({
      '/Users/kai/client work/dorkos': 'dorkos',
      '/Users/kai/dev/dorkos': 'dorkos~dev',
      '/Users/kai/dev/my app': 'my-app',
      '/Volumes/x/work/dorkos': 'dorkos~work',
      '/Volumes/y/work/dorkos': 'dorkos~work-2',
    });
  });
});

describe('versionOf', () => {
  const own: Behaviour = {
    behaviour: 2,
    changes: [
      { level: 1, effect: 'timed pauses end on time' },
      { level: 2, effect: 'the terminal obeys the account rule' },
    ],
  };

  it('names the first thing an older flow lacks, and nothing when behaviour is equal', () => {
    install(world.main, '0.46.1');
    expect(versionOf(world.main, own)).toEqual({
      flow: '0.46.1',
      behaviour: 0,
      olderBehaviour: 'timed pauses end on time',
    });
    install(world.main, '0.49.0', 1);
    expect(versionOf(world.main, own).olderBehaviour).toBe('the terminal obeys the account rule');
    install(world.main, '9.9.9', 2);
    expect(versionOf(world.main, own)).toEqual({
      flow: '9.9.9',
      behaviour: 2,
      olderBehaviour: null,
    });
  });

  it('says nothing about a project with no copy of flow of its own', () => {
    expect(versionOf(world.main, own)).toEqual({ flow: null, behaviour: 2, olderBehaviour: null });
  });

  it('reads a missing or broken behaviour file as level 0', () => {
    expect(readBehaviour(path.join(world.root, 'none.json'))).toEqual({
      behaviour: 0,
      changes: [],
    });
  });
});

describe('readTracker', () => {
  it('merges the two files and knows which adapter a read would run', () => {
    const flow = flowRoot();
    configure(world.main, { connection: { team: { key: null } } });
    writeFileSync(
      path.join(world.main, '.agents', 'flow', 'config.local.json'),
      JSON.stringify({ connection: { team: { key: 'DOR' } } })
    );
    expect(readTracker(world.main, flow)).toEqual({
      id: 'linear',
      label: 'Linear',
      team: 'DOR',
      transport: 'cli',
      adapter: 'shipped',
    });
    configure(world.main, { tracker: 'jira', connection: { transport: 'mcp' } });
    expect(readTracker(world.main, flow)).toMatchObject({
      label: 'Jira',
      transport: 'mcp',
      adapter: 'other',
    });
    configure(world.main, {});
    mkdirSync(path.join(world.main, '.agents', 'flow', 'adapters', 'linear'), { recursive: true });
    writeFileSync(path.join(world.main, '.agents', 'flow', 'adapters', 'linear', 'SKILL.md'), '');
    expect(readTracker(world.main, flow)?.adapter).toBe('project');
    rmSync(path.join(world.main, '.agents', 'flow', 'config.json'));
    expect(readTracker(world.main, flow)).toBeNull();
  });
});

describe('ProjectDirectory', () => {
  it("lists core's projects under core's names, reports the ones it does not know, and remembers them", async () => {
    const flow = flowRoot();
    const work = repo(path.join(world.root, 'work', 'dorkos'));
    configure(work);
    configure(world.main);
    const found = repo(path.join(world.root, 'found'));
    install(found, '0.49.0', 1);
    const core = fakeProjects([
      { root: work, name: 'dorkos~work', originRepo: null, lastSeenAt: '2026-09-28T00:00:00Z' },
      {
        root: world.main,
        name: 'main',
        originRepo: 'acme/app',
        lastSeenAt: '2026-09-28T00:00:00Z',
      },
    ]);
    const { box, shared } = storage({ claimed: {}, reported: ['a→b'] });
    const directory = new ProjectDirectory({
      flowRoot: flow,
      projects: core.api,
      storage: shared,
      log: () => {},
    });
    const listed = await directory.list([found]);
    expect(listed.map((p) => [p.name, p.root, p.setup])).toEqual([
      // A clash name reaches the URL as core gave it.
      ['dorkos~work', work, 'ready'],
      ['found~reported', found, 'not-set-up'],
      ['main', world.main, 'ready'],
    ]);
    expect(core.api.report).toHaveBeenCalledTimes(1);
    expect(core.api.report).toHaveBeenCalledWith(found);
    await directory.list([found]);
    expect(core.api.report).toHaveBeenCalledTimes(1);
    // Remembered beside the watcher's data, which it left alone.
    expect(box.data).toMatchObject({ reported: ['a→b'], [SEEN_KEY]: [work, world.main, found] });

    // After a restart, a project not found again still shows; a vanished one drops out.
    rmSync(work, { recursive: true, force: true });
    core.list.length = 0;
    const restarted = new ProjectDirectory({
      flowRoot: flow,
      projects: core.api,
      storage: storage(box.data).shared,
      log: () => {},
    });
    expect((await restarted.list([])).map((p) => p.root)).toEqual([found, world.main]);
  });

  it('names projects by folder, with the clash rule, without core’s registry', async () => {
    const flow = flowRoot();
    const a = repo(path.join(world.root, 'dev', 'app'));
    const b = repo(path.join(world.root, 'work', 'app'));
    configure(a);
    configure(b);
    const directory = new ProjectDirectory({
      flowRoot: flow,
      storage: storage().shared,
      log: () => {},
    });
    expect((await directory.list([b, a])).map((p) => p.name)).toEqual(['app', 'app~work']);
  });

  it('keeps working when core’s list fails', async () => {
    const flow = flowRoot();
    configure(world.main);
    const core = fakeProjects();
    core.api.list.mockRejectedValueOnce(new Error('down'));
    const logs: string[] = [];
    const directory = new ProjectDirectory({
      flowRoot: flow,
      projects: core.api,
      storage: storage().shared,
      log: (line) => logs.push(line),
    });
    expect((await directory.list([world.main])).map((p) => p.root)).toEqual([world.main]);
    expect(logs[0]).toMatch(/could not list DorkOS's projects/);
  });
});
