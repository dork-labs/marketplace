/**
 * The Flow tab's calls to DorkOS's own routes (not flow's), made from the
 * person's browser as that person (spec `flow-multiproject` §5.2).
 *
 * @module @dorkos/flow/extension/ui/core-api
 */

import { resolveApiBaseUrl } from './api.ts';

/** What switching a schedule back on came to. */
export type EnableResult = 'on' | 'gone' | 'failed';

/**
 * Switch one DorkOS schedule back on (`PATCH /api/tasks/:id`), as the person
 * whose browser this is. A schedule someone deleted since is `gone`: there is
 * nothing left to switch on.
 *
 * @param id - The schedule's id.
 * @returns What happened.
 */
export async function enableSchedule(id: string): Promise<EnableResult> {
  try {
    const response = await fetch(`${resolveApiBaseUrl()}/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    if (response.ok) return 'on';
    return response.status === 404 ? 'gone' : 'failed';
  } catch {
    return 'failed';
  }
}
