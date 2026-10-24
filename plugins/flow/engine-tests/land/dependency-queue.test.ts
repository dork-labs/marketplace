/**
 * One dependency PR at a time (DOR-3262 follow-up): two PRs that both change
 * a lockfile or package manifest conflict in the merge queue, and the second
 * is ejected. So flow refuses to arm a dependency PR while another one is
 * queued or armed, and refuses when it cannot read the queue. This retires
 * the team's manual "one lockfile PR at a time" rule.
 */

import { describe, expect, it } from 'vitest';

import type { Forge, QueuedPr } from '../../scripts/forge/types.ts';
import { dependencyConflict, touchesDependency } from '../../scripts/land/dependency-queue.ts';

const lockfilePr = (number: number, how: 'queued' | 'armed' = 'queued'): QueuedPr => ({
  number,
  queued: how === 'queued',
  armed: how === 'armed',
  files: ['pnpm-lock.yaml', 'package.json'],
});
const codePr = (number: number): QueuedPr => ({
  number,
  queued: true,
  armed: false,
  files: ['src/app.ts'],
});

describe('dependencyConflict (the agreed fixtures)', () => {
  it('a second lockfile PR while one is queued: refuse', () => {
    expect(dependencyConflict(9, ['pnpm-lock.yaml'], [lockfilePr(7)])).toEqual({
      ok: false,
      reason: 'dependency-queue-busy',
      detail: 'another dependency PR is in the queue: #7; arm this after it lands',
    });
  });

  it('a second lockfile PR while one is armed: refuse', () => {
    expect(dependencyConflict(9, ['package-lock.json'], [lockfilePr(7, 'armed')])).toMatchObject({
      ok: false,
      reason: 'dependency-queue-busy',
    });
  });

  it('a lockfile PR while only code PRs are queued: allow', () => {
    expect(dependencyConflict(9, ['pnpm-lock.yaml'], [codePr(5), codePr(6)])).toEqual({ ok: true });
  });

  it('a code PR while a lockfile PR is queued: allow', () => {
    expect(dependencyConflict(9, ['src/app.ts'], [lockfilePr(7)])).toEqual({ ok: true });
  });

  it('the queue is unreadable: refuse', () => {
    expect(dependencyConflict(9, ['pnpm-lock.yaml'], null)).toMatchObject({
      ok: false,
      reason: 'dependency-queue-unreadable',
    });
  });
});

describe('dependencyConflict, the edges', () => {
  it('a code PR never needs the queue, readable or not', () => {
    expect(dependencyConflict(9, ['src/app.ts'], null)).toEqual({ ok: true });
  });

  it('the PR itself in the queue does not block it', () => {
    expect(dependencyConflict(9, ['pnpm-lock.yaml'], [lockfilePr(9)])).toEqual({ ok: true });
  });

  it('a PR whose own file list is unknown counts as a dependency PR', () => {
    expect(dependencyConflict(9, null, [lockfilePr(7)])).toMatchObject({ ok: false });
  });

  it('a queued PR whose file list is unknown counts as a dependency PR', () => {
    expect(
      dependencyConflict(9, ['yarn.lock'], [{ number: 7, queued: true, armed: false, files: null }])
    ).toMatchObject({ ok: false, reason: 'dependency-queue-busy' });
  });

  it('an open PR that is neither queued nor armed does not count', () => {
    expect(
      dependencyConflict(9, ['yarn.lock'], [{ ...lockfilePr(7), queued: false, armed: false }])
    ).toEqual({ ok: true });
  });

  it('matches manifests in any case, like the security paths', () => {
    expect(touchesDependency(['apps/web/Package.json'])).toBe(true);
    expect(touchesDependency(['PNPM-LOCK.YAML'])).toBe(true);
    expect(touchesDependency(['src/packagejson.ts'])).toBe(false);
    // Flow's own config is a security path, not a dependency.
    expect(touchesDependency(['.agents/flow/config.json'])).toBe(false);
  });
});

export type { Forge };
