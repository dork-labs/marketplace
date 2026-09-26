/**
 * `flow usage install-statusline` (spec `flow-usage` §2.3): add the two
 * recorder lines to each registered account's status-line script, take them
 * out again with `--remove`, or update them when the plugin moved.
 *
 * Nothing changes without `--yes`: the default prints the plan. With `--yes`
 * each change keeps a backup, preserves the file's mode and every other byte
 * (line endings, a missing final newline), is verified by reading it back, and
 * is undone from the backup when the check fails. `settings.json` is only read.
 *
 * @module @dorkos/flow/cli/usage-install
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PreconditionError } from '../errors.ts';
import { loadAccounts, resolveAccountRef, resolveDorkHome } from '../fleet/accounts.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { formatColumns } from './output.ts';

/** The first words of the marker comment; how an installed block is found. */
export const MARKER_PREFIX = '# flow usage recorder';

/** A stdin-capture line such as `input=$(cat)`; group 1 is the variable. */
const CAPTURE_LINE = /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=["']?\$\(cat\)["']?\s*(#.*)?$/;

/**
 * The recorder line: any line that runs `statusline-hook.sh`. Matched loosely on
 * purpose, so a later release that changes the line's shape still updates it in
 * place instead of adding a second one.
 */
const HOOK_LINE = /statusline-hook\.sh/;

/** `[bash|sh|zsh] <script>`, the script bare or quoted. */
const COMMAND = /^(?:(?:bash|sh|zsh)\s+)?(?:'([^']*)'|"([^"]*)"|(\S+))$/;

/** What happens to one account's script. */
export type InstallAction = 'insert' | 'update' | 'remove' | 'none' | 'manual';

/** One account's plan and, after `--yes`, its outcome. */
export interface InstallPlan {
  id: string;
  script: string | null;
  action: InstallAction;
  reason?: string;
  /** The 1-based line the block goes after (insert) or starts at (update, remove). */
  line?: number;
  /** The two lines, for insert, update and manual. */
  lines?: string[];
  applied: boolean;
  backup?: string;
}

/**
 * The two lines a status-line script gets. The redirection wraps the whole
 * group, `[ -x … ]` test included: otherwise the backgrounded subshell keeps the
 * status line's stdout open until the recorder ends, and the status line waits.
 *
 * @param variable - The shell variable holding the status-line JSON.
 * @param hookPath - The absolute hook path.
 * @param nodePath - The absolute Node to run it with.
 * @param flowRoot - The plugin folder, named in the comment.
 * @returns The marker comment and the hook line.
 */
export function recorderBlock(
  variable: string,
  hookPath: string,
  nodePath: string,
  flowRoot: string
): [string, string] {
  return [
    `${MARKER_PREFIX} (opt-in): records this account's usage for \`flow fleet\`. See ${flowRoot}/docs/account-usage.mdx`,
    `{ [ -x '${hookPath}' ] && printf '%s' "$${variable}" | FLOW_NODE='${nodePath}' '${hookPath}'; } >/dev/null 2>&1 &`,
  ];
}

/** Expand `~/`, `$HOME/` and `${HOME}/`. */
function expandHome(value: string, osHome: string): string {
  for (const prefix of ['~/', '$HOME/', '${HOME}/']) {
    if (value.startsWith(prefix)) return path.join(osHome, value.slice(prefix.length));
  }
  return value;
}

/** Find the status-line script of an account, or say why it cannot be edited. */
function findScript(
  account: { path: string },
  osHome: string
): { script: string } | { reason: string } {
  const settingsFile = path.join(account.path, 'settings.json');
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    return { reason: `no readable ${settingsFile}` };
  }
  const statusLine =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>).statusLine
      : undefined;
  if (typeof statusLine !== 'object' || statusLine === null) {
    return { reason: 'no status line is set up' };
  }
  const { type, command } = statusLine as Record<string, unknown>;
  if (type !== 'command' || typeof command !== 'string') {
    return { reason: 'the status line is not a command' };
  }
  const match = COMMAND.exec(command.trim());
  if (match === null) {
    return { reason: 'the status line is an inline command, not a script file' };
  }
  const script = expandHome(match[1] ?? match[2] ?? match[3], osHome);
  if (!path.isAbsolute(script) || !existsSync(script) || !statSync(script).isFile()) {
    return { reason: `${script} is not a file` };
  }
  // Edit the real file behind a symlink (a dotfiles manager's link), never replace the link.
  return { script: realpathSync(script) };
}

/** One line of a script with its position and terminator. */
interface Line {
  start: number;
  /** Index just past the line's text, before its terminator. */
  end: number;
  /** `'\r\n'`, `'\n'`, or `''` for a last line with no newline. */
  eol: string;
  text: string;
}

/** Split text into lines, keeping where each one starts and ends. */
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ start, end: text.length, eol: '', text: text.slice(start) });
      break;
    }
    const crlf = newline > start && text[newline - 1] === '\r';
    const end = crlf ? newline - 1 : newline;
    lines.push({ start, end, eol: crlf ? '\r\n' : '\n', text: text.slice(start, end) });
    start = newline + 1;
  }
  return lines;
}

/** The planned new text of a script, or why it cannot be planned. */
interface Edit {
  action: InstallAction;
  reason?: string;
  line?: number;
  lines?: string[];
  next?: string;
}

/**
 * Plan the change to one script's text.
 *
 * @param text - The script as it is now.
 * @param block - The two lines it should hold, built for its capture variable
 *   (called with the variable once it is known).
 * @param remove - Whether to take the block out.
 * @returns The action and the new text.
 */
export function planEdit(
  text: string,
  block: (variable: string) => [string, string],
  remove: boolean
): Edit {
  const lines = linesOf(text);
  const markerIndex = lines.findIndex((line) => line.text.trimStart().startsWith(MARKER_PREFIX));
  if (markerIndex !== -1) {
    // Only a line shaped like the recorder counts as the block's second line. If
    // someone deleted it by hand, the line after the marker is theirs: never touch it.
    const after = lines[markerIndex + 1];
    const hookLine = after !== undefined && HOOK_LINE.test(after.text) ? after : undefined;
    if (remove) {
      const marker = lines[markerIndex];
      // Take out both lines with their newlines. When the block ends the file
      // with no newline, take the newline before it instead, which is exactly
      // what an insert at the end added.
      const from =
        hookLine !== undefined && hookLine.eol === '' && markerIndex > 0
          ? lines[markerIndex - 1].end
          : marker.start;
      const to =
        hookLine === undefined
          ? marker.end + marker.eol.length
          : hookLine.eol === '' && markerIndex > 0
            ? hookLine.end
            : hookLine.end + hookLine.eol.length;
      return {
        action: 'remove',
        line: markerIndex + 1,
        next: text.slice(0, from) + text.slice(to),
      };
    }
    const capture = lines.map((line) => CAPTURE_LINE.exec(line.text)).find((m) => m !== null);
    if (!capture) return { action: 'manual', reason: 'no stdin-capture line like input=$(cat)' };
    const wanted = block(capture[1]);
    if (
      hookLine !== undefined &&
      lines[markerIndex].text === wanted[0] &&
      hookLine.text === wanted[1]
    ) {
      return { action: 'none', line: markerIndex + 1 };
    }
    const marker = lines[markerIndex];
    let next = text.slice(0, marker.start) + wanted[0] + text.slice(marker.end);
    if (hookLine !== undefined) {
      const shift = next.length - text.length;
      next = next.slice(0, hookLine.start + shift) + wanted[1] + next.slice(hookLine.end + shift);
    } else {
      // The recorder line is gone (deleted by hand): put it back right after the
      // marker, leaving the person's own next line as it is.
      const markerEnd = marker.start + wanted[0].length;
      const eol = marker.eol || lines.find((line) => line.eol !== '')?.eol || '\n';
      next =
        marker.eol === ''
          ? `${next}${eol}${wanted[1]}`
          : next.slice(0, markerEnd + eol.length) +
            wanted[1] +
            eol +
            next.slice(markerEnd + eol.length);
    }
    return { action: 'update', line: markerIndex + 1, lines: wanted, next };
  }
  if (remove) return { action: 'none' };
  const captureIndex = lines.findIndex((line) => CAPTURE_LINE.test(line.text));
  if (captureIndex === -1) {
    return { action: 'manual', reason: 'no stdin-capture line like input=$(cat)' };
  }
  const capture = lines[captureIndex];
  const variable = (CAPTURE_LINE.exec(capture.text) as RegExpExecArray)[1];
  const wanted = block(variable);
  const eol = capture.eol || lines.find((line) => line.eol !== '')?.eol || '\n';
  const next =
    capture.eol === ''
      ? `${text}${eol}${wanted[0]}${eol}${wanted[1]}`
      : text.slice(0, capture.end + capture.eol.length) +
        `${wanted[0]}${eol}${wanted[1]}${eol}` +
        text.slice(capture.end + capture.eol.length);
  return { action: 'insert', line: captureIndex + 1, lines: wanted, next };
}

/** How many marker lines a text holds. */
function markerCount(text: string): number {
  return linesOf(text).filter((line) => line.text.trimStart().startsWith(MARKER_PREFIX)).length;
}

/** Apply one planned edit: backup, temp file with the same mode, rename, verify, restore on failure. */
function applyEdit(script: string, next: string, expectMarkers: number, stamp: number): string {
  const backup = `${script}.flow-backup-${stamp}`;
  copyFileSync(script, backup);
  const mode = statSync(script).mode & 0o7777;
  const temp = `${script}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, next, { mode });
  // writeFileSync's mode is reduced by the umask; set the original bits exactly.
  chmodSync(temp, mode);
  renameSync(temp, script);
  const written = readFileSync(script, 'utf8');
  if (written !== next || markerCount(written) !== expectMarkers) {
    copyFileSync(backup, script);
    throw new PreconditionError(
      `${script} did not read back as planned; flow put the original back from ${backup}.`
    );
  }
  return backup;
}

/**
 * Run `flow usage install-statusline`.
 *
 * @param ctx - The verb context.
 * @returns One plan per account; exit 5 when any account needs a manual edit.
 * @throws {PreconditionError} For an unknown `--account`, an unusable hook or
 *   Node path, or a write that did not read back as planned.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const dorkHome = resolveDorkHome(ctx.env, ctx.io.osHome);
  // Every Claude Code account from the shared resolver (spec §1.1a rev 6d): the
  // registered rows (an aliased `default` once, as its row) and a standalone
  // `default` in its machine-wide folder, when that folder exists, so the
  // operator's own sign-in gets the recorder too.
  const { accounts } = loadAccounts(dorkHome, { home: ctx.io.osHome });
  const installable = accounts.flatMap((account) =>
    account.runtime === 'claude-code' &&
    account.routable &&
    account.path !== null &&
    (!account.implicit || existsSync(account.path))
      ? [{ ...account, path: account.path }]
      : []
  );
  const only = ctx.args.flags.account;
  const picked =
    typeof only === 'string' ? resolveAccountRef(installable, 'claude-code', only) : null;
  const targets = typeof only === 'string' ? (picked === null ? [] : [picked]) : installable;
  if (typeof only === 'string' && targets.length === 0) {
    throw new PreconditionError(`"${only}" is not a Claude Code account; see "flow accounts".`);
  }
  const yes = ctx.args.flags.yes === true;
  const remove = ctx.args.flags.remove === true;

  const hookSource = path.join(ctx.flowRoot, 'scripts', 'usage', 'statusline-hook.sh');
  let hookPath: string;
  try {
    hookPath = realpathSync(hookSource);
    if ((statSync(hookPath).mode & 0o111) === 0) throw new Error('not executable');
  } catch {
    throw new PreconditionError(`${hookSource} is missing or not executable; reinstall flow.`);
  }
  const nodePath = process.execPath;
  for (const value of [hookPath, nodePath]) {
    if (/['\n]/.test(value)) {
      throw new PreconditionError(
        `${value} contains a quote or a newline, so it cannot be written safely.`
      );
    }
  }
  const flowRoot = realpathSync(ctx.flowRoot);
  const block = (variable: string) => recorderBlock(variable, hookPath, nodePath, flowRoot);

  const plans: InstallPlan[] = [];
  for (const account of targets) {
    const found = findScript(account, ctx.io.osHome);
    if ('reason' in found) {
      plans.push({
        id: account.id,
        script: null,
        action: 'manual',
        reason: found.reason,
        lines: block('input'),
        applied: false,
      });
      continue;
    }
    const text = readFileSync(found.script, 'utf8');
    const edit = planEdit(text, block, remove);
    const plan: InstallPlan = {
      id: account.id,
      script: found.script,
      action: edit.action,
      ...(edit.reason ? { reason: edit.reason } : {}),
      ...(edit.line ? { line: edit.line } : {}),
      ...(edit.lines
        ? { lines: edit.lines }
        : edit.action === 'manual'
          ? { lines: block('input') }
          : {}),
      applied: false,
    };
    if (yes && edit.next !== undefined && ['insert', 'update', 'remove'].includes(edit.action)) {
      plan.backup = applyEdit(
        found.script,
        edit.next,
        edit.action === 'remove' ? 0 : 1,
        ctx.now().getTime()
      );
      plan.applied = true;
    }
    plans.push(plan);
  }

  const manual = plans.some((plan) => plan.action === 'manual');
  return {
    exitCode: manual ? 5 : 0,
    json: { ok: !manual, accounts: plans },
    text: render(plans, yes),
  };
}

/** The human report. */
function render(plans: readonly InstallPlan[], yes: boolean): string {
  if (plans.length === 0)
    return 'No accounts registered. Add one: flow accounts add --path ~/.claude';
  const rows: string[][] = [];
  const details: string[] = [];
  for (const plan of plans) {
    const where = plan.script ?? '-';
    let what: string;
    switch (plan.action) {
      case 'insert':
        what = plan.applied
          ? `added after line ${plan.line} (backup: ${plan.backup})`
          : `would add 2 lines after line ${plan.line}`;
        break;
      case 'update':
        what = plan.applied
          ? `updated at line ${plan.line} (backup: ${plan.backup})`
          : `would update the lines at line ${plan.line}`;
        break;
      case 'remove':
        what = plan.applied
          ? `removed from line ${plan.line} (backup: ${plan.backup})`
          : `would remove the lines at line ${plan.line}`;
        break;
      case 'none':
        what = 'nothing to do';
        break;
      default:
        what = `add by hand: ${plan.reason}`;
    }
    rows.push([`  ${plan.id}`, what, where]);
    if (plan.lines && !plan.applied && plan.action !== 'none') {
      details.push(`${plan.id}:`, ...plan.lines.map((line) => `    ${line}`));
    }
  }
  const out = [formatColumns(rows)];
  if (details.length > 0) out.push('', ...details);
  if (!yes && plans.some((plan) => ['insert', 'update', 'remove'].includes(plan.action))) {
    out.push('', 'Nothing changed. Run again with --yes to make these changes.');
  }
  if (plans.some((plan) => plan.action === 'manual')) {
    out.push(
      '',
      'For "add by hand", put the two lines right after the line that reads the status-line input, using its variable name.'
    );
  }
  return out.join('\n');
}
