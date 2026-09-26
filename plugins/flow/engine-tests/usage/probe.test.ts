/**
 * `flow usage probe <id>` (spec `flow-usage` §2.5, task 2.3): one official
 * Claude Code turn, its cost stated first, its `rate_limit_event` readings saved.
 *
 * The real `claude` binary never runs here. A fake `spawnStream` records what it
 * was asked to run and feeds scripted `stream-json` lines back; the "binary" is
 * an empty executable file in a temp folder, only there so lookup succeeds.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StreamOptions, StreamOutcome, StreamRunner } from '../../scripts/cli/host-io.ts';
import { PROBE_STRIPPED_ENV } from '../../scripts/cli/usage-probe.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';
import { ledgerPath } from '../../scripts/fleet/usage-ledger.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-09-20T00:00:00.000Z');

/** The exact arguments §2.5 names. */
const EXPECTED_ARGS = [
  '-p',
  'Reply with the single word OK.',
  '--model',
  'haiku',
  '--output-format',
  'stream-json',
  '--verbose',
  '--tools',
  '',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--settings',
  '{"disableAllHooks":true}',
];

let root: string;
let dorkHome: string;
let osHome: string;
let account: string;
let claudeBin: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-usage-probe-'));
  dorkHome = path.join(root, 'dork');
  osHome = path.join(root, 'home');
  account = path.join(root, 'accounts', 'two');
  mkdirSync(dorkHome, { recursive: true });
  mkdirSync(path.join(osHome, '.claude'), { recursive: true });
  mkdirSync(account, { recursive: true });
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  claudeBin = path.join(bin, 'claude');
  writeFileSync(claudeBin, '');
  chmodSync(claudeBin, 0o755);
  writeFileSync(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'main', path: path.join(osHome, '.claude'), label: 'Main' },
            { id: 'two', path: account, label: 'Second' },
          ],
        },
      },
    })
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One recorded call to the fake runner. */
interface Call {
  cmd: string;
  args: readonly string[];
  opts: StreamOptions;
  cwdExisted: boolean;
  replies: ('continue' | 'stop')[];
}

/**
 * A fake runner that feeds `lines` to `onLine` and resolves with `outcome`.
 * With `hang`, it feeds nothing and resolves only when its timeout passes.
 */
function fakeRunner(
  lines: readonly string[],
  outcome: Partial<StreamOutcome> = {},
  hang = false
): { runner: StreamRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: StreamRunner = async (cmd, args, opts) => {
    const call: Call = { cmd, args, opts, cwdExisted: existsSync(opts.cwd ?? ''), replies: [] };
    calls.push(call);
    if (hang) {
      await new Promise((resolve) => setTimeout(resolve, opts.timeoutMs));
      return { code: null, stopped: false, timedOut: true };
    }
    let stopped = false;
    for (const line of lines) {
      const reply = opts.onLine(line);
      call.replies.push(reply);
      if (reply === 'stop') {
        stopped = true;
        break;
      }
    }
    return { code: 0, stopped, timedOut: false, ...outcome };
  };
  return { runner, calls };
}

function sink() {
  let buffer = '';
  return {
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    text: () => buffer,
  };
}

/** Run `flow <argv>` with a temp home and the given runner. */
async function flow(
  argv: string[],
  runner: StreamRunner,
  env: Record<string, string | undefined> = {}
) {
  const stdout = sink();
  const stderr = sink();
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome, ...env },
    cwd: root,
    now: () => NOW,
    stdout,
    stderr,
    createAdapter: async () => {
      throw new Error('flow usage must not need a tracker');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    flowRoot: path.resolve(here, '..', '..'),
    io: { osHome, spawnStream: runner },
  };
  const code = await main(argv, deps);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const INIT = JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' });
const RESULT = JSON.stringify({ type: 'result', subtype: 'success' });
const FIVE_HOUR_EVENT = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1790000000,
    rateLimitType: 'five_hour',
    utilization: 0.25,
  },
});
const SEVEN_DAY_EVENT = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1790400000,
    rateLimitType: 'seven_day',
    utilization: 0.81,
  },
});

describe('flow usage probe', () => {
  it('prints the cost note and runs nothing without --yes', async () => {
    // Purpose: the probe costs part of the account's limit; nothing may run
    // until the operator (or an agent) says --yes.
    const { runner, calls } = fakeRunner([INIT, FIVE_HOUR_EVENT, RESULT]);
    const run = await flow(['usage', 'probe', 'two', '--claude', claudeBin], runner);
    expect(run.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(run.stdout.startsWith('This runs one short Claude Code turn on Second (')).toBe(true);
    expect(run.stdout).toContain("It uses a small part of that account's 5-hour limit");
    expect(run.stdout).toContain('Run again with --yes to go ahead.');
    expect(existsSync(ledgerPath(dorkHome, 'claude-code', 'two'))).toBe(false);
  });

  it('prints the note on stderr under --json, before anything runs', async () => {
    // Purpose: stdout carries only the JSON, so the note must go to stderr in --json mode.
    const { runner, calls } = fakeRunner([INIT, FIVE_HOUR_EVENT, RESULT]);
    const run = await flow(['usage', 'probe', 'two', '--json', '--claude', claudeBin], runner);
    expect(run.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(run.stderr).toContain('This runs one short Claude Code turn on Second');
    expect(JSON.parse(run.stdout)).toMatchObject({ v: 1, account: 'two', ran: false });
  });

  it('runs the exact arguments with a scrubbed env in a temp folder removed afterwards', async () => {
    // Purpose: the turn must bill only the account's own sign-in (no key or
    // provider variables), load no project instructions, and never use --bare.
    const { runner, calls } = fakeRunner([INIT, FIVE_HOUR_EVENT, RESULT]);
    const parentEnv: Record<string, string> = {
      PATH: '/usr/bin',
      HOME: osHome,
      CLAUDE_CONFIG_DIR: '/somewhere/else',
    };
    for (const name of PROBE_STRIPPED_ENV) parentEnv[name] = 'x';
    const run = await flow(
      ['usage', 'probe', 'two', '--yes', '--claude', claudeBin],
      runner,
      parentEnv
    );
    expect(run.code, run.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.cmd).toBe(claudeBin);
    expect(call.args).toEqual(EXPECTED_ARGS);
    expect(call.args).not.toContain('--bare');
    expect(call.opts.timeoutMs).toBe(90_000);
    expect(call.opts.env.CLAUDE_CONFIG_DIR).toBe(account);
    expect(call.opts.env.PATH).toBe('/usr/bin');
    for (const name of PROBE_STRIPPED_ENV) expect(call.opts.env).not.toHaveProperty(name);
    expect(call.cwdExisted).toBe(true);
    expect(path.dirname(call.opts.cwd ?? '')).toBe(path.resolve(tmpdir()));
    expect(existsSync(call.opts.cwd ?? '')).toBe(false);
  });

  it('removes CLAUDE_CONFIG_DIR for the default ~/.claude account', async () => {
    // Purpose: Claude Code reads a different stored sign-in whenever the
    // variable is set, so the default account must run without it.
    const { runner, calls } = fakeRunner([INIT, FIVE_HOUR_EVENT, RESULT]);
    const run = await flow(['usage', 'probe', 'main', '--yes', '--claude', claudeBin], runner, {
      CLAUDE_CONFIG_DIR: account,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(calls[0].opts.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  describe('the default account (rev 6d)', () => {
    /** The operator's real config shape: defaultAccount null, one registered row. */
    function operatorConfig(defaultAccount: string | null): void {
      mkdirSync(path.join(osHome, '.claude3'), { recursive: true });
      writeFileSync(
        path.join(dorkHome, 'config.json'),
        JSON.stringify({
          runtimes: {
            claudeCode: {
              defaultAccount,
              accounts: [{ id: 'claude3', path: path.join(osHome, '.claude3'), label: 'Claude3' }],
            },
          },
        })
      );
    }

    it("probes this computer's own sign-in as default and writes default.json", async () => {
      // Purpose: the operator's setup (defaultAccount null, only claude3
      // registered, HOME holding .claude and .claude3, CLAUDE_CONFIG_DIR unset).
      // `default` is ~/.claude, its own account, so the turn runs in ~/.claude
      // (Claude Code's own folder, which it uses when CLAUDE_CONFIG_DIR is
      // absent; setting it would look up another stored sign-in) and the
      // readings land in default.json, never in claude3's file.
      operatorConfig(null);
      const { runner, calls } = fakeRunner([INIT, FIVE_HOUR_EVENT, RESULT]);
      const run = await flow(
        ['usage', 'probe', 'default', '--yes', '--json', '--claude', claudeBin],
        runner,
        { HOME: osHome }
      );
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toContain("Main (this computer's sign-in)");
      expect(run.stderr).toContain(`(${path.join(osHome, '.claude')})`);
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(JSON.parse(run.stdout)).toMatchObject({ account: 'default', changed: true });
      expect(existsSync(ledgerPath(dorkHome, 'claude-code', 'default'))).toBe(true);
      expect(existsSync(ledgerPath(dorkHome, 'claude-code', 'claude3'))).toBe(false);
    });

    it('probes the aliased row when defaultAccount names a registered folder', async () => {
      // Purpose: with defaultAccount at ~/.claude3, `default` is claude3's alias:
      // the turn runs with CLAUDE_CONFIG_DIR set to that folder and writes
      // claude3.json, so one real account never gets two readings.
      operatorConfig('~/.claude3');
      const { runner, calls } = fakeRunner([INIT, FIVE_HOUR_EVENT, RESULT]);
      const run = await flow(
        ['usage', 'probe', 'default', '--yes', '--json', '--claude', claudeBin],
        runner
      );
      expect(run.code, run.stderr).toBe(0);
      expect(calls[0].opts.env.CLAUDE_CONFIG_DIR).toBe(path.join(osHome, '.claude3'));
      expect(JSON.parse(run.stdout)).toMatchObject({ account: 'claude3' });
      expect(existsSync(ledgerPath(dorkHome, 'claude-code', 'claude3'))).toBe(true);
      expect(existsSync(ledgerPath(dorkHome, 'claude-code', 'default'))).toBe(false);
    });
  });

  it('records both rate_limit_event readings as sdk_event, utilization x 100', async () => {
    // Purpose: DOR-2369's probe path. Each event becomes one window in the ledger.
    const { runner } = fakeRunner([
      INIT,
      FIVE_HOUR_EVENT,
      '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
      SEVEN_DAY_EVENT,
      RESULT,
    ]);
    const run = await flow(
      ['usage', 'probe', 'two', '--yes', '--json', '--claude', claudeBin],
      runner
    );
    expect(run.code, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out).toMatchObject({
      v: 1,
      account: 'two',
      model: 'haiku',
      changed: true,
      apiKeySource: 'none',
    });
    expect(out.observations).toHaveLength(2);

    const windows = JSON.parse(
      readFileSync(ledgerPath(dorkHome, 'claude-code', 'two'), 'utf8')
    ).windows;
    expect(windows.five_hour).toEqual({
      usedPct: 25,
      resetsAt: new Date(1790000000 * 1000).toISOString(),
      status: 'allowed',
      observedAt: NOW.toISOString(),
      source: 'sdk_event',
    });
    expect(windows.seven_day).toMatchObject({
      usedPct: 81,
      status: 'allowed_warning',
      source: 'sdk_event',
    });
  });

  it('stops and records nothing when the account answers on an API key', async () => {
    // Purpose: an API-key turn bills a different account than the subscription
    // being measured, so its readings must never be saved.
    const { runner, calls } = fakeRunner([
      JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }),
      FIVE_HOUR_EVENT,
      RESULT,
    ]);
    const run = await flow(['usage', 'probe', 'two', '--yes', '--claude', claudeBin], runner);
    expect(run.code).toBe(5);
    expect(run.stderr).toContain('answered with an API key (ANTHROPIC_API_KEY)');
    expect(calls[0].replies).toEqual(['stop']);
    expect(existsSync(ledgerPath(dorkHome, 'claude-code', 'two'))).toBe(false);
  });

  it('exits 5 when the turn reports no usage', async () => {
    // Purpose: a turn with no rate_limit_event must say so, not claim success.
    const { runner } = fakeRunner([INIT, 'not json at all', RESULT]);
    const run = await flow(['usage', 'probe', 'two', '--yes', '--claude', claudeBin], runner);
    expect(run.code).toBe(5);
    expect(run.stderr).toContain('reported no usage; nothing recorded');
    expect(run.stderr).toContain('not JSON');
    expect(existsSync(ledgerPath(dorkHome, 'claude-code', 'two'))).toBe(false);
  });

  it('stops a hanging turn at --timeout and exits 5', async () => {
    // Purpose: a stuck child must not hold the caller forever.
    const { runner, calls } = fakeRunner([], {}, true);
    const run = await flow(
      ['usage', 'probe', 'two', '--yes', '--timeout', '0.05', '--claude', claudeBin],
      runner
    );
    expect(calls[0].opts.timeoutMs).toBe(50);
    expect(run.code).toBe(5);
    expect(run.stderr).toContain('did not finish within 0.05 s');
    expect(existsSync(calls[0].opts.cwd ?? '')).toBe(false);
  });

  it('finds claude on PATH and exits 3 naming what it tried when it is missing', async () => {
    // Purpose: the binary lookup follows --claude, FLOW_CLAUDE_BIN, then PATH,
    // and a miss names the fix instead of failing obscurely.
    const found = fakeRunner([INIT, FIVE_HOUR_EVENT, RESULT]);
    const onPath = await flow(['usage', 'probe', 'two', '--yes'], found.runner, {
      PATH: ['/nonexistent', path.dirname(claudeBin)].join(path.delimiter),
    });
    expect(onPath.code, onPath.stderr).toBe(0);
    expect(found.calls[0].cmd).toBe(claudeBin);

    const missing = fakeRunner([]);
    const noPath = await flow(['usage', 'probe', 'two', '--yes'], missing.runner, {
      PATH: '/nonexistent',
    });
    expect(noPath.code).toBe(3);
    expect(noPath.stderr).toContain('no claude found on PATH');

    const badEnv = await flow(['usage', 'probe', 'two', '--yes'], missing.runner, {
      FLOW_CLAUDE_BIN: path.join(root, 'nope'),
    });
    expect(badEnv.code).toBe(3);
    expect(badEnv.stderr).toContain('FLOW_CLAUDE_BIN');
    expect(missing.calls).toHaveLength(0);
  });

  it('exits 3 when the binary cannot be started', async () => {
    // Purpose: a spawn failure is a setup problem (exit 3), not a usage reading.
    const runner: StreamRunner = async () => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    };
    const run = await flow(['usage', 'probe', 'two', '--yes', '--claude', claudeBin], runner);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('could not start');
  });

  it('exits 5 for an unknown account', async () => {
    // Purpose: a typo must fail before any note or turn.
    const { runner, calls } = fakeRunner([]);
    const run = await flow(['usage', 'probe', 'nobody', '--yes', '--claude', claudeBin], runner);
    expect(run.code).toBe(5);
    expect(calls).toHaveLength(0);
  });
});
