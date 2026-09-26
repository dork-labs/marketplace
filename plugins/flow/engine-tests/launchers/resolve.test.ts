/**
 * Host resolution (spec `flow-handoff-dispatch` §2.2, task 2.1): the
 * preference order, a named host that is down (an error with its reason and
 * never a fallback), and the `auto` order cmux, dorkos, cli.
 */

import { describe, expect, it } from 'vitest';

import { ConfigError, UsageError } from '../../scripts/errors.ts';
import { hostPreference, resolveHost } from '../../scripts/launchers/resolve.ts';
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
    expect(resolveHost('cli', inCmux, probes()).host).toBe('cli');
    expect(resolveHost('dorkos', {}, probes()).host).toBe('dorkos');
  });

  // The DOR-2372 validation: a missing host is reported, not guessed.
  it('a named host that is down is an error with its reason, never a fallback', () => {
    const run = () =>
      resolveHost(
        'dorkos',
        {},
        probes({ dorkos: down('DorkOS is not answering at http://127.0.0.1:4242') })
      );
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/DorkOS is not answering at http:\/\/127\.0\.0\.1:4242/);
  });

  // auto: cmux only when the supervisor itself runs inside cmux.
  it('auto picks cmux inside cmux, and skips it outside', () => {
    expect(resolveHost('auto', inCmux, probes())).toMatchObject({ host: 'cmux' });
    expect(resolveHost('auto', {}, probes())).toMatchObject({ host: 'dorkos' });
    expect(resolveHost('auto', { CMUX_SURFACE_ID: '' }, probes())).toMatchObject({
      host: 'dorkos',
    });
  });

  // auto: a failing probe moves on down the order.
  it('auto falls through cmux, then dorkos, to cli', () => {
    expect(resolveHost('auto', inCmux, probes({ cmux: down('cmux is not running') })).host).toBe(
      'dorkos'
    );
    expect(resolveHost('auto', {}, probes({ dorkos: down('no DorkOS') })).host).toBe('cli');
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
        })
      );
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/cmux: cmux is not running.*dorkos: no DorkOS.*cli: no claude/);
  });

  // The why is a sentence for the drain's first line.
  it('says why', () => {
    expect(resolveHost('auto', {}, probes({ dorkos: down('x') })).why).toMatch(/plain claude/);
  });
});
