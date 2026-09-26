/**
 * The messages the drain supervisor sends a worker (spec `flow-handoff-dispatch`
 * §4.4, §5.2, §1 "The resume message").
 *
 * Every message is plain Markdown the runner writes to
 * `.dork/flow/drain/messages/<seq>-<kind>.md` in the worker's worktree and
 * delivers with `launcher.send`. Every message ends with the exact command the
 * worker should run next, spelled with the full flow prefix
 * ({@link MessageContextBase.flow}), on a line of its own in backticks, so a
 * worker never has to guess a verb or its flags.
 *
 * Pure and dependency-free (local zero-dependency modules only), so it runs
 * before `npm install`.
 *
 * @module @dorkos/flow/drain/messages
 */

import { shellQuote } from '../launchers/shell-quote.ts';

/** Every message the supervisor can send a worker. */
export type MessageKind =
  | 'continue'
  | 'open-pr'
  | 'review-findings'
  | 'ci-red'
  | 'merged'
  | 'wind-down'
  | 'resume-from-handoff'
  | 'limit-cleared';

/** Every {@link MessageKind}. */
export const MESSAGE_KINDS: readonly MessageKind[] = [
  'continue',
  'open-pr',
  'review-findings',
  'ci-red',
  'merged',
  'wind-down',
  'resume-from-handoff',
  'limit-cleared',
];

/** What every message needs. */
export interface MessageContextBase {
  /** The full flow command prefix: `node --experimental-strip-types <flow-root>/scripts/flow.ts`. */
  flow: string;
  /** The tracker item, e.g. `ACME-12`. */
  identifier: string;
}

/** A failing check on a pull request. */
export interface FailingCheck {
  /** The check's name. */
  name: string;
  /** Where its run is. */
  url: string;
}

/** Each message kind's context. */
export interface MessageContexts {
  /** The worker stopped without reporting a push, or pushed without reporting it. */
  continue: MessageContextBase & {
    /** `true` when origin's branch moved past the reviewed commit and no push was reported. */
    unreportedPush?: boolean;
    /** `true` when a person answered the question the run parked on. */
    answered?: boolean;
    /** Where the answer is (e.g. "the comment by dorian on ACME-12 at ..."), when known. */
    answer?: string;
  };
  /** The review came back clean at the branch head on origin. */
  'open-pr': MessageContextBase & {
    /** The commit the clean review covers. */
    sha: string;
    /** The pull request's title (the item's title). */
    title: string;
  };
  /** The review asked for changes. */
  'review-findings': MessageContextBase & {
    /** The commit reviewed. */
    sha: string;
    /** The review round (1 for the first verdict). */
    round: number;
    /** The findings file, relative to the worktree. */
    findingsFile: string;
  };
  /** The pull request's checks are failing, or it left the merge queue. */
  'ci-red': MessageContextBase & {
    /** The pull request's web address. */
    prUrl: string;
    /** The failing checks, possibly none (an ejection that reported none). */
    failing: FailingCheck[];
    /** `true` when the PR was ejected from the merge queue rather than failing in place. */
    ejected?: boolean;
  };
  /** The pull request merged. */
  merged: MessageContextBase & {
    /** The pull request's web address. */
    prUrl: string;
  };
  /** The account is close to a limit: finish, checkpoint, stop. */
  'wind-down': MessageContextBase & {
    /** The account's label as the operator knows it. */
    accountLabel: string;
    /** The limit window's label (e.g. "weekly"), when known. */
    windowLabel?: string | null;
  };
  /** The first message of a session that takes over from another account. */
  'resume-from-handoff': MessageContextBase & {
    /** The worktree (absolute). */
    worktree: string;
    /** The run's branch. */
    branch: string;
    /**
     * The previous session's transcript (absolute), when flow could resolve it.
     * The new session reads its last part, read-only; flow never copies, moves
     * or writes a transcript (spec §5.2a).
     */
    transcript?: string | null;
    /** The runtime the previous session ran on, when it was another one than this session's. */
    previousRuntime?: string | null;
  };
  /** The limit that stopped the worker has cleared: carry on. */
  'limit-cleared': MessageContextBase & {
    /** The account's label as the operator knows it. */
    accountLabel: string;
    /**
     * Set when the session goes on under another model because only its model's
     * allowance ran out (spec §5.2a model fallback); absent after a reset.
     */
    model?: string | null;
  };
}

/** The file a worker writes a pull request's body to, relative to its worktree. */
export const PR_BODY_FILE = '.dork/flow/drain/pr-body.md';

/** The file a worker writes its checkpoint body to, relative to its worktree. */
export const CHECKPOINT_BODY_FILE = '.dork/flow/drain/checkpoint-body.md';

/** The file a worker writes its completion summary to, relative to its worktree. */
export const SUMMARY_FILE = '.dork/flow/drain/summary.md';

/** The worker brief, relative to the worktree (spec §4.7). */
export const WORKER_BRIEF_FILE = '.dork/flow/drain/briefs/worker.md';

/**
 * Where a review's findings are copied in the worker's worktree (spec §4.5):
 * `.dork/flow/drain/reviews/<round>-<sha7>.md`.
 *
 * @param round - The review round the verdict recorded (1 for the first).
 * @param sha - The commit reviewed.
 * @returns The path, relative to the worktree.
 */
export function reviewFindingsPath(round: number, sha: string): string {
  return `.dork/flow/drain/reviews/${round}-${sha.slice(0, 7)}.md`;
}

/** A shell word: bare when it needs no quoting, else single-quoted. */
function word(value: string): string {
  return /^[A-Za-z0-9._/:@%+=,-]+$/.test(value) ? value : shellQuote(value);
}

/** A flow command line: the prefix, the verb and its arguments. */
function command(ctx: MessageContextBase, ...args: string[]): string {
  return [ctx.flow, ...args.map(word)].join(' ');
}

/** The seven characters of a SHA people read. */
function short(sha: string): string {
  return sha.slice(0, 7);
}

/** The body, then the next command on its own line: the one shape every message has. */
function compose(paragraphs: string[], next: string): string {
  return `${paragraphs.join('\n\n')}\n\nNext command:\n\n\`${next}\`\n`;
}

/** Refuse a context whose required text is missing, so no message goes out with a hole. */
function need(kind: MessageKind, name: string, value: unknown): void {
  if (typeof value === 'string' ? value.trim() === '' : value === undefined || value === null) {
    throw new Error(`the ${kind} message needs ${name}`);
  }
}

/**
 * The shared "commit, checkpoint, push, report" steps, as a sentence. A fix
 * (review findings or red CI) spells its checkpoint command out; a task's
 * checkpoint names its task, which only the worker knows, so it points at the
 * brief's step instead.
 */
function pushSteps(ctx: MessageContextBase, trigger: 'task' | 'fix'): string {
  if (trigger === 'fix') {
    const checkpoint = command(
      ctx,
      'checkpoint',
      ctx.identifier,
      '--trigger',
      'fix',
      '--body-file',
      CHECKPOINT_BODY_FILE
    );
    return `Commit, write a checkpoint at that commit with \`${checkpoint}\` (its body in \`${CHECKPOINT_BODY_FILE}\`), push, then report the push.`;
  }
  return 'Commit each finished task, write its checkpoint at that commit (the checkpoint step in your brief, `--trigger task`), push, then report the push.';
}

/**
 * Render one message.
 *
 * @param kind - Which message.
 * @param ctx - Its context; every required field must be present and non-empty.
 * @returns The message as Markdown, ending with the next command in backticks.
 * @throws {Error} When a required context field is missing or empty.
 */
export function render<K extends MessageKind>(kind: K, ctx: MessageContexts[K]): string {
  need(kind, 'flow', ctx.flow);
  need(kind, 'identifier', ctx.identifier);
  const id = ctx.identifier;
  const reportPushed = command(ctx, 'report', id, 'pushed');
  switch (kind) {
    case 'continue': {
      const c = ctx as MessageContexts['continue'];
      if (c.unreportedPush) {
        return compose(
          [
            `The branch for ${id} on origin has moved past the commit that was reviewed, but no push was reported.`,
            'If you pushed, report it so the new commit gets reviewed. If you did not, check `git log origin/HEAD` against your branch before going on.',
          ],
          reportPushed
        );
      }
      if (c.answered) {
        return compose(
          [
            c.answer
              ? `A person answered the question ${id} was parked on: ${c.answer}. Read it through the adapter first.`
              : `A person answered the question ${id} was parked on. Read the newest comments on ${id} through the adapter first.`,
            'Then continue from `.dork/flow/HANDOFF.md`. ' + pushSteps(ctx, 'task'),
          ],
          reportPushed
        );
      }
      return compose(
        [
          `You stopped before reporting a push for ${id}.`,
          'Continue from `.dork/flow/HANDOFF.md`. ' + pushSteps(ctx, 'task'),
          `If you are stuck on a question only a person can answer, write it to a file and run \`${command(ctx, 'report', id, 'blocked', '--question-file', '.dork/flow/drain/question.md')}\` instead.`,
        ],
        reportPushed
      );
    }
    case 'open-pr': {
      const c = ctx as MessageContexts['open-pr'];
      need(kind, 'sha', c.sha);
      need(kind, 'title', c.title);
      const title = c.title.replace(/\s+/g, ' ').trim();
      return compose(
        [
          `The review of ${id} came back clean at ${short(c.sha)}, the head of your branch on origin.`,
          `Open the pull request with flow, never with \`gh pr create\`: flow checks the clean review first. Write the pull request's body to \`${PR_BODY_FILE}\`, then run the command below. Push nothing more until it has run.`,
        ],
        command(ctx, 'pr', id, '--title', title, '--body-file', PR_BODY_FILE)
      );
    }
    case 'review-findings': {
      const c = ctx as MessageContexts['review-findings'];
      need(kind, 'sha', c.sha);
      need(kind, 'round', c.round);
      need(kind, 'findingsFile', c.findingsFile);
      return compose(
        [
          `The review of ${id} at ${short(c.sha)} (round ${c.round}) asked for changes.`,
          `Read the findings in \`${c.findingsFile}\` and fix each one. ` + pushSteps(ctx, 'fix'),
        ],
        reportPushed
      );
    }
    case 'ci-red': {
      const c = ctx as MessageContexts['ci-red'];
      need(kind, 'prUrl', c.prUrl);
      const lead = c.ejected
        ? `The pull request for ${id} (${c.prUrl}) left the merge queue without merging.`
        : `Checks are failing on the pull request for ${id} (${c.prUrl}).`;
      const checks =
        c.failing.length === 0
          ? 'No failing check was reported. Open the pull request and read its checks.'
          : ['Failing checks:', ...c.failing.map((f) => `- ${f.name}: ${f.url}`)].join('\n');
      return compose(
        [lead, checks, 'Read each failing run and fix the cause. ' + pushSteps(ctx, 'fix')],
        reportPushed
      );
    }
    case 'merged': {
      const c = ctx as MessageContexts['merged'];
      need(kind, 'prUrl', c.prUrl);
      return compose(
        [
          `The pull request for ${id} merged: ${c.prUrl}.`,
          `Run the DONE stage: follow the closing-work skill, write your completion summary to \`${SUMMARY_FILE}\`, then close the item with the command below.`,
        ],
        command(ctx, 'done', id, '--summary-file', SUMMARY_FILE, '--pr', c.prUrl)
      );
    }
    case 'wind-down': {
      const c = ctx as MessageContexts['wind-down'];
      need(kind, 'accountLabel', c.accountLabel);
      const which = c.windowLabel ? `its ${c.windowLabel} limit` : 'a usage limit';
      return compose(
        [
          `The account ${c.accountLabel} is close to ${which}, so ${id} will move to another session soon.`,
          'Finish the step you are on and commit it. Write the checkpoint below so the next session knows what is done and what is next. If you pushed, report the push afterwards with `' +
            reportPushed +
            '`. Then stop, and take no new step on this account.',
          `Write the checkpoint body to \`${CHECKPOINT_BODY_FILE}\` first.`,
        ],
        command(
          ctx,
          'checkpoint',
          id,
          '--trigger',
          'limit-warning',
          '--body-file',
          CHECKPOINT_BODY_FILE
        )
      );
    }
    case 'resume-from-handoff': {
      const c = ctx as MessageContexts['resume-from-handoff'];
      need(kind, 'worktree', c.worktree);
      need(kind, 'branch', c.branch);
      return compose(
        [
          `You are continuing ${id} in this worktree (${c.worktree}), on branch ${c.branch}.`,
          `Read \`.dork/flow/HANDOFF.md\`, then your brief at \`${WORKER_BRIEF_FILE}\`, then run the command under "Next command" in HANDOFF.md.`,
          c.previousRuntime
            ? `The previous session ran on another tool (${c.previousRuntime}) and another account. Do not run \`flow claim\`: the run is already yours.`
            : 'The previous session was on another account. Do not run `flow claim`: the run is already yours.',
          ...(c.transcript
            ? [
                `For detail HANDOFF.md leaves out, read the last part of the previous session's transcript at \`${c.transcript}\` (for example \`tail -n 200\`). Only read it: never edit, copy or move it.`,
              ]
            : []),
          'First, check where the run stands:',
        ],
        command(ctx, 'status', id)
      );
    }
    case 'limit-cleared': {
      const c = ctx as MessageContexts['limit-cleared'];
      need(kind, 'accountLabel', c.accountLabel);
      return compose(
        [
          c.model
            ? `${c.accountLabel} ran out of room for the model you were on, so this session now runs on ${c.model}. Continue ${id} from where you stopped; \`.dork/flow/HANDOFF.md\` says what is next.`
            : `The limit on ${c.accountLabel} has reset. Continue ${id} from where you stopped; \`.dork/flow/HANDOFF.md\` says what is next.`,
          pushSteps(ctx, 'task'),
        ],
        reportPushed
      );
    }
    default: {
      const unknown: never = kind;
      throw new Error(`unknown message kind ${String(unknown)}`);
    }
  }
}
