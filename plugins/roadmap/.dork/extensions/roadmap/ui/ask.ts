/**
 * "Ask in this room": the board's only action. It never moves a card. It
 * copies a message for the person who keeps the roadmap and puts the cursor in
 * the room's message box, so the person finishes the reason and sends it.
 *
 * DorkOS has no way for an extension to fill the room's message box yet, so
 * the message goes on the clipboard and a toast says so.
 *
 * @module @dorkos/roadmap/extension/ui/ask
 */

/** What "Ask in this room" needs from the host. */
export interface AskHost {
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;
}

/** A starter `roadmap.json`: the smallest file the board reads. */
export const STARTER_FILE = `${JSON.stringify({ version: 1, milestones: [], items: [] }, null, 2)}\n`;

/**
 * The message that asks the roadmap's keeper to move a bet.
 *
 * @param keeper - The keeper's handle, or null.
 * @param title - The bet.
 * @returns `@keeper move "<title>" to … because …`.
 */
export function moveRequest(keeper: string | null, title: string): string {
  return `${keeper ? `@${keeper} ` : ''}move "${title}" to … because …`;
}

/**
 * The message that asks the keeper to start or update the roadmap.
 *
 * @param keeper - The keeper's handle, or null.
 * @param what - `start` or `update`.
 */
export function roadmapRequest(keeper: string | null, what: 'start' | 'update'): string {
  return `${keeper ? `@${keeper} ` : ''}could you ${what} the roadmap? `;
}

/** Put the cursor in the room's message box, when the page has one. */
function focusComposer(): void {
  const box = document.querySelector<HTMLElement>(
    '[data-composer-card] textarea, [data-composer-card] [contenteditable="true"]'
  );
  box?.focus();
}

/**
 * Copy a message for the room and point the person at the message box.
 *
 * @param host - For the toast.
 * @param text - The message.
 */
export async function askInRoom(host: AskHost, text: string): Promise<void> {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    copied = false;
  }
  focusComposer();
  host.notify(
    copied
      ? 'Copied a message for this room. Paste it in the message box, finish it and send.'
      : `Couldn't copy. Write this in the room: ${text}`,
    { type: 'info' }
  );
}

/**
 * Copy a starter file.
 *
 * @param host - For the toast.
 */
export async function copyStarter(host: AskHost): Promise<void> {
  try {
    await navigator.clipboard.writeText(STARTER_FILE);
    host.notify('Copied a starter roadmap.json. Save it as roadmap/roadmap.json in the repo.', {
      type: 'info',
    });
  } catch {
    host.notify("Couldn't copy the starter file.", { type: 'error' });
  }
}
