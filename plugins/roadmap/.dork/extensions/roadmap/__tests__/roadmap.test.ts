import { describe, expect, it } from 'vitest';
import { cleanText, jsonErrorOffset, parseRoadmap } from '../lib/roadmap.ts';
import { itemsOf, sampleText } from './fixtures/roadmap.ts';

describe('parseRoadmap', () => {
  it('reads every valid item, in file order, with its asks and links', () => {
    const result = parseRoadmap(sampleText());
    if (!result.ok) throw new Error('expected ok');
    expect(result.board.items.map((i) => i.id.slice(-2))).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    expect(result.board.milestones).toHaveLength(2);
    const first = result.board.items[0]!;
    expect(first.needs[0]).toMatchObject({ kind: 'decision', ask: 'Pick the whistle pitch' });
    expect(first.links).toHaveLength(2);
    expect(result.board.items[1]!.needs[0]).toMatchObject({
      kind: 'permission',
      approval: 'apr_01HZZZZZZZZZZZZZZZZZZZZZP1',
    });
    expect(result.skipped).toEqual([]);
  });

  it('reports where the JSON breaks, by line', () => {
    const text = sampleText().replace('"version": 1,', '"version": 1,,');
    const result = parseRoadmap(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.line).toBe(2);
    expect(result.error.message).toMatch(/line 2/);
  });

  it('refuses a document that is not a version 1 roadmap', () => {
    expect(parseRoadmap('{"version": 2, "items": []}')).toMatchObject({ ok: false });
    expect(parseRoadmap('[]')).toMatchObject({ ok: false });
    expect(parseRoadmap('{"version": 1}')).toMatchObject({ ok: false });
  });

  it('skips items that break the schema and says why, keeping the good ones', () => {
    const text = sampleText((doc) => {
      const items = itemsOf(doc);
      delete items[0]!.horizon;
      items[1]!.moscow = 'maybe';
      items[2]!.id = 'not-a-ulid';
      items.push({ ...items[3], title: 'A copy with the same id' });
    });
    const result = parseRoadmap(text);
    if (!result.ok) throw new Error('expected ok');
    expect(result.board.items.map((i) => i.id.slice(-2))).toEqual(['A4', 'A5']);
    expect(result.skipped).toEqual([
      { id: '01HZZZZZZZZZZZZZZZZZZZZZA1', reason: 'has no horizon' },
      { id: '01HZZZZZZZZZZZZZZZZZZZZZA2', reason: 'moscow is "maybe"' },
      { id: 'not-a-ulid', reason: 'id is not a ULID' },
      { id: '01HZZZZZZZZZZZZZZZZZZZZZA4', reason: 'id is used twice' },
    ]);
  });

  it('drops an ask that breaks the schema but keeps its bet', () => {
    const text = sampleText((doc) => {
      const needs = itemsOf(doc)[1]!.needs as Record<string, unknown>[];
      delete needs[0]!.approval;
    });
    const result = parseRoadmap(text);
    if (!result.ok) throw new Error('expected ok');
    expect(result.board.items[1]!.needs).toEqual([]);
    expect(result.skipped).toEqual([
      { id: '01HZZZZZZZZZZZZZZZZZZZZZA2', reason: 'a permission ask has no approval' },
    ]);
  });

  it('keeps only links it can show safely', () => {
    const text = sampleText((doc) => {
      itemsOf(doc)[0]!.links = [
        { kind: 'url', ref: 'javascript:alert(1)' },
        { kind: 'url', ref: 'http://example.com' },
        { kind: 'url', ref: 'https://example.com/ok' },
        { kind: 'pr', ref: '42' },
        { kind: 'wiki', ref: 'x' },
      ];
    });
    const result = parseRoadmap(text);
    if (!result.ok) throw new Error('expected ok');
    expect(result.board.items[0]!.links.map((l) => l.ref)).toEqual([
      'https://example.com/ok',
      '42',
    ]);
  });

  it('strips control and direction-override characters from text', () => {
    const text = sampleText((doc) => {
      itemsOf(doc)[0]!.title = 'Kettle\u202e\u0007 plan';
    });
    const result = parseRoadmap(text);
    if (!result.ok) throw new Error('expected ok');
    expect(result.board.items[0]!.title).toBe('Kettle plan');
  });
});

describe('cleanText', () => {
  it('keeps ordinary text, drops controls and trims to the limit', () => {
    expect(cleanText('a\tb\nc\u200f', 100)).toBe('a b c');
    expect(cleanText('abcdef', 4)).toBe('abc…');
    expect(cleanText(42, 10)).toBe('');
  });
});

describe('jsonErrorOffset', () => {
  it('finds the first character that breaks the JSON', () => {
    expect(jsonErrorOffset('{ "a": [ } ')).toBe(9);
    expect(jsonErrorOffset('{"a": tru}')).toBe(9);
    expect(jsonErrorOffset('{"a": 1,}')).toBe(8);
    expect(jsonErrorOffset('{"a": "x\\q"}')).toBe(9);
    expect(jsonErrorOffset('{"a": 1} x')).toBe(9);
    expect(jsonErrorOffset('{"a": ')).toBe(6);
    expect(jsonErrorOffset('['.repeat(5000))).toBeLessThan(5000);
    // Depth is nesting, not a count: many sibling arrays are fine.
    const many = `[${Array.from({ length: 400 }, () => '[1]').join(',\n')}\n`;
    expect(jsonErrorOffset(many)).toBe(many.length);
  });

  it('agrees with JSON.parse on text that is valid', () => {
    const text = '{"a": [1, -2.5e3, true, false, null, "q\\u00e9\\n"], "b": {}}';
    expect(() => JSON.parse(text)).not.toThrow();
    expect(jsonErrorOffset(text)).toBe(text.length);
  });
});
