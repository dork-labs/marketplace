/**
 * `behaviour.json` (spec `flow-multiproject` §9.3): the level of what a
 * project's own flow does unattended that the Flow extension relies on. The
 * extension compares a project's level with its own and names the first
 * effect the project lacks ("dorkos runs an older flow, so timed pauses may
 * not end on time"), so every level must name its effect.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'behaviour.json');

interface Behaviour {
  v: number;
  behaviour: number;
  changes: { level: number; effect: string }[];
}

const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Behaviour;

describe('behaviour.json', () => {
  // Purpose: a bump that forgets to name its effect would leave the extension
  // with nothing to tell a person about a project on an older flow.
  it('names the effect of every level, and its level is the last change', () => {
    expect(parsed.v).toBe(1);
    expect(parsed.changes.length).toBeGreaterThan(0);
    expect(parsed.behaviour).toBe(parsed.changes.at(-1)?.level);
  });

  // Purpose: the extension finds "the first level the project lacks" by walking
  // the list in order, so levels must count up from 1 with no gap.
  it('lists the levels in order from 1, each with a plain effect', () => {
    parsed.changes.forEach((change, index) => {
      expect(change.level).toBe(index + 1);
      expect(change.effect.trim()).not.toBe('');
      expect(change.effect).not.toMatch(/`|^[A-Z]|\.$/);
    });
  });
});
