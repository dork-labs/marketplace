/**
 * `flow selftest --file`: turn failing checks into tracker work, once each
 * (spec `specs/flow-self-improvement` §1, "Report and --file").
 *
 * Every failing check has a fingerprint, and an item filed for it carries the
 * marker line `<!-- flow-selftest:fp=<fingerprint> -->` in its description
 * (and the fingerprint in its title, since closed items reach the snapshot as
 * titles only). Before anything is written, the snapshot is read with closed
 * items included, and each failing check is matched against it:
 *
 * - an open match gets one comment with the new detail (not repeated while
 *   the detail stays the same);
 * - a match canceled in the last {@link WINDOW_DAYS} days is not filed again:
 *   a person declined it;
 * - a completed match is filed again only on evidence dated after it was
 *   completed, as a regression of that item;
 * - no match is a new item.
 *
 * A close the tracker cannot date counts as recent, so it is never overridden.
 *
 * The code adapter contract has no verb that creates an item, so nothing is
 * created: the items that would be filed are listed in the report with
 * "filing needs a create capability", and the run exits 1 (it has failures).
 *
 * @module @dorkos/flow/selftest/file
 */

import type { CodeAdapter, WorkItem } from '../tracker/types.ts';
import type { Check } from './report.ts';

/** How far back a closed match still counts. */
export const WINDOW_DAYS = 90;

/** What the report says when an item would be filed. */
export const CREATE_MISSING =
  'filing needs a create capability: the tracker adapter has no verb that creates an item, so these were not filed';

/** The labels every filed item carries, before `selfImprovement.retro.labels`. */
export const FILED_LABELS: readonly string[] = ['type/task', 'origin/from-agent'];

/**
 * A filed item's labels: {@link FILED_LABELS} plus the configured extras, each
 * once. An extra in the `agent/*` family is dropped (a person triages the item
 * first), and so is one in `type/*`, an exclusive group this item already
 * fills with `type/task`.
 *
 * @param extra - `selfImprovement.retro.labels`.
 * @returns The labels.
 */
export function filedLabels(extra: readonly string[]): string[] {
  const kept = extra.filter((label) => !label.startsWith('agent/') && !label.startsWith('type/'));
  return [...new Set([...FILED_LABELS, ...kept])];
}

/**
 * The marker line a filed item's description carries.
 *
 * @param fp - The check's fingerprint.
 * @returns The line.
 */
export function markerFor(fp: string): string {
  return `<!-- flow-selftest:fp=${fp} -->`;
}

/**
 * A filed item's title: the check and its fingerprint.
 *
 * @param check - The failing check.
 * @returns The title.
 */
export function titleFor(check: Check): string {
  return `flow selftest: ${check.id} fails (${check.fingerprint})`;
}

/** One item a failing check could match: open, or closed with its close date when known. */
export interface Candidate {
  /** Human key. */
  identifier: string;
  /** Its state category. */
  stateCategory: WorkItem['stateCategory'];
  /** Its description (where the marker lives). */
  description: string;
  /** When it closed (ISO), when the tracker says. */
  closedAt?: string;
}

/** What `--file` does, or would do, for one failing check. */
export type Disposition =
  | { kind: 'comment'; checkId: string; identifier: string; body: string }
  | { kind: 'declined'; checkId: string; identifier: string }
  | { kind: 'not-refiled'; checkId: string; identifier: string; reason: string }
  | {
      kind: 'file';
      checkId: string;
      title: string;
      body: string;
      labels: string[];
      project?: string;
      regressionOf?: string;
    };

/** When the evidence was gathered, and which flow produced it. */
export interface FilingMeta {
  /** When the self-test run started (ISO): the evidence's date. */
  evidenceAt: string;
  /** Now, for the window. */
  now: Date;
  /** The flow version that ran. */
  flowVersion: string;
  /** `selfImprovement.retro.labels`: extra labels a filed item gets. Default none. */
  labels?: readonly string[];
  /** `selfImprovement.retro.project`: the project a filed item goes to; `null`/absent = none. */
  project?: string | null;
}

/** The body of a filed item, or of the comment on an open one. */
function bodyFor(check: Check, meta: FilingMeta, regressionOf?: string): string {
  return [
    ...(regressionOf === undefined ? [] : [`Regressed after ${regressionOf}.`, '']),
    `The self-test check \`${check.id}\` failed on flow ${meta.flowVersion}.`,
    '',
    check.detail === '' ? '(no detail)' : check.detail,
    '',
    markerFor(check.fingerprint),
  ].join('\n');
}

/** The item a failing check would be filed as. */
function newItem(
  check: Check,
  meta: FilingMeta,
  regressionOf?: string
): Extract<Disposition, { kind: 'file' }> {
  return {
    kind: 'file',
    checkId: check.id,
    title: titleFor(check),
    body: bodyFor(check, meta, regressionOf),
    labels: filedLabels(meta.labels ?? []),
    ...(meta.project ? { project: meta.project } : {}),
  };
}

/** Whether a close falls inside the window; an undated close always does. */
function recent(candidate: Candidate, now: Date): boolean {
  if (candidate.closedAt === undefined) return true;
  return now.getTime() - Date.parse(candidate.closedAt) <= WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Decide what to do for each failing check. Pure.
 *
 * @param failing - The failing checks.
 * @param candidates - Open items, and closed items with their descriptions.
 * @param meta - The evidence date, now, and the flow version.
 * @returns One disposition per failing check, in order.
 */
export function planFiling(
  failing: readonly Check[],
  candidates: readonly Candidate[],
  meta: FilingMeta
): Disposition[] {
  return failing.map((check): Disposition => {
    const marker = markerFor(check.fingerprint);
    const matches = candidates.filter((c) => c.description.includes(marker));
    const open = matches.find(
      (c) => c.stateCategory !== 'completed' && c.stateCategory !== 'canceled'
    );
    if (open !== undefined) {
      return {
        kind: 'comment',
        checkId: check.id,
        identifier: open.identifier,
        body: bodyFor(check, meta),
      };
    }
    const closed = matches.filter((c) => recent(c, meta.now));
    const canceled = closed.find((c) => c.stateCategory === 'canceled');
    if (canceled !== undefined) {
      return { kind: 'declined', checkId: check.id, identifier: canceled.identifier };
    }
    const completed = closed
      .filter((c) => c.stateCategory === 'completed')
      .sort((a, b) => (b.closedAt ?? '￿').localeCompare(a.closedAt ?? '￿'))[0];
    if (completed !== undefined) {
      if (completed.closedAt === undefined) {
        return {
          kind: 'not-refiled',
          checkId: check.id,
          identifier: completed.identifier,
          reason: 'completed at an unknown time, so this failure cannot be shown to be newer',
        };
      }
      if (Date.parse(completed.closedAt) >= Date.parse(meta.evidenceAt)) {
        return {
          kind: 'not-refiled',
          checkId: check.id,
          identifier: completed.identifier,
          reason: 'completed after this run started',
        };
      }
      return { ...newItem(check, meta, completed.identifier), regressionOf: completed.identifier };
    }
    return newItem(check, meta);
  });
}

/** What `--file` did. */
export interface FilingResult {
  /** Open items that got a comment; `posted: false` when the same text was already there. */
  commented: { checkId: string; identifier: string; posted: boolean }[];
  /** Matches a person canceled in the window: not filed again. */
  declined: { checkId: string; identifier: string }[];
  /** Completed matches not filed again, and why. */
  notRefiled: { checkId: string; identifier: string; reason: string }[];
  /** Items that would be filed, were there a create verb. */
  wouldFile: {
    checkId: string;
    title: string;
    body: string;
    labels: string[];
    project?: string;
    regressionOf?: string;
  }[];
  /** {@link CREATE_MISSING} when anything would be filed. */
  message?: string;
  /** Why filing could not run at all (config, capability, tracker). */
  error?: string;
}

/** What {@link fileFailures} writes with. */
export interface FilingDeps {
  /** The project's tracker adapter. */
  adapter: CodeAdapter;
  /** Signs a comment body (identity marker plus provenance line). */
  sign(body: string): string;
  /** Strips a body's signature, to compare two posts of the same text. */
  unsign(body: string): string;
}

/**
 * Match each failing check against the tracker and act: comment on open
 * matches, list everything else. Never creates an item.
 *
 * @param failing - The failing checks.
 * @param meta - The evidence date, now, and the flow version.
 * @param deps - The adapter and the signer.
 * @returns What was done and what would be filed.
 */
export async function fileFailures(
  failing: readonly Check[],
  meta: FilingMeta,
  deps: FilingDeps
): Promise<FilingResult> {
  const result: FilingResult = { commented: [], declined: [], notRefiled: [], wouldFile: [] };
  if (failing.length === 0) return result;
  const { adapter } = deps;
  const snapshot = await adapter.getBacklogSnapshot({ includeClosed: true });
  const candidates: Candidate[] = snapshot.items.map((item) => ({
    identifier: item.identifier,
    stateCategory: item.stateCategory,
    description: item.description,
  }));
  // Closed items arrive as titles: read in full only those titled for a failing check.
  const wanted = failing.map((check) => `(${check.fingerprint})`);
  for (const closed of snapshot.closed) {
    if (!wanted.some((tag) => closed.title.includes(tag))) continue;
    const item = await adapter.getItem(closed.identifier);
    candidates.push({
      identifier: closed.identifier,
      stateCategory: closed.stateCategory,
      description: item.description,
      ...(closed.closedAt === undefined ? {} : { closedAt: closed.closedAt }),
    });
  }

  for (const plan of planFiling(failing, candidates, meta)) {
    if (plan.kind === 'comment') {
      const item = await adapter.getItem(plan.identifier, { comments: 10 });
      const signed = deps.sign(plan.body);
      const already = (item.comments ?? []).some(
        (comment) => deps.unsign(comment.body) === deps.unsign(signed)
      );
      if (!already) await adapter.comment(item, signed);
      result.commented.push({
        checkId: plan.checkId,
        identifier: plan.identifier,
        posted: !already,
      });
    } else if (plan.kind === 'declined') {
      result.declined.push({ checkId: plan.checkId, identifier: plan.identifier });
    } else if (plan.kind === 'not-refiled') {
      const { checkId, identifier, reason } = plan;
      result.notRefiled.push({ checkId, identifier, reason });
    } else {
      const { kind: _kind, ...item } = plan;
      result.wouldFile.push(item);
    }
  }
  if (result.wouldFile.length > 0) result.message = CREATE_MISSING;
  return result;
}

/**
 * Render a filing result as text lines for the report.
 *
 * @param filing - The result.
 * @returns The lines, starting with a blank one.
 */
export function renderFiling(filing: FilingResult): string[] {
  const lines = ['', 'Filing:'];
  if (filing.error !== undefined) lines.push(`  could not file: ${filing.error}`);
  for (const c of filing.commented) {
    lines.push(`  ${c.posted ? 'commented on' : 'already noted on'} ${c.identifier}: ${c.checkId}`);
  }
  for (const d of filing.declined)
    lines.push(`  declined in ${d.identifier}, not filed again: ${d.checkId}`);
  for (const n of filing.notRefiled)
    lines.push(`  not filed again (${n.identifier} ${n.reason}): ${n.checkId}`);
  if (filing.message !== undefined) lines.push(`  ${filing.message}:`);
  for (const w of filing.wouldFile) {
    lines.push(`    ${w.title}${w.regressionOf ? ` (regressed after ${w.regressionOf})` : ''}`);
  }
  if (lines.length === 2) lines.push('  nothing to file');
  return lines;
}
