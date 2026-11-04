/** A separate CLI process journals a parent-observed failure without loading CLI modules in the extension. */
import { invokedDirectly } from './_shared.ts';
import { recordEvent } from './cli/auto-journal.ts';
import { assertProjectInRunCheckout } from './project-boundary.ts';

/** Accept only fixed categories and a duration; never accept a tracker response or message. */
export function recordPanelFailure(
  argv: readonly string[],
  cwd = process.cwd(),
  now = () => new Date()
): boolean {
  const [projectDir, flowRoot, verb, reason, duration] = argv;
  if (
    argv.length !== 5 ||
    !projectDir ||
    !flowRoot ||
    !['snapshot', 'next', 'status'].includes(verb) ||
    !['timeout', 'killed', 'unreachable'].includes(reason) ||
    !/^\d+$/.test(duration)
  )
    return false;
  const ms = Number(duration);
  if (!Number.isSafeInteger(ms)) return false;
  try {
    assertProjectInRunCheckout(cwd, projectDir);
    recordEvent(
      { projectDir, flowRoot, env: process.env, sessionId: undefined, now },
      { kind: 'verb', verb, ms, exit: 4, reason: reason as 'timeout' | 'killed' | 'unreachable' }
    );
    return true;
  } catch {
    return false;
  }
}

if (invokedDirectly(import.meta.url))
  process.exitCode = recordPanelFailure(process.argv.slice(2)) ? 0 : 1;
