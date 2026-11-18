import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IntakeSchema } from '../scripts/config-schema.ts';

/** Tiny inputs discriminate early rejection without allocating an attack payload. */
const collections = [
  {
    name: 'array.max',
    schema: (visit: () => boolean) => z.array(z.string().refine(visit)).max(2),
    oversized: ['a', 'b', 'c'],
    valid: ['a', 'b'],
    validVisits: 2,
  },
  {
    name: 'array.length',
    schema: (visit: () => boolean) => z.array(z.string().refine(visit)).length(2),
    oversized: ['a', 'b', 'c'],
    valid: ['a', 'b'],
    validVisits: 2,
  },
  {
    name: 'set.max',
    schema: (visit: () => boolean) => z.set(z.string().refine(visit)).max(2),
    oversized: new Set(['a', 'b', 'c']),
    valid: new Set(['a', 'b']),
    validVisits: 2,
  },
  {
    name: 'set.size',
    schema: (visit: () => boolean) => z.set(z.string().refine(visit)).size(2),
    oversized: new Set(['a', 'b', 'c']),
    valid: new Set(['a', 'b']),
    validVisits: 2,
  },
  {
    name: 'map.max',
    schema: (visit: () => boolean) =>
      z.map(z.string().refine(visit), z.string().refine(visit)).max(2),
    oversized: new Map([
      ['a', 'one'],
      ['b', 'two'],
      ['c', 'three'],
    ]),
    valid: new Map([
      ['a', 'one'],
      ['b', 'two'],
    ]),
    validVisits: 4,
  },
  {
    name: 'map.size',
    schema: (visit: () => boolean) =>
      z.map(z.string().refine(visit), z.string().refine(visit)).size(2),
    oversized: new Map([
      ['a', 'one'],
      ['b', 'two'],
      ['c', 'three'],
    ]),
    valid: new Map([
      ['a', 'one'],
      ['b', 'two'],
    ]),
    validVisits: 4,
  },
];

describe('patched runtime collection limits', () => {
  it.each(collections)('$name rejects oversized input before visiting elements', (collection) => {
    let visits = 0;
    const schema = collection.schema(() => {
      visits++;
      return true;
    });
    const result = schema.safeParse(collection.oversized);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('The oversized collection was accepted.');
    expect(result.error.issues).toMatchObject([{ code: 'too_big' }]);
    expect(visits).toBe(0);
  });

  it.each(collections)('$name still parses a small valid collection', (collection) => {
    let visits = 0;
    const schema = collection.schema(() => {
      visits++;
      return true;
    });
    expect(schema.parse(collection.valid)).toEqual(collection.valid);
    expect(visits).toBe(collection.validVisits);
  });

  it('rejects an over-limit intake through the actual Flow config schema', () => {
    const result = IntakeSchema.safeParse({
      sources: Array.from({ length: 21 }, (_, index) => ({
        kind: 'github',
        repo: `owner/repo${index}`,
      })),
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('The oversized intake was accepted.');
    expect(result.error.issues).toMatchObject([{ code: 'too_big', path: ['sources'] }]);
  });

  it('preserves a small valid intake and its resolved defaults', () => {
    expect(IntakeSchema.parse({ sources: [{ kind: 'github', repo: 'owner/repo' }] })).toEqual({
      sources: [{ kind: 'github', repo: 'owner/repo', labels: [], limit: 30 }],
    });
  });
});
