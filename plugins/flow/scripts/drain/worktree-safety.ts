/**
 * The checks flow makes before it removes a worktree it made: `flow release`
 * for a kept reviewer worktree (DOR-3704) and `flow drain` for a finished
 * run's worker worktree (DOR-2469). Each answers one question and reads only.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/drain/worktree-safety
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { ProcessRunner } from '../cli/context.ts';
import {
  handleRuntime,
  HOST_NAMES,
  type HostName,
  type Launcher,
  type SessionHandle,
} from '../launchers/types.ts';

/** `p` resolved through symlinks when it exists (git prints real paths). */
export function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** What git lists for one worktree. */
export interface ListedWorktree {
  /** Its `HEAD`, or `null` when git printed none. */
  head: string | null;
  /** The branch it is on, without `refs/heads/`, or `null` when detached. */
  branch: string | null;
  /** Whether it is detached. */
  detached: boolean;
}

/**
 * What git lists for the worktree at `target`, as a worktree of `mainCheckout`.
 *
 * @param run - The process runner.
 * @param mainCheckout - The checkout that owns it.
 * @param target - The folder.
 * @returns Its entry, or `null` when git lists no worktree there (or cannot list).
 */
export async function listedWorktree(
  run: ProcessRunner,
  mainCheckout: string,
  target: string
): Promise<ListedWorktree | null> {
  const out = await run('git', ['worktree', 'list', '--porcelain'], { cwd: mainCheckout });
  if (out.code !== 0) return null;
  for (const block of out.stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const at = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (at === undefined || real(at) !== real(target)) continue;
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? null;
    const ref = lines.find((l) => l.startsWith('branch refs/heads/'));
    return {
      head,
      branch: ref === undefined ? null : ref.slice('branch refs/heads/'.length),
      detached: lines.includes('detached'),
    };
  }
  return null;
}

/**
 * How many uncommitted changes (untracked files included) `target` has.
 *
 * @param run - The process runner.
 * @param target - The worktree.
 * @returns The count, or `null` when git could not read them.
 */
export async function uncommittedChanges(
  run: ProcessRunner,
  target: string
): Promise<number | null> {
  const status = await run('git', ['status', '--porcelain'], { cwd: target });
  if (status.code !== 0) return null;
  return status.stdout.split('\n').filter((l) => l.trim() !== '').length;
}

/** A recorded session that may work in a folder. */
export interface FolderSession {
  host: string;
  runtime?: string;
  sessionId: string;
  cwd: string;
  pending?: boolean;
}

/**
 * What a session's host says about it, or `null` when it cannot be asked: a
 * start not yet confirmed (`pending`), a host flow does not know, or a failed read.
 *
 * @param launcherFor - The launcher for a host.
 * @param session - The recorded session.
 * @returns Its state, or `null`.
 */
export async function folderSessionState(
  launcherFor: (host: HostName) => Launcher,
  session: FolderSession
): Promise<Awaited<ReturnType<Launcher['state']>> | null> {
  if (session.pending === true) return null;
  if (!(HOST_NAMES as readonly string[]).includes(session.host)) return null;
  try {
    return await launcherFor(session.host as HostName).state({
      ...session,
      runtime: handleRuntime(session as { runtime?: SessionHandle['runtime'] }),
    } as SessionHandle);
  } catch {
    return null;
  }
}

/**
 * Whether the host confirms the session no longer runs: it exited, or it is
 * gone (DorkOS's 404, the rule DOR-3263 restarts on). Idle, busy, limited or
 * unknown may still run; so may a start not yet confirmed (`pending`).
 *
 * @param launcherFor - The launcher for a host.
 * @param session - The recorded session.
 * @returns `true` only when the host confirms it.
 */
export async function sessionDone(
  launcherFor: (host: HostName) => Launcher,
  session: FolderSession
): Promise<boolean> {
  const state = await folderSessionState(launcherFor, session);
  return (
    state !== null && (state.kind === 'exited' || (state.kind === 'unknown' && state.gone === true))
  );
}
