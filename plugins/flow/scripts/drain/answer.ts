/**
 * Finding the answer to a parked drain run (spec `flow-handoff-dispatch` §4.4,
 * "Park"). The inbox pass leaves drain runs to the drain, so the drain itself
 * reads the parked item's recent comments on each pass and looks for a reply.
 *
 * The rules are the comment-response rules every flow inbox uses
 * (`shouldRespondToComment`): the agent's own comments never count, and a
 * non-empty reply on an `agent/needs-input` item is the answer. Only comments
 * newer than the park count; for a record from before parks were timed, only
 * comments after the agent's own latest one.
 *
 * Pure: no I/O. Needs `zod` only through the config type's module, so it is
 * reached from the verb.
 *
 * @module @dorkos/flow/drain/answer
 */

import {
  shouldRespondToComment,
  type CommentIdentity,
  type CommentsConfig,
} from '../comment-response.ts';
import type { ItemComment, WorkItem } from '../tracker/types.ts';
import type { OwnershipClass } from '../work-item.ts';

/** What {@link findAnswer} judges a comment with. */
export interface AnswerContext {
  /** The agent's resolved identity (its account id and marker). */
  identity: CommentIdentity;
  /** The item's ownership class. */
  ownership: OwnershipClass;
  /** The `comments` config. */
  comments: CommentsConfig;
}

/** How far from `parkedAt` the park comment may be stamped by the tracker's clock. */
const PARK_ANCHOR_WINDOW_MS = 10 * 60_000;

/** Tolerated clock skew between this machine and the tracker when no park comment is found. */
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * The newest reply that answers a parked item, or `null`.
 *
 * @param item - The item, with its labels (rule 3 reads `agent/needs-input`).
 * @param comments - Its recent comments, oldest first.
 * @param since - When the run parked (ISO), or `null` when unknown.
 * @param ctx - The identity, ownership and comment settings.
 * @returns The answering comment, or `null`.
 */
export function findAnswer(
  item: WorkItem,
  comments: readonly ItemComment[],
  since: string | null,
  ctx: AnswerContext
): ItemComment | null {
  const decide = (comment: ItemComment) =>
    shouldRespondToComment(
      { author: comment.author, mentions: [], body: comment.body },
      { item, ownership: ctx.ownership, identity: ctx.identity },
      ctx.comments
    );
  const parkedAt = since === null ? Number.NaN : Date.parse(since);
  let candidates = [...comments];
  if (Number.isFinite(parkedAt)) {
    // parkedAt is this machine's clock; comment times are the tracker's. Anchor
    // on the park comment itself (the agent's own comment around parkedAt) when
    // it is there, and otherwise allow a small skew, so a quick reply is never
    // missed because the local clock runs ahead.
    const parkComment = candidates
      .map((comment, index) => ({ comment, index }))
      .filter(
        ({ comment }) =>
          decide(comment).rule === 1 &&
          Math.abs(Date.parse(comment.createdAt) - parkedAt) <= PARK_ANCHOR_WINDOW_MS
      )[0];
    candidates =
      parkComment !== undefined
        ? candidates.filter(
            (comment, index) =>
              index !== parkComment.index &&
              Date.parse(comment.createdAt) >= Date.parse(parkComment.comment.createdAt)
          )
        : candidates.filter((comment) => Date.parse(comment.createdAt) > parkedAt - CLOCK_SKEW_MS);
  } else {
    // No park time: only what came after the agent's own latest comment (its question).
    const lastOwn = candidates
      .map(decide)
      .map((d) => d.rule === 1)
      .lastIndexOf(true);
    candidates = candidates.slice(lastOwn + 1);
  }
  for (const comment of candidates.reverse()) {
    if (decide(comment).action !== 'ignore') return comment;
  }
  return null;
}

/**
 * A pointer to the answer, for the worker's `continue` message.
 *
 * @param comment - The answering comment.
 * @param identifier - The item.
 * @returns E.g. `the comment by dorian on ACME-12 at 2026-09-26T12:05:00Z`.
 */
export function answerPointer(comment: ItemComment, identifier: string): string {
  const who = comment.author === '' ? 'a person' : comment.author;
  return `the comment by ${who} on ${identifier} at ${comment.createdAt}`;
}
