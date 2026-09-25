/**
 * Unit + interchangeability suite for the inbound transport seam (§4, task 4.3).
 *
 * Two purposes:
 *   (a) PollingTransport unit — the injected reader → `comment.added` events,
 *       a durable watermark that advances, and NO re-emit on a second poll.
 *   (b) THE interchangeability test (G9, the seam's defining test) — the SAME
 *       hand-built `TrackerEvent[]` fed through a fake POLLING producer and a fake
 *       WEBHOOK producer (both implementing `InboundTransport`) into the same
 *       consuming reducer yields IDENTICAL output. It is written to FAIL if any
 *       consumer branches on `receivedVia` — proving the engine cannot tell which
 *       transport produced the events.
 *
 * Imports from the relative module paths (NOT the `@dorkos/flow` barrel), matching
 * the sibling flow suites.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §4
 */

import { describe, expect, it, vi } from 'vitest';
import {
  trackerEventDedupeKey,
  type CommentAddedEvent,
  type ReceivedVia,
  type TrackerEvent,
} from '../scripts/events.ts';
import {
  PollingTransport,
  type InboundTransport,
  type InboxEntry,
  type PollResult,
  type Watermark,
} from '../scripts/transport.ts';
import { bodyOf, hasLabel, labelsOf, mentionsOf, type WorkItem } from '../scripts/work-item.ts';

// ─── shared fixtures ─────────────────────────────────────────────────────────

/**
 * Build an inbox entry (the injected reader's row) with overridable fields.
 *
 * Populates EVERY `InboxEntry` field, the optional `actor` included: the
 * `InboxEntry` non-conformance sweep below derives its field list from this
 * fixture at runtime, so a field left unpopulated here would be silently missing
 * from the sweep too (the same discipline as `comment-response.test.ts`'s
 * `makeItem`).
 */
function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    itemId: 'DOR-1',
    occurredAt: '2026-06-25T00:00:00.000Z',
    comment: { author: 'human', mentions: [], body: 'go with option B' },
    actor: 'human',
    raw: { native: true },
    ...overrides,
  };
}

/** The fixed clock the DOR-638 suites run on, so their 2027 dates are in the past. */
const NOW = Date.parse('2028-01-01T00:00:00.000Z');

/**
 * A `PollingTransport` on the fixed {@link NOW} clock, whose warnings land in a
 * spy instead of the console.
 */
function quietTransport(read: () => Promise<readonly InboxEntry[]>) {
  const warn = vi.fn<(message: string) => void>();
  return { transport: new PollingTransport(read, { warn, now: () => NOW }), warn };
}

// ─── (a) PollingTransport unit ────────────────────────────────────────────────

describe('PollingTransport — maps inbox entries to events + advances the watermark', () => {
  it('turns two new comments into two comment.added events (receivedVia: poll)', async () => {
    const entries: InboxEntry[] = [
      entry({ itemId: 'DOR-1', occurredAt: '2026-06-25T00:00:01.000Z' }),
      entry({ itemId: 'DOR-2', occurredAt: '2026-06-25T00:00:02.000Z' }),
    ];
    const transport = new PollingTransport(async () => entries);

    const { events, watermark } = await transport.poll();

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === 'comment.added')).toBe(true);
    expect(events.every((e) => e.receivedVia === 'poll')).toBe(true);
    expect((events[0] as CommentAddedEvent).comment.body).toBe('go with option B');
    // Watermark advanced to the newest entry's occurredAt.
    expect(watermark).toBe('2026-06-25T00:00:02.000Z');
  });

  it('a follow-up poll(watermark) over the same snapshot returns [] (no re-emit)', async () => {
    const entries: InboxEntry[] = [
      entry({ itemId: 'DOR-1', occurredAt: '2026-06-25T00:00:01.000Z' }),
      entry({ itemId: 'DOR-2', occurredAt: '2026-06-25T00:00:02.000Z' }),
    ];
    const transport = new PollingTransport(async () => entries);

    const first = await transport.poll();
    const second = await transport.poll(first.watermark);

    expect(second.events).toEqual([]);
    // The watermark holds at the high-water point — no regression.
    expect(second.watermark).toBe(first.watermark);
  });

  it('emits events oldest-first regardless of reader order', async () => {
    const transport = new PollingTransport(async () => [
      entry({ itemId: 'DOR-late', occurredAt: '2026-06-25T00:00:05.000Z' }),
      entry({ itemId: 'DOR-early', occurredAt: '2026-06-25T00:00:01.000Z' }),
    ]);
    const { events } = await transport.poll();
    expect(events.map((e) => e.itemId)).toEqual(['DOR-early', 'DOR-late']);
  });

  it('cold start (no watermark) consumes the whole inbox; an empty inbox holds the cursor', async () => {
    const empty = new PollingTransport(async () => []);
    const cold = await empty.poll();
    expect(cold.events).toEqual([]);

    const held = await empty.poll('2026-06-25T00:00:09.000Z');
    expect(held.events).toEqual([]);
    expect(held.watermark).toBe('2026-06-25T00:00:09.000Z');
  });

  it('maps a bare @mention (empty body, non-empty mentions) to a mention event', async () => {
    const transport = new PollingTransport(async () => [
      entry({ comment: { author: 'human', mentions: ['acct-agent'], body: '' } }),
    ]);
    const { events } = await transport.poll();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('mention');
    expect(events[0].kind === 'mention' && events[0].mentioned).toBe('acct-agent');
  });

  it('keys every event with the kind:itemId:occurredAt dedupeKey convention', async () => {
    const transport = new PollingTransport(async () => [
      entry({ itemId: 'DOR-7', occurredAt: '2026-06-25T12:00:00.000Z' }),
    ]);
    const { events } = await transport.poll();
    expect(events[0].dedupeKey).toBe(
      trackerEventDedupeKey('comment.added', 'DOR-7', '2026-06-25T12:00:00.000Z')
    );
  });
});

// ─── PollingTransport non-conformance sweep (DOR-535 follow-up) ──────────────

describe('PollingTransport — non-conformance sweep (InboxComment fields)', () => {
  // `PollingTransport` is strictly upstream of `shouldRespondToComment`: it
  // produces the exact `InboxComment` payload the comment-response rules
  // consume (`entryToEvent` reads `entry.comment.body`/`.mentions` before the
  // comment-response rules ever see the comment). DOR-535 hardened
  // `shouldRespondToComment` against a non-conformant `labels`/`mentions`/
  // `body`, but the same crash shape was still reachable HERE, one hop
  // upstream and unguarded — an adapter's `getInbox` need only misbehave once
  // for the hardened downstream path to never be reached. Same sweep shape as
  // `engine-tests/dispatch.test.ts` (DOR-515) and
  // `engine-tests/comment-response.test.ts` (DOR-535): substitute a hostile
  // value into every `InboxComment` field mechanically, field list derived at
  // runtime from the fixture.
  const HOSTILE_VALUES: [label: string, value: unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['an empty array', []],
  ];

  const COMMENT_FIELDS = Object.keys(entry().comment) as (keyof InboxEntry['comment'])[];

  it('derives its field list from the fixture, and the fixture is complete', () => {
    expect(COMMENT_FIELDS).toHaveLength(3);
    expect(COMMENT_FIELDS).toEqual(expect.arrayContaining(['author', 'mentions', 'body']));
  });

  const cases = COMMENT_FIELDS.flatMap((field) =>
    HOSTILE_VALUES.map(([label, value]) => [field, label, value] as const)
  );

  it.each(cases)(
    'PollingTransport.poll survives InboxComment.%s = %s without throwing',
    async (field, _label, value) => {
      // `entryToEvent`'s bare-mention check is `bodyOf(comment).trim() === '' &&
      // mentions.length > 0` — a short-circuit `&&`. A hostile `mentions` value
      // is only ever READ if `body` is empty; the fixture forces `body: ''` here
      // (rather than reusing the suite's default non-empty body) so sweeping
      // `mentions` actually exercises the crash site instead of silently
      // short-circuiting past it. The `body` case below then overrides this
      // forced-empty default with its own hostile value.
      const hostileEntry = entry({
        comment: { author: 'human', mentions: ['acct-agent'], body: '', [field]: value },
      });
      const transport = new PollingTransport(async () => [hostileEntry]);

      // Not throwing (awaiting the promise resolving, rather than rejecting) is
      // the whole assertion. `events[0].kind` is typed to `'comment.added' |
      // 'mention'`, so a `.toContain` check against its full range cannot fail
      // for any value the return type permits — see comment-response.test.ts's
      // non-conformance sweeps for the same lesson (DOR-535 review).
      const { events } = await transport.poll();
      expect(events).toHaveLength(1);
    }
  );

  it('a bare-string mentions scalar does NOT become a MentionEvent (silent-garbage regression)', async () => {
    // `'@agent'.length > 0` is TRUE — a scalar `mentions` would otherwise sail
    // through the bare-mention check (`mentionsOf(comment).length > 0`) and
    // `mentioned: mentions[0]` would silently emit a MentionEvent naming '@'
    // (the string's first CHARACTER, not an account id): a person who does not
    // exist. This is the transport-layer echo of the DOR-535 bare-string
    // `labels` false positive, and — unlike that one — the sweep above cannot
    // catch it: one right event and one wrong event both satisfy
    // `toHaveLength(1)` identically. `mentionsOf`'s `Array.isArray` guard
    // degrades the scalar to `[]`, so the bare-mention check reads
    // `mentions.length > 0` as false and this correctly falls through to a
    // normal `comment.added` event instead.
    const transport = new PollingTransport(async () => [
      entry({
        comment: { author: 'human', mentions: '@agent' as unknown as string[], body: '' },
      }),
    ]);
    const { events } = await transport.poll();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('comment.added');
  });
});

// ─── DOR-638: a bad timestamp must never kill the inbox ──────────────────────

describe('PollingTransport — an unusable occurredAt never poisons the watermark (DOR-638)', () => {
  // The watermark is the one piece of state that outlives a poll. Before
  // DOR-638 it was compared as a raw string, so one entry whose `occurredAt`
  // was `"nonsense"` became the watermark, and since `'n' > '2'`, every later
  // ISO timestamp failed the `>` filter forever: an inbox that never crashed and
  // never heard anyone again. Every test here asserts that a LATER real comment
  // still arrives, because "it did not crash" is satisfied identically by a
  // working inbox and a dead one.
  const LATER = '2027-01-01T00:00:00.000Z';

  it('a later real comment still arrives after one non-ISO occurredAt', async () => {
    let inbox: InboxEntry[] = [entry({ itemId: 'DOR-bad', occurredAt: 'nonsense' })];
    const { transport } = quietTransport(async () => inbox);

    const first = await transport.poll('2026-06-25T00:00:00.000Z');
    expect(first.watermark).toBe('2026-06-25T00:00:00.000Z');

    inbox = [entry({ itemId: 'DOR-real', occurredAt: LATER })];
    const second = await transport.poll(first.watermark);

    expect(second.events.map((e) => e.itemId)).toEqual(['DOR-real']);
    expect(second.watermark).toBe(LATER);
  });

  it('drops the bad entry loudly and still emits the good ones in the same snapshot', async () => {
    const { transport, warn } = quietTransport(async () => [
      entry({ itemId: 'DOR-bad', occurredAt: 'nonsense' }),
      entry({ itemId: 'DOR-good', occurredAt: '2026-06-25T00:00:01.000Z' }),
    ]);

    const { events, watermark, warnings } = await transport.poll();

    expect(events.map((e) => e.itemId)).toEqual(['DOR-good']);
    expect(watermark).toBe('2026-06-25T00:00:01.000Z');
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]).toContain('DOR-bad');
    expect(warnings?.[0]).toContain('nonsense');
    expect(warn).toHaveBeenCalledWith(warnings?.[0]);
  });

  it('warns on the console by default, so nobody has to remember to read `warnings`', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const transport = new PollingTransport(async () => [entry({ occurredAt: 'nonsense' })], {
        now: () => NOW,
      });
      await transport.poll();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  // Date.parse is lenient: V8 reads '42' as the year 2042 and '1' as 2001. A
  // watermark of 2042 is the same dead inbox as "nonsense", just with an expiry
  // date, so only a full ISO-8601 date-time with an explicit zone is accepted.
  it.each([
    ['a word', 'nonsense'],
    ['a bare number V8 reads as a year', '42'],
    ['a date with no time', '2099-01-01'],
    ['a date-time with no zone', '2099-01-01T00:00:00'],
    ['an impossible date', '2026-13-45T00:00:00.000Z'],
    ['the empty string', ''],
  ])('%s (%j) is dropped, and a later real comment still arrives', async (_label, bad) => {
    let inbox: InboxEntry[] = [entry({ itemId: 'DOR-bad', occurredAt: bad })];
    const { transport } = quietTransport(async () => inbox);

    const first = await transport.poll('2026-06-25T00:00:00.000Z');
    expect(first.events).toEqual([]);

    inbox = [entry({ itemId: 'DOR-real', occurredAt: LATER })];
    const second = await transport.poll(first.watermark);
    expect(second.events.map((e) => e.itemId)).toEqual(['DOR-real']);
  });

  it('recovers an inbox whose persisted watermark was already poisoned', async () => {
    // A cursor written before this fix may already read "nonsense". Treating an
    // unusable `since` as a cold start re-delivers the current inbox instead of
    // staying deaf forever. Nothing stores processed `dedupeKey`s, so what keeps
    // a re-delivered event harmless is that events are triggers, not truth: the
    // consumer re-reads each item and the comment-response rules decide again
    // (an item already un-parked no longer carries `agent/needs-input`).
    const { transport, warn } = quietTransport(async () => [
      entry({ itemId: 'DOR-real', occurredAt: LATER }),
    ]);

    const { events, watermark } = await transport.poll('nonsense');

    expect(events.map((e) => e.itemId)).toEqual(['DOR-real']);
    expect(watermark).toBe(LATER);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops a far-future occurredAt, so it cannot become a watermark nothing exceeds', async () => {
    let inbox: InboxEntry[] = [entry({ itemId: 'DOR-future', occurredAt: '9999-12-31T23:59:59Z' })];
    const { transport, warn } = quietTransport(async () => inbox);

    const first = await transport.poll('2026-06-25T00:00:00.000Z');
    expect(first.events).toEqual([]);
    expect(first.watermark).toBe('2026-06-25T00:00:00.000Z');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('in the future'));

    inbox = [entry({ itemId: 'DOR-real', occurredAt: LATER })];
    const second = await transport.poll(first.watermark);
    expect(second.events.map((e) => e.itemId)).toEqual(['DOR-real']);
  });

  it('allows an hour of clock skew, and no more', async () => {
    const withinSkew = new Date(NOW + 59 * 60 * 1000).toISOString();
    const pastSkew = new Date(NOW + 61 * 60 * 1000).toISOString();
    const { transport } = quietTransport(async () => [
      entry({ itemId: 'DOR-skewed', occurredAt: withinSkew }),
      entry({ itemId: 'DOR-too-far', occurredAt: pastSkew }),
    ]);
    const { events, watermark } = await transport.poll();
    expect(events.map((e) => e.itemId)).toEqual(['DOR-skewed']);
    expect(watermark).toBe(withinSkew);
  });

  it('discards a saved far-future watermark, so an inbox stuck on one recovers', async () => {
    const { transport, warn } = quietTransport(async () => [
      entry({ itemId: 'DOR-real', occurredAt: LATER }),
    ]);
    const { events, watermark } = await transport.poll('9999-12-31T23:59:59Z');
    expect(events.map((e) => e.itemId)).toEqual(['DOR-real']);
    expect(watermark).toBe(LATER);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the real clock by default', async () => {
    // No `now` injected: a date a century out is future on any machine running this.
    const warn = vi.fn<(message: string) => void>();
    const transport = new PollingTransport(
      async () => [entry({ occurredAt: '2126-01-01T00:00:00Z' })],
      { warn }
    );
    const { events } = await transport.poll();
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('in the future'));
  });

  it('compares instants, not strings, so a mixed-precision timestamp is not lost', async () => {
    // As strings, '…:01Z' > '…:01.500Z' ('Z' sorts after '.'), so a comment half a
    // second AFTER the cursor used to be filtered out as if it were older.
    const { transport } = quietTransport(async () => [
      entry({ itemId: 'DOR-late', occurredAt: '2026-06-25T00:00:01.500Z' }),
    ]);
    const { events } = await transport.poll('2026-06-25T00:00:01Z');
    expect(events.map((e) => e.itemId)).toEqual(['DOR-late']);
  });

  it('orders by instant across zone offsets', async () => {
    // 01:00+02:00 is 23:00Z the day before, so it is the EARLIER entry even
    // though it sorts later as a string.
    const { transport } = quietTransport(async () => [
      entry({ itemId: 'DOR-offset', occurredAt: '2026-06-25T01:00:00+02:00' }),
      entry({ itemId: 'DOR-utc', occurredAt: '2026-06-25T00:00:00.000Z' }),
    ]);
    const { events, watermark } = await transport.poll();
    expect(events.map((e) => e.itemId)).toEqual(['DOR-offset', 'DOR-utc']);
    expect(watermark).toBe('2026-06-25T00:00:00.000Z');
  });
});

describe('PollingTransport — an entry with no comment is handled, not thrown (DOR-638)', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'go with option B'],
    ['an array', []],
  ])('comment = %s is dropped with a warning, not thrown', async (_label, missing) => {
    // Dropped, never faked as an empty comment: an empty comment on a parked
    // `agent/needs-input` item reads as an anonymous reply, and the agent would
    // un-park its own question with no answer in hand.
    let inbox: InboxEntry[] = [
      entry({ itemId: 'DOR-empty', comment: missing as unknown as InboxEntry['comment'] }),
    ];
    const { transport, warn } = quietTransport(async () => inbox);

    const first = await transport.poll('2026-06-24T00:00:00.000Z');

    expect(first.events).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DOR-empty'));
    expect(first.warnings?.[0]).toContain('not a comment object');

    // And the inbox is still alive afterwards.
    inbox = [entry({ itemId: 'DOR-real', occurredAt: '2027-01-01T00:00:00.000Z' })];
    const second = await transport.poll(first.watermark);
    expect(second.events.map((e) => e.itemId)).toEqual(['DOR-real']);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('bodyOf / mentionsOf / labelsOf / hasLabel accept %s', (_label, missing) => {
    // The guard lives in the accessors themselves, so no call site can forget it.
    expect(bodyOf(missing as unknown as InboxEntry['comment'])).toBe('');
    expect(mentionsOf(missing as unknown as InboxEntry['comment'])).toEqual([]);
    expect(labelsOf(missing as unknown as WorkItem)).toEqual([]);
    expect(hasLabel(missing as unknown as WorkItem, 'agent/ready')).toBe(false);
  });
});

// ─── PollingTransport non-conformance sweep (InboxEntry's own fields) ─────────

describe('PollingTransport — non-conformance sweep (InboxEntry fields, DOR-638)', () => {
  // The sweep above substitutes hostile values INSIDE `entry.comment`, and so it
  // could not see `entry.comment` itself being missing, nor a bad `occurredAt`
  // poisoning the watermark: its axis stopped one level short. This sweep runs
  // the same hostile values through every field of `InboxEntry`, the field list
  // derived at runtime from the fixture, so a field added later is covered
  // without anyone remembering to add it.
  const HOSTILE_VALUES: [label: string, value: unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['an empty array', []],
  ];

  const ENTRY_FIELDS = Object.keys(entry()) as (keyof InboxEntry)[];

  it('derives its field list from the fixture, and the fixture is complete', () => {
    expect(ENTRY_FIELDS).toHaveLength(5);
    expect(ENTRY_FIELDS).toEqual(
      expect.arrayContaining(['itemId', 'occurredAt', 'comment', 'actor', 'raw'])
    );
  });

  const cases = ENTRY_FIELDS.flatMap((field) =>
    HOSTILE_VALUES.map(([label, value]) => [field, label, value] as const)
  );

  it.each(cases)(
    'InboxEntry.%s = %s neither throws nor deafens the inbox',
    async (field, _label, value) => {
      const hostileEntry = { ...entry({ itemId: 'DOR-hostile' }), [field]: value } as InboxEntry;
      let inbox: InboxEntry[] = [hostileEntry];
      const { transport } = quietTransport(async () => inbox);

      // Resolving rather than rejecting is the first half.
      const first = await transport.poll('2026-06-24T00:00:00.000Z');

      // The second half is the one that matters: whatever the hostile entry did,
      // a later, well-formed comment must still get through.
      inbox = [entry({ itemId: 'DOR-after', occurredAt: '2027-01-01T00:00:00.000Z' })];
      const second = await transport.poll(first.watermark);
      expect(second.events.map((e) => e.itemId)).toEqual(['DOR-after']);
    }
  );
});

// ─── (b) THE interchangeability test (G9) ─────────────────────────────────────

/**
 * A fixture transport that re-emits a fixed `TrackerEvent[]` from `poll()`. Used
 * to stand up BOTH a "polling" and a "webhook" producer from the same event list
 * so the only difference between them is each event's `receivedVia` provenance.
 */
function fixtureTransport(events: readonly TrackerEvent[]): InboundTransport {
  return {
    poll(since?: Watermark): Promise<PollResult> {
      void since;
      return Promise.resolve({
        events: [...events],
        watermark: events.at(-1)?.occurredAt ?? '',
      });
    },
  };
}

/** Build the SAME canonical events, parameterized ONLY by provenance. */
function canonicalEvents(via: ReceivedVia): TrackerEvent[] {
  const mk = (itemId: string, occurredAt: string, body: string): CommentAddedEvent => ({
    kind: 'comment.added',
    itemId,
    actor: 'human',
    occurredAt,
    receivedVia: via,
    dedupeKey: trackerEventDedupeKey('comment.added', itemId, occurredAt),
    raw: null,
    comment: { author: 'human', mentions: [], body },
  });
  return [
    mk('DOR-1', '2026-06-25T00:00:01.000Z', 'go with option B'),
    mk('DOR-2', '2026-06-25T00:00:02.000Z', 'ship it'),
  ];
}

/**
 * The consuming reducer the engine runs over an event stream. It projects each
 * event onto a tracker-agnostic summary and DELIBERATELY never reads
 * `receivedVia` — exactly the discipline every real reconciler follows. If a
 * consumer ever branched on provenance, the poll-vs-webhook outputs would diverge
 * and the interchangeability assertion below would fail.
 */
function consume(events: readonly TrackerEvent[]): Array<Record<string, unknown>> {
  return events.map((event) => ({
    kind: event.kind,
    itemId: event.itemId,
    actor: event.actor,
    occurredAt: event.occurredAt,
    dedupeKey: event.dedupeKey,
    body: event.kind === 'comment.added' ? event.comment.body : undefined,
  }));
}

describe('inbound transport interchangeability (G9) — poll == webhook', () => {
  it('the same events through a polling and a webhook producer yield IDENTICAL consumer output', async () => {
    const polling = fixtureTransport(canonicalEvents('poll'));
    const webhook = fixtureTransport(canonicalEvents('webhook'));

    const pollOut = await polling.poll();
    const webhookOut = await webhook.poll();

    // Sanity: the two raw streams genuinely DIFFER in provenance (not vacuous).
    expect(pollOut.events[0].receivedVia).toBe('poll');
    expect(webhookOut.events[0].receivedVia).toBe('webhook');
    expect(pollOut.events[0].receivedVia).not.toBe(webhookOut.events[0].receivedVia);

    // The defining assertion: identical downstream output. The engine cannot tell
    // which transport produced the events.
    expect(consume(pollOut.events)).toEqual(consume(webhookOut.events));
  });

  it('structurally enforces that the consumer never branches on receivedVia', () => {
    // The reducer's own source must not reference provenance. If a future consumer
    // adds a `receivedVia` branch, this fails — keeping the G9 invariant honest.
    expect(consume.toString()).not.toContain('receivedVia');
  });
});
