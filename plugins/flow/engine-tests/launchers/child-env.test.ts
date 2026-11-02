import { describe, expect, it } from 'vitest';
import { childEnv } from '../../scripts/launchers/common.ts';
import { detectRuntime } from '../../scripts/runtime-detect.ts';

const dorkosClaudeTurn = {
  PATH: '/synthetic/bin',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  FLOW_RUNTIME: 'claude-code',
  FLOW_HARNESS: 'dorkos',
};

describe('childEnv names the child, not its parent', () => {
  it('a Codex worker started from a DorkOS Claude Code chat is Codex', () => {
    const env = childEnv(dorkosClaudeTurn, 'codex', '/synthetic/codex', '/synthetic/home');
    expect(detectRuntime({ ...env, CODEX_THREAD_ID: 't' })).toMatchObject({
      runtime: 'codex',
      harness: 'codex',
      source: 'override',
      markers: ['codex'],
    });
    expect(env.PATH).toBe('/synthetic/bin');
  });

  it('a Claude Code worker from the same chat is no longer labelled as hosted by DorkOS', () => {
    const env = childEnv(dorkosClaudeTurn, 'claude-code', '/synthetic/claude', '/synthetic/home');
    expect(detectRuntime(env)).toMatchObject({ runtime: 'claude-code', harness: 'claude-code' });
  });

  it('still removes the credentials the runtime must not inherit', () => {
    const env = childEnv(
      { ...dorkosClaudeTurn, ANTHROPIC_API_KEY: 'synthetic' },
      'claude-code',
      '/synthetic/claude',
      '/synthetic/home'
    );
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});
