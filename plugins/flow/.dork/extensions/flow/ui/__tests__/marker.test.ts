/**
 * The Flow tab's dot (spec `flow-multiproject` §3.4): on for a waiting
 * decision or when every set-up project is paused, off for anything else
 * (a plain condition included), sent only when it changes, and never on a
 * DorkOS without tab markers.
 */

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowDecision } from '../../lib/model.ts';
import { PANEL_TAB_ID, followMarker, markerFor } from '../marker.ts';
import { FlowStore } from '../store.ts';
import { flowModel, flowProject, routeFetch } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const PAUSED = { since: '2026-09-28T08:00:00.000Z', until: null };

/** A review gate waiting in `project`. */
function decision(project: string): FlowDecision {
  return {
    key: `review:${project}`,
    project,
    kind: 'review',
    title: 'Ship the new out-of-usage banner?',
    detail: null,
    identifier: 'DOR-2387',
    raisedAt: '2026-09-28T09:00:00.000Z',
    actions: {
      kind: 'yes-no',
      approveLabel: 'Ship it',
      rejectLabel: 'Send it back',
      rejectAsksForNote: true,
    },
    answerIn: 'activity',
    shown: '',
    why: "It's built, tests pass, and the reviewer agent found nothing.",
    defaultChoice: null,
    decideBy: null,
  };
}

describe('markerFor', () => {
  it('is on when a decision waits', () => {
    expect(markerFor(flowModel([flowProject('dorkos')], { decisions: [decision('dorkos')] }))).toBe(
      'attention'
    );
  });

  it('is on when every set-up project is paused, and off when one still runs', () => {
    const notSetUp = flowProject('fresh', { setup: 'not-set-up' });
    expect(markerFor(flowModel([flowProject('dorkos', { pause: PAUSED }), notSetUp]))).toBe(
      'attention'
    );
    expect(
      markerFor(flowModel([flowProject('dorkos', { pause: PAUSED }), flowProject('blintz')]))
    ).toBeNull();
  });

  it('stays off for a condition flow fixes on its own, for no projects, and before a model', () => {
    const slow = flowProject('dorkos', {
      conditions: [
        {
          kind: 'tracker-unreachable',
          since: '2026-09-28T09:14:00.000Z',
          escalated: false,
          detail: {},
        },
      ],
    });
    expect(markerFor(flowModel([slow]))).toBeNull();
    expect(markerFor(flowModel([notReady()]))).toBeNull();
    expect(markerFor(flowModel([]))).toBeNull();
    expect(markerFor(null)).toBeNull();
  });
});

/** A project that is installed but not set up, and so never counts as paused. */
function notReady() {
  return flowProject('fresh', { setup: 'not-set-up', pause: PAUSED });
}

describe('followMarker', () => {
  it('sets the dot when something needs you, clears it after, and sends only changes', async () => {
    const quiet = flowModel([flowProject('dorkos')]);
    routeFetch(() => ({ status: 200, body: quiet }));
    const store = new FlowStore({});
    const setTabMarker = vi.fn();
    const stop = followMarker({ setTabMarker }, store);
    store.apply(quiet);
    expect(setTabMarker).not.toHaveBeenCalled();
    store.apply(flowModel([flowProject('dorkos')], { decisions: [decision('dorkos')] }));
    store.apply(flowModel([flowProject('dorkos')], { decisions: [decision('dorkos')] }));
    expect(setTabMarker.mock.calls).toEqual([[PANEL_TAB_ID, 'attention']]);
    store.apply(quiet);
    expect(setTabMarker.mock.calls.at(-1)).toEqual([PANEL_TAB_ID, null]);
    stop();
    store.apply(flowModel([flowProject('dorkos')], { decisions: [decision('dorkos')] }));
    expect(setTabMarker).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });

  it('does nothing on a DorkOS without tab markers', () => {
    const store = new FlowStore({});
    const stop = followMarker({}, store);
    expect(() =>
      store.apply(flowModel([flowProject('dorkos')], { decisions: [decision('dorkos')] }))
    ).not.toThrow();
    stop();
  });
});
