/**
 * `detectRuntime` (scripts/runtime-detect.ts): which agent runtime and harness
 * a flow process runs under, from the markers each runtime sets in the shell
 * its agent runs commands in. One case per runtime, the overrides, the nested
 * (inherited) case, and the fallbacks.
 */

import { describe, expect, it } from 'vitest';

import { detectRuntime } from '../scripts/runtime-detect.ts';

describe('detectRuntime', () => {
  it.each([
    ['Claude Code (CLAUDECODE=1)', { CLAUDECODE: '1' }, 'claude-code'],
    ['Claude Code (entrypoint only)', { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, 'claude-code'],
    ['Codex (thread id)', { CODEX_THREAD_ID: 'thr_1' }, 'codex'],
    ['Codex (sandbox)', { CODEX_SANDBOX: 'seatbelt' }, 'codex'],
    ['Codex (network sandbox)', { CODEX_SANDBOX_NETWORK_DISABLED: '1' }, 'codex'],
    ['OpenCode', { OPENCODE: '1', OPENCODE_PID: '42' }, 'opencode'],
  ])('finds %s from its own marker', (_name, env, runtime) => {
    const got = detectRuntime(env);
    expect(got).toMatchObject({ runtime, harness: runtime, source: 'env', markers: [runtime] });
  });

  it('is unknown in a plain shell, hosted by the shell', () => {
    expect(detectRuntime({ PATH: '/usr/bin' })).toEqual({
      runtime: 'unknown',
      harness: 'shell',
      source: 'none',
      markers: [],
    });
  });

  it('ignores markers set to nothing, and OPENCODE other than 1', () => {
    expect(detectRuntime({ CODEX_THREAD_ID: '', OPENCODE: '0', CLAUDECODE: '' }).runtime).toBe(
      'unknown'
    );
  });

  it('picks the most specific runtime when a child inherits its parent’s markers', () => {
    // Codex started from inside Claude Code keeps CLAUDECODE=1.
    expect(detectRuntime({ CLAUDECODE: '1', CODEX_THREAD_ID: 't' })).toMatchObject({
      runtime: 'codex',
      markers: ['codex', 'claude-code'],
    });
    expect(detectRuntime({ CLAUDECODE: '1', OPENCODE: '1' }).runtime).toBe('opencode');
    expect(detectRuntime({ OPENCODE: '1', CODEX_SANDBOX: 'x' }).runtime).toBe('codex');
  });

  it('lets FLOW_RUNTIME and FLOW_HARNESS override everything', () => {
    expect(
      detectRuntime({
        CLAUDECODE: '1',
        CMUX_PANEL_ID: 'p',
        FLOW_RUNTIME: 'opencode',
        FLOW_HARNESS: 'DorkOS',
      })
    ).toMatchObject({
      runtime: 'opencode',
      harness: 'dorkos',
      source: 'override',
      markers: ['claude-code'],
    });
  });

  it('ignores an override that is not a runtime, and says so', () => {
    expect(detectRuntime({ FLOW_RUNTIME: 'gemini', CLAUDECODE: '1' })).toMatchObject({
      runtime: 'claude-code',
      source: 'env',
      invalidOverride: 'gemini',
    });
  });

  it('names cmux as the harness inside a cmux panel, and refuses an unsafe harness name', () => {
    expect(detectRuntime({ CLAUDECODE: '1', CMUX_PANEL_ID: 'p' }).harness).toBe('cmux');
    expect(detectRuntime({ CLAUDECODE: '1', FLOW_HARNESS: 'a b/../c' }).harness).toBe(
      'claude-code'
    );
  });

  it('reads this process’s environment by default', () => {
    expect(detectRuntime()).toHaveProperty('runtime');
  });
});
