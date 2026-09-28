import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelAccount, PanelModel, PanelRun } from '../../lib/panel.ts';
import {
  FALLBACK_POLL_MS,
  NOTHING_RUNNING_TEXT,
  PANEL_EVENT,
  PANEL_LOAD_FAILED_TEXT,
  SCHEDULES_OFF_TEXT,
  createFlowPanel,
  type PanelHostApi,
} from '../flow-panel.ts';
import { UNREACHABLE_MESSAGE } from '../api.ts';
import { formatResetDay } from '../panel-format.ts';
import { stubFetch } from './helpers.ts';

/** A stand-in for the browser's `EventSource`, recording every stream opened. */
class FakeEventSource {
  static opened: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  closed = false;
  /** `CONNECTING` (0) until {@link open}, then `OPEN` (1). */
  readyState = 0;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver one server-sent event. */
  send(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }

  /** Open (or reopen) the stream. */
  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get('open') ?? []) listener({});
  }

  /** Drop the stream; the browser goes back to connecting it. */
  fail(): void {
    this.readyState = 0;
    for (const listener of this.listeners.get('error') ?? []) listener({});
  }
}

/** A window with a reading. */
function win(usedPct: number | null, status: 'allowed' | 'rejected' = 'allowed') {
  return { usedPct, resetsAt: '2026-10-02T15:00:00.000Z', status };
}

/** An account row. */
function acct(id: string, extra: Partial<PanelAccount> = {}): PanelAccount {
  return {
    key: `claude-code:${id}`,
    runtime: 'claude-code',
    id,
    label: id,
    color: '#16a34a',
    windows: { five_hour: win(30), seven_day: win(55) },
    out: null,
    reserved: false,
    plan: null,
    ...extra,
  };
}

/** A run row. */
function run(identifier: string, extra: Partial<PanelRun> = {}): PanelRun {
  return {
    identifier,
    title: 'account chip',
    sessionId: `s-${identifier}`,
    cwd: '/work/app wt',
    accountKey: 'claude-code:Claude2',
    state: 'building',
    ...extra,
  };
}

/** A panel model. */
function model(extra: Partial<PanelModel> = {}): PanelModel {
  return {
    accounts: [acct('Claude2')],
    runs: [run('DOR-2387')],
    slots: { busy: 2, total: 3 },
    paused: 'none',
    canPause: true,
    schedulesOff: false,
    ...extra,
  };
}

let host: PanelHostApi & { navigate: ReturnType<typeof vi.fn> };

beforeEach(() => {
  FakeEventSource.opened = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  host = { navigate: vi.fn(), getState: () => ({ currentCwd: '/work/app' }) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Render the panel and wait for its first `GET /panel`. */
async function renderPanel() {
  const Panel = createFlowPanel(host);
  render(React.createElement(Panel));
  await act(async () => {});
}

describe('FlowPanel: accounts', () => {
  it('asks for the model with the chat folder, and shows each account with its bars', async () => {
    const stub = stubFetch({
      status: 200,
      body: model({
        accounts: [
          acct('Claude2'),
          acct('Claude4', { windows: { five_hour: win(20), seven_day: null } }),
        ],
      }),
    });
    await renderPanel();
    expect(stub.calls[0].url).toBe('/api/ext/flow/panel?cwd=%2Fwork%2Fapp');
    expect(screen.getByText('Accounts')).toBeTruthy();
    const row = screen.getByRole('button', {
      name: 'Claude2, 5-hour window 30% used, weekly 55% used',
    });
    expect(row.getAttribute('aria-haspopup')).toBe('dialog');
    const bars = within(row).getByRole('img');
    expect(bars.getAttribute('aria-label')).toBe('5-hour window 30% used, weekly 55% used');
    // An unreadable window is an empty track, never a 0% fill.
    const unknown = screen.getByRole('img', {
      name: '5-hour window 20% used, weekly usage unknown',
    });
    const [, week] = Array.from(unknown.children) as HTMLElement[];
    expect(week.dataset.tone).toBe('unknown');
    expect(week.children).toHaveLength(0);
  });

  it('colors bars by the host rule: amber from 70%, red when rejected or full', async () => {
    stubFetch({
      status: 200,
      body: model({
        accounts: [
          acct('A', { windows: { five_hour: win(69), seven_day: win(70) } }),
          acct('B', { windows: { five_hour: win(10, 'rejected'), seven_day: win(100) } }),
        ],
      }),
    });
    await renderPanel();
    const tones = (name: string) =>
      (Array.from(screen.getByRole('img', { name }).children) as HTMLElement[]).map(
        (track) => track.dataset.tone
      );
    expect(tones('5-hour window 69% used, weekly 70% used')).toEqual(['success', 'warning']);
    expect(tones('5-hour window 10% used, weekly 100% used')).toEqual(['error', 'error']);
    const fill = screen
      .getByRole('img', { name: '5-hour window 69% used, weekly 70% used' })
      .querySelector('b') as HTMLElement;
    expect(fill.style.width).toBe('69%');
    expect(fill.style.background).toBe('hsl(var(--status-success))');
  });

  it('says out with the reset day, or reserved, after the name', async () => {
    const resetsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    stubFetch({
      status: 200,
      body: model({
        accounts: [
          acct('Claude3', { out: { resetsAt } }),
          acct('Gone', { out: { resetsAt: null } }),
          acct('Main', { reserved: true }),
        ],
      }),
    });
    await renderPanel();
    const day = formatResetDay(resetsAt, new Date());
    expect(screen.getByText(`out · resets ${day}`)).toBeTruthy();
    expect(screen.getByText('out')).toBeTruthy();
    expect(screen.getByText('reserved')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Main, reserved, 5-hour window/ })).toBeTruthy();
  });

  it('opens a popover with the name, plan and each window, and Escape returns focus', async () => {
    stubFetch({ status: 200, body: model({ accounts: [acct('Claude2', { plan: 'max' })] }) });
    await renderPanel();
    const row = screen.getByRole('button', { name: /^Claude2,/ });
    fireEvent.click(row);
    const dialog = screen.getByRole('dialog', { name: 'Claude2' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(within(dialog).getByText('Max plan')).toBeTruthy();
    expect(within(dialog).getByText('5-hour')).toBeTruthy();
    expect(within(dialog).getByText('This week')).toBeTruthy();
    expect(within(dialog).getAllByText(/^30% · resets /)).toHaveLength(1);
    expect(within(dialog).getAllByText(/^55% · resets /)).toHaveLength(1);
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('closes on a press of the row that opened it, without reopening', async () => {
    stubFetch({ status: 200, body: model() });
    await renderPanel();
    const row = screen.getByRole('button', { name: /^Claude2,/ });
    fireEvent.click(row);
    // A press on the opener is its own toggle, not a press outside.
    fireEvent.pointerDown(row);
    expect(screen.getByRole('dialog', { name: 'Claude2' })).toBeTruthy();
    fireEvent.click(row);
    expect(screen.queryByRole('dialog')).toBeNull();
    // A press anywhere else closes it.
    fireEvent.click(row);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('FlowPanel: running', () => {
  it('shows each run with its account dot, name and pill', async () => {
    stubFetch({
      status: 200,
      body: model({
        runs: [
          run('DOR-2387'),
          run('DOR-2380', { title: null, state: 'in-review' }),
          run('DOR-2377', { state: 'waiting-on-you' }),
          run('DOR-2376', { state: 'handing-off' }),
          run('DOR-2375', { state: 'parked' }),
        ],
      }),
    });
    await renderPanel();
    expect(screen.getByText('Running')).toBeTruthy();
    const names = screen
      .getAllByRole('button')
      .filter((b) => b.dataset.row === 'run')
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      'DOR-2387 account chip, building',
      'DOR-2380, in review',
      'DOR-2377 account chip, waiting on you',
      'DOR-2376 account chip, handing off',
      'DOR-2375 account chip, parked',
    ]);
    const first = screen.getByRole('button', { name: 'DOR-2387 account chip, building' });
    expect(within(first).getByText('building')).toBeTruthy();
    const dot = first.querySelector('span[aria-hidden]') as HTMLElement;
    expect(dot.style.background).toBe('rgb(22, 163, 74)');
  });

  it('opens the session with the exact route on click', async () => {
    stubFetch({ status: 200, body: model() });
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'DOR-2387 account chip, building' }));
    expect(host.navigate).toHaveBeenCalledWith(
      '/session?session=s-DOR-2387&dir=%2Fwork%2Fapp%20wt'
    );
  });

  it('shows a queued run with no session as plain text', async () => {
    stubFetch({ status: 200, body: model({ runs: [run('DOR-1', { sessionId: null })] }) });
    await renderPanel();
    expect(screen.getByText('DOR-1 account chip')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /DOR-1/ })).toBeNull();
  });

  it('says nothing is running when there are no runs', async () => {
    stubFetch({ status: 200, body: model({ runs: [] }) });
    await renderPanel();
    expect(screen.getByText(NOTHING_RUNNING_TEXT)).toBeTruthy();
  });
});

describe('FlowPanel: pause', () => {
  it('pauses, then resumes, with the pressed state and slots text following', async () => {
    const stub = stubFetch({ status: 200, body: model() }, [
      { status: 200, body: model({ paused: 'all' }) },
      { status: 200, body: model({ schedulesOff: true }) },
    ]);
    await renderPanel();
    const pause = screen.getByRole('button', { name: 'Pause flow' });
    expect(pause.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('· 2 of 3 slots busy')).toBeTruthy();

    await act(async () => {
      fireEvent.click(pause);
    });
    expect(stub.calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/ext/flow/pause' });
    const resume = screen.getByRole('button', { name: 'Resume flow' });
    expect(resume.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('· paused')).toBeTruthy();

    await act(async () => {
      fireEvent.click(resume);
    });
    expect(stub.calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/ext/flow/resume' });
    expect(screen.getByRole('button', { name: 'Pause flow' })).toBeTruthy();
    expect(screen.getByText(SCHEDULES_OFF_TEXT)).toBeTruthy();
  });

  it('reads Pause flow when only some projects are paused', async () => {
    stubFetch({ status: 200, body: model({ paused: 'some' }) });
    await renderPanel();
    expect(screen.getByRole('button', { name: 'Pause flow' }).getAttribute('aria-pressed')).toBe(
      'false'
    );
  });

  it('disables the button when there is nothing to pause', async () => {
    const stub = stubFetch({ status: 200, body: model({ canPause: false, runs: [] }) });
    await renderPanel();
    const pause = screen.getByRole('button', { name: 'Pause flow' }) as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
    fireEvent.click(pause);
    expect(stub.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('says so when a pause fails', async () => {
    stubFetch({ status: 200, body: model() }, [
      {
        status: 502,
        body: { error: "Flow couldn't pause in app. Try again.", refusedBy: 'flow' },
      },
    ]);
    await renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause flow' }));
    });
    // A 5xx is never shown in flow's words: the tab's own message says nothing changed.
    expect(screen.getByRole('alert').textContent).toBe(UNREACHABLE_MESSAGE);
  });

  it("shows the fixed sentence, never flow's own words, and logs them to the console", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({ status: 200, body: model({ paused: 'all' }) }, [
      {
        status: 409,
        body: { error: 'fleet.json is locked; nothing was changed.', refusedBy: 'flow' },
      },
    ]);
    await renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume flow' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(
      "Flow didn't respond, so nothing was changed. Try again."
    );
    expect(screen.queryByText(/fleet\.json is locked/)).toBeNull();
    expect(logged).toHaveBeenCalledWith('[flow] pause/resume failed:', expect.any(Error));
    expect(String((logged.mock.calls[0][1] as Error).message)).toBe(
      'fleet.json is locked; nothing was changed.'
    );
    logged.mockRestore();
  });
});

describe('FlowPanel: loading and live updates', () => {
  it('offers Retry after a failed load, and loads again', async () => {
    const stub = stubFetch({ status: 500, body: {} });
    await renderPanel();
    expect(screen.getByRole('alert').textContent).toBe(PANEL_LOAD_FAILED_TEXT);
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    stub.calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => model() }))
    );
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(screen.getByRole('button', { name: 'Pause flow' })).toBeTruthy();
  });

  it('keeps Retry focused when the retried load fails too', async () => {
    stubFetch({ status: 500, body: {} });
    await renderPanel();
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('alert').textContent).toBe(PANEL_LOAD_FAILED_TEXT);
  });

  it('replaces the model on each panel event, and closes the stream on unmount', async () => {
    stubFetch({ status: 200, body: model() });
    const Panel = createFlowPanel(host);
    const view = render(React.createElement(Panel));
    await act(async () => {});
    const [source] = FakeEventSource.opened;
    expect(source.url).toBe('/api/events');
    act(() => {
      source.send(PANEL_EVENT, model({ runs: [run('DOR-9', { state: 'parked' })] }));
    });
    expect(screen.getByRole('button', { name: 'DOR-9 account chip, parked' })).toBeTruthy();
    expect(screen.queryByText('DOR-2387 account chip')).toBeNull();
    view.unmount();
    expect(source.closed).toBe(true);
  });

  it('re-reads every 30 seconds only while the stream is down, and stops once it reconnects', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stub = stubFetch({ status: 200, body: model() });
    await renderPanel();
    const [source] = FakeEventSource.opened;
    const gets = () => stub.calls.filter((c) => c.method === 'GET').length;
    const wait = async () => {
      await act(async () => {
        vi.advanceTimersByTime(FALLBACK_POLL_MS);
      });
    };
    // The load, then one read when the stream opens.
    await act(async () => source.open());
    await wait();
    expect(gets()).toBe(2);

    // Down: the stream is left to reconnect, and the panel polls meanwhile.
    act(() => source.fail());
    expect(source.closed).toBe(false);
    await wait();
    expect(gets()).toBe(3);
    await wait();
    expect(gets()).toBe(4);

    // Back: one read for what was missed, then polling stops.
    await act(async () => source.open());
    expect(gets()).toBe(5);
    await wait();
    await wait();
    expect(gets()).toBe(5);
  });

  it('does not poll for an error the stream recovers from while still open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stub = stubFetch({ status: 200, body: model() });
    await renderPanel();
    const [source] = FakeEventSource.opened;
    await act(async () => source.open());
    act(() => {
      for (const listener of source.listeners.get('error') ?? []) listener({});
    });
    await act(async () => {
      vi.advanceTimersByTime(FALLBACK_POLL_MS);
    });
    // The load and the read on open; no poll.
    expect(stub.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('reads the model again when the stream reopens, catching what was missed', async () => {
    const stub = stubFetch({ status: 200, body: model() });
    await renderPanel();
    const [source] = FakeEventSource.opened;
    act(() => source.fail());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => model({ runs: [run('DOR-7', { state: 'parked' })] }),
      }))
    );
    await act(async () => source.open());
    expect(stub.calls).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'DOR-7 account chip, parked' })).toBeTruthy();
  });
});
