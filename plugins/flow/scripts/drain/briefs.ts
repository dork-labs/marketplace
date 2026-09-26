/**
 * Brief rendering (spec `flow-handoff-dispatch` §4.7): the worker and reviewer
 * briefs under `templates/drain/` are Markdown with `{{name}}` placeholders the
 * drain fills in before a session starts.
 *
 * The rule is strict on purpose: a placeholder the caller gave no value for
 * throws, and so does a value the template never asked for, so a brief can
 * never go out with a hole in it or silently drop a fact. Values are inserted
 * in one pass and never scanned again, so a title that happens to contain
 * `{{` stays text.
 *
 * Dependency-free (node builtins only).
 *
 * @module @dorkos/flow/drain/briefs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** A placeholder: `{{name}}`, where name is a letter then letters or digits. */
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/** Anything left that still looks like a placeholder, well-formed or not. */
const LEFTOVER = /\{\{[^}]*\}\}/;

/** The briefs flow ships, relative to the flow root. */
export const BRIEF_TEMPLATES = {
  worker: path.join('templates', 'drain', 'worker-brief.md'),
  reviewer: path.join('templates', 'drain', 'reviewer-brief.md'),
} as const;

/** The placeholders each brief takes (spec §4.7). */
export const BRIEF_VARS = {
  worker: ['identifier', 'title', 'worktree', 'branch', 'flow', 'accountLabel', 'rubric'],
  reviewer: ['identifier', 'sha', 'base', 'deltaFrom', 'rubric', 'flow', 'findingsFile', 'token'],
} as const;

/**
 * Fill a template's `{{name}}` placeholders.
 *
 * @param template - The template text.
 * @param vars - A value for every placeholder the template names, and no others.
 * @param where - The template's name, for the error.
 * @returns The rendered text.
 * @throws {Error} Naming every placeholder with no value, every value with no
 *   placeholder, and any malformed `{{...}}` left in the template.
 */
export function renderTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
  where = 'the template'
): string {
  const named = new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]));
  const missing = [...named].filter((name) => !Object.hasOwn(vars, name));
  const unused = Object.keys(vars).filter((name) => !named.has(name));
  const malformed = template.replace(PLACEHOLDER, '').match(LEFTOVER);
  const problems = [
    ...(missing.length > 0 ? [`no value for ${missing.map((n) => `{{${n}}}`).join(', ')}`] : []),
    ...(unused.length > 0 ? [`no placeholder for ${unused.join(', ')}`] : []),
    ...(malformed !== null ? [`a malformed placeholder ${malformed[0]}`] : []),
  ];
  if (problems.length > 0) throw new Error(`${where} cannot be rendered: ${problems.join('; ')}`);
  return template.replace(PLACEHOLDER, (_, name: string) => vars[name]);
}

/**
 * Render one of flow's briefs.
 *
 * @param flowRoot - The plugin folder.
 * @param which - `worker` or `reviewer`.
 * @param vars - Every placeholder that brief takes ({@link BRIEF_VARS}).
 * @returns The rendered brief.
 * @throws {Error} When the template cannot be read or rendered.
 */
export function renderBrief(
  flowRoot: string,
  which: keyof typeof BRIEF_TEMPLATES,
  vars: Readonly<Record<string, string>>
): string {
  const file = path.join(flowRoot, BRIEF_TEMPLATES[which]);
  return renderTemplate(readFileSync(file, 'utf8'), vars, BRIEF_TEMPLATES[which]);
}
