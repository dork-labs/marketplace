/**
 * A recording arm guard for tests of a verb's own arm logic (DOR-3262). It
 * answers `ok` unless told to refuse, and keeps every request so a test can
 * show the guard was asked, about which commit, before the arm. The real guard
 * is tested on its own in `engine-tests/land/`.
 */

import type { ArmGuard, ArmGuardRequest } from '../../../scripts/cli/context.ts';
import type { GuardResult } from '../../../scripts/land/arm-guard.ts';

/** A guard and what it was asked. */
export interface RecordingGuard {
  /** Pass as `armGuard` in the CLI deps. */
  guard: ArmGuard;
  /** Every request, in order. */
  requests: ArmGuardRequest[];
}

/**
 * Build a recording guard.
 *
 * @param answer - What it answers (default `ok`).
 * @returns The guard and its requests.
 */
export function recordingGuard(
  answer: (request: ArmGuardRequest) => GuardResult = () => ({ ok: true, preArm: [] })
): RecordingGuard {
  const requests: ArmGuardRequest[] = [];
  return {
    requests,
    guard: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
}

/** A refusal, for tests that the arm does not happen. */
export function refusal(
  reason: Extract<GuardResult, { ok: false }>['reason'] = 'freeze',
  ranPreArm = false
): GuardResult {
  return { ok: false, reason, detail: `refused for the test (${reason})`, ranPreArm, preArm: [] };
}
