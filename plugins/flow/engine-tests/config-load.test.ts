/**
 * Contract suite for `scripts/config-load.ts`: how the flow CLI turns the
 * settings files into one validated config (spec `flow-cli-core` §3). Every case
 * runs against real temporary folders, because the loader reads the same files
 * `config-files.ts` resolves.
 *
 * @see specs/flow-cli-core/02-specification.md §3
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ConfigRoots } from '../scripts/config-files.ts';
import { loadConfig } from '../scripts/config-load.ts';
import { ConfigError, EXIT } from '../scripts/errors.ts';

let base: string;
let project: string;
let plugin: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-config-load-')));
  project = path.join(base, 'project');
  plugin = path.join(base, 'plugin');
  mkdirSync(project, { recursive: true });
  mkdirSync(plugin, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function roots(checkout = project, pluginRoot = plugin): ConfigRoots {
  return { checkout, mainCheckout: null, inGit: true, pluginRoot };
}

function write(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function writeCommitted(value: unknown): void {
  write(path.join(project, '.agents/flow/config.json'), value);
}

function writeLocal(value: unknown): void {
  write(path.join(project, '.agents/flow/config.local.json'), value);
}

/** The error `fn` throws, so a test can assert on its type and text. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('precedence', () => {
  it('fills every field the files leave out from the schema defaults', () => {
    // Purpose: the lowest layer. A config.json naming almost nothing must still
    // resolve to the full default config the engine runs on.
    writeCommitted({ tracker: 'linear' });
    const { config } = loadConfig(roots(), {});
    expect(config.autonomy.default).toBe('auto');
    expect(config.autonomy.wipCap.global).toBe(2);
    expect(config.connection.transport).toBe('cli');
  });

  it('lets config.json win over the schema defaults', () => {
    // Purpose: the committed file overrides a default.
    writeCommitted({ autonomy: { wipCap: { global: 5 } } });
    const { config } = loadConfig(roots(), {});
    expect(config.autonomy.wipCap.global).toBe(5);
    expect(config.autonomy.wipCap.perProject).toBe(1);
  });

  it('lets config.local.json win over config.json, deep-merging objects', () => {
    // Purpose: the local file overrides one leaf and keeps its committed siblings,
    // so a local override never has to restate the team's whole block.
    writeCommitted({ autonomy: { default: 'auto', wipCap: { global: 5, perProject: 3 } } });
    writeLocal({ autonomy: { default: 'manual', wipCap: { global: 1 } } });
    const { config } = loadConfig(roots(), {});
    expect(config.autonomy.default).toBe('manual');
    expect(config.autonomy.wipCap).toEqual({ global: 1, perProject: 3 });
  });

  it('replaces arrays rather than concatenating them', () => {
    // Purpose: arrays are values, not sets to union. A local `scope` of one entry
    // must mean exactly that one entry.
    writeCommitted({ ownership: { scope: ['issues', 'projects'] } });
    writeLocal({ ownership: { scope: ['issues'] } });
    const { config } = loadConfig(roots(), {});
    expect(config.ownership.scope).toEqual(['issues']);
  });

  it('lets the environment win over config.local.json for the tracker secrets', () => {
    // Purpose: the top layer. FLOW_TRACKER_* beat whatever the local file holds.
    writeCommitted({});
    writeLocal({ secrets: { trackerAccount: 'file-account', trackerToken: 'file-token' } });
    const { secrets } = loadConfig(roots(), {
      FLOW_TRACKER_ACCOUNT: 'env-account',
      FLOW_TRACKER_TOKEN: 'env-token',
    });
    expect(secrets).toEqual({ trackerAccount: 'env-account', trackerToken: 'env-token' });
  });

  it('keeps the file secrets when the environment names none, and reads no other variable', () => {
    // Purpose: an unset or empty variable is not an override, and a FLOW_-prefixed
    // variable the spec does not name changes nothing.
    writeCommitted({});
    writeLocal({ secrets: { trackerAccount: 'file-account' } });
    const { config, secrets } = loadConfig(roots(), {
      FLOW_TRACKER_TOKEN: '',
      FLOW_TRACKER: 'jira',
      FLOW_AUTONOMY_DEFAULT: 'manual',
    });
    expect(secrets).toEqual({ trackerAccount: 'file-account' });
    expect(config.tracker).toBe('linear');
    expect(config.autonomy.default).toBe('auto');
  });
});

describe('secrets', () => {
  it('never reach the config', () => {
    // Purpose: the policy schema is strict and has no secrets key; the loader
    // must split them off before parsing, and the parsed config must not carry
    // them anywhere.
    writeCommitted({});
    writeLocal({ secrets: { trackerAccount: 'acct', trackerToken: 'tok-123' } });
    const { config, secrets, warnings } = loadConfig(roots(), { FLOW_TRACKER_TOKEN: 'env-tok' });
    expect(secrets).toEqual({ trackerAccount: 'acct', trackerToken: 'env-tok' });
    expect(config).not.toHaveProperty('secrets');
    // Split, not merely dropped as an unknown key: a local secrets block is
    // expected there and earns no warning.
    expect(warnings).toEqual([]);
    const text = JSON.stringify(config);
    expect(text).not.toContain('tok-123');
    expect(text).not.toContain('env-tok');
    expect(text).not.toContain('acct');
  });

  it('in the committed file are still split off, with a warning', () => {
    // Purpose: credentials committed by mistake must not break the parse, and a
    // person must be told they are in a file git shares.
    writeCommitted({ secrets: { trackerToken: 'oops' } });
    const { config, secrets, warnings } = loadConfig(roots(), {});
    expect(config).not.toHaveProperty('secrets');
    expect(secrets).toEqual({ trackerToken: 'oops' });
    expect(warnings.join('\n')).toMatch(/config\.json.*secrets|secrets.*config\.json/);
  });
});

describe('invalid settings', () => {
  it('raise a ConfigError that lists each path and message', () => {
    // Purpose: a Zod failure maps to exit 3 and names every bad field, so a
    // person can fix all of them in one pass.
    writeCommitted({ autonomy: { wipCap: { global: -1 }, default: 'sometimes' } });
    const error = thrown(() => loadConfig(roots(), {}));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).exitCode).toBe(EXIT.config);
    const message = (error as ConfigError).message;
    expect(message).toContain('autonomy.wipCap.global');
    expect(message).toContain('autonomy.default');
  });

  it('report an unknown top-level key as a warning, not an error (config/CONFIG.md)', () => {
    // Purpose: the strict schema must not condemn a file for a key flow does not
    // know (a `//` note, a setting a later flow removed); it is dropped and named.
    writeCommitted({ '//': 'a note', retiredSetting: true });
    const { config, warnings } = loadConfig(roots(), {});
    expect(config).not.toHaveProperty('retiredSetting');
    expect(config).not.toHaveProperty('//');
    expect(warnings.join('\n')).toContain('retiredSetting');
  });

  it('raise a ConfigError for a file that is not a JSON object', () => {
    // Purpose: a broken file is a config error naming the file, not a crash.
    writeCommitted('{ not json');
    const error = thrown(() => loadConfig(roots(), {}));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('config.json');
  });
});

describe('refusals', () => {
  it('raise a ConfigError when flow is not configured', () => {
    // Purpose: origin none means there is nothing to load; the CLI exits 3.
    const error = thrown(() => loadConfig(roots(), {}));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/not configured/);
  });

  it('raise a ConfigError carrying the refusal text for the home folder', () => {
    // Purpose: refusalFor wins before any file is read, and its text is the message.
    const home = roots(os.homedir());
    home.inGit = false;
    const error = thrown(() => loadConfig(home, {}));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('home folder');
  });

  it('raise a ConfigError for legacy settings no one confirmed are this project’s', () => {
    // Purpose: settings in a plugin folder outside the project may be another
    // project's; they must never drive this one.
    write(path.join(plugin, 'config/config.json'), { tracker: 'linear' });
    const error = thrown(() => loadConfig(roots(), {}));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/another project/);
  });

  it('load legacy settings inside the project, with a warning to move them', () => {
    // Purpose: a plugin folder inside this project is its own; it still works,
    // but a person is told an update can erase it.
    const inside = path.join(project, 'plugins/flow');
    write(path.join(inside, 'config/config.json'), { autonomy: { default: 'manual' } });
    const { config, files, warnings } = loadConfig(roots(project, inside), {});
    expect(files.origin).toBe('legacy');
    expect(config.autonomy.default).toBe('manual');
    expect(warnings.join('\n')).toMatch(/migrate/);
  });
});

describe('files and pause', () => {
  it('reports the files it read', () => {
    // Purpose: the caller can say which files the config came from.
    writeCommitted({});
    writeLocal({});
    const { files } = loadConfig(roots(), {});
    expect(files.origin).toBe('project');
    expect(files.committed).toBe(path.join(project, '.agents/flow/config.json'));
    expect(files.local).toBe(path.join(project, '.agents/flow/config.local.json'));
  });

  it('reports the pause when the flag exists, and null when it does not', () => {
    // Purpose: paused comes from pauseState, so the CLI can refuse autonomous verbs.
    writeCommitted({});
    expect(loadConfig(roots(), {}).paused).toBeNull();
    write(path.join(project, '.agents/flow/paused.json'), {
      pausedAt: '2026-09-26T00:00:00.000Z',
    });
    const { paused } = loadConfig(roots(), {});
    expect(paused?.pausedAt).toBe('2026-09-26T00:00:00.000Z');
  });
});
