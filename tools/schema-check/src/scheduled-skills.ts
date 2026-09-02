/**
 * The skills in this marketplace that MUST stay scheduled.
 *
 * A `schedule:` block is what turns a skill into a scheduled task, and DorkOS
 * is forgiving about a broken one on purpose: a skill whose block will not
 * parse still installs and still works as a plain skill. That forgiveness is
 * right for a person's own vault and wrong for a published package — it means a
 * one-character typo can ship a package whose scheduled task silently never
 * runs, with nothing anywhere going red.
 *
 * This list is the other half. Every entry is a directory (relative to the repo
 * root) that has to hold a SKILL.md whose schedule block reads cleanly. It
 * catches the failure a strict parse cannot: deleting the block, or misspelling
 * the `schedule:` key itself, leaves nothing behind to complain about.
 *
 * The list is kept exhaustive by the gate rather than by memory — a SKILL.md
 * that carries a schedule block and is not listed here is an error, with the
 * line to add in the message.
 *
 * @module scheduled-skills
 */

/**
 * Skill directories, relative to the repo root, that must each hold a SKILL.md
 * with a readable `schedule:` block.
 */
export const SCHEDULED_SKILLS: readonly string[] = [
  'plugins/flow/skills/flow-drain',
  'plugins/flow/skills/flow-groom',
];
