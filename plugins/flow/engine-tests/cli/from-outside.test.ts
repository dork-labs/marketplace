/**
 * `agent/from-outside` (DOR-3258, Security's Must on #128): an item captured
 * from a GitHub issue is never readied by anything flow runs. `flow create`
 * may put the label on; no flow write takes it off (ready, park, claim);
 * dispatch never picks it. Only a person, or the PM in its own triage, clears
 * it, by editing the tracker. Closing it is the one write flow still allows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import { AGENT_FROM_OUTSIDE } from '../../scripts/work-state.ts';
import { item, makeProject, runFlow, type WriteProject } from './write-harness.ts';

let project: WriteProject;

beforeEach(() => {
  project = makeProject();
});

afterEach(() => project.cleanup());

/** A captured issue, as triage files it: an idea carrying the label and the issue's tag. */
const captured = () =>
  item('FAKE-1', {
    title: 'Let people export the report as CSV [acme/app#7]',
    type: 'idea',
    stateCategory: 'backlog',
    stateName: 'Triage',
    labels: ['type/idea', AGENT_FROM_OUTSIDE],
    agentDisposition: undefined,
  });

describe('agent/from-outside', () => {
  it('triage names the label when it refuses, so the reader knows who may clear it', async () => {
    const result = await runFlow(project, { items: [captured()] }, [
      'triage',
      'FAKE-1',
      '--ready',
      '--stage',
      'execute',
    ]);
    expect(result.stderr + result.stdout).toMatch(/agent\/from-outside[\s\S]*only a person/);
  });

  it.each([
    ['ready it', ['triage', 'FAKE-1', '--ready', '--stage', 'execute']],
    ['park it', ['triage', 'FAKE-1', '--park', 'What do you mean?']],
    ['claim it', ['claim', 'FAKE-1']],
  ])('no flow write may %s: refused before any tracker write', async (_what, argv) => {
    const result = await runFlow(project, { items: [captured()] }, argv);
    expect(result.code).toBe(EXIT.precondition);
    expect(result.tracker.calls).toEqual([]);
    expect(result.tracker.backlog.items[0].labels).toEqual(['type/idea', AGENT_FROM_OUTSIDE]);
  });

  it('the next triage leaves it un-readied, and flow next never picks it', async () => {
    // Step 3 of the daily triage takes only items with no agent/* label; flow next only agent/ready.
    const next = await runFlow(project, { items: [captured(), item('FAKE-2')] }, [
      'next',
      '-n',
      '5',
      '--no-account',
      '--manual',
    ]);
    expect(next.code).toBe(EXIT.ok);
    expect(JSON.stringify(next.json)).not.toContain('FAKE-1');
    expect(JSON.stringify(next.json)).toContain('FAKE-2');
  });

  it('once a person clears it in the tracker, flow may ready the item as usual', async () => {
    const cleared = { ...captured(), labels: ['type/idea'] };
    const result = await runFlow(project, { items: [cleared] }, [
      'triage',
      'FAKE-1',
      '--ready',
      '--stage',
      'execute',
    ]);
    expect(result.code).toBe(EXIT.ok);
  });
});
