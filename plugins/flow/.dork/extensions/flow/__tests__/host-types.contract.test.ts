/**
 * The drift guard (spec `flow-multiproject` §10.1): flow's mirror of the host
 * types (`lib/host-types.ts`) against core's seam contract, vendored whole into
 * `lib/__contract__/` from dork-labs/dorkos
 * `packages/extension-api/src/__fixtures__/seam-contract/` (1.2.0, at
 * 5b683d964bb8). Core checks the same file against its real types in both
 * directions, so a seam core renames or reshapes fails here as soon as the
 * fixture is refreshed, never at run time on someone's machine.
 *
 * The rule is one-way on this side: every seam flow mirrors must be assignable
 * from the contract's (flow may mirror a subset, never a different shape).
 * Refresh by copying both files over the vendored ones; never edit them by hand.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as Contract from '../lib/__contract__/seams.contract.ts';
import type {
  DataProviderContext,
  DecisionActionEvent,
  DecisionActionResult,
  DecisionActions,
  DecisionActor,
  DecisionAnswer,
  DecisionAnswerResult,
  DecisionInput,
  DecisionOffer,
  DecisionOutcome,
  ExtensionDecisionView,
  InboxApi,
  ProjectSettingsReader,
  RaisedDecision,
  RecordedDecisionInput,
  ExtensionPageOptions,
  ExtensionPageProps,
  LimitedSessionInfo,
  ProjectInfo,
  ProjectRef,
  ProjectsApi,
  ReadableState,
  SessionInfo,
  StatusBarItemOptions,
  StatusBarSlotContext,
  TrackerItemRef,
} from '../lib/host-types.ts';
import type { FlowExtensionApi } from '../index.ts';

const CONTRACT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'lib',
  '__contract__'
);

describe('the vendored seam contract', () => {
  it('is the 1.x line flow was built against', () => {
    // A major bump is a removal or a narrowing on core's side: read what
    // changed and update the mirror before moving this line.
    const version = readFileSync(path.join(CONTRACT_DIR, 'CONTRACT_VERSION'), 'utf8').trim();
    expect(version).toMatch(/^1\.\d+\.\d+$/);
  });
});

describe('lib/host-types.ts against the contract', () => {
  it('mirrors the project registry exactly as core ships it', () => {
    expectTypeOf<Contract.ProjectRef>().toExtend<ProjectRef>();
    expectTypeOf<Contract.ProjectInfo>().toExtend<ProjectInfo>();
    expectTypeOf<Contract.ProjectsApi>().toExtend<ProjectsApi>();
    expectTypeOf<Contract.DataProviderContextSeams['projects']>().toExtend<
      NonNullable<DataProviderContext['projects']>
    >();
  });

  it('takes core’s person guard as route middleware', () => {
    expectTypeOf<Contract.DataProviderContextSeams['requirePerson']>().toExtend<
      NonNullable<DataProviderContext['requirePerson']>
    >();
  });

  it('reads a session’s tracker items as core sends them', () => {
    expectTypeOf<Contract.SessionInfoSeams['trackerItems']>().toExtend<
      NonNullable<SessionInfo['trackerItems']>
    >();
    expectTypeOf<Contract.SessionInfoSeams['trackerItems']>().toExtend<
      NonNullable<LimitedSessionInfo['trackerItems']>
    >();
    expectTypeOf<Contract.SessionInfoSeams['trackerItem']>().toExtend<SessionInfo['trackerItem']>();
  });

  it('reads the chat’s project and navigates as the client API does', () => {
    expectTypeOf<Contract.ExtensionReadableStateSeams['currentProject']>().toExtend<
      ReadableState['currentProject']
    >();
    expectTypeOf<Contract.ExtensionAPISeams['navigate']>().toExtend<FlowExtensionApi['navigate']>();
  });

  it('registers pages, the status-bar item and the tab marker as core takes them', () => {
    expectTypeOf<Contract.ExtensionPageProps>().toExtend<ExtensionPageProps>();
    expectTypeOf<Contract.ExtensionPageOptions>().toExtend<ExtensionPageOptions>();
    expectTypeOf<Contract.TrackerItemRef>().toExtend<TrackerItemRef>();
    expectTypeOf<Contract.StatusBarSlotContext>().toExtend<StatusBarSlotContext>();
    expectTypeOf<Contract.StatusBarItemOptions>().toExtend<StatusBarItemOptions>();
    expectTypeOf<Contract.ExtensionAPISeams['registerPage']>().toExtend<
      NonNullable<FlowExtensionApi['registerPage']>
    >();
    expectTypeOf<Contract.ExtensionAPISeams['registerStatusBarItem']>().toExtend<
      NonNullable<FlowExtensionApi['registerStatusBarItem']>
    >();
    expectTypeOf<Contract.ExtensionAPISeams['setTabMarker']>().toExtend<
      NonNullable<FlowExtensionApi['setTabMarker']>
    >();
  });

  it('mirrors the inbox exactly as core ships it', () => {
    expectTypeOf<Contract.DecisionActions>().toExtend<DecisionActions>();
    expectTypeOf<Contract.DecisionInput>().toExtend<DecisionInput>();
    expectTypeOf<Contract.RaisedDecision>().toExtend<RaisedDecision>();
    expectTypeOf<Contract.DecisionOutcome>().toExtend<DecisionOutcome>();
    expectTypeOf<Contract.DecisionActor>().toExtend<DecisionActor>();
    expectTypeOf<Contract.DecisionActionEvent>().toExtend<DecisionActionEvent>();
    expectTypeOf<Contract.DecisionOffer>().toExtend<DecisionOffer>();
    expectTypeOf<Contract.RecordedDecisionInput>().toExtend<RecordedDecisionInput>();
    // flow's answers must be answers core takes.
    expectTypeOf<DecisionActionResult>().toExtend<Contract.DecisionActionResult>();
    expectTypeOf<DecisionInput>().toExtend<Contract.DecisionInput>();
    expectTypeOf<RecordedDecisionInput>().toExtend<Contract.RecordedDecisionInput>();
    expectTypeOf<Contract.InboxApi>().toExtend<InboxApi>();
    expectTypeOf<Contract.DataProviderContextSeams['inbox']>().toExtend<
      NonNullable<DataProviderContext['inbox']>
    >();
  });

  it('reads per-project settings without any way to write them', () => {
    expectTypeOf<Contract.ProjectSettingsReader>().toExtend<ProjectSettingsReader>();
    expectTypeOf<Contract.DataProviderContextSeams['projectSettings']>().toExtend<
      NonNullable<DataProviderContext['projectSettings']>
    >();
    // The server half has no setter (spec §7.7): the dial is written only by a person.
    expectTypeOf<ProjectSettingsReader>().not.toHaveProperty('set');
    expectTypeOf<Contract.ProjectSettingsReader>().not.toHaveProperty('set');
  });

  it('writes the dial only through the client API, as core ships it', () => {
    // The browser's `set` is the one writer (spec §7.7), behind the person bar.
    expectTypeOf<Contract.ExtensionAPISeams['projectSettings']>().toExtend<
      NonNullable<FlowExtensionApi['projectSettings']>
    >();
  });

  it('answers from its own pages the way the client API does', () => {
    expectTypeOf<Contract.DecisionAnswer>().toExtend<DecisionAnswer>();
    expectTypeOf<DecisionAnswer>().toExtend<Contract.DecisionAnswer>();
    expectTypeOf<Contract.DecisionAnswerResult>().toExtend<DecisionAnswerResult>();
    expectTypeOf<Contract.ExtensionDecisionView>().toExtend<ExtensionDecisionView>();
    expectTypeOf<Contract.ExtensionAPISeams['listDecisions']>().toExtend<
      NonNullable<FlowExtensionApi['listDecisions']>
    >();
    expectTypeOf<Contract.ExtensionAPISeams['answerDecision']>().toExtend<
      NonNullable<FlowExtensionApi['answerDecision']>
    >();
    expectTypeOf<Contract.ExtensionReadableStateSeams['requireLogin']>().toExtend<
      NonNullable<ReadableState['requireLogin']>
    >();
  });
});
