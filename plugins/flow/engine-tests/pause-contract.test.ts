/**
 * The pause is prose every autonomous entry point follows (DOR-2285), so this
 * suite pins the prose: each entry point checks the pause first and stops when
 * the check cannot run, and `/flow:pause` / `/flow:resume` switch DorkOS schedule
 * rows only as the contract allows. Each guard is shown to bite on a planted
 * break.
 *
 * @see specs/flow-generated-state-location/02-specification.md ("Who honours the pause")
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectFilterGaps } from './schedule-filter.ts';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(pluginRoot, rel), 'utf8');

/** What makes a passage a pause check: it names the check, the flag, and failing closed. */
function pauseCheckGaps(passage: string): string[] {
  const needs: [string, RegExp][] = [
    ['names the pause check', /\*\*Pause check/],
    ['reads `paused`', /`paused` is not\s+`null`/],
    ['stops when the check cannot run', /cannot run or its output\s+cannot be read,\s+stop/],
  ];
  return needs.filter(([, re]) => !re.test(passage)).map(([label]) => label);
}

/** The text between two markers (the first after `from`), which must both exist. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  if (start === -1 || end === -1) throw new Error(`markers not found: ${from} … ${to}`);
  return text.slice(start, end);
}

/** Every passage that must hold a pause check, by name. */
function entryPoints(flow: string, files: Record<string, string>): Record<string, string> {
  return {
    'flow-drain tick': between(files.drain, '0. **Pause check', '1. **Recovery'),
    'flow-groom check': between(files.groom, '0. **Pause check', '1. Pull once'),
    'flow-triage tick': between(files.triage, '0. **Pause check', '1. Via the adapter'),
    'tending-tracker tick': between(files.tending, '**Pause check', '0. **Resolve identity'),
    '/flow continue': between(flow, '- **`continue`**', '- **`auto`**'),
    '/flow auto start': between(flow, '0. **Pause check', '1. **Start'),
    '/flow auto iteration': between(flow, '2. **Pause check', '**Then it runs'),
  };
}

/** What the general "The pause." paragraph of flow.md must cover. */
function generalPauseGaps(flow: string): string[] {
  const text = between(flow, '**The pause.**', 'With a valid config present');
  const needs: [string, RegExp][] = [
    ['reads `paused`', /When `paused` is not `null`/],
    ['never starts continue or auto', /never\s+start `continue` or `auto`/],
    ['covers scheduled and tracker ticks', /scheduled tick or a tracker tick/],
    ['leaves the operator free', /a pause stops the loop, never\s+the operator/],
  ];
  return needs.filter(([, re]) => !re.test(text)).map(([label]) => label);
}

const shipped = () => ({
  drain: read('skills/flow-drain/SKILL.md'),
  groom: read('skills/flow-groom/SKILL.md'),
  triage: read('skills/flow-triage/SKILL.md'),
  tending: read('skills/tending-tracker/SKILL.md'),
});

describe('every autonomous entry point checks the pause first', () => {
  it('each passage holds a complete pause check', () => {
    const passages = entryPoints(read('commands/flow.md'), shipped());
    const gaps = Object.entries(passages).flatMap(([name, text]) =>
      pauseCheckGaps(text).map((gap) => `${name}: ${gap}`)
    );
    expect(gaps).toEqual([]);
    expect(Object.keys(passages)).toHaveLength(7);
  });

  it('the guard bites when a check is removed or loses its fail-closed line', () => {
    // Plant-a-break on the real files: drop the drain's check; strip the
    // fail-closed sentence from the auto iteration.
    const files = shipped();
    files.drain = files.drain.replace('`paused` is not `null`', '`paused` is set');
    const flow = read('commands/flow.md').replace(
      /(2\. \*\*Pause check[\s\S]*?)if the check cannot run or its output cannot be read,\s+stop too\./,
      '$1'
    );
    const passages = entryPoints(flow, files);
    expect(pauseCheckGaps(passages['flow-drain tick'])).toEqual(['reads `paused`']);
    expect(pauseCheckGaps(passages['/flow auto iteration'])).toEqual([
      'stops when the check cannot run',
    ]);
  });
});

describe('the general pause rule in /flow', () => {
  it('states who stops and who does not', () => {
    expect(generalPauseGaps(read('commands/flow.md'))).toEqual([]);
  });

  it('the guard bites when the tracker tick is dropped from it', () => {
    const flow = read('commands/flow.md').replace(
      'scheduled tick or a tracker tick',
      'scheduled tick'
    );
    expect(generalPauseGaps(flow)).toEqual(['covers scheduled and tracker ticks']);
  });
});

describe('/flow:pause and /flow:resume switch DorkOS schedules only as agreed', () => {
  /** What the pause command must say about host schedule rows. */
  function pauseGaps(text: string): string[] {
    const needs: [string, RegExp][] = [
      [
        'only when the tools exist',
        /only when the `tasks_list` and `tasks_update` tools are\s+available/,
      ],
      ['only rows that are on', /whose `enabled` is `true`/],
      ['records the ids', /pause --host-schedule <id>/],
      [
        'skips plainly without the tools',
        /When the tools are not available[\s\S]*?skip this step and say so/,
      ],
      ['the flag stays the authority', /The\s+flag is the pause/],
      [
        'loads deferred tools first',
        /deferred behind tool search[\s\S]*?load them with ToolSearch first/,
      ],
    ];
    return [
      ...needs.filter(([, re]) => !re.test(text)).map(([label]) => label),
      ...projectFilterGaps(text),
    ];
  }

  /** What the resume command must say. */
  function resumeGaps(text: string): string[] {
    const needs: [string, RegExp][] = [
      ['switches back only the recorded ids', /for each id in the list,\s+and for nothing else/],
      ['reads hostSchedules', /`hostSchedules`/],
      [
        'loads a deferred tool first',
        /deferred behind tool search[\s\S]*?load it with ToolSearch first/,
      ],
    ];
    return needs.filter(([, re]) => !re.test(text)).map(([label]) => label);
  }

  it('pause and resume state the whole contract', () => {
    expect(pauseGaps(read('commands/pause.md'))).toEqual([]);
    expect(resumeGaps(read('commands/resume.md'))).toEqual([]);
  });

  it('the guard bites when a limit is dropped', () => {
    // A root matched as a bare string prefix would let `/work/app` claim
    // `/work/app-2`: switching off another project's schedule.
    const pause = read('commands/pause.md').replace('roots followed by `/`', 'roots');
    expect(pauseGaps(pause)).toEqual(['requires a separator after the root']);
    const unrooted = read('commands/pause.md').replace('`committedDir` and the `localDir`', 'x');
    expect(pauseGaps(unrooted)).toEqual(['names the roots']);
    const resume = read('commands/resume.md').replace('and for nothing else', 'x');
    expect(resumeGaps(resume)).toEqual(['switches back only the recorded ids']);
  });

  it('the guard bites when the deferred-tool rule is dropped', () => {
    const pause = read('commands/pause.md').replace('load them with ToolSearch first', 'x');
    expect(pauseGaps(pause)).toEqual(['loads deferred tools first']);
  });

  it('a running tick is not interrupted, and pause says so', () => {
    expect(read('commands/pause.md')).toMatch(
      /finishes the item it is on, up to that item's review gate/
    );
  });
});
