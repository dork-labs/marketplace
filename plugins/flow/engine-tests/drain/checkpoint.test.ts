/**
 * The `HANDOFF.md` checkpoint (spec `flow-handoff-dispatch` §1, task 1.1): the
 * pure render, parse, body rules and synthesis in `scripts/drain/checkpoint.ts`,
 * plus the file write (previous copy kept) and the `info/exclude` lines, which
 * run against real temp git repositories.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHECKPOINT_EXCLUDE_LINES,
  CHECKPOINT_TRIGGERS,
  MAX_CHECKPOINT_BYTES,
  WORKER_BRIEF_PATH,
  checkBody,
  ensureCheckpointExcludes,
  parseCheckpoint,
  renderCheckpoint,
  synthesizeCheckpoint,
  writeCheckpointFile,
  type CheckpointHeader,
} from '../../scripts/drain/checkpoint.ts';

/** A header with every field set. */
function header(overrides: Partial<CheckpointHeader> = {}): CheckpointHeader {
  return {
    v: 1,
    identifier: 'ACME-12',
    stage: 'execute',
    trigger: 'task',
    writtenAt: '2026-09-26T18:02:11.000Z',
    sessionId: '6f1c',
    account: 'claude3',
    host: 'cli',
    branch: 'ACME-12-export-csv',
    headSha: '4be1c2d',
    pushedSha: '4be1c2d',
    dirty: false,
    spec: 'specs/export-csv/02-specification.md',
    task: '1.3',
    pr: null,
    reviewRound: null,
    ...overrides,
  };
}

const BODY = [
  '## Done',
  '',
  '- Task 1.3: the CSV writer escapes quotes and newlines.',
  '',
  '## Next',
  '',
  '- Task 1.4: wire the writer to the Export button.',
  '',
  '## Open questions',
  '',
  'None.',
  '',
  '## Next command',
  '',
  '```sh',
  'pnpm vitest run src/export',
  '```',
].join('\n');

/** Render and unwrap, failing the test on a refusal. */
function rendered(h: CheckpointHeader, title: string | null, body = BODY): string {
  const result = renderCheckpoint(h, title, body);
  if (!result.ok) throw new Error(result.message);
  return result.text;
}

describe('render and parse', () => {
  // Purpose: what render writes, parse reads back: the header, the title and
  // the four sections. Fails if either side drops or reshapes a field.
  it('round-trips header, title and sections', () => {
    const text = rendered(header(), 'Export the report as CSV');
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^<!-- flow:handoff \{.*\} -->$/);
    expect(lines[2]).toBe('# Handoff: ACME-12 Export the report as CSV');

    const parsed = parseCheckpoint(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.header).toEqual(header());
    expect(parsed.title).toBe('Export the report as CSV');
    expect(parsed.sections).toEqual({
      done: '- Task 1.3: the CSV writer escapes quotes and newlines.',
      next: '- Task 1.4: wire the writer to the Export button.',
      openQuestions: 'None.',
      nextCommand: '```sh\npnpm vitest run src/export\n```',
    });
  });

  // Purpose: with no title source the line is the identifier alone.
  it('writes the identifier alone when there is no title', () => {
    const text = rendered(header(), null);
    expect(text.split('\n')[2]).toBe('# Handoff: ACME-12');
    const parsed = parseCheckpoint(text);
    expect(parsed.ok && parsed.title).toBe(null);
  });

  // Purpose: a value holding "-->" cannot end the header comment early. Fails
  // if the JSON is written without escaping angle brackets.
  it('keeps a header value containing --> inside the comment', () => {
    const text = rendered(header({ spec: 'specs/a-->b.md', branch: 'x<y' }), null);
    expect(text.split('\n')[0].indexOf('-->')).toBe(text.split('\n')[0].length - 3);
    const parsed = parseCheckpoint(text);
    expect(parsed.ok && parsed.header.spec).toBe('specs/a-->b.md');
    expect(parsed.ok && parsed.header.branch).toBe('x<y');
  });

  // Purpose: a reader ignores fields it does not know and still reads the
  // known ones from a newer header version.
  it('reads the known fields of a v2 header and drops unknown ones', () => {
    const text = rendered(header(), null).replace(
      /^<!-- flow:handoff \{"v":1,/,
      '<!-- flow:handoff {"v":2,"future":{"a":1},'
    );
    const parsed = parseCheckpoint(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.header).toEqual({ ...header(), v: 2 });
    expect(parsed.header).not.toHaveProperty('future');
  });

  // Purpose: the typed errors. Fails if a malformed file parses, or throws
  // instead of returning an error.
  it.each([
    ['no header line', BODY, 'header'],
    [
      'a header that is not JSON',
      '<!-- flow:handoff {nope -->\n\n# Handoff: A-1\n\n' + BODY,
      'header',
    ],
    ['a header without headSha', null, 'header'],
    ['an unknown v1 trigger', null, 'header'],
    ['no title line', null, 'title'],
    ['a broken body', null, 'body'],
  ])('refuses %s', (name, text, code) => {
    let input = text as string | null;
    const good = rendered(header(), null);
    if (name === 'a header without headSha') input = good.replace('"headSha":"4be1c2d",', '');
    if (name === 'an unknown v1 trigger')
      input = good.replace('"trigger":"task"', '"trigger":"whim"');
    if (name === 'no title line') input = good.replace('# Handoff: ACME-12\n', '');
    if (name === 'a broken body') input = good.replace('## Next\n', '## Later\n');
    const parsed = parseCheckpoint(input as string);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.code).toBe(code);
  });

  // Purpose: the trigger vocabulary includes `fix` (a push answering review
  // findings or red CI) and `synthesized`.
  it('knows every trigger in the spec table', () => {
    expect([...CHECKPOINT_TRIGGERS]).toEqual([
      'stage',
      'task',
      'fix',
      'limit-warning',
      'limit-rejected',
      'manual',
      'synthesized',
    ]);
  });
});

describe('the body rules', () => {
  // Purpose: each rule refuses with a message that names it. Fails if a rule is
  // missing or its message does not say what to fix.
  it.each([
    ['its own # title', `# My title\n\n${BODY}`, 'title', /own # title/],
    [
      'a missing section',
      BODY.replace(/## Open questions\n\nNone.\n\n/, ''),
      'sections',
      /exactly four/,
    ],
    [
      'sections out of order',
      BODY.replace('## Done', '## Tmp')
        .replace('## Next\n', '## Done\n')
        .replace('## Tmp', '## Next'),
      'sections',
      /in order/,
    ],
    ['a fifth section', `${BODY}\n\n## Notes\n\nmore`, 'sections', /exactly four/],
    ['text before the first section', `Hello.\n\n${BODY}`, 'sections', /before/],
    ['an empty section', BODY.replace('None.', ''), 'empty-section', /Open questions/],
    [
      'a Next command with no code block',
      BODY.replace(/```sh\n.*\n```/, 'pnpm test'),
      'next-command',
      /one fenced code block/,
    ],
    [
      'a Next command with two code blocks',
      `${BODY}\n\n\`\`\`sh\nls\n\`\`\``,
      'next-command',
      /one fenced code block/,
    ],
    [
      'a Next command whose block is blank',
      BODY.replace('pnpm vitest run src/export', '   '),
      'next-command',
      /non-blank/,
    ],
    ['a code block never closed', BODY.replace(/\n```$/, ''), 'unclosed-fence', /never closed/],
  ])('refuses %s', (_name, body, rule, message) => {
    const result = checkBody(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rule).toBe(rule);
    expect(result.message).toMatch(message);
  });

  // Purpose: headings inside a code block are code, not sections or titles.
  it('ignores # lines inside code blocks', () => {
    const body = BODY.replace('None.', '```md\n# not a title\n## not a section\n```');
    expect(checkBody(body).ok).toBe(true);
  });

  // Purpose: the whole file is capped at 16 KB. Fails if the cap is missing or
  // measured in characters instead of bytes.
  it('refuses a file over 16 KB, counted in bytes', () => {
    const filler = 'é'.repeat(MAX_CHECKPOINT_BYTES / 2);
    const result = renderCheckpoint(header(), null, BODY.replace('None.', filler));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.rule).toBe('size');
    expect(!result.ok && result.message).toMatch(/16 KB/);
  });
});

describe('synthesizeCheckpoint', () => {
  const facts = {
    identifier: 'ACME-12',
    stage: 'execute' as const,
    stoppedAt: '2026-09-26 18:40 UTC',
    reason: 'the account reached its limit',
    commits: Array.from({ length: 25 }, (_, i) => `abc${i} commit ${i}`),
  };

  // Purpose: with a previous checkpoint, Done gains at most 20 commits, Next and
  // Next command carry over, Open questions gains the stop note, and the result
  // passes the body rules.
  it('extends the previous checkpoint', () => {
    const prev = parseCheckpoint(rendered(header(), null));
    if (!prev.ok) throw new Error('fixture');
    const result = synthesizeCheckpoint(prev, facts);
    expect(result.trigger).toBe('synthesized');
    expect(result.sections.done).toContain('- Task 1.3');
    expect(result.sections.done).toContain('Commits since the last checkpoint');
    expect(result.sections.done).toContain('abc19 commit 19');
    expect(result.sections.done).not.toContain('abc20 commit 20');
    expect(result.sections.next).toBe(prev.sections.next);
    expect(result.sections.nextCommand).toBe(prev.sections.nextCommand);
    expect(result.sections.openQuestions).toContain(
      'The previous session stopped at 2026-09-26 18:40 UTC (the account reached its limit) without a checkpoint. Run `git status` and check any uncommitted work before continuing.'
    );
    expect(result.sections.openQuestions).not.toContain('None.');
    expect(checkBody(result.body)).toEqual({ ok: true, sections: result.sections });
  });

  // Purpose: previous open questions are kept, not replaced.
  it('keeps real previous open questions', () => {
    const prev = parseCheckpoint(
      rendered(header(), null, BODY.replace('None.', '- Which delimiter?'))
    );
    if (!prev.ok) throw new Error('fixture');
    const result = synthesizeCheckpoint(prev, { ...facts, commits: [] });
    expect(result.sections.openQuestions).toMatch(/^- Which delimiter\?\n\n.*stopped at/s);
    expect(result.sections.done).toContain('No commits since the last checkpoint.');
  });

  // Purpose: with no previous checkpoint the next session is pointed at the
  // stage and the worker brief, and runs a safe look-around command.
  it('writes a starting point when there is no previous checkpoint', () => {
    const result = synthesizeCheckpoint(null, { ...facts, commits: [] });
    expect(result.sections.next).toBe(
      `Continue the \`execute\` stage of ACME-12. Read the worker brief at \`${WORKER_BRIEF_PATH}\`.`
    );
    expect(WORKER_BRIEF_PATH).toBe('.dork/flow/drain/briefs/worker.md');
    expect(result.sections.nextCommand).toBe('```sh\ngit status && git log --oneline -5\n```');
    expect(checkBody(result.body).ok).toBe(true);
  });
});

describe('files', () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-checkpoint-')));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  function repo(): string {
    const dir = path.join(base, 'repo');
    mkdirSync(dir);
    git(dir, 'init', '-q');
    git(
      dir,
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    );
    return dir;
  }

  // Purpose: each write keeps the previous checkpoint as HANDOFF.prev.md and
  // leaves no temp file behind.
  it('keeps the previous copy', () => {
    const dir = repo();
    const first = rendered(header({ task: '1.1' }), null);
    const second = rendered(header({ task: '1.2' }), null);
    const target = writeCheckpointFile(dir, first);
    expect(target).toBe(path.join(dir, '.dork', 'flow', 'HANDOFF.md'));
    writeCheckpointFile(dir, second);
    expect(readFileSync(target, 'utf8')).toBe(second);
    expect(readFileSync(path.join(dir, '.dork', 'flow', 'HANDOFF.prev.md'), 'utf8')).toBe(first);
    expect(readdirSync(path.join(dir, '.dork', 'flow')).sort()).toEqual([
      'HANDOFF.md',
      'HANDOFF.prev.md',
    ]);
  });

  // Purpose: the two exclude lines land in the common git dir exactly once,
  // across repeated writes and across two worktrees of one repository, and they
  // make git ignore the checkpoint files.
  it('adds the exclude lines once, for every worktree', () => {
    const dir = repo();
    const other = path.join(base, 'other');
    git(dir, 'worktree', 'add', '-q', '-b', 'side', other);
    ensureCheckpointExcludes(dir);
    ensureCheckpointExcludes(dir);
    ensureCheckpointExcludes(other);
    const exclude = readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    for (const line of CHECKPOINT_EXCLUDE_LINES) {
      expect(exclude.filter((l) => l === line)).toHaveLength(1);
    }
    writeCheckpointFile(other, rendered(header(), null));
    writeCheckpointFile(other, rendered(header(), null));
    mkdirSync(path.join(other, '.dork', 'flow', 'drain'), { recursive: true });
    execFileSync('touch', [path.join(other, '.dork', 'flow', 'drain', 'x.md')]);
    expect(git(other, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });
});
