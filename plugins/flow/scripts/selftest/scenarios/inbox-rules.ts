/**
 * Scenario `inbox-rules`: one comment per comment-response rule, read back
 * from the fake tracker, gets the expected respond, resume or ignore (spec
 * `specs/flow-self-improvement` §1).
 *
 * There is no inbox verb yet: the rules are the pure oracle
 * `shouldRespondToComment` (`scripts/comment-response.ts`). So people comment
 * on the fake, the comments are read back through the adapter (`getItem` with
 * comments), the item's ownership is classified with `classifyOwnership`, and
 * the oracle is called directly with those facts and the loaded config. The
 * adapter contract carries no mention list, so mentions are the `@account`
 * tokens in the body. The agent's own parked question is posted through the
 * adapter, signed with the identity marker, and the park written with
 * `applyWorkState`, since no verb parks an item yet.
 *
 * @module @dorkos/flow/selftest/scenarios/inbox-rules
 */

import { shouldRespondToComment, type CommentAction } from '../../comment-response.ts';
import { classifyOwnership } from '../../identity.ts';
import type { ItemComment } from '../../tracker/types.ts';
import {
  BASE_CONFIG,
  checkEqual,
  seedItem,
  type ScenarioContext,
  type ScenarioOptions,
  withScenario,
} from './harness.ts';

/** The person who reviews the agent's work. */
const REVIEWER = 'person-reviewer';
/** A teammate who owns another thread. */
const TEAMMATE = 'person-teammate';

/** One comment and the decision it must get. */
interface Case {
  /** What the case shows. */
  name: string;
  /** The item commented on. */
  item: string;
  /** The author's account id (`''`: unknown), or `agent` for the agent's own account. */
  author: string;
  /** The body. */
  body: string;
  /** The expected action and rule. */
  expect: { action: CommentAction; rule: number };
}

/** The `@account` tokens in a body. */
function mentions(body: string): string[] {
  return [...body.matchAll(/@([\w.-]+)/g)].map((m) => m[1]);
}

/** Decide every case, reading each comment back through the adapter. */
async function decide(
  ctx: ScenarioContext,
  cases: readonly Case[],
  posted: readonly ItemComment[]
): Promise<void> {
  const config = ctx.loadedConfig();
  const agent = (await ctx.tracker.adapter.getCurrentUser()).id;
  const identity = { agent, reviewer: config.identity.reviewer, marker: config.identity.marker };
  const scope = config.ownership.scope.includes('issues') ? 'issues' : 'projects';
  for (const [i, c] of cases.entries()) {
    const item = await ctx.tracker.adapter.getItem(c.item, { comments: 50 });
    const read = (item.comments ?? []).find((comment) => comment.id === posted[i].id);
    const decision = read
      ? shouldRespondToComment(
          { author: read.author, body: read.body, mentions: mentions(read.body) },
          { item, ownership: classifyOwnership(item, identity, scope), identity },
          config.comments
        )
      : undefined;
    checkEqual(decision, c.expect, `inbox rule for "${c.name}"`);
  }
}

/**
 * Run the inbox-rules scenario.
 *
 * @param options - The flow root and the tracker factory.
 */
export async function inboxRules(options: ScenarioOptions): Promise<void> {
  await withScenario(options, async (ctx) => {
    const tracker = ctx.seed({
      items: [
        seedItem('FAKE-1', { labels: ['type/task'] }),
        seedItem('FAKE-2', { labels: ['type/task'], assignee: TEAMMATE }),
        seedItem('FAKE-3', {
          labels: ['type/task', 'agent/claimed'],
          stateCategory: 'started',
          stateName: 'In Progress',
        }),
      ],
    });
    ctx.config({ ...BASE_CONFIG, identity: { agent: 'auto', reviewer: REVIEWER } });
    const agent = tracker.user.id;
    const marker = ctx.loadedConfig().identity.marker;

    // The agent parks FAKE-3 on a question, signed with its marker.
    const parked = await tracker.adapter.getItem('FAKE-3');
    await tracker.adapter.comment(parked, `Should the export include archived rows?\n\n${marker}`);
    await tracker.adapter.applyWorkState(parked, { agentLabel: 'agent/needs-input' });
    const question = tracker.backlog.comments?.['FAKE-3']?.at(-1);

    const cases: Case[] = [
      {
        name: 'own account',
        item: 'FAKE-1',
        author: agent,
        body: 'Started on this.',
        expect: { action: 'ignore', rule: 1 },
      },
      {
        name: 'shared account, marker in body',
        item: 'FAKE-1',
        author: REVIEWER,
        body: `Picked this up.\n\n${marker}`,
        expect: { action: 'ignore', rule: 1 },
      },
      {
        name: '@mention on a teammate thread',
        item: 'FAKE-2',
        author: TEAMMATE,
        body: `@${agent} can you take a look?`,
        expect: { action: 'respond', rule: 2 },
      },
      {
        name: '/flow token',
        item: 'FAKE-2',
        author: TEAMMATE,
        body: 'Could /flow pick this up next?',
        expect: { action: 'respond', rule: 2 },
      },
      {
        name: 'parked question answered',
        item: 'FAKE-3',
        author: REVIEWER,
        body: 'No, leave archived rows out.',
        expect: { action: 'resume', rule: 3 },
      },
      {
        name: 'empty reply on a parked question',
        item: 'FAKE-3',
        author: '',
        body: '   ',
        expect: { action: 'ignore', rule: 5 },
      },
      {
        name: "teammate's thread, not addressed",
        item: 'FAKE-2',
        author: TEAMMATE,
        body: 'Moving this to next week.',
        expect: { action: 'ignore', rule: 4 },
      },
      {
        name: 'ambiguous, quiet by default',
        item: 'FAKE-1',
        author: REVIEWER,
        body: 'Hm, interesting.',
        expect: { action: 'ignore', rule: 5 },
      },
    ];
    const posted = cases.map((c) => tracker.addComment(c.item, c.author, c.body));
    await decide(ctx, cases, posted);

    // The agent's own question never resumes its own park.
    const own: Case = {
      name: "the agent's own parked question",
      item: 'FAKE-3',
      author: agent,
      body: '',
      expect: { action: 'ignore', rule: 1 },
    };
    if (question !== undefined) await decide(ctx, [own], [question]);
    else checkEqual(question, 'a stored comment', 'the parked question');

    // With ambiguousBias "engage", the soft zone responds.
    ctx.config({
      ...BASE_CONFIG,
      identity: { agent: 'auto', reviewer: REVIEWER },
      comments: { ambiguousBias: 'engage' },
    });
    const engaged: Case = {
      ...cases[7],
      name: 'ambiguous, ambiguousBias engage',
      expect: { action: 'respond', rule: 5 },
    };
    await decide(ctx, [engaged], [posted[7]]);
  });
}
