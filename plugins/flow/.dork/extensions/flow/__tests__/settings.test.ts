/**
 * A project's settings on the server (spec `flow-multiproject` §8.2-§8.3,
 * §11): `GET /settings/:name` reads both files leniently and says where each
 * value came from; the person-only `PUT /settings/:name` changes only the keys
 * it names, checks the result with this extension's own flow, and puts both
 * files back when the check finds a problem the write caused; the pause
 * default lives in the extension's storage; a key a project's older flow would
 * refuse is refused first. The record of the "Only for these repos" move is
 * kept behind a person-only route too. And flow's server half has no way to
 * write the dial or which accounts a project may use.
 */

import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecFileLike } from '../lib/advisor.ts';
import type { FlowModel } from '../lib/model.ts';
import {
  PAUSE_DEFAULTS_KEY,
  UPDATE_FLOW_TEXT,
  parseSettingsPatch,
  readProjectSettings,
  type ProjectSettingsView,
} from '../lib/settings.ts';
import { REPO_MIGRATION_KEY } from '../lib/repo-migration.ts';
import { createFlowExtension } from '../server.ts';
import { NOT_A_PERSON, fakeCtx, fakeRouter, makeWorld, type World } from './fixtures.ts';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-09-29T12:00:00.000Z');

let world: World;

beforeEach(() => {
  world = makeWorld();
});

afterEach(() => {
  world.cleanup();
});

/** The project's two files. */
function files(root = world.main) {
  const dir = path.join(root, '.agents', 'flow');
  return { dir, shared: path.join(dir, 'config.json'), local: path.join(dir, 'config.local.json') };
}

/** Write the project's committed settings. */
function configure(config: Record<string, unknown>, local?: Record<string, unknown>): void {
  const paths = files();
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.shared, `${JSON.stringify(config, null, 2)}\n`);
  if (local !== undefined) writeFileSync(paths.local, `${JSON.stringify(local, null, 2)}\n`);
}

/** Run flow's real `config-files.ts`; answer every tracker read as unreachable. */
const realExec: ExecFileLike = (file, args, opts, callback) => {
  if (args.some((arg) => arg.endsWith(`${path.sep}flow.ts`))) {
    queueMicrotask(() => callback(Object.assign(new Error('no tracker'), { code: 4 }), '', ''));
    return undefined;
  }
  return (execFile as unknown as ExecFileLike)(file, args, opts, callback);
};

/** Build the extension, and make it see the project (its name is its folder's: `main`). */
async function setup(opts: Parameters<typeof fakeCtx>[1] = {}, exec: ExecFileLike = realExec) {
  const router = fakeRouter();
  const host = fakeCtx(world, { extensionDir: EXTENSION_DIR, ...opts });
  const ext = createFlowExtension(router, host.ctx, {
    now: () => NOW,
    originOf: () => null,
    log: () => {},
    execFile: exec,
    pidAlive: () => true,
  });
  await router.call('get', '/model', { query: { cwd: world.main } });
  return { router, host, ext };
}

async function settings(router: ReturnType<typeof fakeRouter>): Promise<ProjectSettingsView> {
  const sent = await router.call('get', '/settings/:name', { params: { name: 'main' } });
  expect(sent.status).toBe(200);
  return sent.body as ProjectSettingsView;
}

describe('GET /settings/:name', () => {
  it('reads both files leniently, with defaults, and says where each value came from', async () => {
    configure(
      { tracker: 'linear', review: { adversarial: false }, drain: { parallel: 3 } },
      { drain: { parallel: 0 }, autonomy: { default: 'bogus' } }
    );
    const { router } = await setup();
    const view = await settings(router);
    expect(view.files).toEqual({
      shared: '.agents/flow/config.json',
      local: '.agents/flow/config.local.json',
    });
    expect(view.shared.reviewerAgent).toEqual({ value: false, source: 'shared', locked: null });
    expect(view.shared.mergeOnApproval).toEqual({ value: true, source: 'default', locked: null });
    // 0 is flow's sequential default: one at a time. It came from this computer.
    expect(view.local.parallel).toEqual({ value: 1, source: 'local', locked: null });
    // A value flow can't read is its default.
    expect(view.local.startsOnItsOwn).toEqual({ value: 'auto', source: 'default', locked: null });
    expect(view.pauseDefault).toBe('tomorrow');
    expect(view.canChange).toBe(true);
  });

  it('answers 404 in plain words for a project flow does not know', async () => {
    configure({ tracker: 'linear' });
    const { router } = await setup();
    const sent = await router.call('get', '/settings/:name', { params: { name: 'nope' } });
    expect(sent).toEqual({
      status: 404,
      body: { error: 'No flow project is called nope on this computer.', refusedBy: 'flow' },
    });
  });
});

describe('PUT /settings/:name', () => {
  it('changes only the keys it names, in the right file, and leaves every other key as it was', async () => {
    configure({ $schema: './x.json', tracker: 'linear', connection: { team: { key: 'DOR' } } });
    const { router } = await setup();
    const sent = await router.call('put', '/settings/:name', {
      params: { name: 'main' },
      body: {
        shared: { reviewerAgent: false, labels: ['bug', 'bug', 'idea'] },
        local: { parallel: 3, startsOnItsOwn: 'manual' },
      },
    });
    expect(sent.status).toBe(200);
    expect(JSON.parse(readFileSync(files().shared, 'utf8'))).toEqual({
      $schema: './x.json',
      tracker: 'linear',
      connection: { team: { key: 'DOR' } },
      review: { adversarial: false },
      groom: { unnamespacedLabels: ['bug', 'idea'] },
    });
    expect(JSON.parse(readFileSync(files().local, 'utf8'))).toEqual({
      drain: { parallel: 3 },
      autonomy: { default: 'manual' },
    });
    // The local file was created kept out of git, as flow's own prepare does.
    expect(readFileSync(path.join(files().dir, '.gitignore'), 'utf8')).toContain(
      'config.local.json'
    );
    const view = sent.body as ProjectSettingsView;
    expect(view.local.parallel).toEqual({ value: 3, source: 'local', locked: null });
  });

  it('puts both files back, byte for byte, when the check finds a problem the write caused', async () => {
    configure({ tracker: 'linear' }, { secrets: { trackerToken: 't' } });
    const before = { shared: readFileSync(files().shared), local: readFileSync(files().local) };
    let checks = 0;
    const exec: ExecFileLike = (file, args, opts, callback) => {
      if (args.includes('check')) {
        checks += 1;
        const errors =
          checks === 1 ? [] : [{ path: '/drain/parallel', message: 'must be at most 2' }];
        queueMicrotask(() =>
          callback(null, `${JSON.stringify({ ok: errors.length === 0, errors })}\n`, '')
        );
        return undefined;
      }
      return realExec(file, args, opts, callback);
    };
    const { router } = await setup({}, exec);
    const sent = await router.call('put', '/settings/:name', {
      params: { name: 'main' },
      body: { shared: { armAutoMerge: true }, local: { parallel: 5 } },
    });
    expect(sent).toEqual({
      status: 400,
      body: { error: "Flow didn't save that: must be at most 2", refusedBy: 'flow' },
    });
    expect(readFileSync(files().shared)).toEqual(before.shared);
    expect(readFileSync(files().local)).toEqual(before.local);
  });

  it('keeps the committed file’s own indentation, ending and mode', async () => {
    const paths = files();
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.shared, JSON.stringify({ tracker: 'linear' }, null, 4), { mode: 0o644 });
    chmodSync(paths.shared, 0o644);
    const { router } = await setup();
    const sent = await router.call('put', '/settings/:name', {
      params: { name: 'main' },
      body: { shared: { mergeOnApproval: false } },
    });
    expect(sent.status).toBe(200);
    expect(readFileSync(paths.shared, 'utf8')).toBe(
      JSON.stringify({ tracker: 'linear', gates: { review: { mergeOnApproval: false } } }, null, 4)
    );
    expect(statSync(paths.shared).mode & 0o777).toBe(0o644);
  });

  it('holds both files’ locks through the check and the putting back', async () => {
    configure({ tracker: 'linear' }, {});
    const held: boolean[] = [];
    let checks = 0;
    const exec: ExecFileLike = (file, args, opts, callback) => {
      if (args.includes('check')) {
        checks += 1;
        if (checks === 2) {
          held.push(existsSync(`${files().shared}.lock`), existsSync(`${files().local}.lock`));
        }
        const errors = checks === 1 ? [] : [{ path: '/x', message: 'no' }];
        queueMicrotask(() =>
          callback(null, `${JSON.stringify({ ok: errors.length === 0, errors })}\n`, '')
        );
        return undefined;
      }
      return realExec(file, args, opts, callback);
    };
    const { router } = await setup({}, exec);
    const sent = await router.call('put', '/settings/:name', {
      params: { name: 'main' },
      body: { shared: { armAutoMerge: true }, local: { parallel: 2 } },
    });
    expect(sent.status).toBe(400);
    expect(held).toEqual([true, true]);
    expect(existsSync(`${files().shared}.lock`)).toBe(false);
    expect(existsSync(`${files().local}.lock`)).toBe(false);
  });

  it('saves over a problem that was already there, which this write did not cause', async () => {
    configure({ tracker: 'linear' });
    const exec: ExecFileLike = (file, args, opts, callback) => {
      if (args.includes('check')) {
        const errors = [{ path: '/tracker', message: 'old problem' }];
        queueMicrotask(() => callback(null, `${JSON.stringify({ ok: false, errors })}\n`, ''));
        return undefined;
      }
      return realExec(file, args, opts, callback);
    };
    const { router } = await setup({}, exec);
    const sent = await router.call('put', '/settings/:name', {
      params: { name: 'main' },
      body: { shared: { mergeOnApproval: false } },
    });
    expect(sent.status).toBe(200);
  });

  it('checks the files with this extension’s own flow, never the project’s copy', async () => {
    configure({ tracker: 'linear' });
    const scripts: string[] = [];
    const exec: ExecFileLike = (file, args, opts, callback) => {
      const script = args.find((arg) => arg.endsWith('config-files.ts'));
      if (script !== undefined) scripts.push(script);
      return realExec(file, args, opts, callback);
    };
    const { router } = await setup({}, exec);
    await router.call('put', '/settings/:name', {
      params: { name: 'main' },
      body: { shared: { reviewerAgent: false } },
    });
    expect(scripts.length).toBeGreaterThan(0);
    const own = path.resolve(EXTENSION_DIR, '../../..', 'scripts', 'config-files.ts');
    expect(new Set(scripts)).toEqual(new Set([own]));
  });

  it('keeps the pause default in the extension’s storage, and the model carries it', async () => {
    configure({ tracker: 'linear' });
    const { router, host } = await setup();
    const sent = await router.call('put', '/settings/:name', {
      params: { name: 'main' },
      body: { pauseDefault: 'hour' },
    });
    expect((sent.body as ProjectSettingsView).pauseDefault).toBe('hour');
    expect((host.store.data as Record<string, unknown>)[PAUSE_DEFAULTS_KEY]).toEqual({
      [world.main]: 'hour',
    });
    expect(existsSync(files().local)).toBe(false);
    const model = (await router.call('get', '/model', { query: {} })).body as FlowModel;
    expect(model.projects[0].pauseDefault).toBe('hour');
  });

  it.each([
    [{ shared: { parallel: 2 } }, 'Flow\'s settings page can\'t change "parallel".'],
    [{ local: { secrets: {} } }, 'Flow\'s settings page can\'t change "secrets".'],
    [{ local: { parallel: 9 } }, 'Choose between 1 and 8 at once.'],
    [{ shared: { labels: ['team/x'] } }, 'A label has no "/" and no space at either end.'],
    [{ pauseDefault: 'forever' }, 'Choose one of the pause menu’s choices.'],
  ])('refuses %j before writing anything', async (body, words) => {
    configure({ tracker: 'linear' });
    const before = readFileSync(files().shared, 'utf8');
    const { router } = await setup();
    const sent = await router.call('put', '/settings/:name', { params: { name: 'main' }, body });
    expect(sent).toEqual({ status: 400, body: { error: words, refusedBy: 'flow' } });
    expect(readFileSync(files().shared, 'utf8')).toBe(before);
  });

  it('is person-only: an agent is refused, and nothing is written', async () => {
    configure({ tracker: 'linear' });
    const before = readFileSync(files().shared, 'utf8');
    const { router } = await setup();
    const sent = await router.call('put', '/settings/:name', {
      params: { name: 'main' },
      body: { shared: { reviewerAgent: false } },
      agent: true,
    });
    expect(sent).toEqual({ status: 403, body: { error: NOT_A_PERSON } });
    expect(readFileSync(files().shared, 'utf8')).toBe(before);
  });

  it('is not registered at all on a DorkOS without the person guard, and says so in the view', async () => {
    configure({ tracker: 'linear' });
    const { router } = await setup({ personGuard: false });
    expect(router.has('put', '/settings/:name')).toBe(false);
    expect(router.has('put', '/fleet/migration')).toBe(false);
    expect((await settings(router)).canChange).toBe(false);
  });

  it('answers host-too-old on a DorkOS from before 0.88.0', async () => {
    const router = fakeRouter();
    createFlowExtension(router, fakeCtx(world, { dorkHome: false }).ctx);
    expect(await router.call('get', '/settings/:name', { params: { name: 'x' } })).toEqual({
      status: 501,
      body: { reason: 'host-too-old' },
    });
  });
});

describe('key skew (§8.3 step 1)', () => {
  const entry = {
    root: '/work/x',
    name: 'x',
    setup: 'ready' as const,
    tracker: null,
    version: { flow: null, behaviour: -1, olderBehaviour: null },
  };

  it('refuses a key the project’s flow is too old for, before anything is written', () => {
    expect(() => parseSettingsPatch({ shared: { reviewerAgent: false } }, -1)).toThrow(
      UPDATE_FLOW_TEXT
    );
    expect(parseSettingsPatch({ shared: { reviewerAgent: false } }, 0)).toEqual({
      shared: { reviewerAgent: false },
      local: {},
    });
  });

  it('marks such a field locked, with the same words, when it is read', () => {
    const view = readProjectSettings(entry, { pauseDefault: 'tomorrow', canChange: true });
    expect(view.shared.reviewerAgent.locked).toBe(UPDATE_FLOW_TEXT);
  });
});

describe('the record of moving "Only for these repos"', () => {
  it('reads empty, stores a record a person sends, and refuses anything else', async () => {
    configure({ tracker: 'linear' });
    const { router, host } = await setup();
    expect((await router.call('get', '/fleet/migration')).body).toEqual({ accounts: {} });
    const record = {
      accounts: {
        'claude-code:work': {
          movedRoots: ['/work/client-app'],
          pendingRepos: ['acme/web'],
          at: '2026-09-29T10:00:00.000Z',
        },
      },
    };
    expect(
      (await router.call('put', '/fleet/migration', { body: record, agent: true })).status
    ).toBe(403);
    expect((await router.call('put', '/fleet/migration', { body: record })).body).toEqual(record);
    expect((host.store.data as Record<string, unknown>)[REPO_MIGRATION_KEY]).toEqual(record);
    expect((await router.call('put', '/fleet/migration', { body: { accounts: 3 } })).status).toBe(
      400
    );
  });
});

describe('what flow’s server half can never write', () => {
  // Purpose: the dial and account access are a person's to change (spec §7.7,
  // §8.4). The type test in host-types.contract.test.ts proves there is no
  // setter on ctx.projectSettings; this proves no server file reaches for a
  // writer by another road (DorkOS's HTTP routes, or the client API).
  it('never calls a settings setter or DorkOS’s account-rule routes', () => {
    const server = [path.join(EXTENSION_DIR, 'server.ts')];
    const lib = path.join(EXTENSION_DIR, 'lib');
    for (const name of readdirSync(lib)) {
      if (name.endsWith('.ts')) server.push(path.join(lib, name));
    }
    for (const file of server) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/projectSettings\??\.set\(/);
      expect(text, file).not.toMatch(/project-accounts|only-projects|account-eligibility/);
    }
  });
});
