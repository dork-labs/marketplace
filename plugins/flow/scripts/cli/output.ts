/**
 * Output for the `flow` CLI (spec `flow-cli-core` §2): results, errors,
 * warnings and help, in human text or `--json`.
 *
 * - Human text is plain, aligned and uncolored.
 * - Under `--json`, stdout carries exactly one JSON value, `v: 1` included,
 *   also on failure: `{ "v": 1, "ok": false, "error": { "code", "message" } }`.
 * - Diagnostics (warnings, and errors in human mode) go to stderr in both modes.
 *
 * Dependency-free: only other zero-dependency local modules.
 *
 * @module @dorkos/flow/cli/output
 */

import { flagsFor, type FlagSpec, type VerbSpec } from './args.ts';
import type { TextSink, VerbResult } from './context.ts';

/** The one JSON version every `flow --json` payload carries. */
export const JSON_VERSION = 1;

/**
 * Align rows of cells into columns two spaces apart. Trailing cells are not
 * padded, so no line ends in spaces.
 *
 * @param rows - Rows of cells; rows may have different lengths.
 * @returns The rows joined by newlines, with no trailing newline.
 */
export function formatColumns(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')
    )
    .join('\n');
}

/** Writes results, errors, warnings and help in one output mode. */
export class Output {
  private readonly json: boolean;
  private readonly stdout: TextSink;
  private readonly stderr: TextSink;

  // Plain fields, not parameter properties: `--experimental-strip-types` cannot
  // run TypeScript syntax that needs a transform.
  /**
   * @param json - Whether `--json` was given.
   * @param stdout - Where results go.
   * @param stderr - Where diagnostics go.
   */
  constructor(json: boolean, stdout: TextSink, stderr: TextSink) {
    this.json = json;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  /**
   * Print a verb's result: its JSON with `v: 1`, or its text.
   *
   * @param result - What the verb returned.
   */
  result(result: VerbResult): void {
    if (this.json) {
      this.writeJson({ ...result.json, v: JSON_VERSION });
    } else if (result.text !== '') {
      this.stdout.write(ensureNewline(result.text));
    }
  }

  /**
   * Print a failure: the message on stderr, plus the JSON envelope on stdout
   * under `--json`.
   *
   * @param code - The exit code the run ends with.
   * @param message - A plain sentence naming the problem and the fix.
   */
  error(code: number, message: string): void {
    this.stderr.write(`flow: ${message}\n`);
    if (this.json) this.writeJson({ v: JSON_VERSION, ok: false, error: { code, message } });
  }

  /**
   * Print a warning to stderr.
   *
   * @param message - The warning.
   */
  warn(message: string): void {
    this.stderr.write(`flow: warning: ${message}\n`);
  }

  /**
   * Print help text on stdout, wrapped as `{ v, ok, verb?, usage }` under `--json`.
   *
   * @param usage - The rendered help.
   * @param verb - The verb the help is for, when it is per-verb help.
   */
  help(usage: string, verb?: string): void {
    if (this.json) {
      this.writeJson({ v: JSON_VERSION, ok: true, ...(verb ? { verb } : {}), usage });
    } else {
      this.stdout.write(ensureNewline(usage));
    }
  }

  private writeJson(value: Record<string, unknown>): void {
    // Put `v` first so a person reading the payload sees the version up front.
    const { v, ...rest } = value;
    this.stdout.write(`${JSON.stringify({ v, ...rest })}\n`);
  }
}

function ensureNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** One help row for a flag: `-n, --limit <N>` and its description. */
function flagRow(flag: FlagSpec): string[] {
  const long = `--${flag.name}${flag.kind === 'string' ? ` <${flag.value ?? 'value'}>` : ''}`;
  return [`  ${flag.short ? `-${flag.short}, ` : '    '}${long}`, flag.description];
}

/**
 * Render `flow --help`: the usage line, the verb list (omitted when no verb is
 * registered) and the flags every verb takes.
 *
 * @param verbs - The registered verbs, in table order.
 * @returns The help text.
 */
export function renderTopHelp(verbs: readonly VerbSpec[]): string {
  const sections = ['Usage: flow <verb> [args] [flags]'];
  if (verbs.length > 0) {
    sections.push(`Verbs:\n${formatColumns(verbs.map((v) => [`  ${v.name}`, v.summary]))}`);
  }
  sections.push(
    `Flags for every verb:\n${formatColumns(flagsFor({ name: '', summary: '' }).map(flagRow))}`
  );
  sections.push('Run "flow <verb> --help" for one verb\'s arguments and flags.');
  return sections.join('\n\n');
}

/**
 * Render `flow <verb> --help`: the usage line, the description, the arguments
 * and every flag the verb takes.
 *
 * @param spec - The verb.
 * @returns The help text.
 */
export function renderVerbHelp(spec: VerbSpec): string {
  const positionals = spec.positionals ?? [];
  const synopsis = positionals.map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`));
  const sections = [
    ['Usage: flow', spec.name, ...synopsis, '[flags]'].join(' '),
    spec.description ?? spec.summary,
  ];
  if (positionals.length > 0) {
    sections.push(
      `Arguments:\n${formatColumns(positionals.map((p) => (p.description ? [`  <${p.name}>`, p.description] : [`  <${p.name}>`])))}`
    );
  }
  sections.push(`Flags:\n${formatColumns(flagsFor(spec).map(flagRow))}`);
  return sections.join('\n\n');
}
