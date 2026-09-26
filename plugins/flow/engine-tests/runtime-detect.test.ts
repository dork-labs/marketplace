/**
 * `detectRuntime` (scripts/runtime-detect.ts): which agent runtime and harness
 * a flow process runs under, from the markers each runtime sets in the shell
 * its agent runs commands in. One case per runtime, the overrides, the nested
 * (inherited) case, and the fallbacks.
 */

import { describe, expect, it } from 'vitest';

import { childRuntimeEnv, detectRuntime } from '../scripts/runtime-detect.ts';

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

  it('keeps FLOW_RUNTIME authoritative: Claude Code started by a Codex launcher is Claude Code', () => {
    // The child inherits CODEX_THREAD_ID; the launcher's override names it.
    expect(
      detectRuntime({ CODEX_THREAD_ID: 't', CLAUDECODE: '1', FLOW_RUNTIME: 'claude-code' })
    ).toMatchObject({ runtime: 'claude-code', source: 'override' });
  });

  it('childRuntimeEnv drops every marker and stale override, and names the child', () => {
    const parent = {
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CODEX_THREAD_ID: 't',
      OPENCODE: '1',
      FLOW_RUNTIME: 'claude-code',
      FLOW_HARNESS: 'cmux',
      UNSET: undefined,
    };
    const child = childRuntimeEnv(parent, 'codex', 'dorkos');
    expect(child).toEqual({ PATH: '/bin', FLOW_RUNTIME: 'codex', FLOW_HARNESS: 'dorkos' });
    expect(parent.CLAUDECODE).toBe('1');
    // Once the child runtime adds its own marker, detection agrees with the launcher.
    expect(detectRuntime({ ...child, CODEX_THREAD_ID: 'thr' })).toMatchObject({
      runtime: 'codex',
      harness: 'dorkos',
      markers: ['codex'],
    });
    expect(childRuntimeEnv(parent, 'opencode')).not.toHaveProperty('FLOW_HARNESS');
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
    expect(detectRuntime({ CLAUDECODE: '1', FLOW_HARNESS: 'a b/../c' })).toMatchObject({
      harness: 'claude-code',
      invalidHarnessOverride: 'a b/../c',
    });
  });

  it('reads this process’s environment by default', () => {
    expect(detectRuntime()).toHaveProperty('runtime');
  });
});
