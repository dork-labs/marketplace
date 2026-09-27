/**
 * A brand-new user, end to end (spec `flow-cli-core` Amendment "account setup").
 *
 * A temp HOME holds three personal Claude Code folders, one org-managed folder,
 * a Codex folder and nothing else: no `~/.dork`, no config, no ledger. The real
 * `flow` script runs as a child process with only `PATH` and that `HOME` in its
 * environment, the way a person or an agent would run it. It must:
 *
 * 1. nudge (`flow fleet`) toward setup,
 * 2. set the accounts up with one `--yes` command,
 * 3. leave a `config.json` and a `fleet.json` the contract accepts, with the
 *    roles `flow accounts` then reports, and the recorder in the status line,
 * 4. stop nudging.
 *
 * A reviewer can repeat this by hand with the same commands in any empty folder
 * used as HOME.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FLOW_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FLOW = path.join(FLOW_ROOT, 'scripts', 'flow.ts');

let home: string;

/** Run the real `flow` with only PATH and the temp HOME. */
function flow(...args: string[]) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', FLOW, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  home = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-fresh-user-'))), 'home');
  for (const dir of [
    '.claude',
    '.claude-2/projects',
    '.claude3/sessions',
    '.claude-client/projects',
    '.codex',
  ]) {
    mkdirSync(path.join(home, dir), { recursive: true });
  }
  writeFileSync(path.join(home, '.claude-client', 'policy-limits.json'), '{}');
  // .claude-2 has a status line; the others do not.
  const script = path.join(home, '.claude-2', 'statusline.sh');
  writeFileSync(script, '#!/bin/bash\ninput=$(cat)\necho "$input" | head -c 40\n');
  chmodSync(script, 0o755);
  writeFileSync(
    path.join(home, '.claude-2', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: script } })
  );
});

afterAll(() => {
  rmSync(path.dirname(home), { recursive: true, force: true });
});

describe('a fresh user sets up their accounts', () => {
  it('runs in a temp HOME, never the real one', () => {
    expect(home.startsWith(realpathSync(os.tmpdir()))).toBe(true);
    expect(home).not.toBe(os.homedir());
    expect(existsSync(path.join(home, '.dork'))).toBe(false);
  });

  it('is nudged toward setup before it', () => {
    const before = flow('fleet', '--no-dorkos');
    expect(before.code).toBe(0);
    expect(before.stdout).toContain(
      '3 Claude Code accounts found, 1 in rotation: run `flow accounts setup`.'
    );
  });

  it('sets everything up with one --yes command', () => {
    const setup = flow('accounts', 'setup', '--yes', '--rotation', 'all', '--statusline', '--json');
    expect(setup.code, setup.stderr).toBe(0);
    const out = JSON.parse(setup.stdout);
    expect(out).toMatchObject({ ok: true, mode: 'yes', applied: true });
    const client = out.candidates.find((c: { path: string }) => c.path.endsWith('.claude-client'));
    expect(client.orgManaged.file).toBe('policy-limits.json');
    expect(client.proposedRole).toBeNull();

    const config = JSON.parse(readFileSync(path.join(home, '.dork', 'config.json'), 'utf8'));
    expect(config.runtimes.claudeCode.accounts.map((a: { id: string }) => a.id)).toEqual([
      'claude-2',
      'claude3',
    ]);
    const fleet = JSON.parse(readFileSync(path.join(home, '.dork', 'flow', 'fleet.json'), 'utf8'));
    const ajv = new (Ajv as unknown as typeof import('ajv').default)({ strict: true });
    const validate = ajv.compile(
      JSON.parse(
        readFileSync(
          path.join(FLOW_ROOT, 'conformance', 'fleet', 'fleet-policy.schema.json'),
          'utf8'
        )
      ) as object
    );
    expect(validate(fleet), JSON.stringify(validate.errors)).toBe(true);
    expect(readFileSync(path.join(home, '.claude-2', 'statusline.sh'), 'utf8')).toContain(
      '# flow usage recorder'
    );
  });

  it('leaves the roles flow accounts reports', () => {
    const listed = flow('accounts', '--json');
    expect(listed.code).toBe(0);
    const roles = Object.fromEntries(
      JSON.parse(listed.stdout).accounts.map((a: { key: string; role: string }) => [a.key, a.role])
    );
    expect(roles).toMatchObject({
      'claude-code:claude-2': 'rotation',
      'claude-code:claude3': 'rotation',
      'claude-code:default': 'main',
      'codex:default': 'rotation',
    });
    expect(roles['claude-code:claude-client']).toBeUndefined();
  });

  it('is no longer nudged, and a second setup has nothing to do', () => {
    expect(flow('fleet', '--no-dorkos').stdout).not.toContain('accounts setup');
    const again = JSON.parse(
      flow('accounts', 'setup', '--yes', '--rotation', 'all', '--json').stdout
    );
    expect(again.plan).toEqual([]);
  });
});
