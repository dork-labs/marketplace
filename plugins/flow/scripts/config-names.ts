/**
 * Where a project keeps flow's settings. Kept apart from `config-files.ts`
 * (which also runs as a CLI and finds its own folder from its module URL) so
 * the Flow extension's bundled server half can name the same files.
 *
 * @module @dorkos/flow/config-names
 */

/** The project folder, relative to a checkout, that holds flow's settings. */
export const PROJECT_CONFIG_DIR = '.agents/flow';
/** The committed team-policy file. */
export const CONFIG_FILE = 'config.json';
/** The per-machine file: credentials and overrides, never committed. */
export const LOCAL_CONFIG_FILE = 'config.local.json';
/**
 * The file whose presence pauses flow's autonomy on this machine. It sits beside
 * `config.local.json` in the main checkout's {@link PROJECT_CONFIG_DIR} and, like
 * it, is never committed.
 */
export const PAUSE_FILE = 'paused.json';
