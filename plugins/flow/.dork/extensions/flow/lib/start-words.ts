/**
 * The words of every button that starts work in a new chat (spec
 * `flow-multiproject` §7.9, V7): the chat's title, the reason it shows as its
 * first line, the prompt it runs, the row's "· Watch" label, and, for a DorkOS
 * without the seam, the one place a command is ever shown.
 *
 * The prompt is never the headline: DorkOS shows `title` and `reason`, and
 * collapses the prompt. No prompt asks the chat to start further chats.
 *
 * Pure and dependency-free: the browser half and the server half both use it.
 *
 * @module @dorkos/flow/extension/start-words
 */

/** The longest title DorkOS takes. */
export const MAX_TITLE = 80;

/** The longest reason DorkOS takes. */
export const MAX_REASON = 200;

/** The longest "· Watch" label DorkOS takes. */
export const MAX_WATCH_LABEL = 40;

/** Which button started the work. */
export type StartKind = 'set-up' | 'connect' | 'sort' | 'sign-in' | 'daily-sort';

/** What one start sends DorkOS, and what the row says after it. */
export interface StartWords {
  /** The chat's title, plain words. */
  title: string;
  /** Why it was started. */
  reason: string;
  /** What the chat runs. */
  prompt: string;
  /** The row's label while it runs ("Sorting 12 ideas…"). */
  watch: string;
  /** What to type in a chat instead, on a DorkOS that cannot start one. */
  command: string;
}

/** Cut `text` to `max` characters, ending with "…" when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** "12 new ideas", "1 new idea", or "new ideas" when the count is unknown. */
function ideas(count: number | null): string {
  if (count === null || count <= 0) return 'new ideas';
  return count === 1 ? '1 new idea' : `${count} new ideas`;
}

/**
 * The words for one start.
 *
 * @param kind - Which button.
 * @param facts - The project's name, its tracker's name ("Linear"), and the
 *   number of ideas waiting, when known.
 * @returns The words, each within DorkOS's limits.
 */
export function startWords(
  kind: StartKind,
  facts: { name: string; tracker?: string | null; count?: number | null }
): StartWords {
  const tracker = facts.tracker ?? 'the tracker';
  const count = facts.count ?? null;
  let words: StartWords;
  switch (kind) {
    case 'set-up':
      words = {
        title: `Setting up flow in ${facts.name}`,
        reason: 'You asked to set up flow in this repo',
        prompt:
          'Install the flow plugin into this project from the DorkOS Marketplace (at project scope), then run /flow:init to set it up. Do not start any other chats.',
        watch: 'Setting up flow…',
        command: 'Install flow from the Marketplace, then type /flow:init',
      };
      break;
    case 'connect':
      words = {
        title: `Connecting a tracker for ${facts.name}`,
        reason: "Flow is installed here but doesn't know where your work lives yet",
        prompt: '/flow:init',
        watch: 'Connecting a tracker…',
        command: '/flow:init',
      };
      break;
    case 'sort':
      words = {
        title: `Sorting ${ideas(count)} in ${facts.name}`,
        reason: `${ideas(count).replace(/^./, (c) => c.toUpperCase())} ${count === 1 ? 'was' : 'were'} waiting to be sorted`,
        prompt: '/flow:triage',
        watch: count !== null && count > 0 ? `Sorting ${count} ideas…` : 'Sorting ideas…',
        command: '/flow:triage',
      };
      break;
    case 'daily-sort':
      words = {
        title: `Sorting new ideas in ${facts.name}`,
        reason: 'Your settings sort new ideas every morning',
        prompt: '/flow:triage',
        watch: 'Sorting ideas…',
        command: '/flow:triage',
      };
      break;
    case 'sign-in':
      words = {
        title: `Signing in to ${tracker} for ${facts.name}`,
        reason: `${tracker} stopped accepting flow's sign-in`,
        prompt: `/flow:init\n\nOnly reconnect the tracker (${tracker}): its sign-in stopped working. Keep every other setting as it is.`,
        watch: `Signing in to ${tracker}…`,
        command: `/flow:init, and ask it to reconnect ${tracker}`,
      };
      break;
  }
  return {
    ...words,
    title: clip(words.title, MAX_TITLE),
    reason: clip(words.reason, MAX_REASON),
    watch: clip(words.watch, MAX_WATCH_LABEL),
  };
}

/** Plain words for a refused start, by DorkOS's code. */
export function startRefusal(code: unknown, message: unknown, name: string): string {
  const said = typeof message === 'string' && message.trim() !== '' ? message.trim() : null;
  if (code === 'account_not_allowed_here') {
    return `${said ?? `No account may work in ${name}.`} Choose accounts in ${name}'s Flow settings.`;
  }
  if (code === 'start_limit') {
    return said ?? 'Flow started a lot of chats in the last hour. Try again in a few minutes.';
  }
  if (code === 'not_a_project') return said ?? `${name} is no longer a project on this computer.`;
  return "Flow couldn't start that. Try again.";
}

/** Whether an error is DorkOS's refused start (matched by code: a bundle carries its own class). */
export function isStartRefusal(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    ['not_a_project', 'account_not_allowed_here', 'start_limit'].includes(
      (error as { code: string }).code
    )
  );
}
