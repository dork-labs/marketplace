/**
 * `flow usage install-statusline` (spec `flow-usage` §2.3). It edits the
 * operator's own status-line scripts, so the contract is strict: nothing
 * changes without --yes, every other byte survives, --remove restores the
 * original exactly, and settings.json is never written.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planEdit, recorderBlock } from '../../scripts/cli/usage-install.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let root: string;
let osHome: string;
let dorkHome: string;

/** A status-line script shaped like a real one: reads stdin into `input`, then renders. */
const SCRIPT_LF =
  '#!/bin/bash\n\n# Read JSON input from stdin\ninput=$(cat)\n\nprintf \'%s\' "line"\n';
const SCRIPT_CRLF_NO_EOL = '#!/bin/bash\r\ndata="$(cat)"\r\nprintf \'%s\' "x"';

function account(id: string, settings: unknown, script?: { name: string; text: string }) {
  const dir = path.join(osHome, `.${id}`);
  mkdirSync(dir, { recursive: true });
  if (settings !== undefined)
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  if (script) {
    writeFileSync(path.join(dir, script.name), script.text);
    chmodSync(path.join(dir, script.name), 0o750);
  }
  return { id, path: dir, label: null, color: null };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-install-'));
  osHome = path.join(root, 'home');
  dorkHome = path.join(root, 'dork');
  mkdirSync(dorkHome, { recursive: true });
  const accounts = [
    account(
      'a',
      { statusLine: { type: 'command', command: 'bash ~/.a/statusline.sh' } },
      { name: 'statusline.sh', text: SCRIPT_LF }
    ),
    account(
      'b',
      { statusLine: { type: 'command', command: `"${path.join(osHome, '.b', 'sl.sh')}"` } },
      { name: 'sl.sh', text: SCRIPT_CRLF_NO_EOL }
    ),
    account('c', { statusLine: { type: 'command', command: 'echo hi && date' } }),
    account('d', undefined),
    account(
      'e',
      { statusLine: { type: 'command', command: 'sh $HOME/.e/s.sh' } },
      { name: 's.sh', text: '#!/bin/sh\necho hi\n' }
    ),
  ];
  writeFileSync(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({ runtimes: { claudeCode: { accounts } } })
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sink() {
  let text = '';
  return { write: (chunk: string) => ((text += chunk), true), text: () => text };
}

async function install(argv: string[], flowRoot = FLOW_ROOT) {
  const stdout = sink();
  const stderr = sink();
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome },
    cwd: root,
    now: () => new Date('2026-09-26T16:00:00.000Z'),
    stdout,
    stderr,
    createAdapter: async () => {
      throw new Error('flow usage must not need a tracker');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    io: { osHome },
    flowRoot,
  };
  const code = await main(['usage', 'install-statusline', ...argv], deps);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const scriptA = () => path.join(osHome, '.a', 'statusline.sh');
const scriptB = () => path.join(osHome, '.b', 'sl.sh');
const hook = () => path.join(FLOW_ROOT, 'scripts', 'usage', 'statusline-hook.sh');
const blockFor = (variable: string) => recorderBlock(variable, hook(), process.execPath, FLOW_ROOT);

describe('flow usage install-statusline', () => {
  it('changes nothing without --yes, and reports every account', async () => {
    // Purpose: the operator's scripts are never touched until they say so.
    const settingsBefore = readFileSync(path.join(osHome, '.a', 'settings.json'), 'utf8');
    const result = await install(['--json']);
    expect(result.code).toBe(5);
    const plans = JSON.parse(result.stdout).accounts;
    expect(plans.map((p: { id: string; action: string }) => [p.id, p.action])).toEqual([
      ['a', 'insert'],
      ['b', 'insert'],
      ['c', 'manual'],
      ['d', 'manual'],
      ['e', 'manual'],
    ]);
    expect(plans.map((p: { reason?: string }) => p.reason ?? null)).toEqual([
      null,
      null,
      'the status line is an inline command, not a script file',
      expect.stringContaining('no readable'),
      'no stdin-capture line like input=$(cat)',
    ]);
    expect(plans[0]).toMatchObject({
      script: realpathSync(scriptA()),
      line: 4,
      lines: blockFor('input'),
      applied: false,
    });
    expect(readFileSync(scriptA(), 'utf8')).toBe(SCRIPT_LF);
    expect(readFileSync(scriptB(), 'utf8')).toBe(SCRIPT_CRLF_NO_EOL);
    expect(readFileSync(path.join(osHome, '.a', 'settings.json'), 'utf8')).toBe(settingsBefore);
  });

  it('inserts after the capture line with --yes, keeps a backup and the mode, then does nothing twice', async () => {
    // Purpose: the edit lands where the variable exists, and a rerun is harmless.
    expect((await install(['--yes', '--account', 'a'])).code).toBe(0);
    const [marker, line] = blockFor('input');
    expect(readFileSync(scriptA(), 'utf8')).toBe(
      `#!/bin/bash\n\n# Read JSON input from stdin\ninput=$(cat)\n${marker}\n${line}\n\nprintf '%s' "line"\n`
    );
    const backups = readdirSync(path.join(osHome, '.a')).filter((n) => n.includes('.flow-backup-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(osHome, '.a', backups[0]), 'utf8')).toBe(SCRIPT_LF);
    expect(statSync(scriptA()).mode & 0o777).toBe(0o750);
    const again = await install(['--yes', '--account', 'a', '--json']);
    expect(JSON.parse(again.stdout).accounts[0]).toMatchObject({ action: 'none', applied: false });
  });

  it('updates moved paths in place and removes the lines back to the original bytes', async () => {
    // Purpose: moving the plugin is fixable, and --remove is a true undo.
    await install(['--yes', '--account', 'a']);
    const installed = readFileSync(scriptA(), 'utf8');
    writeFileSync(
      scriptA(),
      installed
        .replace(hook(), '/old/place/statusline-hook.sh')
        .replace(hook(), '/old/place/statusline-hook.sh')
    );
    const updated = await install(['--yes', '--account', 'a', '--json']);
    expect(JSON.parse(updated.stdout).accounts[0].action).toBe('update');
    expect(readFileSync(scriptA(), 'utf8')).toBe(installed);
    await install(['--yes', '--remove', '--account', 'a']);
    expect(readFileSync(scriptA(), 'utf8')).toBe(SCRIPT_LF);
  });

  it('keeps CRLF endings and a missing final newline through insert and remove', async () => {
    // Purpose: nothing but the two lines may change, byte for byte.
    await install(['--yes', '--account', 'b']);
    const [marker, line] = blockFor('data');
    expect(readFileSync(scriptB(), 'utf8')).toBe(
      `#!/bin/bash\r\ndata="$(cat)"\r\n${marker}\r\n${line}\r\nprintf '%s' "x"`
    );
    await install(['--yes', '--remove', '--account', 'b']);
    expect(readFileSync(scriptB(), 'utf8')).toBe(SCRIPT_CRLF_NO_EOL);
  });

  it('edits the real file behind a symlinked script and keeps the link', async () => {
    // Purpose: dotfiles managers link status-line scripts; replacing the link would orphan the real file.
    const real = path.join(root, 'dotfiles', 'statusline.sh');
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, SCRIPT_LF);
    chmodSync(real, 0o775);
    rmSync(scriptA());
    symlinkSync(real, scriptA());
    await install(['--yes', '--account', 'a']);
    expect(lstatSync(scriptA()).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toContain('# flow usage recorder');
    // The umask must not strip the group write bit.
    expect(statSync(real).mode & 0o777).toBe(0o775);
    await install(['--yes', '--remove', '--account', 'a']);
    expect(lstatSync(scriptA()).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe(SCRIPT_LF);
  });

  it('refuses an unknown account and a path it cannot quote', async () => {
    // Purpose: a quote in a path would break the single-quoted line.
    expect((await install(['--account', 'ghost'])).code).toBe(5);
    const odd = path.join(root, "flo'w");
    mkdirSync(path.join(odd, 'scripts', 'usage'), { recursive: true });
    copyFileSync(hook(), path.join(odd, 'scripts', 'usage', 'statusline-hook.sh'));
    chmodSync(path.join(odd, 'scripts', 'usage', 'statusline-hook.sh'), 0o755);
    const result = await install(['--yes', '--account', 'a'], odd);
    expect(result.code).toBe(5);
    expect(result.stderr).toMatch(/quote/);
    expect(readFileSync(scriptA(), 'utf8')).toBe(SCRIPT_LF);
  });
});

describe('planEdit', () => {
  const block = (v: string): [string, string] => [
    `# flow usage recorder x`,
    `{ [ -x '/h/statusline-hook.sh' ] && printf '%s' "$${v}" | '/h/statusline-hook.sh'; } >/dev/null 2>&1 &`,
  ];

  it('never touches the line after a lone marker when the recorder line was deleted', () => {
    // Purpose: someone deleted only the recorder line; their next line must survive remove and update.
    const text =
      '#!/bin/bash\ninput=$(cat)\n# flow usage recorder x\necho "$(jq -r .model <<<"$input")"\n';
    expect(planEdit(text, block, true).next).toBe(
      '#!/bin/bash\ninput=$(cat)\necho "$(jq -r .model <<<"$input")"\n'
    );
    expect(planEdit(text, block, false).next).toBe(
      `#!/bin/bash\ninput=$(cat)\n# flow usage recorder x\n${block('input')[1]}\necho "$(jq -r .model <<<"$input")"\n`
    );
  });

  it('inserts at the end of a file whose capture line has no newline, and removes it exactly', () => {
    // Purpose: the one layout where insert must add a newline before the block.
    const text = '#!/bin/bash\ninput=$(cat)';
    const inserted = planEdit(text, block, false);
    expect(inserted.next).toBe(
      `#!/bin/bash\ninput=$(cat)\n# flow usage recorder x\n${block('input')[1]}`
    );
    expect(planEdit(inserted.next as string, block, true).next).toBe(text);
  });

  it('finds local and quoted capture lines', () => {
    // Purpose: common ways of reading stdin into a variable all count.
    expect(planEdit('  local raw="$(cat)"\n', block, false).lines).toEqual(block('raw'));
    expect(planEdit("x='$(cat)' # read\n", block, false).lines).toEqual(block('x'));
  });
});
