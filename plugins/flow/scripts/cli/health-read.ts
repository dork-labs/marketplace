/**
 * Read the facts the Health block of `flow status` judges (DOR-3260, F4).
 *
 * **Where a schedule's last run comes from.** Flow keeps no record of its
 * scheduled runs. DorkOS does: it runs the schedules and keeps each run's
 * outcome. This reads that record from the DorkOS on this machine, the same way
 * `flow fleet` reads its sessions (`fleet/sessions.ts`: loopback only, no
 * redirect followed, a short timeout), with two read-only calls:
 *
 * - `GET /api/tasks`: every schedule, with its file, cron, timezone, `enabled`
 *   and `status`. This project's flow schedules are the ones whose file is
 *   under one of the project's checkouts (the rule `/flow:status` uses) and
 *   whose name is a flow schedule (`flow-drain`, `flow-groom`, `flow-triage`,
 *   `flow-retro`), or whose prompt runs `/flow continue`.
 * - `GET /api/tasks/runs?scheduleId=<id>&status=completed&limit=1`, per
 *   schedule that is on: its last successful run.
 *
 * Nothing here needs a new tool, permission or allow rule: it is flow's own
 * script making a loopback read, like `flow fleet`. No DorkOS, a DorkOS that
 * answers something else, or one too old to have these routes, is "unknown"
 * with the reason, never healthy.
 *
 * @module @dorkos/flow/cli/health-read
 */

import path from 'node:path';

import { assertLoopback, resolveDorkosUrl } from '../fleet/sessions.ts';
import {
  intakeHealth,
  scheduleHealth,
  type IntakeHealth,
  type ScheduleFacts,
  type ScheduleHealth,
} from '../health.ts';

/** The flow schedules a project can have, by name. */
export const FLOW_SCHEDULES: readonly string[] = [
  'flow-drain',
  'flow-groom',
  'flow-triage',
  'flow-retro',
];

/** How long one DorkOS read may take. */
const TIMEOUT_MS = 1_500;

/** The Health block. */
export interface Health {
  /**
   * One row per flow schedule of this project, or `null` when the schedules
   * could not be read at all (then {@link schedulesUnknown} says why).
   */
  schedules: ScheduleHealth[] | null;
  /** Why the schedules could not be read, when they could not. */
  schedulesUnknown: string | null;
  /** One row per intake source. */
  intake: IntakeHealth[];
}

/** What the read needs. */
export interface HealthInput {
  /** The project's checkouts (a schedule's file under one of them is this project's). */
  roots: readonly string[];
  /** The environment (`FLOW_DORKOS_URL`, `DORKOS_PORT`). */
  env: Readonly<Record<string, string | undefined>>;
  /** The fetch implementation. */
  fetchImpl: typeof fetch;
  /** The moment to judge at. */
  now: Date;
  /** `connection.intake`. */
  intake: readonly { id: string; name?: string }[];
  /** The configured tracker (the plain intake). */
  tracker: string;
}

/** A plain object, or `undefined`. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A string field, or `null`. */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** GET one loopback JSON route; a string is why it could not be read. */
async function getJson(base: URL, route: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(route, base), {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A redirect could send the request off this machine: never follow one.
      redirect: 'manual',
    });
  } catch {
    throw new Error(`DorkOS is not reachable at ${base.origin}`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`DorkOS answered ${route} with a redirect, which flow does not follow`);
  }
  if (!response.ok) throw new Error(`DorkOS answered ${route} with ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`DorkOS sent an answer to ${route} flow could not read`);
  }
}

/** Whether `file` is inside one of `roots` (a root that only starts another folder's name is not). */
function underRoot(file: string, roots: readonly string[]): boolean {
  return roots.some((root) => file.startsWith(path.resolve(root) + path.sep));
}

/**
 * Read the Health block's facts and judge them.
 *
 * @param input - The project's roots, the environment, fetch, the clock and the intake config.
 * @returns The block; never throws for something it cannot read.
 */
export async function readHealth(input: HealthInput): Promise<Health> {
  const intake = intakeHealth(input.intake, input.tracker, input.now);
  const unknown = (why: string): Health => ({ schedules: null, schedulesUnknown: why, intake });
  let base: URL;
  try {
    base = assertLoopback(resolveDorkosUrl(undefined, input.env));
  } catch (error) {
    return unknown((error as Error).message);
  }
  let tasks: unknown;
  try {
    tasks = await getJson(base, '/api/tasks', input.fetchImpl);
  } catch (error) {
    return unknown((error as Error).message);
  }
  if (!Array.isArray(tasks)) return unknown('DorkOS sent a schedule list flow could not read');

  const schedules: ScheduleHealth[] = [];
  for (const entry of tasks) {
    const task = record(entry);
    const id = str(task?.id);
    const name = str(task?.name);
    const file = str(task?.filePath);
    if (task === undefined || id === null || name === null || file === null) continue;
    const flowRun = /\/flow continue\b/.test(str(task.prompt) ?? '');
    if (!underRoot(file, input.roots) || !(FLOW_SCHEDULES.includes(name) || flowRun)) continue;
    const facts: ScheduleFacts = {
      name,
      cron: str(task.cron),
      timezone: str(task.timezone),
      enabled: task.enabled !== false,
      status: str(task.status) ?? 'unknown',
      lastSuccess: null,
    };
    if (facts.enabled && facts.status === 'active') {
      facts.lastSuccess = await lastSuccess(base, id, input.fetchImpl);
    }
    schedules.push(scheduleHealth(facts, input.now));
  }
  schedules.sort((a, b) => a.name.localeCompare(b.name));
  return { schedules, schedulesUnknown: null, intake };
}

/** The last successful run's start (else finish), `null` for none, or why it could not be read. */
async function lastSuccess(
  base: URL,
  id: string,
  fetchImpl: typeof fetch
): Promise<string | null | { error: string }> {
  let runs: unknown;
  try {
    runs = await getJson(
      base,
      `/api/tasks/runs?scheduleId=${encodeURIComponent(id)}&status=completed&limit=1`,
      fetchImpl
    );
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (!Array.isArray(runs)) return { error: 'DorkOS sent a run list flow could not read' };
  const run = record(runs[0]);
  if (run === undefined) return null;
  if (str(run.status) !== 'completed') {
    return { error: 'DorkOS answered with a run that did not complete' };
  }
  const at = str(run.startedAt) ?? str(run.finishedAt);
  return at === null ? { error: 'its last successful run has no time' } : at;
}

/**
 * The block as text, under a `Health:` heading.
 *
 * @param health - The block.
 * @returns The lines.
 */
export function renderHealth(health: Health): string {
  const lines = ['Health:'];
  if (health.schedules === null) {
    lines.push(`  Schedules: unknown (${health.schedulesUnknown ?? 'not read'})`);
  } else if (health.schedules.length === 0) {
    lines.push('  Schedules: this project has no flow schedule in DorkOS.');
  } else {
    for (const s of health.schedules) {
      const when = s.cron === null ? '' : ` (${s.cron}${s.timezone ? `, ${s.timezone}` : ''})`;
      lines.push(`  ${s.name}${when}: ${s.detail}`);
    }
  }
  for (const source of health.intake) {
    lines.push(`  Intake (${source.name ?? source.id}): ${source.detail}`);
  }
  return lines.join('\n');
}
