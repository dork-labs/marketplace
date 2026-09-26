/**
 * The file-backed run store (`scripts/flow-state-file.ts`, spec `flow-cli-core`
 * §1.3): `<main checkout>/.dork/flow/flow-state.json`, shared by every worktree
 * of a project and written through the shared lock (`atomic-json.ts`).
 *
 * What this pins: every worktree resolves the one file in the main checkout;
 * concurrent writers from separate processes never lose each other's runs; a
 * field this reader does not know survives a write of another run; and a file
 * that exists but cannot be read is never replaced (that would delete every
 * other in-flight run).
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../scripts/errors.ts';
import type { FlowRun } from '../scripts/flow-run.ts';
import { openFlowStateFile, resolveMainCheckout } from '../scripts/flow-state-file.ts';

const MODULE_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'flow-state-file.ts')
).href;

let root: string;
let repo: string;

/** Run git in `cwd` quietly. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flow-state-file-')));
  repo = path.join(root, 'main');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A run record, overridable per test. */
function run(issueId: string, overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    issueId,
    identifier: issueId.toUpperCase(),
    sessionId: `session-${issueId}`,
    worktreePath: `/work/${issueId}`,
    branch: issueId,
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 4242,
    startedAt: '2026-09-26T16:00:00.000Z',
    ...overrides,
  };
}

/** The store file for `repo`. */
function stateFile(): string {
  return path.join(repo, '.dork', 'flow', 'flow-state.json');
}

describe('where the store lives', () => {
  // Purpose: the main checkout is the parent of `git rev-parse --git-common-dir`,
  // so a linked worktree resolves the MAIN checkout's file, and every worktree
  // of a project shares one store.
  it('resolves the main checkout from a linked worktree', async () => {
    const worktree = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', worktree);
    expect(resolveMainCheckout(worktree)).toBe(repo);
    expect(resolveMainCheckout(repo)).toBe(repo);
    mkdirSync(path.join(worktree, 'deep', 'er'), { recursive: true });
    expect(resolveMainCheckout(path.join(worktree, 'deep', 'er'))).toBe(repo);

    const fromWorktree = openFlowStateFile(worktree);
    expect(fromWorktree.path).toBe(stateFile());
    await fromWorktree.upsertRun(run('a'));
    expect(Object.keys(openFlowStateFile(repo).read())).toEqual(['a']);
    expect(readdirSync(worktree)).not.toContain('.dork');
  });

  // Purpose: a folder that is not a git checkout has no main checkout; that is
  // a config error naming the folder, not a silent fallback to cwd.
  it('refuses a folder that is not a git checkout', () => {
    const plain = path.join(root, 'plain');
    mkdirSync(plain);
    expect(() => resolveMainCheckout(plain)).toThrow(ConfigError);
    expect(() => resolveMainCheckout(plain)).toThrow(plain);
  });
});

describe('writing runs', () => {
  // Purpose: the helpers cover the run lifecycle over one file: upsert, status
  // and stage changes that keep the other fields, and removal.
  it('upserts, updates and removes runs', async () => {
    const store = openFlowStateFile(repo);
    expect(store.read()).toEqual({});
    expect((await store.upsertRun(run('a'))).status).toBe('written');
    await store.upsertRun(run('b'));
    await store.setRunStage('a', 'verify');
    await store.setRunStatus('b', 'complete', { completedAt: '2026-09-26T17:00:00.000Z' });
    expect(store.read()).toEqual({
      a: run('a', { stage: 'verify' }),
      b: run('b', { status: 'complete', completedAt: '2026-09-26T17:00:00.000Z' }),
    });
    await store.removeRun('a');
    expect(Object.keys(store.read())).toEqual(['b']);
  });

  // Purpose: changing a run that does not exist creates nothing (the claim step
  // owns creation), so the file is not even written.
  it('leaves the file alone when the run does not exist', async () => {
    const store = openFlowStateFile(repo);
    expect((await store.setRunStatus('nope', 'failed')).status).toBe('unchanged');
    expect((await store.setRunStage('nope', 'verify')).status).toBe('unchanged');
    expect((await store.removeRun('nope')).status).toBe('unchanged');
    expect(existsSync(stateFile())).toBe(false);
  });

  // Purpose: the store is read-modify-write, so a field this reader does not
  // know (a newer writer's) must survive a write of ANOTHER run, and reads pass
  // it through too.
  it('keeps unknown fields on other runs', async () => {
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    const future = { ...run('a'), checkpoint: { ref: 'abc123' }, host: 'future-launcher' };
    writeFileSync(stateFile(), JSON.stringify({ a: future }));
    const store = openFlowStateFile(repo);
    expect(store.read().a).toEqual(future);
    await store.upsertRun(run('b', { account: 'claude3', host: 'cli' }));
    const onDisk = JSON.parse(readFileSync(stateFile(), 'utf8')) as Record<string, unknown>;
    expect(onDisk.a).toEqual(future);
    expect(onDisk.b).toEqual(run('b', { account: 'claude3', host: 'cli' }));
  });

  // Purpose: a file that is present but fails the schema is refused with a
  // ConfigError naming it, and left byte-for-byte unchanged. The fail-soft
  // reader would read it as {}, and writing that back would delete every other
  // in-flight run.
  it('refuses to replace a file that fails the schema', async () => {
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    const bytes = JSON.stringify({ a: run('a'), b: { issueId: 'b' } }, null, 3);
    writeFileSync(stateFile(), bytes);
    const store = openFlowStateFile(repo);
    expect(store.read()).toEqual({});
    await expect(store.upsertRun(run('c'))).rejects.toThrow(ConfigError);
    await expect(store.upsertRun(run('c'))).rejects.toThrow(stateFile());
    await expect(store.removeRun('a')).rejects.toThrow(ConfigError);
    expect(readFileSync(stateFile(), 'utf8')).toBe(bytes);
    expect(readdirSync(path.dirname(stateFile()))).toEqual(['flow-state.json']);
  });

  // Purpose: the same refusal for a file that is not JSON at all: no
  // quarantine rename, no rewrite.
  it('refuses to replace a file that is not JSON', async () => {
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), '{"a": ');
    await expect(openFlowStateFile(repo).upsertRun(run('c'))).rejects.toThrow(ConfigError);
    expect(readFileSync(stateFile(), 'utf8')).toBe('{"a": ');
    expect(readdirSync(path.dirname(stateFile()))).toEqual(['flow-state.json']);
  });

  // Purpose: writes take the lock at flow-state.json.lock; reads take none, so
  // a reader is never blocked by a writer.
  it('writes under flow-state.json.lock and reads without it', async () => {
    const store = openFlowStateFile(repo);
    await store.upsertRun(run('a'));
    writeFileSync(`${stateFile()}.lock`, 'someone:else');
    expect(Object.keys(store.read())).toEqual(['a']);
    const blocked = await store.upsertRun(run('b'), { giveUpMs: 150 });
    expect(blocked.status).toBe('dropped');
    expect(Object.keys(store.read())).toEqual(['a']);
  });
});

describe('eight processes writing at once', () => {
  // Purpose: the reason the store takes the lock. Eight separate processes each
  // upsert a different run into one flow-state.json at the same moment, and all
  // eight survive.
  it('keeps every run', async () => {
    const go = path.join(root, 'go');
    const ids = Array.from({ length: 8 }, (_, i) => `run-${i}`);
    const children = ids.map(
      (id) =>
        new Promise<string>((resolve, reject) => {
          const code = `
            import { existsSync } from 'node:fs';
            while (!existsSync(process.env.GO_FILE)) await new Promise((r) => setTimeout(r, 5));
            const { openFlowStateFile } = await import(${JSON.stringify(MODULE_URL)});
            const result = await openFlowStateFile(process.env.REPO).upsertRun(JSON.parse(process.env.RUN));
            console.log(result.status);
          `;
          const proc = spawn(
            process.execPath,
            ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code],
            {
              env: { ...process.env, GO_FILE: go, REPO: repo, RUN: JSON.stringify(run(id)) },
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          let out = '';
          let err = '';
          proc.stdout.on('data', (chunk) => (out += chunk));
          proc.stderr.on('data', (chunk) => (err += chunk));
          proc.on('error', reject);
          proc.on('close', (exit) =>
            exit === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${exit}: ${err}`))
          );
        })
    );
    await new Promise((r) => setTimeout(r, 500));
    writeFileSync(go, '');
    expect(await Promise.all(children)).toEqual(ids.map(() => 'written'));
    expect(Object.keys(openFlowStateFile(repo).read()).sort()).toEqual(ids);
  }, 30_000);
});
