/**
 * The Flow extension's client entry (spec `claude-account-ui` §8.1). The Flow
 * settings tab lands here with the UI work; until then the extension adds
 * nothing to the window, and its server half (`server.ts`) does the work.
 *
 * @module @dorkos/flow/extension
 */

/**
 * Called by DorkOS when the extension is enabled. Registers nothing yet.
 *
 * @returns Nothing to clean up.
 */
export function activate(): void {}
