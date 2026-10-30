/**
 * `--project` stays inside the checkout flow runs in (DOR-3377).
 *
 * A scheduled run may call `flow <verb>` without asking, and `--project` picks
 * whose tracker adapter code loads. These cases run `main` against real
 * temporary git checkouts and check that a verb never starts for a folder in
 * another checkout, however it is spelled.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VerbDefinition } from '../../scripts/cli/context.ts';
import { EXIT } from '../../scripts/errors.ts';
import { main } from '../../scripts/flow.ts';

let base: string;
let repo: string;
let other: string;

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-project-boundary-')));
  repo = path.join(base, 'repo');
  other = path.join(base, 'other');
  gitInit(repo);
  gitInit(other);
  mkdirSync(path.join(repo, 'sub', 'deeper'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

/** Run a test-only verb that takes `--project` and records the folder it was handed. */
async function run(
  cwd: string,
  project: string
): Promise<{ code: number; ran: string | null; out: string }> {
  let ran: string | null = null;
  const probe: VerbDefinition = {
    name: 'probe',
    summary: 'A test-only verb that records its project.',
    common: ['project'],
    load: async () => ({
      run: async (ctx) => {
        ran = ctx.projectDir;
        return { json: {}, text: '' };
      },
    }),
  };
  let out = '';
  const code = await main(['probe', '--json', '--project', project], {
    env: {},
    cwd,
    now: () => new Date('2026-10-30T12:00:00.000Z'),
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: () => true },
    createAdapter: async () => {
      throw new Error('no adapter in this test');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    verbs: [probe],
  });
  return { code, ran, out };
}

/** Expect the run refused with exit 2 and a message naming --project, the verb never started. */
function expectRefused(result: { code: number; ran: string | null; out: string }): void {
  expect(result.code).toBe(EXIT.usage);
  expect(result.ran).toBeNull();
  expect(JSON.parse(result.out).error.message).toMatch(/^--project .* is outside /);
}

describe('inside a git checkout', () => {
  it('passes the checkout itself', async () => {
    expect((await run(repo, repo)).code).toBe(EXIT.ok);
    expect((await run(repo, '.')).code).toBe(EXIT.ok);
  });

  it('passes a subfolder, and the top level from a subfolder', async () => {
    expect((await run(repo, 'sub/deeper')).code).toBe(EXIT.ok);
    expect((await run(path.join(repo, 'sub'), repo)).code).toBe(EXIT.ok);
    expect((await run(path.join(repo, 'sub'), '..')).code).toBe(EXIT.ok);
  });

  it('refuses another checkout, by absolute or relative path', async () => {
    expectRefused(await run(repo, other));
    expectRefused(await run(repo, '../other'));
  });

  it('refuses a symlink to another checkout, inside this one or not', async () => {
    symlinkSync(other, path.join(repo, 'sub', 'link'));
    symlinkSync(other, path.join(base, 'link'));
    expectRefused(await run(repo, 'sub/link'));
    expectRefused(await run(repo, path.join(base, 'link')));
  });

  it('refuses a linked worktree of the same repository', async () => {
    // A worktree has a top level of its own and its own adapter code on its branch.
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
    const worktree = path.join(base, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', worktree], { cwd: repo });
    expectRefused(await run(repo, worktree));
  });

  it('refuses a folder outside every checkout', async () => {
    mkdirSync(path.join(base, 'plain'));
    expectRefused(await run(repo, path.join(base, 'plain')));
  });

  it('ignores GIT_DIR and GIT_WORK_TREE when it asks git', async () => {
    // Either variable would otherwise make git answer for the run's checkout
    // whatever folder it was asked about.
    vi.stubEnv('GIT_DIR', path.join(repo, '.git'));
    vi.stubEnv('GIT_WORK_TREE', repo);
    expectRefused(await run(repo, other));
  });
});

describe('outside git', () => {
  it('passes the folder itself and a subfolder', async () => {
    const plain = path.join(base, 'plain');
    mkdirSync(path.join(plain, 'sub'), { recursive: true });
    expect((await run(plain, plain)).code).toBe(EXIT.ok);
    expect((await run(plain, 'sub')).code).toBe(EXIT.ok);
  });

  it('refuses a folder beside it', async () => {
    const plain = path.join(base, 'plain');
    mkdirSync(path.join(base, 'beside'), { recursive: true });
    mkdirSync(plain);
    expectRefused(await run(plain, '../beside'));
  });

  it('refuses a git checkout below it, where adapter code would load', async () => {
    expectRefused(await run(base, repo));
  });
});
