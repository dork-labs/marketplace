/**
 * The **inbound transport seam** (§4; charter B0/G9) — the producer side of the
 * normalized event seam. An {@link InboundTransport} turns a tracker's native
 * inbound signal (a polled inbox, or a pushed webhook) into a stream of
 * {@link TrackerEvent}s. The engine programs against the *interface*, never a
 * concrete producer, so swapping poll → webhook is a config edit
 * (`ingestion.producer`, task 4.4), not a code change — and the consuming
 * reconciler **cannot tell which transport produced an event** (the G9
 * interchangeability invariant, `__tests__/transport.test.ts`).
 *
 * ## v1 ships poll only; webhook is a deferred drop-in
 *
 * {@link PollingTransport} is the v1 producer. The webhook producer is a future
 * drop-in implementing this **same** interface (per the Non-Goals — NOT built
 * here). Because both emit the identical {@link TrackerEvent} envelope, neither
 * the reducer nor any reconciler changes when the webhook lands.
 *
 * ## Package purity — the injected fetch seam
 *
 * `@dorkos/flow` is pure (no fs / network). {@link PollingTransport} therefore
 * does **not** call the tracker itself: it wraps an **injected reader**
 * ({@link InboxReader}) the adapter supplies (the impure `getInbox` lives in the
 * agent/adapter layer, outside this package), plus a durable {@link Watermark}
 * cursor. Everything {@link PollingTransport} does — filter by the watermark, map
 * each entry onto a {@link TrackerEvent}, advance the cursor — is pure
 * transformation. This mirrors the Phase 3 `FlowStateStore` seam: the I/O is
 * injected, the decision logic is pure and server-portable.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §4 (the inbound event seam)
 * @see ./events.ts ({@link TrackerEvent} — the seam's currency — task 4.1)
 * @see the tracker adapter's SKILL.md, at `adapter.path` from `config-files.ts` (`getInbox` — the reader the adapter supplies)
 * @module @dorkos/flow/transport
 */

import {
  trackerEventDedupeKey,
  type CommentAddedEvent,
  type MentionEvent,
  type TrackerEvent,
} from './events.ts';
import { authorOf, bodyOf, mentionsOf } from './work-item.ts';
import type { InboxComment } from './work-item.ts';

/**
 * A durable cursor marking the high-water point of consumed events — in v1 the
 * ISO-8601 `occurredAt` of the newest event seen, or `''` before any event has
 * been. Durable, not in-memory: persisting it (the run record /
 * `flow-state.json`) keeps the poll stream **gap-free across restarts**.
 * Compared as an **instant**, never as a string, with `>`, so a `poll(since)`
 * returns strictly newer events and never re-emits one already consumed.
 */
export type Watermark = string;

/**
 * The result of one {@link InboundTransport.poll}: the fresh events since the
 * given watermark, plus the **advanced** watermark to persist and pass to the next
 * poll. Returning the new watermark (rather than mutating internal state) keeps
 * {@link PollingTransport} pure and the cursor durable at the call site.
 */
export interface PollResult {
  /** The events strictly newer than the `since` watermark, oldest-first. */
  events: TrackerEvent[];
  /**
   * The watermark to persist and pass to the next {@link InboundTransport.poll}.
   * Advanced to the newest consumed `occurredAt`; unchanged from `since` when no
   * fresh events arrived.
   */
  watermark: Watermark;
  /**
   * One plain-language line per inbox entry this poll dropped, and per unusable
   * `since` it had to discard. Optional so a producer with nothing to report
   * need not set it; {@link PollingTransport} always does.
   */
  warnings?: readonly string[];
}

/**
 * The **producer interface** (§4) — the one seam both the poller and the future
 * webhook implement. {@link poll} is the pull model (v1); {@link subscribe} is the
 * optional push model a webhook producer adds. A consumer drives whichever the
 * configured producer offers; the {@link TrackerEvent} stream is identical either
 * way (G9).
 */
export interface InboundTransport {
  /**
   * Pull the events that arrived since `since`, returning them oldest-first plus
   * the advanced {@link Watermark}. Idempotent on the watermark: `poll(w)`
   * immediately after a `poll()` that returned watermark `w` yields no events.
   *
   * @param since - The last persisted watermark, or `undefined` for a cold start
   *   (consume the whole current inbox).
   * @returns The fresh events and the watermark to persist for the next poll.
   */
  poll(since?: Watermark): Promise<PollResult>;
  /**
   * Register a push handler, returning an unsubscribe function. **Optional** — the
   * push model only a webhook producer offers; {@link PollingTransport} omits it.
   * The handler receives the identical {@link TrackerEvent} stream `poll` would.
   *
   * @param handler - Invoked once per pushed event.
   * @returns A function that unregisters the handler.
   */
  subscribe?(handler: (event: TrackerEvent) => void): () => void;
}

/**
 * One inbox entry as the injected {@link InboxReader} yields it — the adapter's
 * `getInbox` row, enriched with the envelope fields the package needs to build a
 * {@link TrackerEvent} ({@link itemId} + {@link occurredAt}) that a bare
 * {@link InboxComment} lacks. The adapter (impure, outside this package) does the
 * tracker query and normalization; {@link PollingTransport} only transforms.
 */
export interface InboxEntry {
  /** The human key of the item the entry is on (the `WorkItem.identifier`). */
  itemId: string;
  /**
   * ISO-8601 date-time the entry occurred, with an explicit zone (`Z` or
   * `±hh:mm`) — the watermark axis. An entry whose value is anything else is
   * dropped with a warning rather than allowed near the watermark (DOR-638).
   */
  occurredAt: string;
  /** The triggering comment (`author`/`mentions`/`body`), the `comment.added` payload. */
  comment: InboxComment;
  /** The account that produced the entry; defaults to the comment author when omitted. */
  actor?: string;
  /** The tracker-native payload, carried opaque onto the event's `raw` field. */
  raw?: unknown;
}

/**
 * The **injected fetch seam** {@link PollingTransport} wraps — the adapter's
 * `getInbox`, returning the current inbox as {@link InboxEntry}s. Arg-less by
 * design: it yields the inbox snapshot, and {@link PollingTransport} applies the
 * watermark filter itself (the pure half). Keeping the I/O here, at the adapter,
 * is what lets `@dorkos/flow` stay free of fs/network.
 */
export type InboxReader = () => Promise<readonly InboxEntry[]>;

/** Options for {@link PollingTransport}. */
export interface PollingTransportOptions {
  /**
   * Where a dropped entry is reported, once per line of
   * {@link PollResult.warnings}. Defaults to `console.warn`, so a broken
   * `getInbox` is loud even when the caller never reads `warnings`.
   */
  warn?: (message: string) => void;
  /**
   * The current time in epoch milliseconds, read once per poll. Defaults to
   * `Date.now`; injectable so the future-timestamp guard is testable.
   */
  now?: () => number;
}

/**
 * How far past `now` an `occurredAt` may be and still count. A small margin
 * absorbs clock skew between this machine and the tracker; anything later is
 * dropped, because a far-future watermark (`9999-12-31T23:59:59Z`) is as dead as
 * `"nonsense"`: no real comment can ever be newer than it.
 */
const FUTURE_MARGIN_MS = 60 * 60 * 1000;

/**
 * An ISO-8601 date-time with an explicit zone. `Date.parse` alone is not
 * enough: V8 reads `'42'` as the year 2042 and a zone-less date-time as local
 * time, and a watermark of 2042 is the same dead inbox as `"nonsense"`, just
 * with an expiry date.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * The instant a timestamp names, in epoch milliseconds, or `undefined` when the
 * value is not an ISO-8601 date-time with an explicit zone that names a real
 * date. The one gate between an adapter's `occurredAt` and the watermark.
 */
function instantOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Render an adapter-supplied value for a warning without ever throwing: a
 * string is quoted, anything else is named by its type (never stringified, since
 * a hostile object can throw from `toString` or loop in `JSON.stringify`).
 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `${typeof value} ${String(value)}`;
}

/**
 * Map one {@link InboxEntry} onto a {@link TrackerEvent} (always `receivedVia:
 * 'poll'`). A bare @mention notification (a non-empty `mentions` list with an
 * empty body) becomes a {@link MentionEvent}; every other entry — the common case,
 * a real comment — becomes a {@link CommentAddedEvent} carrying the
 * {@link InboxComment}. Pure and deterministic so the poll producer keys and
 * shapes events identically to the future webhook producer.
 *
 * Reads `entry.comment` through {@link bodyOf} / {@link mentionsOf} / {@link authorOf} (the
 * `work-item.ts` accessors also used by the comment-response rules) rather
 * than direct property access: `PollingTransport` is strictly upstream of
 * `shouldRespondToComment` — it produces the exact `InboxComment` payload the
 * comment-response rules consume — so a non-conformant `getInbox` entry must
 * degrade here first, not crash before the hardened path is ever reached
 * (DOR-535 follow-up).
 */
function entryToEvent(entry: InboxEntry): CommentAddedEvent | MentionEvent {
  // `poll` has already dropped an entry whose comment is not an object, so this
  // is a real comment object, though its fields may still be non-conformant.
  const comment = entry.comment;
  const actor = entry.actor ?? authorOf(comment);
  const mentions = mentionsOf(comment);
  const isBareMention = bodyOf(comment).trim().length === 0 && mentions.length > 0;

  if (isBareMention) {
    return {
      kind: 'mention',
      itemId: entry.itemId,
      actor,
      occurredAt: entry.occurredAt,
      receivedVia: 'poll',
      dedupeKey: trackerEventDedupeKey('mention', entry.itemId, entry.occurredAt),
      raw: entry.raw,
      mentioned: mentions[0],
    };
  }

  return {
    kind: 'comment.added',
    itemId: entry.itemId,
    actor,
    occurredAt: entry.occurredAt,
    receivedVia: 'poll',
    dedupeKey: trackerEventDedupeKey('comment.added', entry.itemId, entry.occurredAt),
    raw: entry.raw,
    comment,
  };
}

/**
 * The **v1 polling producer** (§4) — wraps an injected {@link InboxReader} + a
 * durable {@link Watermark} cursor and turns each inbox snapshot into a gap-free
 * delta of {@link TrackerEvent}s. Pure transformation around the injected reader:
 *
 * 1. read the current inbox via the injected {@link InboxReader};
 * 2. drop, with a warning, every entry whose `occurredAt` is not an ISO-8601
 *    date-time, is more than an hour in the future, or whose `comment` is not
 *    an object; then keep only entries strictly newer than the `since`
 *    watermark (`occurredAt > since`, compared as instants);
 * 3. map each survivor onto a `comment.added` / `mention` event ({@link entryToEvent});
 * 4. advance the watermark to the newest consumed `occurredAt`.
 *
 * Step 2's validation is what keeps the inbox alive (DOR-638). The watermark is
 * the one piece of state that outlives a poll, so a value no real timestamp can
 * exceed (the raw string `"nonsense"`, which sorted after every ISO date, or a
 * far-future date) would silence the inbox forever with nothing in any log.
 * Only a parsed instant no later than an hour past now can reach it, and a
 * persisted `since` that is not one is discarded (a cold start) rather than
 * obeyed, which also heals a cursor poisoned before the fix.
 *
 * Because the watermark is exclusive and advances to the newest entry, a second
 * `poll(watermark)` over the same snapshot returns `[]` — no event is ever
 * re-emitted. Events are **triggers, not truth**: a consumer re-reads each item's
 * current state via the adapter before acting, and dedupes on `dedupeKey` +
 * skip-self-authored (`identity.marker`) so a redelivered event acts at most once.
 *
 * The webhook producer is the deferred drop-in implementing the same
 * {@link InboundTransport} interface (NOT built here — v1 ships poll only).
 */
export class PollingTransport implements InboundTransport {
  /** The injected inbox reader (the adapter's `getInbox`) — the sole I/O dependency. */
  private readonly read: InboxReader;
  /** Where dropped-entry warnings go; see {@link PollingTransportOptions.warn}. */
  private readonly warn: (message: string) => void;
  /** The clock; see {@link PollingTransportOptions.now}. */
  private readonly now: () => number;

  /**
   * Construct a polling transport over an injected inbox reader. The reader is the
   * sole I/O dependency; everything the transport does around it is pure.
   *
   * A plain field + assignment (not a TS parameter property) so the module
   * type-strips cleanly under `node --experimental-strip-types`.
   *
   * @param read - The injected inbox reader (the adapter's `getInbox`).
   * @param options - Optional; `warn` redirects dropped-entry warnings and
   *   `now` replaces the clock.
   */
  constructor(read: InboxReader, options: PollingTransportOptions = {}) {
    this.read = read;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.now = options.now ?? Date.now;
  }

  /**
   * Poll the injected reader and return the events strictly newer than `since`,
   * oldest-first, plus the advanced watermark. See the class docs for the four
   * steps; idempotent on the watermark (a re-poll at the returned watermark yields
   * no events).
   *
   * @param since - The last persisted watermark, or `undefined` for a cold start.
   * @returns The fresh events (oldest-first) and the watermark to persist.
   */
  async poll(since?: Watermark): Promise<PollResult> {
    const entries = await this.read();
    const warnings: string[] = [];
    const report = (message: string): void => {
      warnings.push(message);
      this.warn(message);
    };

    const latest = this.now() + FUTURE_MARGIN_MS;

    // An unusable cursor is discarded, not obeyed: `''` is the cold-start value
    // this method itself returns for an empty inbox, and anything else that is
    // not a timestamp, or names a time that has not happened yet, could only
    // have been written by a poisoned poll.
    let sinceAt: number | undefined;
    if (since !== undefined && since !== '') {
      sinceAt = instantOf(since);
      if (sinceAt === undefined || sinceAt > latest) {
        sinceAt = undefined;
        report(
          `flow inbox: the saved watermark ${describeValue(since)} is not a past ` +
            'timestamp, so the whole inbox is read again.'
        );
      }
    }

    // Gap-free delta: strictly newer than the cursor (exclusive), oldest-first so
    // the consumer processes events in occurrence order.
    const fresh: { entry: InboxEntry; at: number }[] = [];
    for (const entry of entries) {
      const on = describeValue(entry?.itemId);
      const at = instantOf(entry?.occurredAt);
      if (at === undefined || at > latest) {
        const why =
          at === undefined ? 'is not an ISO-8601 date-time with a zone' : 'is in the future';
        report(
          `flow inbox: dropped an entry on ${on} because its occurredAt ` +
            `${describeValue(entry?.occurredAt)} ${why}. Fix the adapter's getInbox.`
        );
        continue;
      }
      // No comment means nothing to decide on. Dropped rather than faked as an
      // empty comment: an empty comment on a parked item reads as an anonymous
      // reply, and the agent would un-park its own question with no answer.
      const comment: unknown = entry.comment;
      if (typeof comment !== 'object' || comment === null || Array.isArray(comment)) {
        report(
          `flow inbox: dropped an entry on ${on} because its comment is ` +
            `${describeValue(comment)}, not a comment object. Fix the adapter's getInbox.`
        );
        continue;
      }
      if (sinceAt === undefined || at > sinceAt) {
        // Kept, but said out loud: with no author, only the comment's text can
        // wake a parked question (rule 3), and the reply cannot be attributed.
        if (authorOf(comment as InboxComment).length === 0) {
          report(
            `flow inbox: the comment on ${on} has no author. It is still read, and ` +
              'its text alone can resume a question parked for a reply.'
          );
        }
        fresh.push({ entry, at });
      }
    }
    fresh.sort((a, b) => a.at - b.at);

    const events = fresh.map(({ entry }) => entryToEvent(entry));

    // Advance to the newest consumed occurredAt; hold at `since` when nothing new
    // (or fall back to the cold-start `''` when `since` was unusable).
    const newest = fresh.at(-1);
    const watermark: Watermark =
      newest !== undefined ? newest.entry.occurredAt : sinceAt !== undefined ? (since ?? '') : '';

    return { events, watermark, warnings };
  }
}
