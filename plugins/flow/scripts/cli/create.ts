/**
 * `flow create` (DOR-2433): file one new item through the adapter's
 * `createItem` (contract 2.2.0). The capturing-work skill calls it for its one
 * tracker write; the judgment (what to capture, how to title it, which labels)
 * stays in the skill.
 *
 * - Refuses (exit 2) before any tracker call: an empty title or description,
 *   an `agent/*` label (a new item is never ready: readiness is triage's
 *   decision), two labels of one group (a tracker applies one per group), a
 *   priority outside 0-4, and a malformed key.
 * - Needs the `createItem` capability (exit 3 naming it), and
 *   `getBacklogSnapshot` too when there is a `--key`.
 * - Signs the description with the project's identity marker and this
 *   session's provenance line, as `flow done` signs its summary.
 * - With `--key`, the description carries a `<!-- flow-create:key=<k> -->`
 *   line. An open item already holding that line is returned, and nothing is
 *   created. Otherwise the key goes to `createItem`, so a retry after a
 *   timeout also gets the first item back. A key names one OPEN item: once its
 *   item is closed, the same key files a new one.
 * - `--dry-run` prints the planned item and writes nothing.
 *
 * Its journal line is the `verb` line `main` writes for every run.
 *
 * @module @dorkos/flow/cli/create
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { findConfigRoots } from '../config-files.ts';
import { loadConfig } from '../config-load.ts';
import { UsageError } from '../errors.ts';
import { requireCapabilities } from '../tracker/load.ts';
import type { Capability, NewItem } from '../tracker/types.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { signBody } from './provenance.ts';
import { sessionProvenance } from './work-write.ts';

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

/** The group of a namespaced label (`origin` for `origin/human`), or `null` for a bare one. */
function groupOf(label: string): string | null {
  const slash = label.indexOf('/');
  return slash < 0 ? null : label.slice(0, slash);
}

/** The description from `--description` or `--description-file`, exactly one of them. */
function descriptionText(ctx: VerbContext): string {
  const inline = ctx.args.flags.description;
  const file = ctx.args.flags['description-file'];
  if ((typeof inline === 'string') === (typeof file === 'string')) {
    throw new UsageError('pass exactly one of --description <text> or --description-file <path>');
  }
  if (typeof inline === 'string') return inline;
  const resolved = path.resolve(ctx.projectDir, file as string);
  try {
    return readFileSync(resolved, 'utf8');
  } catch {
    throw new UsageError(`could not read the description file ${resolved}`);
  }
}

/** The labels, each once, refused when one is `agent/*` or two share a group. */
function labelList(ctx: VerbContext): string[] {
  const labels = [...new Set(ctx.args.repeated?.label ?? [])];
  const groups = new Map<string, string>();
  for (const label of labels) {
    if (label.trim() === '') throw new UsageError('a --label is empty');
    const group = groupOf(label);
    if (group === 'agent') {
      throw new UsageError(
        `a new item never carries an agent/* label ("${label}"); readiness is triage's decision`
      );
    }
    if (group === null) continue;
    const other = groups.get(group);
    if (other !== undefined) {
      throw new UsageError(
        `"${other}" and "${label}" are both in the ${group} group, and an item takes one label per group`
      );
    }
    groups.set(group, label);
  }
  return labels;
}

/** `--priority` as 0-4, when given. */
function priorityOf(ctx: VerbContext): NewItem['priority'] {
  const raw = ctx.args.flags.priority;
  if (typeof raw !== 'string') return undefined;
  if (!/^[0-4]$/.test(raw)) {
    throw new UsageError(`--priority must be 0 (none) to 4 (low), not "${raw}"`);
  }
  return Number(raw) as NewItem['priority'];
}

/** `--key`, checked, when given. */
function keyOf(ctx: VerbContext): string | undefined {
  const raw = ctx.args.flags.key;
  if (typeof raw !== 'string') return undefined;
  if (raw.length > KEY_MAX || !KEY_PATTERN.test(raw)) {
    throw new UsageError(
      `--key takes letters, digits and . _ : / @, joined by single hyphens, up to ${KEY_MAX} characters; "${raw}" is not one`
    );
  }
  return raw;
}

/** One optional string flag, refused when given empty. */
function optional(ctx: VerbContext, name: string): string | undefined {
  const raw = ctx.args.flags[name];
  if (typeof raw !== 'string') return undefined;
  if (raw.trim() === '') throw new UsageError(`--${name} is empty`);
  return raw.trim();
}

/**
 * Run `flow create`.
 *
 * @param ctx - The verb's context.
 * @returns Whether an item was created, and its identifier and url.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  // Every refusal below comes before the config, the adapter or any tracker call.
  const rawTitle = ctx.args.flags.title;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (title === '') throw new UsageError('pass a non-empty --title');
  const description = descriptionText(ctx).trimEnd();
  if (description.trim() === '') throw new UsageError('the description is empty');
  const labels = labelList(ctx);
  const priority = priorityOf(ctx);
  const key = keyOf(ctx);
  const project = optional(ctx, 'for-project');
  const parent = optional(ctx, 'parent');

  const { config } = loadConfig(findConfigRoots(ctx.projectDir, ctx.flowRoot), ctx.env);
  const adapter = await ctx.adapter();
  const needed: Capability[] = ['createItem'];
  if (key !== undefined) needed.push('getBacklogSnapshot');
  requireCapabilities(adapter, needed);

  const body = key === undefined ? description : `${description}\n\n${keyMarker(key)}`;
  const spec: NewItem = {
    title,
    description: signBody(body, config.identity.marker, sessionProvenance(ctx)),
    labels,
    ...(project === undefined ? {} : { project }),
    ...(parent === undefined ? {} : { parent }),
    ...(priority === undefined ? {} : { priority }),
    ...(key === undefined ? {} : { key }),
  };

  if (key !== undefined) {
    const marker = keyMarker(key);
    const snapshot = await adapter.getBacklogSnapshot();
    const match = snapshot.items.find((item) =>
      (item.description ?? '').split('\n').some((line) => line.trim() === marker)
    );
    if (match !== undefined) {
      return {
        json: {
          ok: true,
          created: false,
          identifier: match.identifier,
          url: null,
          ...(ctx.dryRun ? { dryRun: true } : {}),
        },
        text: `${match.identifier} ${match.title} (already filed with key ${key})`,
      };
    }
  }

  if (ctx.dryRun) {
    return {
      json: { ok: true, created: false, identifier: null, url: null, dryRun: true, item: spec },
      text: `Would create "${title}"${labels.length > 0 ? ` with ${labels.join(', ')}` : ''}.`,
    };
  }

  const created = await (adapter.createItem as NonNullable<typeof adapter.createItem>)(spec);
  return {
    json: { ok: true, created: true, identifier: created.identifier, url: created.url },
    text: `${created.identifier} ${title} ${created.url}`,
  };
}
