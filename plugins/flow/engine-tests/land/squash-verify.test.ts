/**
 * The post-merge squash check (DOR-3262), on real repositories built the way
 * GitHub squashes: one commit on `main` whose tree is what merged. Security's
 * four cases each have a fixture: a clean squash (patch-ids match) passes, a
 * context-only shift passes on the tree, one extra line fails, a conflict
 * fails. Two more show why a patch-id match alone never passes: a re-indented
 * line and a hunk moved under the same context both keep the reviewed patch's
 * id while changing what the code does.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resetGitProbe,
  squashReport,
  gitIn,
  verifySquash,
  verifySquashIsolated,
  type GitResult,
  type GitRunner,
} from '../../scripts/land/squash-verify.ts';
import { scratchRepo } from '../../scripts/land/isolated-git.ts';

let repo: string;

function git(...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

function write(file: string, text: string): void {
  writeFileSync(path.join(repo, file), text);
}

function commitAll(message: string): string {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** Twenty numbered lines, with `edits` replacing some of them. */
function lines(edits: Record<number, string> = {}): string {
  return Array.from({ length: 20 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
}

/** Squash `reviewed` onto main as GitHub does; `change` edits the squash before it is committed. */
function squashOnto(reviewed: string, change?: () => void): string {
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', reviewed);
  change?.();
  return commitAll('the squash');
}

/** Commit `files` on main, then branch `feature` from it. */
function startFrom(files: Record<string, string>): void {
  git('checkout', '-q', 'main');
  for (const [file, text] of Object.entries(files)) write(file, text);
  commitAll('main');
  git('checkout', '-q', '-B', 'feature');
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-squash-')));
  git('init', '-q', '-b', 'main');
  write('a.txt', lines());
  write('b.txt', 'b\n');
  commitAll('base');
  git('checkout', '-q', '-b', 'feature');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('verifySquash', () => {
  it('a clean squash passes (its patch-ids match too)', async () => {
    write('a.txt', lines({ 10: 'line 10, changed' }));
    const reviewed = commitAll('feature');
    const squash = squashOnto(reviewed);
    expect(await verifySquashIsolated(repo, { squash, reviewed })).toEqual({
      verdict: 'pass',
      check: 'tree',
      patchIdMatch: true,
      squash,
      reviewed,
    });
  });

  it('a context-only shift passes on the tree: main moved lines next to the change (#3180)', async () => {
    write('a.txt', lines({ 10: 'line 10, changed' }));
    const reviewed = commitAll('feature');
    // main moves a neighbouring line after the branch point, inside the diff's context.
    git('checkout', '-q', 'main');
    write('a.txt', lines({ 8: 'line 8, moved on main' }));
    commitAll('main moves on');
    const squash = squashOnto(reviewed);
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe(
      lines({ 8: 'line 8, moved on main', 10: 'line 10, changed' })
    );
    expect(await verifySquashIsolated(repo, { squash, reviewed })).toEqual({
      verdict: 'pass',
      check: 'tree',
      patchIdMatch: false,
      squash,
      reviewed,
    });
  });

  it('one extra line slipped into the squash fails, with both trees and the file', async () => {
    write('a.txt', lines({ 10: 'line 10, changed' }));
    const reviewed = commitAll('feature');
    const squash = squashOnto(reviewed, () => write('b.txt', 'b\nslipped in\n'));
    const result = await verifySquashIsolated(repo, { squash, reviewed });
    expect(result).toMatchObject({ verdict: 'fail', files: ['b.txt'] });
    if (result.verdict !== 'fail') throw new Error('expected a fail');
    expect(result.squashTree).toBe(git('rev-parse', `${squash}^{tree}`));
    expect(result.reviewedTree).toMatch(/^[0-9a-f]{40}$/);
    expect(result.reviewedTree).not.toBe(result.squashTree);
  });

  it('a conflict fails, never passes', async () => {
    write('a.txt', lines({ 10: 'line 10, the feature' }));
    const reviewed = commitAll('feature');
    // main changes the same line another way; a squash made by hand lands the
    // feature's text anyway, so its tree may even look right.
    git('checkout', '-q', 'main');
    write('a.txt', lines({ 10: 'line 10, main' }));
    commitAll('main changes the same line');
    write('a.txt', lines({ 10: 'line 10, the feature' }));
    const squash = commitAll('a squash made by hand');
    const result = await verifySquashIsolated(repo, { squash, reviewed });
    expect(result).toMatchObject({ verdict: 'fail', reviewedTree: null, files: ['a.txt'] });
    expect(result.verdict === 'fail' && result.reason).toMatch(/conflicts/);
  });

  it('a conflict still fails with `* merge=union` planted in .gitattributes', async () => {
    // A union driver would merge the conflicting line both ways and exit 0, so
    // a squash that kept both lines would match. The check reads attributes
    // from the empty tree, so the conflict stays a conflict.
    write('.gitattributes', '* merge=union\n');
    commitAll('plant a union driver on the feature');
    write('a.txt', lines({ 10: 'line 10, the feature' }));
    const reviewed = commitAll('feature');
    git('checkout', '-q', 'main');
    write('.gitattributes', '* merge=union\n');
    write('a.txt', lines({ 10: 'line 10, main' }));
    commitAll('main changes the same line, with a union driver too');
    write('a.txt', lines({ 10: 'line 10, main\nline 10, the feature' }));
    const squash = commitAll('a squash keeping both lines');
    const result = await verifySquashIsolated(repo, { squash, reviewed });
    expect(result).toMatchObject({ verdict: 'fail', reviewedTree: null, files: ['a.txt'] });
    expect(result.verdict === 'fail' && result.reason).toMatch(/conflicts/);
  });

  // The project's own repository is worker-writable: none of its settings may
  // turn a conflict into a pass (review of the attr-source change).
  it.each([
    [
      '* merge=union in .git/info/attributes',
      () => {
        mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
        writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* merge=union\n');
      },
    ],
    ['merge.default=union in the repo config', () => git('config', 'merge.default', 'union')],
    [
      'a merge.text.driver override in the repo config',
      () => {
        // A driver that writes exactly the squash's content and exits 0. Git 2.53
        // keeps its built-in text merge here; the row guards a git that would not.
        writeFileSync(
          path.join(repo, 'evil-merged.txt'),
          lines({ 10: 'line 10, main\nline 10, the feature' })
        );
        git('config', 'merge.text.driver', `cp ${path.join(repo, 'evil-merged.txt')} %A`);
      },
    ],
    [
      'core.attributesFile in the repo config',
      () => {
        writeFileSync(path.join(repo, 'evil-attributes'), '* merge=union\n');
        git('config', 'core.attributesFile', path.join(repo, 'evil-attributes'));
      },
    ],
  ])('a conflict still fails with %s', async (_name, plant) => {
    write('a.txt', lines({ 10: 'line 10, the feature' }));
    const reviewed = commitAll('feature');
    git('checkout', '-q', 'main');
    write('a.txt', lines({ 10: 'line 10, main' }));
    commitAll('main changes the same line');
    write('a.txt', lines({ 10: 'line 10, main\nline 10, the feature' }));
    const squash = commitAll('a squash keeping both lines');
    plant();
    const result = await verifySquashIsolated(repo, { squash, reviewed });
    expect(result).toMatchObject({ verdict: 'fail', files: ['a.txt'] });
  });

  // The project's object folder is worker-writable too, and git does not
  // re-hash objects on most reads: the check copies them in through the fetch
  // protocol, which does.
  it('an overwritten object in the project cannot make a slipped-in line pass', async () => {
    write('a.txt', lines({ 10: 'line 10, changed' }));
    const reviewed = commitAll('feature changes line 10');
    git('checkout', '-q', 'main');
    write('a.txt', lines({ 1: 'line 1, main' }));
    commitAll('main changes line 1');
    // The squash merges both and slips a line in.
    const squash = squashOnto(reviewed, () =>
      write('a.txt', lines({ 1: 'line 1, main', 10: 'line 10, changed', 15: 'slipped in' }))
    );
    // Overwrite the reviewed blob's loose object with the slipped-in content,
    // under the same SHA.
    const blob = git('rev-parse', `${reviewed}:a.txt`);
    const file = path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    const evil = Buffer.from(lines({ 10: 'line 10, changed', 15: 'slipped in' }));
    chmodSync(file, 0o644);
    writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`blob ${evil.length}\0`), evil])));
    // Reading through the project's own object folder would pass it.
    expect((await verifySquash(gitIn(repo), { squash, reviewed })).verdict).toBe('pass');
    expect((await verifySquashIsolated(repo, { squash, reviewed })).verdict).not.toBe('pass');
  });

  it('a shallow project is unverified, never a pass or a false alarm', async () => {
    // History before the branch point, then a shallow boundary that cuts it.
    git('checkout', '-q', 'main');
    write('c.txt', 'c\n');
    const cut = commitAll('more history on main');
    git('checkout', '-q', '-B', 'feature');
    write('a.txt', lines({ 10: 'line 10, changed' }));
    const reviewed = commitAll('feature');
    const squash = squashOnto(reviewed);
    writeFileSync(path.join(repo, '.git', 'shallow'), `${cut}\n`);
    expect(await verifySquashIsolated(repo, { squash, reviewed })).toMatchObject({
      verdict: 'unverified',
      reason: expect.stringMatching(/shallow/),
    });
  });

  it('copies from a --depth 1 clone without running away, and calls it shallow', async () => {
    write('a.txt', lines({ 10: 'line 10, changed' }));
    commitAll('feature');
    const shallow = `${repo}-depth1`;
    execFileSync('git', [
      'clone',
      '-q',
      '--depth',
      '1',
      '--branch',
      'feature',
      `file://${repo}`,
      shallow,
    ]);
    try {
      const tip = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: shallow,
        encoding: 'utf8',
      }).trim();
      const started = Date.now();
      const copy = await scratchRepo(shallow, [tip], { depth: 1 });
      expect(typeof copy).not.toBe('string');
      if (typeof copy !== 'string') {
        const checkout = await copy.git(['checkout', '--quiet', '--detach', tip]);
        expect(checkout.code).toBe(0);
        expect(readFileSync(path.join(copy.dir, 'a.txt'), 'utf8')).toBe(
          lines({ 10: 'line 10, changed' })
        );
        copy.remove();
      }
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(await scratchRepo(shallow, [tip], { refuseShallow: true })).toMatch(/shallow/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses SHAs that are not whole before any git call', async () => {
    const head = git('rev-parse', 'HEAD');
    expect((await verifySquashIsolated(repo, { squash: '--all', reviewed: head })).verdict).toBe(
      'unverified'
    );
  });

  it('a re-indented line keeps the patch-id but fails', async () => {
    startFrom({ 'c.py': 'def f(x):\n    if x:\n        pass\n    return x\n' });
    write('c.py', 'def f(x):\n    if x:\n        pass\n        return None\n    return x\n');
    const reviewed = commitAll('return None inside the if');
    const squash = squashOnto(reviewed, () =>
      write('c.py', 'def f(x):\n    if x:\n        pass\n    return None\n    return x\n')
    );
    expect(await verifySquashIsolated(repo, { squash, reviewed })).toMatchObject({
      verdict: 'fail',
      patchIdMatch: true,
      files: ['c.py'],
    });
  });

  it('a hunk moved under the same context keeps the patch-id but fails', async () => {
    const block = (name: string, extra: boolean) =>
      `def ${name}():\n    a = 1\n    b = 2\n    b2 = 3\n${extra ? '    require_admin()\n' : ''}    c = 3\n    d = 4\n    e = 5\n`;
    startFrom({ 'd.py': `${block('admin', false)}\n${block('public', false)}` });
    write('d.py', `${block('admin', true)}\n${block('public', false)}`);
    const reviewed = commitAll('admin requires admin');
    const squash = squashOnto(reviewed, () =>
      write('d.py', `${block('admin', false)}\n${block('public', true)}`)
    );
    expect(await verifySquashIsolated(repo, { squash, reviewed })).toMatchObject({
      verdict: 'fail',
      patchIdMatch: true,
      files: ['d.py'],
    });
  });

  it('a squash that only matches a later head, not the reviewed one, fails', async () => {
    write('a.txt', lines({ 10: 'line 10, changed' }));
    const reviewed = commitAll('reviewed');
    write('a.txt', lines({ 10: 'line 10, changed', 12: 'pushed after the review' }));
    const later = commitAll('after the review');
    const squash = squashOnto(later);
    expect(await verifySquashIsolated(repo, { squash, reviewed })).toMatchObject({
      verdict: 'fail',
      files: ['a.txt'],
    });
  });

  it('a merge commit is not a squash', async () => {
    write('a.txt', lines({ 10: 'line 10, changed' }));
    const reviewed = commitAll('feature');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', reviewed);
    const merge = git('rev-parse', 'HEAD');
    expect(await verifySquashIsolated(repo, { squash: merge, reviewed })).toMatchObject({
      verdict: 'fail',
      reason: expect.stringMatching(/not a squash commit/),
    });
  });

  it('never passes anything but two full SHAs, nor commits it does not have', async () => {
    const head = git('rev-parse', 'HEAD');
    for (const [squash, reviewed] of [
      [head.slice(0, 7), head],
      [head, '--all'],
      [head, 'HEAD'],
      [head, 'f'.repeat(40)],
    ]) {
      expect((await verifySquashIsolated(repo, { squash, reviewed })).verdict).toBe('unverified');
    }
  });

  it("this machine's git config cannot turn a clean squash into a conflict", async () => {
    // main renames a file, the PR edits it: a clean merge with renames on.
    git('checkout', '-q', 'main');
    git('mv', 'a.txt', 'renamed.txt');
    commitAll('main renames a.txt');
    git('checkout', '-q', 'feature');
    write('a.txt', lines({ 10: 'line 10, changed' }));
    const reviewed = commitAll('feature edits a.txt');
    const squash = squashOnto(reviewed);
    git('config', 'diff.renames', 'false');
    git('config', 'merge.renames', 'false');
    expect(await verifySquashIsolated(repo, { squash, reviewed })).toMatchObject({
      verdict: 'pass',
    });
  });

  it('a local git replace cannot make a slipped-in change pass', async () => {
    write('a.txt', lines({ 10: 'line 10, changed' }));
    const reviewed = commitAll('feature');
    const clean = squashOnto(reviewed);
    git('reset', '-q', '--hard', `${clean}^`);
    const squash = squashOnto(reviewed, () => write('b.txt', 'b\nslipped in\n'));
    // Point the bad squash at the clean one's objects; the check ignores it.
    git('replace', squash, clean);
    expect((await verifySquashIsolated(repo, { squash, reviewed })).verdict).toBe('fail');
  });
});

describe('squashReport', () => {
  it('names who to tell, both trees and the files, and that nothing was reverted', () => {
    const body = squashReport(
      {
        verdict: 'fail',
        reason: 'the squash commit 1111111 is not what was reviewed at 2222222',
        squash: '1'.repeat(40),
        reviewed: '2'.repeat(40),
        squashTree: '3'.repeat(40),
        reviewedTree: '4'.repeat(40),
        files: ['b.txt', 'evil```\n@everyone.txt'],
        patchIdMatch: true,
      },
      ['@octocat', '@acme-security']
    );
    expect(body).toMatch(/^@octocat @acme-security: \*\*Squash check failed\.\*\*/);
    expect(body).toContain('3'.repeat(40));
    expect(body).toContain('4'.repeat(40));
    expect(body).toContain('```text\nb.txt\n');
    // A file name cannot close the block, or start a line of its own.
    expect(body).toContain("evil''' @everyone.txt");
    expect(body).toContain('Patch-ids match, but that alone proves nothing');
    expect(body).toContain('reverted nothing');
  });

  it('says plainly when the check could not run', () => {
    const body = squashReport(
      {
        verdict: 'unverified',
        reason: 'the reviewed head 2222222 is not in this checkout',
        squash: '1'.repeat(40),
        reviewed: '2'.repeat(40),
      },
      ['@octocat']
    );
    expect(body).toMatch(/^@octocat: \*\*Squash check could not run\.\*\*/);
    expect(body).toContain('reverted nothing');
  });
});

describe('the merge-tree call', () => {
  afterEach(resetGitProbe);

  const SQ = 'a'.repeat(40);
  const RV = 'b'.repeat(40);
  const PARENT = 'c'.repeat(40);
  const TREE = 'd'.repeat(40);

  /** A git that answers every call the check makes, recording each argv. */
  function fakeGit(
    mergeTree: GitResult,
    probe: GitResult = { code: 0, stdout: 'git version 2.53.0', stderr: '' }
  ) {
    const calls: (readonly string[])[] = [];
    const run: GitRunner = async (args) => {
      calls.push(args);
      if (args.includes('version')) return probe;
      if (args.includes('merge-tree')) return mergeTree;
      if (args[0] === 'rev-list') return { code: 0, stdout: `${SQ} ${PARENT}\n`, stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${TREE}\n`, stderr: '' };
      if (args[0] === 'merge-base') return { code: 0, stdout: `${PARENT}\n`, stderr: '' };
      if (args[0] === 'diff-tree') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { run, calls };
  }

  it('is exactly git --attr-source=<empty tree> <pinned merge settings> merge-tree --write-tree <squash>^ <reviewed>', async () => {
    resetGitProbe();
    const { run, calls } = fakeGit({ code: 0, stdout: `${TREE}\n`, stderr: '' });
    expect(await verifySquash(run, { squash: SQ, reviewed: RV })).toMatchObject({
      verdict: 'pass',
    });
    expect(calls.find((c) => c.includes('merge-tree'))).toEqual([
      '--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      '-c',
      'merge.renames=true',
      '-c',
      'diff.renames=true',
      '-c',
      'merge.directoryRenames=conflict',
      '-c',
      'merge.renormalize=false',
      'merge-tree',
      '--write-tree',
      PARENT,
      RV,
    ]);
  });

  it.each([129, 2, 128, -1])('a merge-tree exit of %i fails, never passes', async (code) => {
    resetGitProbe();
    const { run } = fakeGit({ code, stdout: '', stderr: 'error: unknown option' });
    expect(await verifySquash(run, { squash: SQ, reviewed: RV })).toMatchObject({
      verdict: 'fail',
    });
  });

  it('a git that does not know --attr-source fails closed, detected once', async () => {
    resetGitProbe();
    const old = { code: 129, stdout: '', stderr: 'unknown option: --attr-source=4b825dc' };
    const { run, calls } = fakeGit({ code: 0, stdout: `${TREE}\n`, stderr: '' }, old);
    for (let i = 0; i < 2; i++) {
      expect(await verifySquash(run, { squash: SQ, reviewed: RV })).toMatchObject({
        verdict: 'fail',
        reason: expect.stringMatching(/git too old for a safe squash check/),
      });
    }
    expect(calls.filter((c) => c.includes('version'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('merge-tree'))).toBe(false);
  });
});
