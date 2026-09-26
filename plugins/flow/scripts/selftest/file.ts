/**
 * Filing: turn findings into tracker work, once each. Shared by `flow selftest
 * --file` (a failing check, spec `specs/flow-self-improvement` §1, "Report and
 * --file") and `flow retro --file` (a proposal, §3, "Filing").
 *
 * Every finding has a fingerprint, and an item filed for it carries a marker
 * line in its description, `<!-- flow-selftest:fp=<fingerprint> -->` or
 * `<!-- flow-retro:fp=<fingerprint> -->`, and the fingerprint in its title,
 * since closed items reach the snapshot as titles only. Before anything is
 * written, the snapshot is read with closed items included, and each finding
 * is matched against it:
 *
 * - an open match gets one comment with the new detail (not repeated while
 *   the detail stays the same);
 * - a match canceled in the last {@link WINDOW_DAYS} days is not filed again:
 *   a person declined it;
 * - a completed match is filed again only on evidence dated after it was
 *   completed, as a regression of that item;
 * - no match is a new item, up to the run's cap (`maxNew`), the findings with
 *   the most evidence first; the rest are listed as not filed (cap).
 *
 * A close the tracker cannot date counts as recent, so it is never overridden.
 *
 * A new item is created through the adapter's `createItem` (contract 2.2.0),
 * only after this dedupe, with the signed body. An adapter without that
 * capability creates nothing: the items that would be filed are listed with
 * "filing needs a create capability", and the caller exits 1.
 *
 * @module @dorkos/flow/selftest/file
 */

import os from 'node:os';

import { buildProvenance, signBody, unsignedBody } from '../cli/provenance.ts';
import { findConfigRoots } from '../config-files.ts';
import type { CodeAdapter, WorkItem } from '../tracker/types.ts';
import type { Check } from './report.ts';

/** How far back a closed match still counts. */
export const WINDOW_DAYS = 90;

/** What the report says when an item would be filed. */
export const CREATE_MISSING =
  'filing needs a create capability: the tracker adapter has no verb that creates an item, so these were not filed';

/** The labels every filed item carries, before `selfImprovement.retro.labels`. */
export const FILED_LABELS: readonly string[] = ['type/task', 'origin/from-agent'];

/** Which marker a filed item carries: one per source, so the two never match each other. */
export type MarkerKind = 'flow-selftest' | 'flow-retro';

/** The group of a namespaced label (`origin` for `origin/human`), or `null` for a bare one. */
function groupOf(label: string): string | null {
  const slash = label.indexOf('/');
  return slash < 0 ? null : label.slice(0, slash);
}

/**
 * A filed item's labels: {@link FILED_LABELS} plus the configured extras, each
 * once and one per group (a tracker applies one label per group). An extra in
 * the `agent/*` family is dropped (a person triages the item first); so is an
 * extra in a group already filled: by `type/task` and `origin/from-agent`, or
 * by an earlier extra.
 *
 * @param extra - `selfImprovement.retro.labels`.
 * @returns The labels.
 */
export function filedLabels(extra: readonly string[]): string[] {
  const labels = [...FILED_LABELS];
  const groups = new Set(labels.map(groupOf));
  for (const label of extra) {
    const group = groupOf(label);
    if (group === 'agent' || labels.includes(label)) continue;
    if (group !== null && groups.has(group)) continue;
    labels.push(label);
    groups.add(group);
  }
  return labels;
}

/**
 * The marker line a filed item's description carries.
 *
 * @param fp - The finding's fingerprint.
 * @param kind - Which source filed it. Default: the self-test.
 * @returns The line.
 */
export function markerFor(fp: string, kind: MarkerKind = 'flow-selftest'): string {
  return `<!-- ${kind}:fp=${fp} -->`;
}

/**
 * A self-test item's title: the check and its fingerprint.
 *
 * @param check - The failing check.
 * @returns The title.
 */
export function titleFor(check: Check): string {
  return `flow selftest: ${check.id} fails (${check.fingerprint})`;
}

/**
 * One thing to file. The title must carry `(<fingerprint>)`, since a closed
 * item is found by its title before its description is read.
 */
export interface Finding {
  /** What it is about, for the report: a check id, or a proposal's title. */
  subject: string;
  /** The stable 12-hex-character id the marker carries. */
  fingerprint: string;
  /** The item title, ending in `(<fingerprint>)`. */
  title: string;
  /** The body text, without the regression line and the marker. */
  text: string;
  /** When the newest piece of evidence was gathered (ISO). */
  evidenceAt: string;
  /** How much evidence there is; under the cap, more files first. Default 1. */
  weight?: number;
}

/**
 * A failing check as a {@link Finding}: its evidence is the run itself.
 *
 * @param check - The failing check.
 * @param meta - The run's start and flow version.
 * @returns The finding.
 */
export function checkFinding(
  check: Check,
  meta: { evidenceAt: string; flowVersion: string }
): Finding {
  return {
    subject: check.id,
    fingerprint: check.fingerprint,
    title: titleFor(check),
    text: [
      `The self-test check \`${check.id}\` failed on flow ${meta.flowVersion}.`,
      '',
      check.detail === '' ? '(no detail)' : check.detail,
    ].join('\n'),
    evidenceAt: meta.evidenceAt,
  };
}

/** One item a finding could match: open, or closed with its close date when known. */
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

/** What filing does, or would do, for one finding. */
export type Disposition =
  | { kind: 'comment'; subject: string; identifier: string; body: string }
  | { kind: 'declined'; subject: string; identifier: string }
  | { kind: 'not-refiled'; subject: string; identifier: string; reason: string }
  | { kind: 'cap'; subject: string; title: string }
  | {
      kind: 'file';
      subject: string;
      /**
       * The create's idempotency key: `<marker kind>:<fingerprint>:` plus every
       * item already filed for it (or `none`). Two runs that see the same
       * tracker send the same key and make one item; once an earlier item
       * exists, even closed long ago, the key is new, so a returning finding is
       * filed again.
       */
      key: string;
      title: string;
      body: string;
      labels: string[];
      project?: string;
      regressionOf?: string;
    };

/** Where filed items go, and how they are marked. */
export interface FilingMeta {
  /** Now, for the window. */
  now: Date;
  /** The marker a filed item carries. Default `flow-selftest`. */
  marker?: MarkerKind;
  /** `selfImprovement.retro.labels`: extra labels a filed item gets. Default none. */
  labels?: readonly string[];
  /** `selfImprovement.retro.project`: the project a filed item goes to; `null`/absent = none. */
  project?: string | null;
  /** The most new items one run may file (`maxItemsPerRun`). Default: no cap. */
  maxNew?: number;
}

/** The self-test's filing meta: the run's start is every finding's evidence date. */
export interface CheckFilingMeta extends FilingMeta {
  /** When the self-test run started (ISO): the evidence's date. */
  evidenceAt: string;
  /** The flow version that ran. */
  flowVersion: string;
}

/** The body of a filed item, or of the comment on an open one. */
function bodyFor(finding: Finding, marker: MarkerKind, regressionOf?: string): string {
  return [
    ...(regressionOf === undefined ? [] : [`Regressed after ${regressionOf}.`, '']),
    finding.text,
    '',
    markerFor(finding.fingerprint, marker),
  ].join('\n');
}

/** The item a finding would be filed as. */
function newItem(
  finding: Finding,
  meta: FilingMeta,
  matches: readonly Candidate[],
  regressionOf?: string
): Extract<Disposition, { kind: 'file' }> {
  const earlier = matches.map((m) => m.identifier).sort();
  return {
    kind: 'file',
    subject: finding.subject,
    key: `${meta.marker ?? 'flow-selftest'}:${finding.fingerprint}:${earlier.length === 0 ? 'none' : earlier.join(',')}`,
    title: finding.title,
    body: bodyFor(finding, meta.marker ?? 'flow-selftest', regressionOf),
    labels: filedLabels(meta.labels ?? []),
    ...(meta.project ? { project: meta.project } : {}),
    ...(regressionOf === undefined ? {} : { regressionOf }),
  };
}

/** Whether a close falls inside the window; an undated close always does. */
function recent(candidate: Candidate, now: Date): boolean {
  if (candidate.closedAt === undefined) return true;
  return now.getTime() - Date.parse(candidate.closedAt) <= WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/** What to do for one finding, before the cap. */
function planOne(
  finding: Finding,
  candidates: readonly Candidate[],
  meta: FilingMeta
): Disposition {
  const marker = markerFor(finding.fingerprint, meta.marker ?? 'flow-selftest');
  const subject = finding.subject;
  const matches = candidates.filter((c) => c.description.includes(marker));
  const open = matches.find(
    (c) => c.stateCategory !== 'completed' && c.stateCategory !== 'canceled'
  );
  if (open !== undefined) {
    const body = bodyFor(finding, meta.marker ?? 'flow-selftest');
    return { kind: 'comment', subject, identifier: open.identifier, body };
  }
  const closed = matches.filter((c) => recent(c, meta.now));
  const canceled = closed.find((c) => c.stateCategory === 'canceled');
  if (canceled !== undefined) return { kind: 'declined', subject, identifier: canceled.identifier };
  const completed = closed
    .filter((c) => c.stateCategory === 'completed')
    .sort((a, b) => (b.closedAt ?? '￿').localeCompare(a.closedAt ?? '￿'))[0];
  if (completed === undefined) return newItem(finding, meta, matches);
  if (completed.closedAt === undefined) {
    return {
      kind: 'not-refiled',
      subject,
      identifier: completed.identifier,
      reason: 'completed at an unknown time, so this evidence cannot be shown to be newer',
    };
  }
  if (Date.parse(completed.closedAt) >= Date.parse(finding.evidenceAt)) {
    return {
      kind: 'not-refiled',
      subject,
      identifier: completed.identifier,
      reason: 'completed after the newest evidence',
    };
  }
  return newItem(finding, meta, matches, completed.identifier);
}

/**
 * Decide what to do for each finding. Pure. Under `meta.maxNew`, the new items
 * with the most evidence are kept (ties in input order) and the rest become
 * `cap`; comments, declines and not-refiled count against no cap.
 *
 * @param findings - The findings.
 * @param candidates - Open items, and closed items with their descriptions.
 * @param meta - Now, the marker, the labels, the project and the cap.
 * @returns One disposition per finding, in input order.
 */
export function planFindings(
  findings: readonly Finding[],
  candidates: readonly Candidate[],
  meta: FilingMeta
): Disposition[] {
  const plans = findings.map((finding) => planOne(finding, candidates, meta));
  if (meta.maxNew === undefined) return plans;
  const kept = new Set(
    plans
      .map((plan, index) => ({ plan, index, weight: findings[index].weight ?? 1 }))
      .filter(({ plan }) => plan.kind === 'file')
      .sort((a, b) => b.weight - a.weight || a.index - b.index)
      .slice(0, Math.max(0, meta.maxNew))
      .map(({ index }) => index)
  );
  return plans.map((plan, index) =>
    plan.kind === 'file' && !kept.has(index)
      ? { kind: 'cap', subject: plan.subject, title: plan.title }
      : plan
  );
}

/**
 * Decide what to do for each failing check (the self-test's form of
 * {@link planFindings}).
 *
 * @param failing - The failing checks.
 * @param candidates - Open items, and closed items with their descriptions.
 * @param meta - The evidence date, now, and the flow version.
 * @returns One disposition per failing check, in order.
 */
export function planFiling(
  failing: readonly Check[],
  candidates: readonly Candidate[],
  meta: CheckFilingMeta
): Disposition[] {
  return planFindings(
    failing.map((check) => checkFinding(check, meta)),
    candidates,
    meta
  );
}

/** What filing did. */
export interface FilingResult {
  /** Open items that got a comment; `posted: false` when the same text was already there. */
  commented: { subject: string; identifier: string; posted: boolean }[];
  /** Matches a person canceled in the window: not filed again. */
  declined: { subject: string; identifier: string }[];
  /** Completed matches not filed again, and why. */
  notRefiled: { subject: string; identifier: string; reason: string }[];
  /** Items created, with the identifier and link the tracker gave them. */
  filed: { subject: string; identifier: string; url: string; regressionOf?: string }[];
  /** Items that would be filed, when the adapter cannot create. */
  wouldFile: {
    subject: string;
    title: string;
    body: string;
    labels: string[];
    project?: string;
    regressionOf?: string;
  }[];
  /** New items over the run's cap: not filed this run. */
  notFiledCap: { subject: string; title: string }[];
  /** {@link CREATE_MISSING} when anything would be filed but the adapter cannot create. */
  message?: string;
  /** Why filing could not run at all (config, capability, tracker). */
  error?: string;
}

/**
 * A result with nothing in it, optionally carrying why filing could not run.
 *
 * @param error - Why filing could not run.
 * @returns The empty result.
 */
export function emptyFiling(error?: string): FilingResult {
  return {
    commented: [],
    declined: [],
    notRefiled: [],
    filed: [],
    wouldFile: [],
    notFiledCap: [],
    ...(error === undefined ? {} : { error }),
  };
}

/** What {@link fileFindings} writes with. */
export interface FilingDeps {
  /** The project's tracker adapter. */
  adapter: CodeAdapter;
  /** Signs a comment body (identity marker plus provenance line). */
  sign(body: string): string;
  /** Strips a body's signature, to compare two posts of the same text. */
  unsign(body: string): string;
}

/**
 * Match each finding against the tracker and act: comment on open matches,
 * skip declined and not-newer ones, and create the rest (up to the cap)
 * through `createItem` when the adapter has it, listing them otherwise. Dedupe
 * always runs first. A write that fails stops the run: the result keeps what
 * already landed and carries the `error`, and a retry finds it by fingerprint.
 *
 * @param findings - The findings.
 * @param meta - Now, the marker, the labels, the project and the cap.
 * @param deps - The adapter and the signer.
 * @returns What was done and what would be filed.
 */
export async function fileFindings(
  findings: readonly Finding[],
  meta: FilingMeta,
  deps: FilingDeps
): Promise<FilingResult> {
  const result = emptyFiling();
  if (findings.length === 0) return result;
  const { adapter } = deps;
  const snapshot = await adapter.getBacklogSnapshot({ includeClosed: true });
  const candidates: Candidate[] = snapshot.items.map((item) => ({
    identifier: item.identifier,
    stateCategory: item.stateCategory,
    description: item.description,
  }));
  // Closed items arrive as titles: read in full only those titled for a finding.
  const wanted = findings.map((finding) => `(${finding.fingerprint})`);
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

  try {
    await act(planFindings(findings, candidates, meta), deps, result);
  } catch (error) {
    // Keep what was already done: those comments and items exist now, and the
    // next run finds them by their fingerprints.
    result.error = (error as Error).message;
  }
  if (result.wouldFile.length > 0) result.message = CREATE_MISSING;
  return result;
}

/** Carry out each plan in order, recording every step in `result` as it lands. */
async function act(plans: Disposition[], deps: FilingDeps, result: FilingResult): Promise<void> {
  const { adapter } = deps;
  for (const plan of plans) {
    if (plan.kind === 'comment') {
      const item = await adapter.getItem(plan.identifier, { comments: 10 });
      const signed = deps.sign(plan.body);
      const already = (item.comments ?? []).some(
        (comment) => deps.unsign(comment.body) === deps.unsign(signed)
      );
      if (!already) await adapter.comment(item, signed);
      result.commented.push({
        subject: plan.subject,
        identifier: plan.identifier,
        posted: !already,
      });
    } else if (plan.kind === 'declined') {
      result.declined.push({ subject: plan.subject, identifier: plan.identifier });
    } else if (plan.kind === 'not-refiled') {
      const { subject, identifier, reason } = plan;
      result.notRefiled.push({ subject, identifier, reason });
    } else if (plan.kind === 'cap') {
      result.notFiledCap.push({ subject: plan.subject, title: plan.title });
    } else if (adapter.capabilities.includes('createItem') && adapter.createItem !== undefined) {
      const created = await adapter.createItem({
        title: plan.title,
        description: deps.sign(plan.body),
        labels: plan.labels,
        ...(plan.project !== undefined ? { project: plan.project } : {}),
        // One item per finding per state of the tracker: a retry, or a second
        // run at the same time, returns the item the first one made.
        key: plan.key,
      });
      result.filed.push({
        subject: plan.subject,
        identifier: created.identifier,
        url: created.url,
        ...(plan.regressionOf !== undefined ? { regressionOf: plan.regressionOf } : {}),
      });
    } else {
      const { kind: _kind, key: _key, ...item } = plan;
      result.wouldFile.push(item);
    }
  }
}

/**
 * Match each failing check against the tracker and act (the self-test's form
 * of {@link fileFindings}).
 *
 * @param failing - The failing checks.
 * @param meta - The evidence date, now, and the flow version.
 * @param deps - The adapter and the signer.
 * @returns What was done and what would be filed.
 */
export async function fileFailures(
  failing: readonly Check[],
  meta: CheckFilingMeta,
  deps: FilingDeps
): Promise<FilingResult> {
  return fileFindings(
    failing.map((check) => checkFinding(check, meta)),
    meta,
    deps
  );
}

/**
 * Render a filing result as text lines for a report.
 *
 * @param filing - The result.
 * @returns The lines, starting with a blank one.
 */
export function renderFiling(filing: FilingResult): string[] {
  const lines = ['', 'Filing:'];
  if (filing.error !== undefined) lines.push(`  could not file: ${filing.error}`);
  for (const c of filing.commented) {
    lines.push(`  ${c.posted ? 'commented on' : 'already noted on'} ${c.identifier}: ${c.subject}`);
  }
  for (const d of filing.declined)
    lines.push(`  declined in ${d.identifier}, not filed again: ${d.subject}`);
  for (const f of filing.filed) {
    lines.push(
      `  filed ${f.identifier}: ${f.subject}${f.regressionOf ? ` (regressed after ${f.regressionOf})` : ''} ${f.url}`
    );
  }
  for (const n of filing.notRefiled)
    lines.push(`  not filed again (${n.identifier} ${n.reason}): ${n.subject}`);
  if (filing.message !== undefined) lines.push(`  ${filing.message}:`);
  for (const w of filing.wouldFile) {
    lines.push(`    ${w.title}${w.regressionOf ? ` (regressed after ${w.regressionOf})` : ''}`);
  }
  for (const c of filing.notFiledCap) lines.push(`  not filed (cap): ${c.title}`);
  if (lines.length === 2) lines.push('  nothing to file');
  return lines;
}

/** Where filing happens: the project, and how to reach its tracker. */
export interface FilingSetupInput {
  /** The project checkout (its config and its tracker). */
  projectDir: string;
  /** The plugin folder. */
  flowRoot: string;
  /** The environment (config secrets, provenance). */
  env: Readonly<Record<string, string | undefined>>;
  /** The session id to sign with, when known. */
  sessionId?: string;
  /** Builds the project's tracker adapter. */
  adapter: () => Promise<CodeAdapter>;
}

/**
 * What both `--file` paths need before they file: the project's
 * `selfImprovement.retro` settings, its adapter (checked for the read and
 * comment verbs; `createItem` is optional), and a signer with the project's
 * identity marker and this session's provenance line. Loads the config, so it
 * needs `zod`.
 *
 * @param input - The project, the environment and the adapter factory.
 * @returns The retro settings and the filing deps.
 * @throws {ConfigError} When flow is not configured here.
 * @throws {TrackerError} When the adapter lacks a verb filing needs.
 */
export async function filingSetup(input: FilingSetupInput): Promise<{
  retro: { labels: string[]; project: string | null; maxItemsPerRun: number; window: string };
  deps: FilingDeps;
}> {
  const { loadConfig } = await import('../config-load.ts');
  const { requireCapabilities } = await import('../tracker/load.ts');
  const { config } = loadConfig(findConfigRoots(input.projectDir, input.flowRoot), input.env);
  const { marker } = config.identity;
  const adapter = await input.adapter();
  requireCapabilities(adapter, ['getBacklogSnapshot', 'getItem', 'comment']);
  const provenance = buildProvenance({
    env: input.env,
    sessionId: input.sessionId,
    hostname: os.hostname(),
  });
  return {
    retro: config.selfImprovement.retro,
    deps: { adapter, sign: (body) => signBody(body, marker, provenance), unsign: unsignedBody },
  };
}
