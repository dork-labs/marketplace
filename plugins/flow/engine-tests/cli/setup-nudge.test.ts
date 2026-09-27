/**
 * The setup nudge (spec `flow-cli-core` Amendment "account setup", S2): `flow
 * status`, `flow fleet` and `flow next` print one line when several account
 * folders exist and none is in rotation, and stay silent otherwise, in `--json`
 * mode, and with `fleet.nudge: false`.
 *
 * Every run gets a temp OS home (the harness's `osHome`) and a temp `DORK_HOME`,
 * so the real home folder is never looked at.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FlowConfigSchema } from '../../scripts/config-schema.ts';
import { FLEET_DEFAULTS } from '../../scripts/config-files.ts';
import type { VerbContext } from '../../scripts/cli/context.ts';
import { setupNudge } from '../../scripts/cli/setup-nudge.ts';
import { runFlow, tempProject, type TempProject } from './read-verb-harness.ts';

// The standalone default reads as rotation alone (rev 6d), as `flow accounts` shows it.
const NUDGE = '3 Claude Code accounts found, 1 in rotation: run `flow accounts setup`.';

/** The three commands the nudge rides on, with arguments that make them read only. */
const VERBS: readonly (readonly string[])[] = [['status'], ['next'], ['fleet', '--no-dorkos']];

let temp: TempProject | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

function project(extra: Record<string, unknown> = {}): TempProject {
  temp = tempProject({ tracker: 'fake', identity: { agent: 'agent-1' }, ...extra });
  // `flow status` finds its run store through git.
  execFileSync('git', ['init', '-q'], { cwd: temp.project });
  // The nudge must only ever see the temp home.
  expect(temp.osHome.startsWith(realpathSync(os.tmpdir()))).toBe(true);
  expect(temp.osHome).not.toBe(os.homedir());
  return temp;
}

/** Three Claude Code folders in the temp home: the default and two more. */
function threeFolders(t: TempProject): void {
  mkdirSync(path.join(t.osHome, '.claude'), { recursive: true });
  mkdirSync(path.join(t.osHome, '.claude-2', 'projects'), { recursive: true });
  mkdirSync(path.join(t.osHome, '.claude3', 'sessions'), { recursive: true });
}

function writeDork(t: TempProject, file: string, value: unknown): void {
  const full = path.join(t.dorkHome, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value));
}

describe('the setup nudge', () => {
  for (const argv of VERBS) {
    it(`flow ${argv[0]} prints it once when three folders exist and none is in rotation`, async () => {
      const t = project();
      threeFolders(t);
      const result = await runFlow(argv, t, { items: [] });
      expect(result.code).toBe(0);
      expect(result.stdout.split(NUDGE)).toHaveLength(2);
      expect(result.stdout.trimEnd().endsWith(NUDGE)).toBe(true);
      expect(result.stderr).not.toContain('accounts setup');
    });

    it(`flow ${argv[0]} --json is byte-for-byte the same with or without it`, async () => {
      const on = project();
      threeFolders(on);
      const withNudge = await runFlow([...argv, '--json'], on, { items: [] });
      on.cleanup();
      const off = project({ fleet: { nudge: false } });
      threeFolders(off);
      const without = await runFlow([...argv, '--json'], off, { items: [] });
      expect(withNudge.stdout).not.toContain('accounts setup');
      expect(withNudge.stderr).not.toContain('accounts setup');
      expect(withNudge.code).toBe(without.code);
      // Only the temp paths differ between the two projects.
      const normalize = (text: string, t: TempProject) =>
        text.split(path.dirname(t.project)).join('<base>');
      expect(normalize(withNudge.stdout, on)).toBe(normalize(without.stdout, off));
    });

    it(`flow ${argv[0]} stays silent with fleet.nudge: false`, async () => {
      const t = project({ fleet: { nudge: false } });
      threeFolders(t);
      const result = await runFlow(argv, t, { items: [] });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('accounts setup');
    });
  }

  it('config.local.json can turn it off too', async () => {
    const t = project();
    threeFolders(t);
    writeFileSync(
      path.join(t.project, '.agents', 'flow', 'config.local.json'),
      JSON.stringify({ fleet: { nudge: false } })
    );
    expect((await runFlow(['status'], t, { items: [] })).stdout).not.toContain('accounts setup');
  });

  it('stays silent with one folder', async () => {
    const t = project();
    mkdirSync(path.join(t.osHome, '.claude'), { recursive: true });
    expect((await runFlow(['status'], t, { items: [] })).stdout).not.toContain('accounts setup');
  });

  it('stays silent once one registered account is in rotation', async () => {
    const t = project();
    threeFolders(t);
    writeDork(t, 'config.json', {
      runtimes: {
        claudeCode: { accounts: [{ id: 'two', path: path.join(t.osHome, '.claude-2') }] },
      },
    });
    writeDork(t, path.join('flow', 'fleet.json'), {
      v: 1,
      accounts: { 'claude-code:two': { role: 'rotation' } },
    });
    expect((await runFlow(['status'], t, { items: [] })).stdout).not.toContain('accounts setup');
  });

  it('still fires when the only rotation account is the default by being alone', async () => {
    // A standalone default reads as rotation when it is its runtime's only
    // account (rev 6d); that says nothing about the other folders.
    const t = project();
    threeFolders(t);
    writeDork(t, path.join('flow', 'fleet.json'), {
      v: 1,
      accounts: { 'claude-code:default': { role: 'rotation' } },
    });
    expect((await runFlow(['status'], t, { items: [] })).stdout).toContain(NUDGE);
  });

  it('never changes the exit code (status --strict with drift-free state)', async () => {
    const t = project();
    threeFolders(t);
    const on = await runFlow(['status', '--strict'], t, { items: [] });
    expect(on.code).toBe(0);
    expect(on.stdout).toContain(NUDGE);
  });

  it('prints nothing when the home folder cannot be read', async () => {
    const t = project();
    // The OS home does not exist at all: nothing to find, nothing printed, no error.
    const result = await runFlow(['status'], t, { items: [] });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('accounts setup');
    expect(result.stderr).toBe('');
  });
});

describe('what the nudge counts', () => {
  it('does not count an org-managed folder, so the default beside one stays quiet', async () => {
    const t = project();
    mkdirSync(path.join(t.osHome, '.claude'), { recursive: true });
    mkdirSync(path.join(t.osHome, '.claude-work', 'projects'), { recursive: true });
    writeFileSync(path.join(t.osHome, '.claude-work', 'remote-settings.json'), '{}');
    expect((await runFlow(['status'], t, { items: [] })).stdout).not.toContain('accounts setup');
  });

  it('does not count a folder flow cannot register (a second Codex folder)', async () => {
    const t = project();
    mkdirSync(path.join(t.osHome, '.codex'), { recursive: true });
    const second = path.join(path.dirname(t.osHome), 'codex-2');
    mkdirSync(second, { recursive: true });
    const result = await runFlow(
      ['fleet', '--no-dorkos'],
      t,
      { items: [] },
      {},
      { CODEX_HOME: second }
    );
    expect(result.stdout).not.toContain('accounts setup');
  });

  it('does not count a folder kept out on purpose', async () => {
    const t = project();
    threeFolders(t);
    writeDork(t, 'config.json', {
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'two', path: path.join(t.osHome, '.claude-2') },
            { id: 'three', path: path.join(t.osHome, '.claude3') },
          ],
        },
      },
    });
    writeDork(t, path.join('flow', 'fleet.json'), {
      v: 1,
      accounts: {
        'claude-code:two': { role: 'kept-out' },
        'claude-code:three': { role: 'kept-out' },
      },
    });
    expect((await runFlow(['status'], t, { items: [] })).stdout).not.toContain('accounts setup');
  });

  it('is never computed in --json mode', () => {
    const t = project();
    threeFolders(t);
    const ctx = {
      json: true,
      projectDir: t.project,
      flowRoot: t.plugin,
      env: { DORK_HOME: t.dorkHome },
      io: { osHome: t.osHome },
    } as unknown as VerbContext;
    expect(setupNudge(ctx)).toBeNull();
    expect(setupNudge({ ...ctx, json: false } as VerbContext)).toBe(NUDGE);
  });
});

describe('fleet.nudge config', () => {
  it('defaults to true, and the zod-free reader agrees with the schema', () => {
    expect(FlowConfigSchema.parse({}).fleet).toEqual({ nudge: true });
    expect(FlowConfigSchema.parse({}).fleet).toEqual(FLEET_DEFAULTS);
    expect(FlowConfigSchema.parse({ fleet: { nudge: false } }).fleet.nudge).toBe(false);
    expect(() => FlowConfigSchema.parse({ fleet: { nudge: 'no' } })).toThrow();
  });
});
