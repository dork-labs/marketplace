/**
 * The declarations of the journal verbs, `flow note` and `flow journal` (spec
 * `flow-self-improvement` §2, DOR-2391). `scripts/flow.ts` lists them in its
 * verb table; their modules (`note.ts`, `journal.ts` here) load only when run.
 *
 * Kept apart from `flow.ts` because `flow journal` declares a flag per event
 * field, and the table should stay a list.
 *
 * Dependency-free: the parser and `--help` read these before `npm install`.
 *
 * @module @dorkos/flow/cli/journal-verbs
 */

import type { FlagSpec } from './args.ts';
import type { VerbDefinition } from './context.ts';

/** `flow note`: an agent records friction it hit. */
export const noteVerb: VerbDefinition = {
  name: 'note',
  summary: 'Record friction, a workaround or a confusion in the journal.',
  description:
    'Record one sentence about flow itself in the journal: a workaround you improvised, a skill step that was wrong or missing (friction), or two instructions that disagreed (confusion). No secrets, no pasted output. When the journal is off, says so and exits 0.',
  common: ['project', 'session'],
  positionals: [{ name: 'text', required: true, description: 'The note, one sentence.' }],
  flags: [
    {
      name: 'kind',
      kind: 'string',
      value: 'friction|workaround|confusion',
      description: 'What the note is about. Required.',
    },
    { name: 'item', kind: 'string', value: 'id', description: 'The tracker item it happened on.' },
    { name: 'skill', kind: 'string', value: 'name', description: 'The skill it is about.' },
  ],
  load: () => import('./note.ts'),
};

/** The `flow journal record` flags, one per event field, in help order. */
export const RECORD_FLAGS: readonly FlagSpec[] = [
  { name: 'item', kind: 'string', value: 'id', description: 'record: the tracker item.' },
  { name: 'round', kind: 'string', value: 'N', description: 'review: the review round, from 1.' },
  { name: 'sha7', kind: 'string', value: 'sha', description: 'review: the reviewed commit.' },
  { name: 'verdict', kind: 'string', value: 'clean|changes', description: 'review: the verdict.' },
  {
    name: 'blocker',
    kind: 'string',
    value: 'N',
    description: 'review: blockers found. Default 0.',
  },
  {
    name: 'should-fix',
    kind: 'string',
    value: 'N',
    description: 'review: should-fix findings. Default 0.',
  },
  { name: 'nit', kind: 'string', value: 'N', description: 'review: nits found. Default 0.' },
  {
    name: 'categories',
    kind: 'string',
    value: 'a,b',
    description:
      'review: comma-separated finding categories (logic, race, test, migration, security, docs, scope, style, other).',
  },
  { name: 'pr', kind: 'string', value: 'N', description: 'ci: the pull request number.' },
  { name: 'event', kind: 'string', value: 'red|ejected|merged', description: 'ci: what happened.' },
  {
    name: 'class',
    kind: 'string',
    value: 'own|innocent|flake|infra|unknown',
    description: 'ci: whose fault it was.',
  },
  { name: 'from', kind: 'string', value: 'who', description: 'handoff: who handed off.' },
  { name: 'to', kind: 'string', value: 'who', description: 'handoff: who took over.' },
  {
    name: 'reason',
    kind: 'string',
    value: 'limit|stage|manual',
    description: 'handoff: why.',
  },
];

/** The `flow journal tail` flags. */
export const TAIL_FLAGS: readonly FlagSpec[] = [
  {
    name: 'lines',
    kind: 'string',
    short: 'n',
    value: 'N',
    description: 'tail: how many lines. Default 20.',
  },
  { name: 'kind', kind: 'string', value: 'kind', description: 'tail: only lines of this kind.' },
];

/** `flow journal`: record an event the CLI cannot see, or print recent lines. */
export const journalVerb: VerbDefinition = {
  name: 'journal',
  summary: 'Record a review, CI or handoff event, or print recent journal lines.',
  description:
    '"flow journal record <review|ci|handoff> --field value ..." records an event flow cannot see for itself, checked against the journal line schema. "flow journal tail [-n N] [--kind k]" prints the newest lines.',
  common: ['project', 'session'],
  positionals: [
    { name: 'action', required: true, description: 'record or tail.' },
    { name: 'kind', description: 'record: review, ci or handoff.' },
  ],
  flags: [...RECORD_FLAGS, ...TAIL_FLAGS],
  load: () => import('./journal.ts'),
};
