/**
 * The rule `/flow:status` and `/flow:pause` both follow to pick this project's
 * flow schedules out of DorkOS's `tasks_list` (DOR-2300 review). Kept in one
 * place so the two commands are held to the same wording.
 *
 * A project root is a folder, not a string prefix: `/work/app` must not claim
 * `/work/app-2/...`, which is how a pause could switch off ANOTHER project's
 * schedule. So the rule has to name where the roots come from and require the
 * path separator after the root.
 *
 * @see specs/flow-schedule-cadence/02-specification.md ("This project's flow schedules")
 */

/**
 * What a command's schedule-selection passage fails to say, by label.
 *
 * @param passage - The command text that selects schedules from `tasks_list`.
 * @returns One label per missing part of the rule; empty when it is complete.
 */
export function projectFilterGaps(passage: string): string[] {
  const needs: [string, RegExp][] = [
    ['names the roots', /`committedDir` and the `localDir`/],
    ['strips the flow folder from each root', /trailing `\/\.agents\/flow` removed/],
    ['requires a separator after the root', /starts with one of those\s+roots followed by `\/`/],
    ['rejects a mere name prefix', /merely the start of another folder's name/],
    ['keeps flow-drain and flow-groom', /`name` is `flow-drain` or `flow-groom`/],
    [
      'keeps a person-made /flow continue schedule',
      /made[\s\S]{0,20}whose `prompt` runs `\/flow continue`/,
    ],
  ];
  return needs.filter(([, re]) => !re.test(passage)).map(([label]) => label);
}
