import { describe, it, expect } from 'vitest';
import { CommentsSchema } from '../scripts/config-schema.ts';
import {
  shouldRespondToComment,
  type CommentDecisionContext,
  type CommentIdentity,
  type CommentsConfig,
  type InboxComment,
} from '../scripts/comment-response.ts';
import type { OwnershipClass, WorkItem } from '../scripts/work-item.ts';

/** The §9 resolved default comments config — `respondWhen: addressed`, `ambiguousBias: quiet`. */
const DEFAULT_COMMENTS: CommentsConfig = CommentsSchema.parse({});

/** The resolved agent identity used across the suite. */
const IDENTITY: CommentIdentity = { agent: 'agent-account', marker: '— 🤖 /flow' };

/**
 * Build a WorkItem with overridable fields (mirrors dispatch.test's factory).
 *
 * Populates EVERY field, including the optional ones (`priority`, `size`,
 * `project`, `assignee`, `agentDisposition`, `createdAt`) — not just the
 * required ones. The non-conformance sweep below derives its field list from
 * this fixture at runtime, so an optional field left unpopulated here would be
 * silently missing from the sweep too (see dispatch.test.ts's `makeItem` for
 * the same discipline, and DOR-535 for why it matters: `labels` was covered by
 * exactly this kind of sweep in dispatch-policy.ts before anyone thought to
 * apply it here).
 */
function makeItem(overrides: Partial<WorkItem> & { identifier: string }): WorkItem {
  return {
    id: `node_${overrides.identifier}`,
    title: `Title ${overrides.identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'started',
    stateName: 'In Progress',
    priority: 3,
    size: 'md',
    project: { id: 'proj_a', name: 'Project A', stateCategory: 'started' },
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: [],
    assignee: 'agent-account',
    agentDisposition: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build an inbound comment with overridable fields. */
function comment(overrides: Partial<InboxComment> = {}): InboxComment {
  return { author: 'human-account', mentions: [], body: 'a plain comment', ...overrides };
}

/** Assemble the decision context: item + injected ownership + identity. */
function ctx(
  ownership: OwnershipClass,
  item: WorkItem = makeItem({ identifier: 'DOR-1' })
): CommentDecisionContext {
  return { item, ownership, identity: IDENTITY };
}

describe('shouldRespondToComment — rule 1: never answer its own comments', () => {
  it('ignores a comment authored by the agent account', () => {
    const c = comment({ author: 'agent-account', body: 'I claimed this' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 1 });
  });

  it('ignores a comment carrying the identity.marker (shared-account mode)', () => {
    // Different author, but the marker proves the agent wrote it.
    const c = comment({ author: 'shared-account', body: 'Assumption logged — 🤖 /flow' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 1 });
  });

  it('rule 1 wins even when the agent @mentions itself (no self-reply loop)', () => {
    // Own comment AND a self-@mention: rule 1 must outrank rule 2.
    const c = comment({
      author: 'agent-account',
      mentions: ['agent-account'],
      body: '/flow status',
    });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 1 });
  });
});

describe('shouldRespondToComment — rule 2: always respond when directly addressed', () => {
  it('responds on an @mention of the agent account', () => {
    const c = comment({ mentions: ['agent-account'], body: 'can you take this?' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'respond', rule: 2 });
  });

  it('responds on an explicit /flow token in the body (shared-mode address)', () => {
    const c = comment({ body: '/flow please re-run verify' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'respond', rule: 2 });
  });

  it('OVERRIDES ownership — responds even on an other-owned thread when mentioned', () => {
    const c = comment({ mentions: ['agent-account'], body: 'thoughts here?' });
    const decision = shouldRespondToComment(c, ctx('other'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'respond', rule: 2 });
  });
});

describe('shouldRespondToComment — rule 3: resume a parked needs-input item', () => {
  it('resumes when an agent/needs-input item gets a non-agent comment', () => {
    const item = makeItem({ identifier: 'DOR-2', labels: ['agent/needs-input', 'stage/execute'] });
    const c = comment({ author: 'human-account', body: 'go with option B' });
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'resume', rule: 3 });
  });

  it("does NOT resume on the agent's own comment on a needs-input item (rule 1 wins)", () => {
    const item = makeItem({ identifier: 'DOR-2', labels: ['agent/needs-input'] });
    const c = comment({ author: 'agent-account', body: 'parked: which approach?' });
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 1 });
  });

  it('a directly-addressed comment on a needs-input item responds (rule 2 outranks rule 3)', () => {
    const item = makeItem({ identifier: 'DOR-2', labels: ['agent/needs-input'] });
    const c = comment({ mentions: ['agent-account'], body: 'here is the answer' });
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'respond', rule: 2 });
  });
});

describe('shouldRespondToComment — rule 4: stay out of other-owned threads', () => {
  it('ignores a non-addressed comment on an other-owned thread', () => {
    const c = comment({ author: 'teammate', body: 'discussing internals' });
    const decision = shouldRespondToComment(c, ctx('other'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 4 });
  });
});

describe('shouldRespondToComment — rule 5: soft zone leans quiet', () => {
  it('ignores an ambiguous comment on a mine thread (quiet default)', () => {
    const c = comment({ author: 'human-account', body: 'nice progress' });
    const decision = shouldRespondToComment(c, ctx('mine'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 5 });
  });

  it('ignores an ambiguous comment on an unassigned thread (quiet default)', () => {
    const c = comment({ author: 'human-account', body: 'looks good' });
    const decision = shouldRespondToComment(c, ctx('unassigned'), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 5 });
  });

  it('responds in the soft zone when ambiguousBias is flipped to engage', () => {
    const engage = CommentsSchema.parse({ ambiguousBias: 'engage' });
    const c = comment({ author: 'human-account', body: 'any update?' });
    const decision = shouldRespondToComment(c, ctx('reviewer'), engage);
    expect(decision).toEqual({ action: 'respond', rule: 5 });
  });
});

describe('shouldRespondToComment — DOR-535: rule 3 degrades a non-conformant `labels`', () => {
  // `labels` is required under the adapter contract (mirroring the argument
  // already settled for `relations` / `size` / `createdAt` / `labels` in
  // dispatch-policy.ts, DOR-515): the runtime must not crash on a
  // non-conformant adapter, and it must not silently treat a non-array as if
  // it carried the needs-input label.

  it('degrades `labels: undefined` without throwing, and does NOT resume', () => {
    const item = makeItem({ identifier: 'DOR-2', labels: undefined as unknown as string[] });
    const c = comment({ author: 'human-account', body: 'go with option B' });
    expect(() => shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS)).not.toThrow();
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    // No labels ⇒ not parked ⇒ falls through to the rule 5 soft zone (quiet).
    expect(decision).toEqual({ action: 'ignore', rule: 5 });
  });

  it('degrades `labels: null` without throwing, and does NOT resume', () => {
    const item = makeItem({ identifier: 'DOR-2', labels: null as unknown as string[] });
    const c = comment({ author: 'human-account', body: 'go with option B' });
    expect(() => shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS)).not.toThrow();
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'ignore', rule: 5 });
  });

  it('rejects a bare-string `labels` scalar instead of substring-matching it (the silent failure)', () => {
    // `"agent/needs-input".includes("agent/needs-input")` is TRUE — a scalar
    // `labels` would otherwise sail through rule 3 and get treated as a parked
    // item on a shape the contract never allowed, with no error to notice.
    const item = makeItem({
      identifier: 'DOR-2',
      labels: 'agent/needs-input' as unknown as string[],
    });
    const c = comment({ author: 'human-account', body: 'go with option B' });
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(decision).not.toEqual({ action: 'resume', rule: 3 });
    expect(decision).toEqual({ action: 'ignore', rule: 5 });
  });

  it('still resumes normally when `labels` is a real array carrying the needs-input label', () => {
    // The control case: the guard must not have swallowed the real signal.
    const item = makeItem({ identifier: 'DOR-2', labels: ['agent/needs-input'] });
    const c = comment({ author: 'human-account', body: 'go with option B' });
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(decision).toEqual({ action: 'resume', rule: 3 });
  });
});

describe('shouldRespondToComment — non-conformance sweep (WorkItem fields)', () => {
  // Same shape as the dispatch-policy.ts sweep (`engine-tests/dispatch.test.ts`,
  // DOR-515): substitute a hostile value into EVERY WorkItem field mechanically
  // and assert `shouldRespondToComment` never throws. That sweep is what found
  // the original crash before anyone thought to look at this call site
  // (DOR-535); the field list is derived at runtime so a field added later is
  // covered without anyone remembering to think of it.
  const HOSTILE_VALUES: [label: string, value: unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['an empty array', []],
  ];

  // `identifier` is excluded for the same reason dispatch.test.ts excludes it:
  // it is the relation key, not a degradable data field.
  const ITEM_FIELDS = (
    Object.keys(makeItem({ identifier: 'DOR-PROBE' })) as (keyof WorkItem)[]
  ).filter((field) => field !== 'identifier');

  it('derives its field list from the fixture, and the fixture is complete', () => {
    // Guards the derivation itself: if `makeItem` stops populating a field the
    // sweep silently shrinks; if a field is added the sweep grows. The count
    // below makes that change deliberate and announced rather than silent.
    expect(ITEM_FIELDS).toHaveLength(15);
    expect(ITEM_FIELDS).not.toContain('identifier');
    expect(ITEM_FIELDS).toEqual(expect.arrayContaining(['labels', 'relations']));
  });

  const itemCases = ITEM_FIELDS.flatMap((field) =>
    HOSTILE_VALUES.map(([label, value]) => [field, label, value] as const)
  );

  it.each(itemCases)('survives WorkItem.%s = %s without throwing', (field, _label, value) => {
    const item = { ...makeItem({ identifier: 'DOR-HOSTILE' }), [field]: value };
    const c = comment({ author: 'human-account', body: 'a plain comment' });

    expect(() => shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS)).not.toThrow();
    const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
    expect(['respond', 'resume', 'ignore']).toContain(decision.action);
    expect([1, 2, 3, 4, 5]).toContain(decision.rule);
  });
});

describe('shouldRespondToComment — non-conformance sweep (InboxComment fields)', () => {
  // The InboxComment half of the same sweep: `author`, `mentions`, `body` are
  // all required under the adapter's `getInbox` contract, and the same
  // graceful-degradation argument applies to a non-conformant comment as to a
  // non-conformant WorkItem.
  const HOSTILE_VALUES: [label: string, value: unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['an empty array', []],
  ];

  const COMMENT_FIELDS = Object.keys(comment()) as (keyof InboxComment)[];

  it('derives its field list from the fixture, and the fixture is complete', () => {
    expect(COMMENT_FIELDS).toHaveLength(3);
    expect(COMMENT_FIELDS).toEqual(expect.arrayContaining(['author', 'mentions', 'body']));
  });

  const commentCases = COMMENT_FIELDS.flatMap((field) =>
    HOSTILE_VALUES.map(([label, value]) => [field, label, value] as const)
  );

  it.each(commentCases)(
    'survives InboxComment.%s = %s without throwing',
    (field, _label, value) => {
      const c = { ...comment(), [field]: value };
      const item = makeItem({ identifier: 'DOR-1' });

      expect(() => shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS)).not.toThrow();
      const decision = shouldRespondToComment(c, ctx('mine', item), DEFAULT_COMMENTS);
      expect(['respond', 'resume', 'ignore']).toContain(decision.action);
      expect([1, 2, 3, 4, 5]).toContain(decision.rule);
    }
  );
});
