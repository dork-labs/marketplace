/**
 * `flow retro [--since <duration>] [--json] [--file] [--input <proposals.json>]`
 * (spec `flow-self-improvement` §3, DOR-2392): look back over a window of
 * flow's own runs, report the measures, and propose changes to flow.
 *
 * Reads the journal (this window and the one before), the self-test history,
 * one backlog snapshot (`--snapshot`, else the tracker; a tracker it cannot
 * reach leaves the backlog measure at "no data") and the prose word counts.
 * The measures and rules are `scripts/retro.ts`.
 *
 * Read-only unless `--file`. Every run writes `.dork/flow/retro/<date>.json`
 * (the report and its proposals) and `.md` in the project's main checkout, and
 * one `retro` journal line. `--file` files the proposals (or the edited copy
 * `--input` names) through the same filing module as `flow selftest --file`
 * (`selftest/file.ts`), with the marker `<!-- flow-retro:fp=<fingerprint> -->`
 * and at most `selfImprovement.retro.maxItemsPerRun` new items.
 *
 * Exit codes: 0 the report was written (and, with `--file`, everything was
 * filed) · 1 `--file` could not file everything (no create capability, or the
 * tracker failed) · 2 a bad `--since` or `--input`.
 *
 * @module @dorkos/flow/cli/retro
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { flowVersion } from '../_shared.ts';
import { findConfigRoots } from '../config-files.ts';
import { UsageError } from '../errors.ts';
import { ensureIgnored } from '../git-exclude.ts';
import { append, journalFor, read, runtimeOf } from '../journal.ts';
import {
  NO_DATA,
  RUNTIME_KEYS,
  parseProposals,
  runRetro,
  splitWindows,
  windowFor,
  type HistoryEntry,
  type JournalMeasure,
  type GlobalMeasure,
  type Measures,
  type PluginWords,
  type Proposal,
  type ReadyVsUntriaged,
  type RetroResult,
  type RetroWindow,
  type UsageTrend,
  type Value,
} from '../retro.ts';
import { loadCorpus, loadLintConfig, wordSummary } from '../selftest/doc-lint.ts';
import {
  emptyFiling,
  fileFindings,
  filingSetup,
  renderFiling,
  type FilingResult,
  type Finding,
} from '../selftest/file.ts';
import { SELFTEST_DIR } from '../selftest.ts';
import type { WorkItem } from '../work-item.ts';
import { loadProjectConfig, readBacklog } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** Where a project keeps retro reports, relative to its main checkout. */
export const RETRO_DIR = path.join('.dork', 'flow', 'retro');

/** A retro report, as `--json` prints it and `<date>.json` stores it. */
export interface RetroReport extends RetroResult {
  /** Report format version. */
  v: 1;
  /** When the retro ran (ISO). */
  generatedAt: string;
  /** The flow version that ran it. */
  flowVersion: string;
  /** The window. */
  window: RetroWindow;
  /** What was read. */
  inputs: {
    journalLines: number;
    prevJournalLines: number;
    skippedLines: number;
    selftestRuns: number;
    snapshot: 'tracker' | 'file' | 'none';
  };
  /** What `--file` did, when asked. */
  filing?: FilingResult;
}

/** Read `history.jsonl`, skipping lines that are not history entries. */
function readHistory(file: string): HistoryEntry[] {
  if (!existsSync(file)) return [];
  const out: HistoryEntry[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const value = JSON.parse(raw) as HistoryEntry;
      if (typeof value.startedAt === 'string' && Array.isArray(value.checks)) out.push(value);
    } catch {
      // A torn or foreign line: skip it.
    }
  }
  return out;
}

/** The newest earlier report's backlog and word measures, if there is one. */
function previousReport(
  dir: string,
  today: string
): { readyVsUntriaged?: Value<ReadyVsUntriaged>; pluginWords?: Value<PluginWords> } | undefined {
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name < `${today}.json`)
    .sort();
  const newest = names[names.length - 1];
  if (newest === undefined) return undefined;
  try {
    const report = JSON.parse(readFileSync(path.join(dir, newest), 'utf8')) as RetroReport;
    return {
      readyVsUntriaged: report.measures?.readyVsUntriaged?.now,
      pluginWords: report.measures?.pluginWords?.now,
    };
  } catch {
    return undefined;
  }
}

/** A proposal as a finding for the filing module. */
export function proposalFinding(proposal: Proposal, flowVersionText: string): Finding {
  const evidenceAt = proposal.evidence.map((e) => e.ts).sort()[proposal.evidence.length - 1];
  return {
    subject: proposal.title,
    fingerprint: proposal.fingerprint,
    title: `flow retro: ${proposal.title} (${proposal.fingerprint})`,
    text: [
      proposal.proposal,
      '',
      `Evidence (${proposal.rule}, flow ${flowVersionText}):`,
      ...proposal.evidence.map((e) => `- ${e.ts}: ${e.text}`),
    ].join('\n'),
    evidenceAt,
    weight: proposal.evidence.length,
  };
}

/** One value as report text. */
function show(value: Value<unknown>): string {
  if (value === NO_DATA) return NO_DATA;
  if (typeof value === 'number') return String(value);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return 'none';
    return entries.map(([key, inner]) => `${key} ${String(inner)}`).join(', ');
  }
  return String(value);
}

/** The measures table, in Markdown. */
function measuresTable(measures: Measures): string[] {
  const head = ['Measure', 'This window', 'Previous', ...RUNTIME_KEYS];
  const rows: string[][] = [];
  for (const [name, measure] of Object.entries(measures) as [
    string,
    JournalMeasure<unknown> | GlobalMeasure<unknown>,
  ][]) {
    const split =
      measure.byRuntime === null
        ? RUNTIME_KEYS.map(() => 'n/a')
        : RUNTIME_KEYS.map((key) =>
            show((measure.byRuntime as JournalMeasure<unknown>['byRuntime'])[key].now)
          );
    rows.push([name, show(measure.now), show(measure.prev), ...split]);
  }
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

/** The usage trend table, in Markdown. */
function usageTable(trend: UsageTrend): string[] {
  const rows: string[] = [];
  for (const [account, windows] of Object.entries(trend)) {
    for (const [name, pair] of Object.entries(windows)) {
      const cell = (v: typeof pair.now) =>
        v === NO_DATA
          ? NO_DATA
          : `${v.first}% -> ${v.last}% (peak ${v.peak}%, ran out ${v.hitLimit}x)`;
      rows.push(`| ${account} | ${name} | ${cell(pair.now)} | ${cell(pair.prev)} |`);
    }
  }
  if (rows.length === 0) return ['No usage readings in either window.'];
  return ['| Account | Window | This window | Previous |', '| --- | --- | --- | --- |', ...rows];
}

/**
 * Render a report as Markdown: the measures, usage, proposals, filing, caveats.
 *
 * @param report - The report.
 * @returns The text, ending in a newline.
 */
export function renderRetro(report: RetroReport): string {
  const { window } = report;
  const lines = [
    `# flow retro, ${window.since.slice(0, 10)} to ${window.until.slice(0, 10)} (${window.label})`,
    '',
    `flow ${report.flowVersion}. ${report.inputs.journalLines} journal lines this window, ${report.inputs.prevJournalLines} the window before; ${report.inputs.selftestRuns} self-test runs on record.`,
    '',
    '## Measures',
    '',
    ...measuresTable(report.measures),
    '',
    '## Usage',
    '',
    ...usageTable(report.usageTrend),
    '',
    '## Proposals',
    '',
  ];
  if (report.proposals.length === 0) lines.push('None this window.');
  for (const p of report.proposals) {
    lines.push(
      `### ${p.title}`,
      '',
      p.proposal,
      '',
      `Rule \`${p.rule}\`, fingerprint \`${p.fingerprint}\`:`
    );
    for (const e of p.evidence) lines.push(`- ${e.ts}: ${e.text}`);
    lines.push('');
  }
  if (report.filing !== undefined) lines.push(...renderFiling(report.filing).slice(1), '');
  lines.push('## What this cannot see', '', ...report.caveats.map((c) => `- ${c}`));
  return `${lines.join('\n')}\n`;
}

/**
 * Run `flow retro`.
 *
 * @param ctx - The verb's context.
 * @returns The report; exit 1 when `--file` could not file everything.
 * @throws {UsageError} On a bad `--since` or `--input`.
 * @throws {ConfigError} When flow is not configured here.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const { flags } = ctx.args;
  const project = loadProjectConfig(ctx);
  const settings = project.loaded.config.selfImprovement.retro;
  const label = typeof flags.since === 'string' ? flags.since : settings.window;
  const now = ctx.now();
  const window = windowFor(label, now);
  if (window === null) {
    throw new UsageError(
      `--since ${label} is not a duration: use a count and h, d or w (for example 7d)`
    );
  }
  const fileFlag = flags.file === true;
  let edited: Proposal[] | undefined;
  if (typeof flags.input === 'string') {
    if (!fileFlag) throw new UsageError('--input names proposals to file, so it needs --file');
    const file = path.resolve(ctx.cwd, flags.input);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new UsageError(`could not read --input ${file}: ${(error as Error).message}`);
    }
    const proposals = parseProposals(parsed);
    if (typeof proposals === 'string') throw new UsageError(`--input ${file}: ${proposals}`);
    edited = proposals;
  }

  const journal = journalFor(ctx.projectDir, ctx.flowRoot);
  const lines =
    'refusal' in journal
      ? { lines: [], skipped: 0 }
      : read(journal.settings, new Date(window.prevSince));
  const { journal: current, prevJournal } = splitWindows(lines.lines, window);

  const roots = findConfigRoots(ctx.projectDir, ctx.flowRoot);
  const checkout = roots.mainCheckout ?? roots.checkout;
  const history = readHistory(path.join(checkout, SELFTEST_DIR, 'history.jsonl'));

  let snapshot: WorkItem[] | null = null;
  let snapshotSource: RetroReport['inputs']['snapshot'] = 'none';
  try {
    snapshot = (await readBacklog(ctx, project.adapter)).items;
    snapshotSource = ctx.snapshotPath === undefined ? 'tracker' : 'file';
  } catch (error) {
    if (ctx.snapshotPath !== undefined) throw error;
    ctx.warn(
      `no backlog snapshot, so the backlog measure has no data: ${(error as Error).message}`
    );
  }
  project.flushWarnings();

  const dir = path.join(checkout, RETRO_DIR);
  const today = window.until.slice(0, 10);
  const lint = loadLintConfig(ctx.flowRoot);
  const words = wordSummary(loadCorpus(ctx.flowRoot), lint.budgets);
  const version = flowVersion(ctx.flowRoot);
  const result = runRetro({
    window,
    journal: current,
    prevJournal,
    selftestHistory: history,
    snapshot,
    words,
    previous: previousReport(dir, today),
  });
  const report: RetroReport = {
    v: 1,
    generatedAt: now.toISOString(),
    flowVersion: version,
    window,
    inputs: {
      journalLines: current.length,
      prevJournalLines: prevJournal.length,
      skippedLines: lines.skipped,
      selftestRuns: history.length,
      snapshot: snapshotSource,
    },
    ...result,
    ...(edited === undefined ? {} : { proposals: edited }),
  };

  if (fileFlag) {
    const findings = report.proposals.map((p) => proposalFinding(p, version));
    try {
      const { retro, deps } = await filingSetup({
        projectDir: ctx.projectDir,
        flowRoot: ctx.flowRoot,
        env: ctx.env,
        sessionId: ctx.sessionId,
        adapter: () => ctx.adapter(),
      });
      report.filing = await fileFindings(
        findings,
        {
          now,
          marker: 'flow-retro',
          labels: retro.labels,
          project: retro.project,
          maxNew: retro.maxItemsPerRun,
        },
        deps
      );
    } catch (error) {
      report.filing = emptyFiling((error as Error).message);
    }
  }

  const text = renderRetro(report);
  try {
    mkdirSync(dir, { recursive: true });
    ensureIgnored(checkout, path.join(RETRO_DIR, `${today}.json`), '.dork/flow/');
    writeFileSync(path.join(dir, `${today}.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(dir, `${today}.md`), text);
  } catch (error) {
    ctx.warn(`could not save the retro report: ${(error as Error).message}`);
  }
  if (!('refusal' in journal)) {
    append(
      journal.settings,
      {
        kind: 'retro',
        window: window.label,
        proposals: report.proposals.length,
        filed: report.filing?.filed.length ?? 0,
        commented: report.filing?.commented.filter((c) => c.posted).length ?? 0,
      },
      { now, flowVersion: version, session: ctx.sessionId, ...runtimeOf(ctx.env), warn: ctx.warn }
    );
  }

  const incomplete =
    report.filing !== undefined &&
    (report.filing.error !== undefined || report.filing.wouldFile.length > 0);
  return {
    ...(incomplete ? { exitCode: 1 as const } : {}),
    json: report as unknown as Record<string, unknown>,
    text,
  };
}
