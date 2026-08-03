/*
 * audit-backlog.ts - the /flow backlog-groom invariant oracle.
 *
 * Asserts the fourteen groom invariants (GRM-1 .. GRM-14) against a snapshot of
 * NORMALIZED WorkItems - the whole live backlog as the adapter's
 * `getBacklogSnapshot()` verb emits it. Where validate-adapter.ts asks "did the
 * adapter normalize each item correctly?", this oracle asks "is the backlog
 * itself healthy enough to dispatch from?" - the machine-checked verification
 * gate the grooming-backlog skill runs before and after a groom.
 *
 * The invariants were extracted from the 2026-08-03 DorkOS tracker
 * reorganization, where every one of them was seeded with a synthetic violation
 * and proven to go red before being trusted (the engine-tests bad fixtures pin
 * that property permanently). They are tracker-neutral: the two Linear-only
 * checks from that run (nothing left in the Triage state, nothing in the
 * unmappable Duplicate state) are snapshot-time obligations of the ADAPTER,
 * documented in the linear-adapter skill, and never reach this oracle.
 *
 * This script is dependency-free by design (no zod, no imports beyond node:fs /
 * node:url) and runs directly under `node --experimental-strip-types`, exactly
 * like the other oracle scripts in this directory (ADR-0294, ADR-0298). Schema
 * types are deliberately NOT imported here, even as `import type` - the checks
 * are hand-rolled over `unknown` so the oracle also survives a NON-conformant
 * snapshot without crashing (and so no value import can ever drag zod into the
 * shipped runtime; see DOR-863 for how that class of defect looks).
 *
 * Interface (matches validate-adapter.ts exactly):
 *   node --experimental-strip-types scripts/audit-backlog.ts --fixture <path>
 *   node --experimental-strip-types scripts/audit-backlog.ts        # stdin
 *   node --experimental-strip-types scripts/audit-backlog.ts --help
 *
 * Output (stdout): a JSON verdict { "ok": boolean, "failures": [{ "invariant", "detail" }] }.
 * Exit codes: 0 pass (ok:true) | 1 invariant failure (ok:false) | 2 invalid input.
 * Diagnostics go to stderr; stdout is always the JSON verdict.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** State categories an item may still be worked FROM (open, not terminal). */
const OPEN_STATE_CATEGORIES: string[] = ['backlog', 'unstarted', 'started'];

/** State categories that end an item's life (terminal). */
const TERMINAL_STATE_CATEGORIES: string[] = ['completed', 'canceled'];

/** Project state categories that hide every item under them from dispatch. */
const DEAD_PROJECT_STATE_CATEGORIES: string[] = ['completed', 'canceled'];

/** The literal, re-namespaced readiness label that gates dispatch. */
const AGENT_READY_LABEL = 'agent/ready';

/** A single breached invariant in the verdict. */
interface Failure {
  /** The invariant identifier (`GRM-1` .. `GRM-14`, or `INPUT` for malformed input). */
  invariant: string;
  /** The aggregated human-readable breach detail(s). */
  detail: string;
}

/** The groom verdict written to stdout. */
interface Verdict {
  /** `true` when every invariant passed. */
  ok: boolean;
  /** One entry per breached invariant (empty when `ok`). */
  failures: Failure[];
}

/** Options the snapshot may carry alongside its items. */
interface AuditOpts {
  /** The dispatch agent's identity; a ready item assigned to it passes GRM-8. */
  agentIdentity?: string;
}

/** The parsed CLI arguments for the oracle. */
interface HarnessArgs {
  /** Whether `--help` / `-h` was passed. */
  help: boolean;
  /** The `--fixture <path>` value, or `undefined` to read the fixture from stdin. */
  fixturePath?: string;
}

const HELP = `audit-backlog - the /flow backlog-groom invariant oracle.

Asserts the fourteen groom invariants (GRM-1 .. GRM-14) against a snapshot of
NORMALIZED WorkItems - the whole live backlog, as the adapter's
getBacklogSnapshot() verb emits it. Run by the grooming-backlog skill before
and after a groom; runnable standalone for a read-only health check.

Usage:
  node --experimental-strip-types scripts/audit-backlog.ts --fixture <path>
  node --experimental-strip-types scripts/audit-backlog.ts        reads stdin
  node --experimental-strip-types scripts/audit-backlog.ts --help

Fixture: a JSON array of WorkItems, or { "items": [...], "opts": { "agentIdentity": "..." } }.
Terminal items (completed/canceled) may be included for context; every
invariant below is asserted over OPEN items only, except GRM-14.

Verdict (stdout): { "ok": boolean, "failures": [{ "invariant": "GRM-N", "detail": "..." }] }
Exit codes: 0 pass (ok:true) | 1 invariant failure (ok:false) | 2 invalid input.

Invariants ("ready" = carries the literal agent/ready label):
  GRM-1   every open item has exactly one type/* label
  GRM-2   every open item has a project
  GRM-3   every open item has priority 1-4 (0 or absent fails - "none" sorts
          behind every concrete value in the ranking ladder)
  GRM-4   ready => size present (a missing estimate sorts last in its tier)
  GRM-5   ready => "## Validation criteria" present in the description
  GRM-6   ready => "## On Completion" present in the description (DONE reads it)
  GRM-7   ready => no blockedBy entry that is itself open in the snapshot
          (the eligibility filter drops these; the label would be a lie)
  GRM-8   ready => unassigned, or assigned to opts.agentIdentity
          (claimAssignedToHuman defaults false; an assigned item never claims)
  GRM-9   ready => project stateCategory is not completed/canceled
  GRM-10  ready => carries a stage/* label (where a dispatched session resumes)
  GRM-11  no completed/canceled project holds an open item
  GRM-12  every label is namespaced family/leaf (a bare tracker default fails)
  GRM-13  no item carries more than one agent/* label
  GRM-14  duplicateOf set => the item is terminal (a live duplicate is unresolved)
`;

/** True for a non-array, non-null object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a string with at least one character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** True for an array whose every element is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** A short, safe label for an item in failure details (its human key, or its index). */
function itemLabel(item: unknown, index: number): string {
  if (isPlainObject(item) && isNonEmptyString(item.identifier)) return item.identifier;
  return `item[${index}]`;
}

/** The item's labels as a string[], degrading a missing/wrong-typed value to []. */
function labelsOf(item: Record<string, unknown>): string[] {
  return isStringArray(item.labels) ? item.labels : [];
}

/** True when the item is in an open (non-terminal) state category. */
function isOpen(item: Record<string, unknown>): boolean {
  return (
    typeof item.stateCategory === 'string' && OPEN_STATE_CATEGORIES.includes(item.stateCategory)
  );
}

/** True when the item carries the literal agent/ready label. */
function isReady(item: Record<string, unknown>): boolean {
  return labelsOf(item).includes(AGENT_READY_LABEL);
}

/** The set of identifiers of items that are open within the snapshot. */
function buildOpenSet(items: readonly unknown[]): Set<string> {
  const open = new Set<string>();
  for (const item of items) {
    if (isPlainObject(item) && isNonEmptyString(item.identifier) && isOpen(item)) {
      open.add(item.identifier);
    }
  }
  return open;
}

/** One groom check: a callback from (items, opts) to breach detail strings. */
type Check = (items: readonly unknown[], opts: AuditOpts) => string[];

/**
 * Walk the OPEN items, collecting a breach detail per item the predicate flags.
 *
 * @param items - The snapshot items.
 * @param flag - Returns a breach detail for the item, or undefined to pass it.
 * @returns The collected breach details (empty = pass).
 */
function eachOpenItem(
  items: readonly unknown[],
  flag: (item: Record<string, unknown>, label: string) => string | undefined
): string[] {
  const details: string[] = [];
  items.forEach((item, index) => {
    if (!isPlainObject(item) || !isOpen(item)) return;
    const detail = flag(item, itemLabel(item, index));
    if (detail !== undefined) details.push(detail);
  });
  return details;
}

/** Like {@link eachOpenItem}, but only over open items that are READY. */
function eachReadyItem(
  items: readonly unknown[],
  flag: (item: Record<string, unknown>, label: string) => string | undefined
): string[] {
  return eachOpenItem(items, (item, label) => (isReady(item) ? flag(item, label) : undefined));
}

/** GRM-1 - every open item has exactly one type/* label. */
function checkGrm1(items: readonly unknown[]): string[] {
  return eachOpenItem(items, (item, label) => {
    const typeLabels = labelsOf(item).filter((lbl) => lbl.startsWith('type/'));
    if (typeLabels.length === 1) return undefined;
    return `${label} carries ${typeLabels.length} type/* labels (${typeLabels.join(', ') || 'none'}); exactly one is required - WorkItem.type derives from it`;
  });
}

/** GRM-2 - every open item has a project. */
function checkGrm2(items: readonly unknown[]): string[] {
  return eachOpenItem(items, (item, label) =>
    isPlainObject(item.project)
      ? undefined
      : `${label} has no project; a project is the programme home and feeds the projectStatus ranking tier`
  );
}

/** GRM-3 - every open item has a real priority (1-4; 0 or absent fails). */
function checkGrm3(items: readonly unknown[]): string[] {
  return eachOpenItem(items, (item, label) => {
    const p = item.priority;
    if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 4) return undefined;
    return `${label} has priority ${JSON.stringify(p)}; must be 1-4 - "none" (0) and absent both sort behind every concrete value in the ranking ladder`;
  });
}

/** GRM-4 - ready implies a size estimate is present. */
function checkGrm4(items: readonly unknown[]): string[] {
  return eachReadyItem(items, (item, label) => {
    const size = item.size;
    const hasSize =
      isNonEmptyString(size) || (typeof size === 'number' && Number.isFinite(size) && size >= 0);
    return hasSize
      ? undefined
      : `${label} is ready but has no size; a missing estimate sorts the item last in the size tier and disables sub-issue promotion`;
  });
}

/** GRM-5 - ready implies "## Validation criteria" in the description. */
function checkGrm5(items: readonly unknown[]): string[] {
  return eachReadyItem(items, (item, label) =>
    typeof item.description === 'string' && item.description.includes('## Validation criteria')
      ? undefined
      : `${label} is ready but its description lacks "## Validation criteria"; the engine reads this section`
  );
}

/** GRM-6 - ready implies "## On Completion" in the description. */
function checkGrm6(items: readonly unknown[]): string[] {
  return eachReadyItem(items, (item, label) =>
    typeof item.description === 'string' && item.description.includes('## On Completion')
      ? undefined
      : `${label} is ready but its description lacks "## On Completion"; the DONE stage reads it to route follow-ups`
  );
}

/** GRM-7 - ready implies no blockedBy entry that is itself open in the snapshot. */
function checkGrm7(items: readonly unknown[]): string[] {
  const open = buildOpenSet(items);
  return eachReadyItem(items, (item, label) => {
    const relations = isPlainObject(item.relations) ? item.relations : {};
    const blockedBy = isStringArray(relations.blockedBy) ? relations.blockedBy : [];
    const live = blockedBy.filter((ref) => open.has(ref));
    return live.length === 0
      ? undefined
      : `${label} is ready but blocked by open ${live.join(', ')}; the eligibility filter drops it, so the ready label is a lie`;
  });
}

/**
 * GRM-8 - ready implies unassigned, or assigned to the dispatch agent's own
 * identity. `claimAssignedToHuman` defaults false, so a ready item assigned to
 * anyone else can never be claimed.
 */
function checkGrm8(items: readonly unknown[], opts: AuditOpts): string[] {
  return eachReadyItem(items, (item, label) => {
    const assignee = item.assignee;
    if (assignee === undefined) return undefined;
    if (isNonEmptyString(assignee) && assignee === opts.agentIdentity) return undefined;
    return `${label} is ready but assigned to ${JSON.stringify(assignee)}; claimAssignedToHuman defaults false, so it can never be claimed`;
  });
}

/** GRM-9 - ready implies the item's project is not completed/canceled. */
function checkGrm9(items: readonly unknown[]): string[] {
  return eachReadyItem(items, (item, label) => {
    const project = isPlainObject(item.project) ? item.project : undefined;
    const category = project?.stateCategory;
    return typeof category === 'string' && DEAD_PROJECT_STATE_CATEGORIES.includes(category)
      ? `${label} is ready but sits in a ${category} project; eligibility rule 4 drops every item under a dead project`
      : undefined;
  });
}

/** GRM-10 - ready implies a stage/* label is present. */
function checkGrm10(items: readonly unknown[]): string[] {
  return eachReadyItem(items, (item, label) =>
    labelsOf(item).some((lbl) => lbl.startsWith('stage/'))
      ? undefined
      : `${label} is ready but carries no stage/* label; the stage label is where a dispatched session resumes`
  );
}

/** GRM-11 - no completed/canceled project holds an open item. */
function checkGrm11(items: readonly unknown[]): string[] {
  return eachOpenItem(items, (item, label) => {
    const project = isPlainObject(item.project) ? item.project : undefined;
    const category = project?.stateCategory;
    return typeof category === 'string' && DEAD_PROJECT_STATE_CATEGORIES.includes(category)
      ? `${label} is open inside ${category} project ${JSON.stringify(project?.name ?? project?.id)}; closing a project permanently hides its open items from dispatch`
      : undefined;
  });
}

/** GRM-12 - every label on an open item is namespaced family/leaf. */
function checkGrm12(items: readonly unknown[]): string[] {
  return eachOpenItem(items, (item, label) => {
    const bare = labelsOf(item).filter((lbl) => !/^[^/]+\/.+$/.test(lbl));
    return bare.length === 0
      ? undefined
      : `${label} carries bare label(s) ${bare.join(', ')}; tracker defaults like "Bug" are invisible to the engine and must be re-namespaced or removed`;
  });
}

/** GRM-13 - no item carries more than one agent/* label. */
function checkGrm13(items: readonly unknown[]): string[] {
  return eachOpenItem(items, (item, label) => {
    const agentLabels = labelsOf(item).filter((lbl) => lbl.startsWith('agent/'));
    return agentLabels.length <= 1
      ? undefined
      : `${label} carries ${agentLabels.length} agent/* labels (${agentLabels.join(', ')}); the durable agent state machine is single-valued`;
  });
}

/**
 * GRM-14 - duplicateOf set implies the item is terminal. A LIVE item still
 * pointing at its duplicate target is an unresolved merge: it double-counts in
 * every backlog view and can be dispatched alongside its twin. This is the one
 * invariant asserted over non-open items too (a terminal duplicate passes; the
 * check exists to catch the live ones, wherever they sit).
 */
function checkGrm14(items: readonly unknown[]): string[] {
  const details: string[] = [];
  items.forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const relations = isPlainObject(item.relations) ? item.relations : {};
    if (!isNonEmptyString(relations.duplicateOf)) return;
    if (
      typeof item.stateCategory === 'string' &&
      TERMINAL_STATE_CATEGORIES.includes(item.stateCategory)
    )
      return;
    details.push(
      `${itemLabel(item, index)} has duplicateOf ${relations.duplicateOf} but is not terminal (stateCategory ${JSON.stringify(item.stateCategory)}); cancel the duplicate or drop the relation`
    );
  });
  return details;
}

/**
 * Run all fourteen groom checks over the snapshot and assemble the verdict.
 * One failures[] entry per breached invariant (details aggregated).
 *
 * @param items - The snapshot's normalized WorkItems.
 * @param opts - Snapshot options (the dispatch agent's identity for GRM-8).
 * @returns The groom verdict.
 */
function audit(items: readonly unknown[], opts: AuditOpts = {}): Verdict {
  const checks: Array<[string, Check]> = [
    ['GRM-1', checkGrm1],
    ['GRM-2', checkGrm2],
    ['GRM-3', checkGrm3],
    ['GRM-4', checkGrm4],
    ['GRM-5', checkGrm5],
    ['GRM-6', checkGrm6],
    ['GRM-7', checkGrm7],
    ['GRM-8', checkGrm8],
    ['GRM-9', checkGrm9],
    ['GRM-10', checkGrm10],
    ['GRM-11', checkGrm11],
    ['GRM-12', checkGrm12],
    ['GRM-13', checkGrm13],
    ['GRM-14', checkGrm14],
  ];
  const failures: Failure[] = [];
  for (const [invariant, check] of checks) {
    const details = check(items, opts);
    if (details.length > 0) failures.push({ invariant, detail: details.join('; ') });
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Parse argv into `{ help, fixturePath }`. Accepts `--fixture <path>` and
 * `--fixture=<path>`.
 *
 * @param argv - Args after the node + script entries (`process.argv.slice(2)`).
 * @returns The parsed help flag and optional fixture path.
 */
function parseArgs(argv: readonly string[]): HarnessArgs {
  const out: HarnessArgs = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--fixture') {
      out.fixturePath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--fixture=')) {
      out.fixturePath = arg.slice('--fixture='.length);
    }
  }
  return out;
}

/**
 * Read the raw fixture text from the given path, or from stdin (fd 0) when absent.
 *
 * @param fixturePath - The `--fixture` path, or `undefined` to read stdin.
 * @returns The raw fixture text.
 */
function readRawInput(fixturePath?: string): string {
  return readFileSync(fixturePath ?? 0, 'utf8');
}

/**
 * Coerce a parsed snapshot (array, or `{ items, opts? }`) into items + opts,
 * or throw.
 *
 * @param parsed - The parsed-JSON snapshot value.
 * @returns The extracted items and options.
 */
function extractSnapshot(parsed: unknown): { items: unknown[]; opts: AuditOpts } {
  if (Array.isArray(parsed)) return { items: parsed, opts: {} };
  if (isPlainObject(parsed) && Array.isArray(parsed.items)) {
    const opts: AuditOpts = {};
    if (isPlainObject(parsed.opts) && isNonEmptyString(parsed.opts.agentIdentity)) {
      opts.agentIdentity = parsed.opts.agentIdentity;
    }
    return { items: parsed.items, opts };
  }
  throw new Error(
    'snapshot must be a JSON array of WorkItems, or an object { "items": [...], "opts"?: {...} }'
  );
}

/**
 * Whether this module is the process entry point (not imported by a test).
 *
 * @param metaUrl - The entry module's `import.meta.url`.
 * @returns `true` when this module is the process entry point.
 */
function invokedDirectly(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

/**
 * CLI entry. Returns the process exit code; writes the verdict to stdout.
 *
 * @param argv - Process args after node + script (`process.argv.slice(2)`).
 * @returns The exit code: 0 pass, 1 invariant failure, 2 invalid input.
 */
function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readRawInput(args.fixturePath));
  } catch (err) {
    const detail = `invalid input - could not read or parse the snapshot: ${(err as Error).message}`;
    process.stderr.write(`audit-backlog: ${detail}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, failures: [{ invariant: 'INPUT', detail }] }, null, 2)}\n`
    );
    return 2;
  }

  let snapshot: { items: unknown[]; opts: AuditOpts };
  try {
    snapshot = extractSnapshot(parsed);
  } catch (err) {
    const detail = `invalid input - ${(err as Error).message}`;
    process.stderr.write(`audit-backlog: ${detail}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, failures: [{ invariant: 'INPUT', detail }] }, null, 2)}\n`
    );
    return 2;
  }

  const verdict = audit(snapshot.items, snapshot.opts);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (!verdict.ok) {
    process.stderr.write(
      `audit-backlog: ${verdict.failures.length} invariant(s) failed: ${verdict.failures
        .map((f) => f.invariant)
        .join(', ')}\n`
    );
  }
  return verdict.ok ? 0 : 1;
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { main, audit };
