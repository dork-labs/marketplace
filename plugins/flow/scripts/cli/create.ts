/**
 * `flow create` (DOR-2433): file one new item through the adapter's
 * `createItem` (contract 2.2.0). The capturing-work skill calls it for its one
 * tracker write; the judgment (what to capture, how to title it, which labels)
 * stays in the skill.
 *
 * - Files only a triaged item (DOR-4546). Refuses (exit 2) before any tracker
 *   call, naming every problem in one message: a missing title, description,
 *   type, MoSCoW priority 1-4 (0 "none" is refused), size or
 *   project, a missing proof or done-when section in the description
 *   (`create-fields.ts`), and every malformed value: an `agent/*` label other
 *   than `agent/from-outside` (readiness is triage's decision), two labels of
 *   one group, a bad priority, size, key or `--not-duplicate-of`, and a title
 *   ending in a capture tag (`[owner/name#N]`) without `agent/from-outside`.
 * - The type is a `type/*` label or a bare `Bug`, `Improvement` or `Feature`
 *   (any case, written once in the tracker's spelling; `type-labels.ts`). A
 *   bare label brings its `type/*` (`Bug` and `Improvement`: `type/task`;
 *   `Feature`: `type/idea`). `type/task` also gets `Improvement`, only when the
 *   team has that label (`optionalLabels`); `type/idea`, capture's
 *   placeholder, gets nothing. Two bare types, or a bare label and a `type/*`
 *   that name different types, are refused.
 *   There is no way around it: an item that cannot say these is not ready to
 *   file.
 * - Needs the `createItem` and `getBacklogSnapshot` capabilities (exit 3
 *   naming them), and an adapter at contract 3.1.0 or later, which can hold
 *   the size (exit 3 naming the version).
 * - Checks for a duplicate first: an open item, other than the `--parent`,
 *   whose title nearly matches (`duplicate-title.ts`) stops the create. It
 *   exits 5 with `nearMatches` in the JSON (identifier, title, score) and a
 *   first text line starting `near duplicate:`; a caller keys on those, not
 *   on the exit code. `--not-duplicate-of <ids>` files anyway once it names
 *   every near match. Every description gains a line naming the words compared
 *   and any items ruled out. One backlog pull per create.
 * - Signs the description with the project's identity marker and this
 *   session's provenance line, as `flow done` signs its summary.
 * - With `--key`, the description carries a `<!-- flow-create:key=<k> -->`
 *   line. An open item already holding that line is returned, and nothing is
 *   created. Otherwise the key goes to `createItem`, so a retry after a
 *   timeout also gets the first item back. A key names one OPEN item: once its
 *   item is closed, the same key files a new one.
 * - `--dry-run` runs every check, duplicates included, prints the planned item
 *   and writes nothing.
 * - A `--description-file` under `.dork/flow/tmp/` is removed once the item
 *   is filed or found, by the scratch-file rule in `scratch-file.ts`.
 *
 * `created` is false when the item was already open before this run: found by
 * its marker, or handed back by the adapter for the key. Two runs racing on
 * one key both reach `createItem`; the adapter files one item, and both runs
 * may report it as created.
 *
 * Its journal line is the `verb` line `main` writes for every run, with the
 * item it filed or found.
 *
 * @module @dorkos/flow/cli/create
 */

import { findConfigRoots } from '../config-files.ts';
import { loadConfig } from '../config-load.ts';
import { CAPTURE_TAG, nearMatches, titleWords, type NearMatch } from '../duplicate-title.ts';
import { EXIT } from '../errors.ts';
import { requireCapabilities, requireContract } from '../tracker/load.ts';
import type { Capability, NewItem } from '../tracker/types.ts';
import { AGENT_FROM_OUTSIDE, labelGroup } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { resolveTypes } from '../type-labels.ts';
import { missingFields, notDuplicateOf, priorityOf, refusal, sizeOf } from './create-fields.ts';
import { flagText, removeScratch } from './scratch-file.ts';
import { signBody, trackerVisibility } from './provenance.ts';
import { sessionProvenance } from './work-write.ts';

/** The first contract version whose `createItem` takes a size. */
const SIZE_CONTRACT = [3, 1] as const;

/** What a key may hold: it goes into an HTML comment and a tracker id. */
const KEY_PATTERN = /^[A-Za-z0-9._:/@]+(?:-[A-Za-z0-9._:/@]+)*$/;

/** The longest key accepted. */
const KEY_MAX = 200;

/**
 * The marker line a keyed item's description carries.
 *
 * @param key - The idempotency key.
 * @returns The line, `<!-- flow-create:key=<key> -->`.
 */
export function keyMarker(key: string): string {
  return `<!-- flow-create:key=${key} -->`;
}

/**
 * The labels, each once, recording a problem when one is empty, `agent/*`
 * (other than `agent/from-outside`), or shares a group with another.
 */
function labelList(ctx: VerbContext, problems: string[]): string[] {
  const labels = [...new Set(ctx.args.repeated?.label ?? [])];
  const groups = new Map<string, string>();
  for (const label of labels) {
    if (label.trim() === '') {
      problems.push('a --label is empty');
      continue;
    }
    const group = labelGroup(label);
    // The one exception: an item captured from outside the team carries
    // agent/from-outside, which keeps it from ever being readied unattended.
    if (group === 'agent' && label !== AGENT_FROM_OUTSIDE) {
      problems.push(
        `a new item never carries an agent/* label ("${label}"); readiness is triage's decision`
      );
    }
    if (group === null) continue;
    const other = groups.get(group);
    if (other !== undefined) {
      problems.push(
        `"${other}" and "${label}" are both in the ${group} group, and an item takes one label per group`
      );
    }
    groups.set(group, label);
  }
  return labels.filter((label) => label.trim() !== '');
}

/** A string flag's value, when given. */
function stringFlag(ctx: VerbContext, name: string): string | undefined {
  const raw = ctx.args.flags[name];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The line every filed description gains, saying what the duplicate check
 * compared and which near matches the filer ruled out with
 * `--not-duplicate-of`, so a reader can see the search was done.
 *
 * @param title - The new title.
 * @param ids - The items `--not-duplicate-of` named.
 * @returns The line.
 */
export function duplicateLine(title: string, ids: readonly string[]): string {
  const words = [...titleWords(title)];
  const compared =
    words.length === 0
      ? 'Duplicate check: the title has no words to compare with open items'
      : `Duplicate check: open item titles compared on "${words.join(' ')}"`;
  return ids.length === 0 ? `${compared}.` : `${compared}; not a duplicate of ${ids.join(', ')}.`;
}

/**
 * The open near matches of a new title that `--not-duplicate-of` does not
 * name, best first. The parent is left out: a sub-item shares its words.
 *
 * @param title - The new title.
 * @param open - The open items.
 * @param checked - The items `--not-duplicate-of` named.
 * @param parent - The `--parent`, when given.
 * @returns The unchecked near matches.
 */
function uncheckedMatches(
  title: string,
  open: readonly { identifier: string; title: string }[],
  checked: readonly string[],
  parent: string | undefined
): NearMatch[] {
  const skip = new Set([...checked, ...(parent === undefined ? [] : [parent.toUpperCase()])]);
  return nearMatches(title, open).filter((match) => !skip.has(match.identifier.toUpperCase()));
}

/**
 * The result a near duplicate stops the create with (exit 5): `nearMatches`
 * in the JSON, and a first text line no caller can mistake for another
 * precondition.
 *
 * @param matches - The unchecked near matches (not empty).
 * @returns The verb result.
 */
function nearDuplicate(matches: readonly NearMatch[]): VerbResult {
  const shown = matches.slice(0, 5);
  const ids = matches.map((match) => match.identifier).join(',');
  const message =
    `near duplicate: ${shown.map((m) => `${m.identifier} - ${m.title}`).join('; ')}` +
    `${matches.length > shown.length ? ` (and ${matches.length - shown.length} more)` : ''}. ` +
    `The same work: comment on it with what is new, and file nothing. Different work: ` +
    `file again with --not-duplicate-of ${ids}. Nothing was filed.`;
  return {
    exitCode: EXIT.precondition,
    json: {
      ok: false,
      created: false,
      identifier: null,
      nearMatches: matches.map(({ identifier, title, score }) => ({
        identifier,
        title,
        score: Math.round(score * 100) / 100,
      })),
      message,
    },
    text: message,
  };
}

/** `--key`, when given and well formed. */
function keyOf(ctx: VerbContext, problems: string[]): string | undefined {
  const raw = ctx.args.flags.key;
  if (typeof raw !== 'string') return undefined;
  if (raw.length > KEY_MAX || !KEY_PATTERN.test(raw)) {
    problems.push(
      `--key takes letters, digits and . _ : / @, joined by single hyphens, up to ${KEY_MAX} characters; "${raw}" is not one`
    );
    return undefined;
  }
  return raw;
}

/** One optional string flag, recording a problem when it is given empty. */
function optional(ctx: VerbContext, name: string, problems: string[]): string | undefined {
  const raw = ctx.args.flags[name];
  if (typeof raw !== 'string') return undefined;
  if (raw.trim() === '') {
    problems.push(`--${name} is empty`);
    return undefined;
  }
  return raw.trim();
}

/**
 * Run `flow create`.
 *
 * @param ctx - The verb's context.
 * @returns Whether an item was created, and its identifier and url.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  // Every refusal below comes before the config, the adapter or any tracker
  // call, and all of them come in one message.
  const problems: string[] = [];
  const rawTitle = ctx.args.flags.title;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const given = flagText(ctx, {
    inline: 'description',
    file: 'description-file',
    what: 'description',
  });
  const scratch = given?.scratch;
  const text = given?.text.trimEnd();
  const description = text === undefined || text.trim() === '' ? undefined : text;
  // Either type vocabulary is accepted (DOR-5069).
  const types = resolveTypes(labelList(ctx, problems));
  problems.push(...types.problems);
  const labels = types.labels;
  if (CAPTURE_TAG.test(title) && !labels.includes(AGENT_FROM_OUTSIDE)) {
    problems.push(
      `a title ending in a capture tag ("${title.match(CAPTURE_TAG)?.[0]}") is an item captured from outside the team: add --label ${AGENT_FROM_OUTSIDE}`
    );
  }
  const rawPriority = stringFlag(ctx, 'priority');
  const rawSize = stringFlag(ctx, 'size');
  const priority = priorityOf(rawPriority, problems);
  const size = sizeOf(rawSize, problems);
  const key = keyOf(ctx, problems);
  const project = optional(ctx, 'for-project', problems);
  const parent = optional(ctx, 'parent', problems);
  const checked = notDuplicateOf(ctx.args.repeated?.['not-duplicate-of'] ?? [], problems);
  problems.push(
    ...missingFields({
      title,
      description,
      labels,
      priority: rawPriority,
      size: rawSize,
      project: stringFlag(ctx, 'for-project'),
    })
  );
  // An empty `problems` already means the description and project are set;
  // naming them here narrows their types.
  if (problems.length > 0 || description === undefined || project === undefined) {
    throw refusal(problems);
  }

  const { config } = loadConfig(findConfigRoots(ctx.projectDir, ctx.flowRoot), ctx.env);
  const adapter = await ctx.adapter();
  const needed: Capability[] = ['createItem', 'getBacklogSnapshot'];
  requireCapabilities(adapter, needed);
  requireContract(adapter, SIZE_CONTRACT, 'file an item with a size');

  const parts = [description];
  parts.push(duplicateLine(title, checked));
  if (key !== undefined) parts.push(keyMarker(key));
  const body = parts.join('\n\n');
  const spec: NewItem = {
    title,
    description: signBody(
      body,
      config.identity.marker,
      sessionProvenance(ctx),
      trackerVisibility(adapter)
    ),
    labels,
    ...(types.optional.length === 0 ? {} : { optionalLabels: types.optional }),
    project,
    priority,
    size,
    ...(parent === undefined ? {} : { parent }),
    ...(key === undefined ? {} : { key }),
  };

  // The open items: to return one a key already filed, and to find duplicates.
  const open: readonly { identifier: string; title: string; description?: string }[] = (
    await adapter.getBacklogSnapshot()
  ).items;
  if (key !== undefined) {
    const marker = keyMarker(key);
    const match = open.find((item) =>
      (item.description ?? '').split('\n').some((line) => line.trim() === marker)
    );
    if (match !== undefined) {
      if (!ctx.dryRun) removeScratch(ctx, scratch);
      return {
        json: {
          ok: true,
          created: false,
          identifier: match.identifier,
          title: match.title,
          url: null,
          ...(ctx.dryRun ? { dryRun: true } : {}),
        },
        text: `Already captured as ${match.identifier} - ${match.title}`,
        item: match.identifier,
      };
    }
  }
  const matches = uncheckedMatches(title, open, checked, parent);
  if (matches.length > 0) return nearDuplicate(matches);

  if (ctx.dryRun) {
    return {
      json: {
        ok: true,
        created: false,
        identifier: null,
        title,
        url: null,
        dryRun: true,
        item: spec,
      },
      text: `Would create "${title}"${labels.length > 0 ? ` with ${labels.join(', ')}` : ''}.`,
    };
  }

  const created = await (adapter.createItem as NonNullable<typeof adapter.createItem>)(spec);
  removeScratch(ctx, scratch);
  // The adapter hands back the key's existing item rather than a new one when
  // it already held that key (an item filed without the marker line). Such an
  // item was open in the snapshot, so it was not created now.
  const existed = open.find((item) => item.identifier === created.identifier);
  if (existed !== undefined) {
    return {
      json: {
        ok: true,
        created: false,
        identifier: created.identifier,
        title: existed.title,
        url: created.url,
      },
      text: `Already captured as ${created.identifier} - ${existed.title} ${created.url}`,
      item: created.identifier,
    };
  }
  return {
    json: { ok: true, created: true, identifier: created.identifier, title, url: created.url },
    text: `${created.identifier} ${title} ${created.url}`,
    item: created.identifier,
  };
}
