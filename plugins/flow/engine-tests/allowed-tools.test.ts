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

/** Why a rule breaks the floor, or null when it holds. */
function breach(rule: string): string | null {
  if (rule === 'Bash' || rule === 'Write' || rule === 'Edit') return 'unscoped';
  if (rule.startsWith('Write(')) return 'Write rule (use Edit(<path>), which governs Write)';
  const edit = /^Edit\((.*)\)$/.exec(rule);
  if (edit)
    return edit[1].startsWith('/') || edit[1].startsWith('~') || edit[1].includes('..')
      ? 'Edit reaches outside the project'
      : null;
  const bash = /^Bash\((.*)\)$/s.exec(rule);
  if (!bash) return null;
  const body = bash[1];
  const wildcard = body.endsWith(':*') || body.endsWith(' *') || body.includes('*');
  if (!wildcard) return null;
  return /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w.-]+\.(ts|sh)"?( [a-z-]+)?:\*$/.test(body)
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
        .map((rule) => ({ rule, why: breach(rule) }))
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
    ]) {
      expect(breach(rule), rule).not.toBeNull();
    }
  });
});
