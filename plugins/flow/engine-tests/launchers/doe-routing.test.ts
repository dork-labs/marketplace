import { describe, expect, it } from 'vitest';
import { detectRuntime } from '../../scripts/runtime-detect.ts';
import { resolveHost } from '../../scripts/launchers/resolve.ts';

describe('Dork runtime routing', () => {
  it('records a Dork supervisor without inheriting another runtime identity', () => {
    expect(
      detectRuntime({ FLOW_RUNTIME: 'doe', FLOW_HARNESS: 'dorkos', CLAUDECODE: '1' })
    ).toMatchObject({ runtime: 'doe', harness: 'dorkos', source: 'override' });
  });

  it('auto selects DorkOS and never substitutes a vendor CLI', () => {
    const probes = {
      cli: { ok: true as const },
      cmux: { ok: true as const },
      dorkos: { ok: true as const },
    };
    expect(resolveHost('auto', { CMUX_SURFACE_ID: 'example' }, probes, 'doe').host).toBe('dorkos');
    expect(() =>
      resolveHost('auto', {}, { ...probes, dorkos: { ok: false, reason: 'offline' } }, 'doe')
    ).toThrow(/offline/);
  });
});
