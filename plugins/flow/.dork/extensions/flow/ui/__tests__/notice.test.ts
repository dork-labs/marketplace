import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InfoNotice, pickNotice, type NoticeKind } from '../notice.ts';
import { account, claudeGroup, codexGroup, fleet } from './helpers.ts';

describe('pickNotice', () => {
  const cases: [string, Parameters<typeof pickNotice>[0], NoticeKind | null][] = [
    [
      'no role stored',
      fleet([claudeGroup([account('A', 'rotation')])], { anyRoleStored: false }),
      'first-visit',
    ],
    [
      'no role stored beats nothing usable',
      fleet([claudeGroup([account('A', 'kept-out')])], { anyRoleStored: false }),
      'first-visit',
    ],
    [
      'no role stored beats nothing in rotation',
      fleet([claudeGroup([account('A', 'main'), account('B', 'kept-out')])], {
        anyRoleStored: false,
      }),
      'first-visit',
    ],
    [
      'every account kept out',
      fleet([claudeGroup([account('A', 'kept-out'), account('B', 'kept-out')])]),
      'nothing-usable',
    ],
    [
      'nothing usable beats nothing in rotation',
      fleet([claudeGroup([account('A', 'kept-out')]), codexGroup('kept-out')]),
      'nothing-usable',
    ],
    [
      "Codex's implicit account in Rotation is usable",
      fleet([claudeGroup([account('A', 'kept-out')]), codexGroup()]),
      null,
    ],
    [
      'a Main and nothing in rotation',
      fleet([claudeGroup([account('A', 'main'), account('B', 'kept-out')])]),
      'nothing-in-rotation',
    ],
    [
      "Codex's implicit Rotation does not count as rotation",
      fleet([claudeGroup([account('A', 'main'), account('B', 'kept-out')]), codexGroup()]),
      'nothing-in-rotation',
    ],
    [
      'a Main and a Rotation',
      fleet([claudeGroup([account('A', 'main'), account('B', 'rotation')])]),
      null,
    ],
    ['Rotation only, no Main', fleet([claudeGroup([account('A', 'rotation')])]), null],
  ];

  it.each(cases)('%s', (_name, body, expected) => {
    expect(pickNotice(body)).toBe(expected);
  });
});

describe('InfoNotice', () => {
  it('is a status in the host info tone, with no icon (the host Notice has none)', () => {
    render(React.createElement(InfoNotice, null, 'Hello'));
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe('Hello');
    expect(notice.getAttribute('data-tone')).toBe('info');
    expect(notice.querySelector('svg')).toBeNull();
    expect(notice.style.borderRadius).toBe('0.375rem');
    expect(notice.style.padding).toBe('0.5rem 0.75rem');
    expect(notice.style.background).toBe('hsl(var(--muted))');
    expect(notice.style.border).toBe('1px solid hsl(var(--border))');
  });
});
