/**
 * `flow watch [<identifier>...] [--pr <owner/repo>#<n>]... [--follow]
 * [--interval <s>]` (spec `flow-handoff-dispatch` §4.6): watch pull requests
 * until something happens to one. It replaces the hand-run `watch.sh`.
 *
 * It watches the named runs' PRs (default: every run with a recorded PR) plus
 * any raw `--pr`, which needs no flow project. Every round it reads each PR and
 * prints one line per event, `<identifier or owner/repo#n> <EVENT>`:
 *
 * - `MERGED`, `CLOSED`;
 * - `FAILING: <checks>` when a check on the head fails;
 * - `EJECTED (<innocent|suspect|unknown>)` when the PR is neither armed nor
 *   queued and its own merge-group attempt failed in the last 30 minutes,
 *   judged by {@link judgeEjection} against the other recent attempts;
 * - `NOT-ARMED-NOT-QUEUED` when it is neither armed nor queued otherwise.
 *
 * Without `--follow` it exits 0 after the first round with an event, the
 * contract a caller blocks on. With `--follow` it keeps going, printing an
 * event only when a PR's event changes, and exits 0 once every PR it watches
 * has merged or closed. Five failed reads in a row for one PR exit 4 naming it
 * (a mistyped repository or an expired login), never a silent wait.
 *
 * @module @dorkos/flow/cli/watch
 */

import { PreconditionError, UsageError } from '../errors.ts';
import { openFlowStateFile } from '../flow-state-file.ts';
import { judgeEjection } from '../forge/ejection.ts';
import { ForgeError, type Forge, type PrStatus } from '../forge/types.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { JSON_VERSION } from './output.ts';

/** Seconds between rounds unless `--interval` says otherwise. */
export const DEFAULT_INTERVAL_SECONDS = 90;
/** Failed reads in a row for one PR before the watch gives up. */
export const MAX_READ_ERRORS = 5;
/** How far back merge-group attempts count for an ejection. */
const EJECTION_WINDOW_MINUTES = 30;

/** One PR being watched. */
interface Target {
  /** What its lines start with: the identifier, or `owner/repo#n`. */
  label: string;
  /** `owner/name`. */
  repo: string;
  /** The PR number. */
  number: number;
}

/** One printed event. */
export interface WatchEvent {
  /** The identifier, or `owner/repo#n`. */
  target: string;
  /** `MERGED`, `CLOSED`, `FAILING: …`, `EJECTED (…)` or `NOT-ARMED-NOT-QUEUED`. */
  event: string;
}

/** `owner/repo#n` (or `watch.sh`'s `owner/repo:n`). */
const RAW_PR = /^([^/\s#:]+\/[^/\s#:]+)[#:](\d+)$/;

/** Parse the raw `--pr` values. */
function rawTargets(values: readonly string[]): Target[] {
  return values.map((value) => {
    const match = RAW_PR.exec(value.trim());
    if (match === null) throw new UsageError(`--pr must look like owner/repo#123, not "${value}"`);
    return { label: `${match[1]}#${match[2]}`, repo: match[1], number: Number(match[2]) };
  });
}

/** The PRs recorded on runs: the named ones, or every run with a PR. */
function runTargets(ctx: VerbContext, identifiers: readonly string[]): Target[] {
  const runs = Object.values(openFlowStateFile(ctx.projectDir).read());
  const withPr = (id?: string) =>
    runs.filter((run) => run.drain?.pr != null && (id === undefined || run.identifier === id));
  const picked =
    identifiers.length === 0
      ? withPr()
      : identifiers.map((id) => {
          const found = withPr(id)[0];
          if (found === undefined) {
            throw new PreconditionError(`${id} has no pull request recorded on its run`);
          }
          return found;
        });
  return picked.map((run) => ({
    label: run.identifier,
    repo: run.drain!.pr!.repo,
    number: run.drain!.pr!.number,
  }));
}

/** The event a PR's status means, or `null` when nothing happened. */
async function eventFor(forge: Forge, pr: number, status: PrStatus): Promise<string | null> {
  if (status.state === 'merged') return 'MERGED';
  if (status.state === 'closed') return 'CLOSED';
  if (status.failing.length > 0) {
    return `FAILING: ${status.failing.map((check) => check.name).join(', ')}`;
  }
  if (status.armed || status.queued) return null;
  const groups = await forge.recentGroupFailures(status.base, [], EJECTION_WINDOW_MINUTES);
  const own = [...new Set(groups.filter((g) => g.pr === pr).flatMap((g) => g.failing))];
  if (own.length === 0) return 'NOT-ARMED-NOT-QUEUED';
  return `EJECTED (${judgeEjection({ failing: own, otherGroups: groups, pr })})`;
}

/** Whether an event ends watching that PR. */
function isFinal(event: string): boolean {
  return event === 'MERGED' || event === 'CLOSED';
}

/** The `--interval` in milliseconds. */
function intervalMs(ctx: VerbContext): number {
  const raw = ctx.args.flags.interval;
  if (raw === undefined) return DEFAULT_INTERVAL_SECONDS * 1000;
  const seconds = Number(raw);
  if (typeof raw !== 'string' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`--interval must be a positive number of seconds, not "${String(raw)}"`);
  }
  return seconds * 1000;
}

/** Render a round's events as text lines. */
function lines(events: readonly WatchEvent[]): string {
  return events.map((e) => `${e.target} ${e.event}`).join('\n');
}

/**
 * Run `flow watch`.
 *
 * @param ctx - The verb's context.
 * @returns The last round's events.
 * @throws {PreconditionError} When there is nothing to watch, or a named run has no PR (exit 5).
 * @throws {ForgeError} After five failed reads in a row for one PR (exit 4).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const follow = ctx.args.flags.follow === true;
  const wait = intervalMs(ctx);
  const raw = rawTargets(ctx.args.repeated?.pr ?? []);
  const identifiers = ctx.args.positionals;
  // A raw --pr alone needs no flow project, so the run store is not opened.
  const fromRuns = raw.length > 0 && identifiers.length === 0 ? [] : runTargets(ctx, identifiers);
  let targets = [...fromRuns, ...raw];
  if (targets.length === 0) {
    throw new PreconditionError(
      'no run has a pull request to watch; name one with --pr owner/repo#n'
    );
  }

  const forges = new Map<string, Forge>();
  const forgeFor = (repo: string): Forge => {
    let forge = forges.get(repo);
    if (forge === undefined) {
      forge = ctx.forge({ host: 'github.com', repo });
      forges.set(repo, forge);
    }
    return forge;
  };
  const errors = new Map<string, number>();
  const printed = new Map<string, string>();

  for (;;) {
    const events: WatchEvent[] = [];
    for (const target of targets) {
      const forge = forgeFor(target.repo);
      let event: string | null;
      try {
        event = await eventFor(forge, target.number, await forge.prStatus(target.number));
        errors.set(target.label, 0);
      } catch (error) {
        const count = (errors.get(target.label) ?? 0) + 1;
        errors.set(target.label, count);
        const message = error instanceof Error ? error.message : String(error);
        if (count >= MAX_READ_ERRORS) {
          throw new ForgeError(
            `${target.label}: ${MAX_READ_ERRORS} reads in a row failed (${message}); check the repository name and "gh auth status"`
          );
        }
        continue;
      }
      if (event === null) {
        printed.delete(target.label);
        continue;
      }
      if (follow && printed.get(target.label) === event) continue;
      printed.set(target.label, event);
      events.push({ target: target.label, event });
    }

    if (follow) targets = targets.filter((t) => !isFinal(printed.get(t.label) ?? ''));
    const done = follow ? targets.length === 0 : events.length > 0;
    if (done) return { json: { events }, text: lines(events) };
    if (events.length > 0) {
      ctx.stdout.write(
        ctx.json ? `${JSON.stringify({ v: JSON_VERSION, events })}\n` : `${lines(events)}\n`
      );
    }
    await ctx.io.sleep(wait);
  }
}
