/**
 * The autonomy dial (spec `flow-multiproject` §7.7, `scripts/autonomy.ts`):
 * reading the copy DorkOS keeps of a project's dial, the stop in force per kind,
 * and the config the dial reads at load time.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyAutonomy,
  AUTONOMY_KINDS,
  autonomyCopyPath,
  parseAutonomyCopy,
  projectId,
  readAutonomyCopy,
  resolveAutonomy,
  stopInForce,
  type AutonomyRead,
  type AutonomyTunables,
} from '../scripts/autonomy.ts';
import {
  NEW_PROJECT_DIAL,
  NO_COPY_DIAL,
  isCustom,
  withDial,
  withKind,
} from '../scripts/autonomy-dial.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'flow-autonomy-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a copy and read it back. */
function copyWith(value: unknown): AutonomyRead {
  const file = path.join(dir, 'copy.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return readAutonomyCopy(file);
}

const TUNABLES: AutonomyTunables = {
  recovery: { maxRetries: 2, onExhausted: 'block' },
  stageBias: { intake: 'ask', execution: 'proceed-and-log' },
};

describe('the copy of the dial', () => {
  // Purpose: the copy is named by the project, never by a path, and lives in
  // DorkOS's home, outside any repo an agent can write.
  it('lives at <dorkHome>/flow/autonomy/<12-hex project id>.json', () => {
    expect(projectId('/work/app')).toMatch(/^[0-9a-f]{12}$/);
    expect(projectId('/work/app')).not.toBe(projectId('/work/other'));
    expect(autonomyCopyPath('/home/me/.dork', '/work/app')).toBe(
      path.join('/home/me/.dork', 'flow', 'autonomy', `${projectId('/work/app')}.json`)
    );
  });

  // Purpose: a broken copy only ever makes flow ask more. Anything that is not
  // a dial as described reads as unreadable, never as a stop.
  it('reads a missing file as missing and anything but a dial as unreadable', () => {
    expect(readAutonomyCopy(path.join(dir, 'none.json')).state).toBe('missing');
    expect(copyWith('not json').state).toBe('unreadable');
    expect(copyWith({ dial: 'yolo' }).state).toBe('unreadable');
    expect(copyWith({ dial: 'tell', kinds: { ship: 'always' } }).state).toBe('unreadable');
    expect(copyWith({ dial: 'tell', questionDeadlineMinutes: 1 }).state).toBe('unreadable');
    expect(copyWith({ dial: 'tell', questionDeadlineMinutes: 99_999 }).state).toBe('unreadable');
    expect(copyWith({ dial: 'tell', kinds: 'all' }).state).toBe('unreadable');
  });

  // Purpose: a newer extension's extra keys never make an older flow distrust the copy.
  it('reads a dial, its kinds and the wait, ignoring keys it does not know', () => {
    expect(parseAutonomyCopy({ dial: 'tell', kinds: { sort: 'auto' }, future: true })).toEqual({
      dial: 'tell',
      kinds: { sort: 'auto' },
      questionDeadlineMinutes: 240,
    });
    expect(parseAutonomyCopy({ dial: 'auto', questionDeadlineMinutes: 60 })).toEqual({
      dial: 'auto',
      kinds: {},
      questionDeadlineMinutes: 60,
    });
  });
});

describe('resolveAutonomy', () => {
  // Purpose: no copy, or one flow cannot trust, means Ask me first for every kind.
  it('asks for every kind without a dial', () => {
    for (const kind of AUTONOMY_KINDS) expect(resolveAutonomy(null, kind)).toBe('ask');
  });

  // Purpose: Customize sets a kind apart from the dial; the rest follow it.
  it('takes a kind set apart over the dial', () => {
    const copy = {
      dial: 'tell' as const,
      kinds: { ship: 'ask' as const },
      questionDeadlineMinutes: 240,
    };
    expect(resolveAutonomy(copy, 'ship')).toBe('ask');
    expect(resolveAutonomy(copy, 'questions')).toBe('tell');
    expect(resolveAutonomy(copy, 'sort')).toBe('tell');
  });

  // Purpose: "someone must check": without a reviewer agent nothing but a
  // person can check finished work, so ship never leaves Ask me first.
  it('keeps ship at ask when no reviewer agent checks the repo', () => {
    const copy = { dial: 'auto' as const, kinds: {}, questionDeadlineMinutes: 240 };
    expect(resolveAutonomy(copy, 'ship', { reviewerAgent: false })).toBe('ask');
    expect(resolveAutonomy(copy, 'ship', { reviewerAgent: true })).toBe('auto');
    expect(resolveAutonomy(copy, 'questions', { reviewerAgent: false })).toBe('auto');
  });

  // Purpose: an install that never chose a dial (no copy at all) fixes failing
  // checks as it always has; an unreadable copy still asks.
  it("keeps today's retries with no copy, and asks with an unreadable one", () => {
    const missing: AutonomyRead = { state: 'missing', file: 'x' };
    const unreadable: AutonomyRead = { state: 'unreadable', file: 'x' };
    expect(stopInForce(missing, 'retry')).toBe('tell');
    expect(stopInForce(missing, 'ship')).toBe('ask');
    expect(stopInForce(unreadable, 'retry')).toBe('ask');
  });
});

describe('applyAutonomy', () => {
  // Purpose: at Ask me first every failure asks: no retries, and exhaustion
  // escalates. Read time only: the input is never changed.
  it('reads retry at ask as no retries that escalate, without writing', () => {
    const read = copyWith({ dial: 'ask' });
    const before = structuredClone(TUNABLES);
    const tuned = applyAutonomy(TUNABLES, read);
    expect(tuned.recovery).toEqual({ maxRetries: 0, onExhausted: 'escalate' });
    expect(TUNABLES).toEqual(before);
  });

  // Purpose: the same for a copy flow cannot read (it only ever asks more).
  it('asks before retrying with an unreadable copy', () => {
    expect(applyAutonomy(TUNABLES, copyWith('{')).recovery.maxRetries).toBe(0);
  });

  // Purpose: no copy at all changes nothing, so this release changes nothing
  // for an install that has not chosen a dial.
  it('changes nothing with no copy', () => {
    expect(applyAutonomy(TUNABLES, { state: 'missing', file: 'x' })).toBe(TUNABLES);
  });

  // Purpose: at Just do it the agent does not ask in the ambiguous middle: it
  // proceeds and writes down why, in every stage.
  it('reads questions at auto as proceed-and-log in every stage', () => {
    const tuned = applyAutonomy(TUNABLES, copyWith({ dial: 'tell', kinds: { questions: 'auto' } }));
    expect(tuned.stageBias).toEqual({ intake: 'proceed-and-log', execution: 'proceed-and-log' });
    expect(tuned.recovery).toEqual(TUNABLES.recovery);
  });
});

describe('loadConfig applies the dial', () => {
  // Purpose: the engine's verbs read the dial through loadConfig, keyed by the
  // project's canonical root, so what the extension writes is what they read.
  it('reads the copy for the project and applies it', async () => {
    const { execFileSync } = await import('node:child_process');
    const { realpathSync } = await import('node:fs');
    const { findConfigRoots } = await import('../scripts/config-files.ts');
    const { loadConfig } = await import('../scripts/config-load.ts');
    const repo = realpathSync(mkdtempSync(path.join(dir, 'repo-')));
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(path.join(repo, '.agents', 'flow'), { recursive: true });
    writeFileSync(path.join(repo, '.agents', 'flow', 'config.json'), '{"tracker":"fake"}');
    const home = path.join(dir, 'dork');
    const file = autonomyCopyPath(home, repo);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ dial: 'ask' }));
    const roots = findConfigRoots(repo, path.join(dir, 'plugin'));
    const loaded = loadConfig(roots, {}, { dorkHome: home });
    expect(loaded.autonomy?.state).toBe('ok');
    expect(loaded.config.recovery.maxRetries).toBe(0);
    expect(loadConfig(roots, {}).config.recovery.maxRetries).toBe(2);
  });
});

describe('how a person’s choice changes the dial (autonomy-dial.ts)', () => {
  // Purpose: the settings page's dial and Customize, and the inbox's "Next
  // time, on its own?" Yes, all store through these, so a choice moves only
  // what it names.
  it('a dial choice moves every kind to that stop and keeps the deadline', () => {
    const copy = {
      dial: 'tell' as const,
      kinds: { sort: 'ask' as const },
      questionDeadlineMinutes: 60,
    };
    expect(withDial(copy, 'auto')).toEqual({
      dial: 'auto',
      kinds: {},
      questionDeadlineMinutes: 60,
    });
    expect(withDial(null, 'ask')).toEqual({ dial: 'ask', kinds: {}, questionDeadlineMinutes: 240 });
  });

  it('a kind choice moves only that kind, and a kind back on the dial’s stop follows the dial again', () => {
    const copy = {
      dial: 'tell' as const,
      kinds: { sort: 'ask' as const },
      questionDeadlineMinutes: 60,
    };
    const moved = withKind(copy, 'ship', 'auto');
    expect(moved).toEqual({
      dial: 'tell',
      kinds: { sort: 'ask', ship: 'auto' },
      questionDeadlineMinutes: 60,
    });
    for (const kind of AUTONOMY_KINDS.filter((k) => k !== 'ship')) {
      expect(resolveAutonomy(moved, kind)).toBe(resolveAutonomy(copy, kind));
    }
    expect(withKind(copy, 'sort', 'tell')).toEqual({
      dial: 'tell',
      kinds: {},
      questionDeadlineMinutes: 60,
    });
    expect(isCustom(copy)).toBe(true);
    expect(isCustom(withKind(copy, 'sort', 'tell'))).toBe(false);
  });

  it('from no copy, starts from what is in force: Ask me first, with failing checks still fixed', () => {
    expect(withKind(null, 'ship', 'tell', NO_COPY_DIAL)).toEqual({
      dial: 'ask',
      kinds: { retry: 'tell', ship: 'tell' },
      questionDeadlineMinutes: 240,
    });
    expect(NEW_PROJECT_DIAL.dial).toBe('tell');
  });
});
