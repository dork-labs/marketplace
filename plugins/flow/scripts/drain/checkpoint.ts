/**
 * `HANDOFF.md` checkpoints (spec `flow-handoff-dispatch` §1): what a session
 * leaves behind so the next one, on this account or another, can pick up the
 * work without the old transcript.
 *
 * A checkpoint is `<worktree>/.dork/flow/HANDOFF.md`:
 *
 * - Line 1 is the header, one HTML comment holding JSON:
 *   `<!-- flow:handoff {...} -->`. Every field is measured (git, the run
 *   record, the flags), never written by the agent, so it cannot drift from the
 *   worktree.
 * - Then `# Handoff: <identifier> <title>`, written by the CLI.
 * - Then the agent's body: exactly four `##` sections, `Done`, `Next`,
 *   `Open questions`, `Next command`, checked by {@link checkBody}.
 *
 * The previous copy is kept as `HANDOFF.prev.md`. Neither file is ever
 * committed: {@link ensureCheckpointExcludes} adds their patterns to the
 * repository's `info/exclude`, which covers every worktree.
 *
 * Everything here except the two file helpers is pure. Dependency-free (node
 * builtins and zero-dependency local modules), so it runs before `npm install`.
 *
 * @module @dorkos/flow/drain/checkpoint
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FlowStage } from '../flow-run.ts';
import { addExcludeLines } from '../git-exclude.ts';

/** The checkpoint's file name, inside `<worktree>/.dork/flow/`. */
export const CHECKPOINT_FILE = 'HANDOFF.md';

/** The previous checkpoint, kept beside the current one. */
export const PREVIOUS_CHECKPOINT_FILE = 'HANDOFF.prev.md';

/** The folder, relative to the worktree, that holds the checkpoint. */
export const CHECKPOINT_DIR = path.join('.dork', 'flow');

/** The worker brief a synthesized checkpoint points a fresh session at (worktree-relative). */
export const WORKER_BRIEF_PATH = '.dork/flow/drain/briefs/worker.md';

/** The `info/exclude` lines that keep checkpoints and drain files out of git. */
export const CHECKPOINT_EXCLUDE_LINES = ['/.dork/flow/HANDOFF*.md', '/.dork/flow/drain/'] as const;

/** The largest checkpoint file, in bytes: a checkpoint points at the work, it does not copy it. */
export const MAX_CHECKPOINT_BYTES = 16 * 1024;

/** How many commits a synthesized checkpoint lists. */
export const MAX_SYNTHESIZED_COMMITS = 20;

/**
 * Why a checkpoint was written. `fix` is a push answering review findings or
 * red CI; `synthesized` is one flow wrote for a session that stopped without one.
 */
export const CHECKPOINT_TRIGGERS = [
  'stage',
  'task',
  'fix',
  'limit-warning',
  'limit-rejected',
  'manual',
  'synthesized',
] as const;

/** One of {@link CHECKPOINT_TRIGGERS}. */
export type CheckpointTrigger = (typeof CHECKPOINT_TRIGGERS)[number];

/** The four body sections, in the order they must appear. */
export const CHECKPOINT_SECTIONS = ['Done', 'Next', 'Open questions', 'Next command'] as const;

/** The measured header on line 1 of a checkpoint. */
export interface CheckpointHeader {
  /** Header version, `1` today. A reader reads the known fields of a higher one. */
  v: number;
  /** The work item. */
  identifier: string;
  /** Where the next session resumes. */
  stage: FlowStage;
  /** Why it was written. */
  trigger: CheckpointTrigger;
  /** When (ISO UTC). */
  writtenAt: string;
  /** The session that wrote it, when known. */
  sessionId: string | null;
  /** The registry id of the account the session billed, when known. */
  account: string | null;
  /** The launcher the session ran under, when known. */
  host: string | null;
  /** `git rev-parse --abbrev-ref HEAD`. */
  branch: string;
  /** `git rev-parse HEAD`. */
  headSha: string;
  /** The branch's SHA on `origin`, or `null` when it is not there. */
  pushedSha: string | null;
  /** Whether `git status --porcelain` showed anything (excluded files do not count). */
  dirty: boolean;
  /** The spec, repo-relative, when given. */
  spec: string | null;
  /** The task id, when given (always, for a `task` trigger). */
  task: string | null;
  /** The run's PR address, when a drain opened one. */
  pr: string | null;
  /** The run's review round, when it is in a drain. */
  reviewRound: number | null;
}

/** The body's four sections, each trimmed. */
export interface CheckpointSections {
  /** What this session finished. */
  done: string;
  /** What the next session does first. */
  next: string;
  /** What is unresolved, or `None.`. */
  openQuestions: string;
  /** One fenced code block: the command the next session runs first. */
  nextCommand: string;
}

/** Which body rule a refusal broke. */
export type CheckpointRule =
  'title' | 'sections' | 'empty-section' | 'next-command' | 'unclosed-fence' | 'size';

/** A refused body or file: the rule and a sentence that names it. */
export interface CheckpointRefusal {
  /** Refused. */
  ok: false;
  /** The rule broken. */
  rule: CheckpointRule;
  /** A plain sentence naming the rule and the fix. */
  message: string;
}

/** The outcome of {@link checkBody}. */
export type BodyCheck = { ok: true; sections: CheckpointSections } | CheckpointRefusal;

/** A checkpoint read by {@link parseCheckpoint}. */
export interface ParsedCheckpoint {
  /** Read. */
  ok: true;
  /** The known header fields. */
  header: CheckpointHeader;
  /** The title after the identifier, or `null` when the line holds the identifier alone. */
  title: string | null;
  /** The body sections. */
  sections: CheckpointSections;
}

/** Why {@link parseCheckpoint} could not read a checkpoint. */
export interface CheckpointParseError {
  /** Not read. */
  ok: false;
  /** Which part is wrong: the header line, the title line, or the body. */
  code: 'header' | 'title' | 'body';
  /** A plain sentence saying what is wrong. */
  message: string;
}

const HEADER_PATTERN = /^<!-- flow:handoff (.*) -->$/;
const TITLE_PATTERN = /^# Handoff: (\S+)(?: (.+))?$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

function refuse(rule: CheckpointRule, message: string): CheckpointRefusal {
  return { ok: false, rule, message };
}

/** Whether `line` closes a fenced block opened with the marker `open`. */
function closesFence(line: string, open: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= open.length && trimmed === open[0].repeat(trimmed.length);
}

/**
 * Check a checkpoint body against the §1 rules and split it into its sections.
 *
 * - No `#` title of its own (the CLI writes the title).
 * - Exactly four `##` sections, in order: Done, Next, Open questions, Next
 *   command, with nothing before the first.
 * - Each section non-empty (`Open questions` may say `None.`).
 * - `Next command` holds exactly one fenced code block with a non-blank line.
 *
 * Headings inside fenced code blocks are code, not headings.
 *
 * @param body - The agent's body text.
 * @returns The sections, or the first rule the body breaks.
 */
export function checkBody(body: string): BodyCheck {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const found: { title: string; lines: string[] }[] = [];
  let preamble = false;
  let fence: string | null = null;

  for (const line of lines) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      found.at(-1)?.lines.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1];
      if (found.length === 0) preamble = true;
      found.at(-1)?.lines.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading && heading[1].length === 1) {
      return refuse(
        'title',
        'the body has its own # title; remove it, flow writes the "# Handoff:" line itself'
      );
    }
    if (heading && heading[1].length === 2) {
      found.push({ title: (heading[2] ?? '').replace(/[ \t]+#+$/, '').trim(), lines: [] });
      continue;
    }
    if (found.length === 0) {
      if (line.trim() !== '') preamble = true;
      continue;
    }
    found[found.length - 1].lines.push(line);
  }

  if (fence !== null) {
    return refuse(
      'unclosed-fence',
      'a code block in the body is never closed; close it with ' + fence
    );
  }
  const titles = found.map((section) => section.title);
  const expected = CHECKPOINT_SECTIONS.join(', ');
  if (titles.length !== CHECKPOINT_SECTIONS.length) {
    return refuse(
      'sections',
      `the body needs exactly four ## sections, in order: ${expected} (found ${titles.length}: ${titles.join(', ') || 'none'})`
    );
  }
  if (titles.some((title, i) => title !== CHECKPOINT_SECTIONS[i])) {
    return refuse(
      'sections',
      `the body's ## sections must be, in order: ${expected} (found: ${titles.join(', ')})`
    );
  }
  if (preamble) {
    return refuse('sections', 'the body has text before "## Done"; start it with the Done section');
  }

  const [done, next, openQuestions, nextCommand] = found.map((section) =>
    section.lines.join('\n').trim()
  );
  for (const [i, text] of [done, next, openQuestions, nextCommand].entries()) {
    if (text === '') {
      const hint = i === 2 ? ' (write "None." when there are none)' : '';
      return refuse('empty-section', `the "${CHECKPOINT_SECTIONS[i]}" section is empty${hint}`);
    }
  }

  const blocks = fencedBlocks(nextCommand);
  if (blocks.length !== 1) {
    return refuse(
      'next-command',
      `"Next command" must hold exactly one fenced code block (found ${blocks.length})`
    );
  }
  if (!blocks[0].some((line) => line.trim() !== '')) {
    return refuse(
      'next-command',
      `the code block under "Next command" needs at least one non-blank line: the command to run first`
    );
  }
  return { ok: true, sections: { done, next, openQuestions, nextCommand } };
}

/** The inner lines of each fenced code block in `text`. */
function fencedBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      else blocks[blocks.length - 1].push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1];
      blocks.push([]);
    }
  }
  return blocks;
}

/**
 * Render sections as a body in the §1 shape.
 *
 * @param sections - The four sections.
 * @returns The body text, with no trailing newline.
 */
export function renderBody(sections: CheckpointSections): string {
  const texts = [sections.done, sections.next, sections.openQuestions, sections.nextCommand];
  return CHECKPOINT_SECTIONS.map((title, i) => `## ${title}\n\n${texts[i]}`).join('\n\n');
}

/**
 * The header line. Angle brackets inside values are written as JSON escapes,
 * so no value can close the HTML comment early.
 */
function renderHeader(header: CheckpointHeader): string {
  const ordered: CheckpointHeader = {
    v: header.v,
    identifier: header.identifier,
    stage: header.stage,
    trigger: header.trigger,
    writtenAt: header.writtenAt,
    sessionId: header.sessionId,
    account: header.account,
    host: header.host,
    branch: header.branch,
    headSha: header.headSha,
    pushedSha: header.pushedSha,
    dirty: header.dirty,
    spec: header.spec,
    task: header.task,
    pr: header.pr,
    reviewRound: header.reviewRound,
  };
  const json = JSON.stringify(ordered).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<!-- flow:handoff ${json} -->`;
}

/**
 * Build the whole checkpoint file: header, title line, body. Refuses a body
 * that breaks a rule of {@link checkBody}, and a file over
 * {@link MAX_CHECKPOINT_BYTES}.
 *
 * @param header - The measured header.
 * @param title - The item's title, or `null` to write the identifier alone.
 * @param body - The agent's body.
 * @returns The file text, or the rule broken.
 */
export function renderCheckpoint(
  header: CheckpointHeader,
  title: string | null,
  body: string
): { ok: true; text: string } | CheckpointRefusal {
  const checked = checkBody(body);
  if (!checked.ok) return checked;
  const cleanTitle = title?.replace(/\s+/g, ' ').trim();
  const titleLine = `# Handoff: ${header.identifier}${cleanTitle ? ` ${cleanTitle}` : ''}`;
  const text = `${renderHeader(header)}\n\n${titleLine}\n\n${body.replace(/\r\n?/g, '\n').trim()}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_CHECKPOINT_BYTES) {
    return refuse(
      'size',
      `the checkpoint is ${bytes} bytes, over the 16 KB limit; point at the work (files, commits, the spec) instead of copying it`
    );
  }
  return { ok: true, text };
}

/** A header field that must be a string. */
function requiredString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A nullable header field: missing reads as `null`; a wrong type is an error (`undefined`). */
function nullable<T>(
  raw: Record<string, unknown>,
  key: string,
  type: 'string' | 'number'
): T | null | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  return typeof value === type ? (value as T) : undefined;
}

/** Read the known header fields, or say which one is wrong. */
function readHeader(json: string): CheckpointHeader | string {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return 'the header is not JSON';
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'the header is not a JSON object';
  }
  const record = raw as Record<string, unknown>;
  const v = record.v;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return 'the header has no valid "v"';

  const strings = ['identifier', 'stage', 'trigger', 'writtenAt', 'branch', 'headSha'] as const;
  const read: Partial<Record<(typeof strings)[number], string>> = {};
  for (const key of strings) {
    const value = requiredString(record, key);
    if (value === undefined) return `the header field "${key}" is missing or not a string`;
    read[key] = value;
  }
  if (v === 1 && !(CHECKPOINT_TRIGGERS as readonly string[]).includes(read.trigger as string)) {
    return `the header trigger "${read.trigger}" is not one flow writes`;
  }
  if (typeof record.dirty !== 'boolean')
    return 'the header field "dirty" is missing or not a boolean';

  const optional: Record<string, string | number | null> = {};
  for (const key of ['sessionId', 'account', 'host', 'pushedSha', 'spec', 'task', 'pr'] as const) {
    const value = nullable<string>(record, key, 'string');
    if (value === undefined) return `the header field "${key}" is not a string or null`;
    optional[key] = value;
  }
  const reviewRound = nullable<number>(record, 'reviewRound', 'number');
  if (reviewRound === undefined) return 'the header field "reviewRound" is not a number or null';

  return {
    v,
    identifier: read.identifier as string,
    // A newer header may carry a stage or trigger this version does not know;
    // it is passed through as read, and the caller decides what to do with it.
    stage: read.stage as FlowStage,
    trigger: read.trigger as CheckpointTrigger,
    writtenAt: read.writtenAt as string,
    sessionId: optional.sessionId as string | null,
    account: optional.account as string | null,
    host: optional.host as string | null,
    branch: read.branch as string,
    headSha: read.headSha as string,
    pushedSha: optional.pushedSha as string | null,
    dirty: record.dirty,
    spec: optional.spec as string | null,
    task: optional.task as string | null,
    pr: optional.pr as string | null,
    reviewRound,
  };
}

/**
 * Read a checkpoint file. Ignores header fields it does not know, and reads
 * the known fields of a header whose `v` is above 1. Never throws.
 *
 * @param text - The file's contents.
 * @returns The header, title and sections, or a typed error.
 */
export function parseCheckpoint(text: string): ParsedCheckpoint | CheckpointParseError {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const headerMatch = HEADER_PATTERN.exec(lines[0] ?? '');
  if (!headerMatch) {
    return {
      ok: false,
      code: 'header',
      message: 'line 1 is not a "<!-- flow:handoff {...} -->" header',
    };
  }
  const header = readHeader(headerMatch[1]);
  if (typeof header === 'string') return { ok: false, code: 'header', message: header };

  let i = 1;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  const titleMatch = TITLE_PATTERN.exec(lines[i] ?? '');
  if (!titleMatch) {
    return { ok: false, code: 'title', message: 'the "# Handoff: <identifier>" line is missing' };
  }
  const body = checkBody(lines.slice(i + 1).join('\n'));
  if (!body.ok) return { ok: false, code: 'body', message: body.message };
  return { ok: true, header, title: titleMatch[2]?.trim() || null, sections: body.sections };
}

/** What {@link synthesizeCheckpoint} needs to know about the stopped session. */
export interface SynthesisFacts {
  /** The work item. */
  identifier: string;
  /** The stage the run is in. */
  stage: FlowStage;
  /** When the session stopped, as the operator should read it. */
  stoppedAt: string;
  /** Why it stopped, in a few words. */
  reason: string;
  /**
   * `git log --oneline <prev.headSha>..HEAD`, newest first (with no previous
   * checkpoint, the caller's choice of recent commits, or none). Only the first
   * {@link MAX_SYNTHESIZED_COMMITS} are listed.
   */
  commits: readonly string[];
  /** The worker brief, worktree-relative. Default {@link WORKER_BRIEF_PATH}. */
  briefPath?: string;
}

/** A body flow wrote for a session that stopped without a checkpoint. */
export interface SynthesizedCheckpoint {
  /** Always `synthesized`. */
  trigger: 'synthesized';
  /** The sections. */
  sections: CheckpointSections;
  /** The sections rendered as a body, ready for {@link renderCheckpoint}. */
  body: string;
}

/**
 * The body flow writes when a session stopped without a fresh checkpoint: a
 * hard stop, or a worker that ignored the wind-down (§1). The header is
 * measured as usual by the caller.
 *
 * - `Done`: the previous checkpoint's, plus the commits since it.
 * - `Next`, `Next command`: the previous checkpoint's.
 * - `Open questions`: the previous ones (a bare `None.` is replaced), plus a
 *   note that the session stopped without a checkpoint.
 * - With no previous checkpoint: continue the stage from the worker brief, and
 *   look around first with `git status && git log --oneline -5`.
 *
 * @param prev - The last checkpoint, or `null` when there is none.
 * @param facts - The stopped session and the commits since.
 * @returns The trigger, the sections and the rendered body.
 */
export function synthesizeCheckpoint(
  prev: Pick<ParsedCheckpoint, 'sections'> | null,
  facts: SynthesisFacts
): SynthesizedCheckpoint {
  const commits = facts.commits.slice(0, MAX_SYNTHESIZED_COMMITS);
  const label = prev ? 'Commits since the last checkpoint' : 'Recent commits';
  const commitText =
    commits.length > 0
      ? `${label}:\n\n${commits.map((line) => `- ${line}`).join('\n')}`
      : prev
        ? 'No commits since the last checkpoint.'
        : 'No earlier checkpoint, and no commits recorded.';
  const stopNote = `The previous session stopped at ${facts.stoppedAt} (${facts.reason}) without a checkpoint. Run \`git status\` and check any uncommitted work before continuing.`;
  const brief = facts.briefPath ?? WORKER_BRIEF_PATH;

  const sections: CheckpointSections = prev
    ? {
        done: `${prev.sections.done}\n\n${commitText}`,
        next: prev.sections.next,
        openQuestions:
          prev.sections.openQuestions === 'None.'
            ? stopNote
            : `${prev.sections.openQuestions}\n\n${stopNote}`,
        nextCommand: prev.sections.nextCommand,
      }
    : {
        done: commitText,
        next: `Continue the \`${facts.stage}\` stage of ${facts.identifier}. Read the worker brief at \`${brief}\`.`,
        openQuestions: stopNote,
        nextCommand: '```sh\ngit status && git log --oneline -5\n```',
      };
  return { trigger: 'synthesized', sections, body: renderBody(sections) };
}

/**
 * Make sure the repository's `info/exclude` (in the common git dir, so every
 * worktree) holds {@link CHECKPOINT_EXCLUDE_LINES}. Appends only missing lines.
 *
 * @param cwd - Any folder inside the worktree.
 * @returns The `info/exclude` path.
 * @throws When `cwd` is not inside a git checkout.
 */
export function ensureCheckpointExcludes(cwd: string): string {
  return addExcludeLines(cwd, CHECKPOINT_EXCLUDE_LINES);
}

/**
 * Write a checkpoint into `<worktree>/.dork/flow/HANDOFF.md`, keeping the
 * current one as `HANDOFF.prev.md`. Both land by temp file and `rename`, so a
 * reader always sees a whole file and `HANDOFF.md` never goes missing. The
 * temp names match the `HANDOFF*.md` exclude line, so a crash mid-write leaves
 * nothing git would show.
 *
 * @param worktree - The worktree's top-level folder.
 * @param text - The rendered checkpoint.
 * @returns The path of `HANDOFF.md`.
 */
export function writeCheckpointFile(worktree: string, text: string): string {
  const dir = path.join(worktree, CHECKPOINT_DIR);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, CHECKPOINT_FILE);
  const tag = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const temp = path.join(dir, `HANDOFF.tmp-${tag}.md`);
  writeFileSync(temp, text);
  if (existsSync(target)) {
    const previousTemp = path.join(dir, `HANDOFF.prev-tmp-${tag}.md`);
    copyFileSync(target, previousTemp);
    renameSync(previousTemp, path.join(dir, PREVIOUS_CHECKPOINT_FILE));
  }
  renameSync(temp, target);
  return target;
}
