/**
 * How long to pause (spec `flow-multiproject` §5.3): "Until tomorrow 9am" is
 * 09:00 local on the next calendar day, even when chosen before 09:00; "For 1
 * hour" is an hour on; "Until I resume" sends no end; and the end carries the
 * browser's own offset.
 */

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PAUSE_CHOICES, PauseMenu, isoWithOffset, pauseUntil } from '../pause-menu.ts';

describe('pauseUntil', () => {
  it('ends "until tomorrow 9am" at 09:00 on the next calendar day, at 08:00 and at 22:00', () => {
    for (const hour of [8, 22]) {
      const now = new Date(2026, 8, 28, hour, 0);
      const until = pauseUntil('tomorrow', now)!;
      expect(Date.parse(until)).toBe(new Date(2026, 8, 29, 9, 0).getTime());
    }
  });

  it('ends "for 1 hour" an hour on, and "until I resume" never', () => {
    const now = new Date(2026, 8, 28, 10, 30);
    expect(Date.parse(pauseUntil('hour', now)!)).toBe(now.getTime() + 60 * 60_000);
    expect(pauseUntil('resume', now)).toBeNull();
  });

  it("writes the end with the browser's offset, which flow's engine needs", () => {
    const text = isoWithOffset(new Date(2026, 8, 29, 9, 0));
    expect(text).toMatch(/^2026-09-29T09:00:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(text)).toBe(new Date(2026, 8, 29, 9, 0).getTime());
  });
});

describe('PauseMenu', () => {
  it('offers the three choices, focuses the default, and moves with the arrow keys', () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    const now = () => new Date(2026, 8, 28, 10, 0);
    render(React.createElement(PauseMenu, { label: 'Pause', onChoose, onClose, now }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(PAUSE_CHOICES.map((c) => c.label));
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'ArrowUp' });
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.click(items[2]);
    expect(onChoose).toHaveBeenCalledWith(null);
    fireEvent.keyDown(items[2], { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
