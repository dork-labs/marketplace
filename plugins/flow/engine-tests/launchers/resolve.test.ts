/**
 * Host resolution (spec `flow-handoff-dispatch` §2.2, task 2.1): the
 * preference order, a named host that is down (an error with its reason and
 * never a fallback), the `auto` order cmux, dorkos, cli, and the runtime a
 * host must be able to run to be picked at all.
 */

import { describe, expect, it } from 'vitest';

import { ConfigError, UsageError } from '../../scripts/errors.ts';
import { hostPreference, resolveHost } from '../../scripts/launchers/resolve.ts';
import {
  CMUX_CLAUDE_ONLY_REASON,
  supportFor,
  supportMatrix,
} from '../../scripts/launchers/support.ts';
import type { HostName, ProbeResult } from '../../scripts/launchers/types.ts';

const up: ProbeResult = { ok: true };
const down = (reason: string): ProbeResult => ({ ok: false, reason });

/** Probe results with every host up, overridden per case. */
function probes(
  overrides: Partial<Record<HostName, ProbeResult>> = {}
): Record<HostName, ProbeResult> {
  return { cli: up, cmux: up, dorkos: up, ...overrides };
}

const inCmux = { CMUX_SURFACE_ID: 'surface:7' };

describe('hostPreference', () => {
  // --host beats drain.host, which beats auto; an unknown name is refused.
  it('takes the flag, else the config value, else auto', () => {
    expect(hostPreference('cli', 'cmux')).toBe('cli');
    expect(hostPreference(undefined, 'dorkos')).toBe('dorkos');
    expect(hostPreference()).toBe('auto');
    expect(() => hostPreference('tmux')).toThrow(UsageError);
    expect(() => hostPreference(undefined, 'tmux')).toThrow(ConfigError);
  });
});

describe('resolveHost', () => {
  // A named host that is up is used, whatever else is up.
  it('uses a named host whose probe passed', () => {
    expect(resolveHost('cli', inCmux, probes(), 'claude-code').host).toBe('cli');
    expect(resolveHost('dorkos', {}, probes(), 'claude-code').host).toBe('dorkos');
  });

  // The DOR-2372 validation: a missing host is reported, not guessed.
  it('a named host that is down is an error with its reason, never a fallback', () => {
    const run = () =>
      resolveHost(
        'dorkos',
        {},
        probes({ dorkos: down('DorkOS is not answering at http://127.0.0.1:4242') }),
        'claude-code'
      );
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/DorkOS is not answering at http:\/\/127\.0\.0\.1:4242/);
  });

  // auto: cmux only when the supervisor itself runs inside cmux.
  it('auto picks cmux inside cmux, and skips it outside', () => {
    expect(resolveHost('auto', inCmux, probes(), 'claude-code')).toMatchObject({ host: 'cmux' });
    expect(resolveHost('auto', {}, probes(), 'claude-code')).toMatchObject({ host: 'dorkos' });
    expect(resolveHost('auto', { CMUX_SURFACE_ID: '' }, probes(), 'claude-code')).toMatchObject({
      host: 'dorkos',
    });
  });

  // auto: a failing probe moves on down the order.
  it('auto falls through cmux, then dorkos, to cli', () => {
    expect(
      resolveHost('auto', inCmux, probes({ cmux: down('cmux is not running') }), 'claude-code').host
    ).toBe('dorkos');
    expect(resolveHost('auto', {}, probes({ dorkos: down('no DorkOS') }), 'claude-code').host).toBe(
      'cli'
    );
  });

  // auto with nothing available lists every reason, so the person can fix one.
  it('auto with every host down lists all three reasons', () => {
    const run = () =>
      resolveHost(
        'auto',
        inCmux,
        probes({
          cmux: down('cmux is not running'),
          dorkos: down('no DorkOS'),
          cli: down('no claude'),
        }),
        'claude-code'
      );
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/cmux: cmux is not running.*dorkos: no DorkOS.*cli: no claude/);
  });

  // The why is a sentence for the drain's first line, naming the runtime's binary.
  it('says why', () => {
    expect(resolveHost('auto', {}, probes({ dorkos: down('x') }), 'claude-code').why).toMatch(
      /plain claude/
    );
    expect(resolveHost('auto', {}, probes({ dorkos: down('x') }), 'codex').why).toMatch(
      /plain codex/
    );
  });
});

describe('resolveHost with a runtime', () => {
  // A named host that cannot run the runtime is an error naming the host, the
  // runtime and the reason, even when its probe passed: never another host.
  it('a named host that cannot run the runtime is an error, never a fallback', () => {
    const run = () => resolveHost('cmux', inCmux, probes(), 'codex');
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/cmux host was asked for but cannot run codex: .*use --host cli/);
  });

  // auto skips a host that is up but cannot run the runtime: inside cmux, a
  // codex or opencode session goes to the next host that can run it.
  it('auto skips cmux for codex and opencode even inside cmux', () => {
    expect(resolveHost('auto', inCmux, probes(), 'codex').host).toBe('dorkos');
    expect(
      resolveHost('auto', inCmux, probes({ dorkos: down('no DorkOS') }), 'opencode').host
    ).toBe('cli');
    expect(resolveHost('auto', inCmux, probes(), 'claude-code').host).toBe('cmux');
  });

  // auto with no host that both runs the runtime and is up names each reason,
  // including why cmux was never an option.
  it('auto with no usable host lists the support reason beside the probe reasons', () => {
    const run = () =>
      resolveHost(
        'auto',
        inCmux,
        probes({ dorkos: down('no DorkOS'), cli: down('the `opencode` binary is not on PATH') }),
        'opencode'
      );
    expect(run).toThrow(/No host can start opencode sessions/);
    expect(run).toThrow(
      /cmux: cmux starts interactive Claude Code sessions only today.*dorkos: no DorkOS.*cli: the `opencode` binary/
    );
  });
});

describe('supportMatrix', () => {
  // The matrix is the one table every launcher and resolution reads: cmux runs
  // claude-code only, with the reason; cli and dorkos run all three.
  it('lists every host × runtime pair with its support and reason', () => {
    const rows = supportMatrix();
    expect(rows).toHaveLength(9);
    const unsupported = rows.filter((r) => !r.ok);
    expect(unsupported.map((r) => `${r.host}:${r.runtime}`)).toEqual([
      'cmux:codex',
      'cmux:opencode',
    ]);
    for (const row of unsupported) expect(row.reason).toBe(CMUX_CLAUDE_ONLY_REASON);
    expect(supportFor('cli', 'opencode')).toEqual({ ok: true });
  });
});
