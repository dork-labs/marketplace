/**
 * Answering and starting work from flow's own surfaces (spec
 * `flow-multiproject` §3.2, §3.3, §7.4, §7.6, §7.9): an ask's buttons read as
 * outcomes and answer through core's `answerDecision` (or flow's route on a
 * DorkOS without the inbox); a review gate goes to Activity where the inbox
 * exists; "Sign in", "Sort them", "Connect a tracker" and "Set up flow here"
 * start work in a new chat with `api.startWork`, and fall back to what to
 * type on a DorkOS without it; the adapter's allow line; the dial's line for
 * a project flow knew before.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionActions, ProjectRef, ReadableState } from '../../lib/host-types.ts';
import type { FlowDecision, FlowModel } from '../../lib/model.ts';
import { SET_UP_HERE_TEXT } from '../all-projects.ts';
import {
  ALREADY_SETTLED_TEXT,
  DecisionAnswers,
  StartButton,
  sendAnswer,
  watchRoute,
} from '../answers.ts';
import { createFlowTab } from '../flow-tab.ts';
import { CHOOSE_AUTONOMY_TEXT, NOT_SET_UP_TEXT, SORT_WAITS_TEXT } from '../project-lens.ts';
import { FlowStore } from '../store.ts';
import { flowModel, flowProject, routeFetch } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An open ask. */
function ask(actions: DecisionActions, extra: Partial<FlowDecision> = {}): FlowDecision {
  return {
    key: 'idle:3f2a00000000',
    project: 'dorkos',
    kind: 'ideas',
    title: "12 new ideas haven't been sorted",
    detail: null,
    identifier: null,
    raisedAt: '2026-09-28T09:00:00.000Z',
    actions,
    answerIn: 'flow',
    why: 'Flow has had nothing ready to work on in dorkos for a day.',
    defaultChoice: null,
    decideBy: null,
    ...extra,
  };
}

/** A host with the inbox: core lists the ask under its own id and answers it. */
function inboxHost(keys: string[], result: Record<string, unknown> = {}) {
  return {
    navigate: vi.fn(),
    listDecisions: vi.fn(async () => keys.map((key) => ({ id: `core-${key}`, key }) as never)),
    answerDecision: vi.fn(async () => ({
      resolved: true,
      message: null,
      navigate: null,
      watch: null,
      ...result,
    })),
  };
}

describe('sending an answer', () => {
  it("answers through core by core's id where DorkOS has the inbox", async () => {
    const api = inboxHost(['idle:3f2a00000000']);
    const result = await sendAnswer(api, ask({ kind: 'word', label: 'Sort them' }), {
      action: 'word',
    });
    expect(api.answerDecision).toHaveBeenCalledWith('core-idle:3f2a00000000', { action: 'word' });
    expect(result.resolved).toBe(true);
    expect(
      await sendAnswer(inboxHost([]), ask({ kind: 'word', label: 'x' }), { action: 'word' })
    ).toEqual({
      resolved: false,
      message: ALREADY_SETTLED_TEXT,
      watch: null,
    });
  });

  it("answers through flow's own route on a DorkOS without the inbox", async () => {
    const model = flowModel([flowProject('dorkos')]);
    const fetch = routeFetch(() => ({
      status: 200,
      body: { resolved: true, message: null, watch: null, model },
    }));
    const store = new FlowStore({});
    const apply = vi.spyOn(store, 'apply');
    await sendAnswer(
      { navigate: vi.fn() },
      ask({ kind: 'word', label: 'x' }),
      { action: 'word' },
      store
    );
    expect(fetch.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/ext/flow/decisions/idle%3A3f2a00000000',
      body: { action: 'word' },
    });
    expect(apply).toHaveBeenCalledWith(model);
  });
});

describe("an ask's buttons", () => {
  it('reads 👎/👍 as outcomes and asks for a note before sending back', async () => {
    const api = inboxHost(['k']);
    render(
      React.createElement(DecisionAnswers, {
        decision: ask(
          {
            kind: 'yes-no',
            approveLabel: 'Fix it',
            rejectLabel: 'Leave it',
            rejectAsksForNote: true,
          },
          { key: 'k', kind: 'retry' }
        ),
        root: '/work/dorkos',
        api,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: '👎 Leave it' }));
    expect(api.answerDecision).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change?' }), {
      target: { value: 'Not now, the release is out.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Leave it' }));
    });
    expect(api.answerDecision).toHaveBeenCalledWith('core-k', {
      action: 'reject',
      note: 'Not now, the release is out.',
    });
  });

  it("marks the agent's pick among a question's chips, and sends a reply", async () => {
    const api = inboxHost(['q']);
    render(
      React.createElement(DecisionAnswers, {
        decision: ask(
          {
            kind: 'choice',
            choices: [
              { id: 'c1', label: 'Keep it' },
              { id: 'c2', label: 'Remove it' },
            ],
            defaultChoice: 'c1',
            decideBy: '2026-09-28T17:00:00.000Z',
            allowReply: true,
          },
          { key: 'q', kind: 'question' }
        ),
        root: null,
        api,
      })
    );
    expect(screen.getByRole('button', { name: "Keep it · agent's pick" })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reply…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'Keep it for one release.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(api.answerDecision).toHaveBeenCalledWith('core-q', {
      action: 'choice',
      text: 'Keep it for one release.',
    });
  });

  it('shows "Sorting 12 ideas… · Watch" after a start, and Watch opens the new chat', async () => {
    const api = inboxHost(['idle:3f2a00000000'], {
      watch: { sessionId: 'chat-9', label: 'Sorting 12 ideas…' },
    });
    render(
      React.createElement(DecisionAnswers, {
        decision: ask({ kind: 'word', label: 'Sort them' }),
        root: '/work/dorkos',
        api,
      })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sort them' }));
    });
    expect(screen.getByText(/Sorting 12 ideas…/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    expect(api.navigate).toHaveBeenCalledWith(watchRoute('chat-9', '/work/dorkos'));
    expect(watchRoute('chat-9', '/work/dorkos')).toBe(
      '/session?session=chat-9&dir=%2Fwork%2Fdorkos'
    );
  });
});

describe('starting work', () => {
  it('starts the work in a new chat with a plain title and reason, never the prompt as a headline', async () => {
    const startWork = vi.fn(async () => ({ sessionId: 'chat-1' }));
    const api = { navigate: vi.fn(), startWork };
    render(
      React.createElement(StartButton, {
        kind: 'sort',
        label: 'Sort them',
        project: { name: 'dorkos', root: '/work/dorkos' },
        count: 12,
        api,
      })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sort them' }));
    });
    expect(startWork).toHaveBeenCalledWith({
      project: '/work/dorkos',
      prompt: '/flow:triage',
      title: 'Sorting 12 new ideas in dorkos',
      reason: '12 new ideas were waiting to be sorted',
    });
    expect(screen.getByText(/Sorting 12 ideas…/)).toBeTruthy();
    expect(screen.queryByText('/flow:triage')).toBeNull();
  });

  it("shows DorkOS's refusal in plain words", async () => {
    const startWork = vi.fn(async () =>
      Promise.reject(
        Object.assign(new Error('Flow started 10 chats in the last hour.'), { code: 'start_limit' })
      )
    );
    render(
      React.createElement(StartButton, {
        kind: 'sign-in',
        label: 'Sign in',
        project: { name: 'dorkos', root: '/work/dorkos', tracker: 'Linear' },
        api: { navigate: vi.fn(), startWork },
      })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Flow started 10 chats in the last hour.');
  });

  it('is absent on a DorkOS that cannot start a chat', () => {
    const { container } = render(
      React.createElement(StartButton, {
        kind: 'connect',
        label: 'Connect a tracker',
        project: { name: 'dorkos', root: '/work/dorkos' },
        api: { navigate: vi.fn() },
      })
    );
    expect(container.textContent).toBe('');
  });
});

/** Render the Flow tab beside a chat in `project`. */
async function renderTab(
  model: FlowModel,
  api: Record<string, unknown>,
  project: ProjectRef | null
) {
  routeFetch(() => ({ status: 200, body: model }));
  const state: ReadableState = { currentCwd: project?.root ?? '/x', currentProject: project };
  const host = { navigate: vi.fn(), getState: () => state, ...api };
  const store = new FlowStore(host);
  store.start();
  const Tab = createFlowTab(host as never, store);
  render(React.createElement(Tab));
  await act(async () => {});
  return host;
}

const DORKOS: ProjectRef = { root: '/work/dorkos', name: 'dorkos' };

describe('the lens', () => {
  it('puts a Sign in button on the condition line where DorkOS can start a chat, else says what to type', async () => {
    const signIn = flowProject('dorkos', {
      conditions: [
        { kind: 'sign-in', since: '2026-09-28T09:14:00.000Z', escalated: true, detail: {} },
      ],
    });
    const startWork = vi.fn(async () => ({ sessionId: 'chat-1' }));
    await renderTab(flowModel([signIn]), { startWork }, DORKOS);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(startWork).toHaveBeenCalledWith(
      expect.objectContaining({ project: '/work/dorkos', title: 'Signing in to Linear for dorkos' })
    );
    document.body.innerHTML = '';
    await renderTab(flowModel([signIn]), {}, DORKOS);
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('offers "Connect a tracker" for a project flow is installed in but not set up', async () => {
    const startWork = vi.fn(async () => ({ sessionId: 'chat-2' }));
    await renderTab(
      flowModel([flowProject('dorkos', { setup: 'not-set-up', tracker: null })]),
      { startWork },
      DORKOS
    );
    expect(screen.getByText(NOT_SET_UP_TEXT)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect a tracker' }));
    });
    expect(startWork).toHaveBeenCalledWith(expect.objectContaining({ prompt: '/flow:init' }));
  });

  it("asks before running a project's own adapter, and records the allow", async () => {
    const model = flowModel([flowProject('dorkos', { upNext: 'own-code' })]);
    const fetch = routeFetch(() => ({ status: 200, body: model }));
    const state: ReadableState = { currentCwd: DORKOS.root, currentProject: DORKOS };
    const host = { navigate: vi.fn(), getState: () => state };
    const store = new FlowStore(host);
    store.start();
    render(React.createElement(createFlowTab(host, store)));
    await act(async () => {});
    expect(
      screen.getByText(
        "Read Linear with this project's own adapter? It runs code from this repo.",
        {
          exact: false,
        }
      )
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    });
    expect(fetch.calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/ext/flow/projects/dorkos/allow-adapter',
    });
  });

  it('shows the dial line for a project flow knew before, and the sorting-waits line', async () => {
    const host = await renderTab(
      flowModel([
        flowProject('dorkos', {
          sortWaits: true,
          autonomy: {
            chosen: false,
            firstSeen: 'existing',
            stops: { ship: 'ask', questions: 'ask', sort: 'ask', retry: 'tell' },
          },
        }),
      ]),
      { registerPage: vi.fn() },
      DORKOS
    );
    expect(screen.getByText(CHOOSE_AUTONOMY_TEXT, { exact: false })).toBeTruthy();
    expect(screen.getByText(SORT_WAITS_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose how much →' }));
    expect(host.navigate).toHaveBeenCalledWith('/x/flow/p/dorkos/settings');
  });

  it("shows the project's asks at the top on a DorkOS without the inbox, and not with it", async () => {
    const model = flowModel([flowProject('dorkos')], {
      decisions: [ask({ kind: 'word', label: 'Sort them' })],
    });
    await renderTab(model, {}, DORKOS);
    expect(screen.getByText("12 new ideas haven't been sorted")).toBeTruthy();
    document.body.innerHTML = '';
    await renderTab(model, inboxHost([]), DORKOS);
    expect(screen.queryByText("12 new ideas haven't been sorted")).toBeNull();
  });
});

describe('the all-projects lens', () => {
  it('starts setting up flow in a repo without it, in a new chat', async () => {
    const startWork = vi.fn(async () => ({ sessionId: 'chat-3' }));
    await renderTab(
      flowModel([flowProject('blintz')]),
      { startWork },
      { root: '/work/app', name: 'app' }
    );
    expect(screen.getByText(SET_UP_HERE_TEXT, { exact: false })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up flow here' }));
    });
    expect(startWork).toHaveBeenCalledWith(
      expect.objectContaining({ project: '/work/app', title: 'Setting up flow in app' })
    );
  });
});
