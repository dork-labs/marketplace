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

/**
 * What makes a passage a pointer at the one pause check: it names the check,
 * runs flow-drain's step 0, and stops when that says stop. The check itself
 * lives once, in flow-drain step 0 (the doc lint's duplicate rule keeps one copy).
 */
function pointerGaps(passage: string): string[] {
  const needs: [string, RegExp][] = [
    ['names the pause check', /\*\*Pause check/],
    ['runs flow-drain step 0', /step 0 of\s+`<flow-root>\/skills\/flow-drain\/SKILL\.md`/],
    ['stops when it says to', /Stop\s+whenever it says to stop/],
  ];
  return needs.filter(([, re]) => !re.test(passage)).map(([label]) => label);
}

const shipped = () => ({
  drain: read('skills/flow-drain/SKILL.md'),
  groom: read('skills/flow-groom/SKILL.md'),
  triage: read('skills/flow-triage/SKILL.md'),
  retro: read('skills/flow-retro/SKILL.md'),
  tending: read('skills/tending-tracker/SKILL.md'),
});

/** Every passage that must point at the pause check, by name. */
function pointers(files: ReturnType<typeof shipped>): Record<string, string> {
  return {
    'flow-groom check': between(files.groom, '0. **Pause check', '1. Pull once'),
    'flow-triage tick': between(files.triage, '0. **Pause check', '1. Take a backlog'),
    'flow-retro tick': between(files.retro, '0. **Pause check', '1. Run `flow selftest'),
    'tending-tracker tick': between(files.tending, '**Pause check', '0. **Resolve identity'),
    '/flow auto start': between(files.drain, '1. **Pause check', '2. **Start'),
    '/flow auto iteration': between(files.drain, '3. **Each iteration', '4. End early'),
  };
}

describe('every autonomous entry point checks the pause first', () => {
  it('the one tick holds the complete pause check', () => {
    const drain = shipped().drain;
    expect(pauseCheckGaps(between(drain, '0. **Pause check', '1. **Identity'))).toEqual([]);
  });

  it('every other entry point runs that check, and stops when it says stop', () => {
    const gaps = Object.entries(pointers(shipped())).flatMap(([name, text]) =>
      pointerGaps(text).map((gap) => `${name}: ${gap}`)
    );
    expect(gaps).toEqual([]);
    expect(Object.keys(pointers(shipped()))).toHaveLength(6);
  });

  it('/flow continue and auto run the flow-drain tick', () => {
    const modes = between(read('commands/flow.md'), '## Queue modes', '- **`auto`**');
    expect(modes).toMatch(/skills\/flow-drain\/SKILL\.md/);
  });

  it('the guard bites when the check loses its flag or a pointer is cut', () => {
    const files = shipped();
    files.drain = files.drain.replace('`paused` is not `null`', '`paused` is set');
    expect(pauseCheckGaps(between(files.drain, '0. **Pause check', '1. **Identity'))).toEqual([
      'reads `paused`',
    ]);
    files.retro = files.retro.replace('flow-drain/SKILL.md', 'flow-retro/SKILL.md');
    files.groom = files.groom.replace('Stop whenever it says to stop', 'Carry on');
    const passages = pointers(files);
    expect(pointerGaps(passages['flow-retro tick'])).toEqual(['runs flow-drain step 0']);
    expect(pointerGaps(passages['flow-groom check'])).toEqual(['stops when it says to']);
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
      ['loads deferred tools first', /load deferred ones first, as `\/flow:status` step 2 says/],
      // The project filter and the deferred-tool rule live once, in /flow:status
      // step 2 (cadence-contract pins them there); pause selects the same way.
      ['selects schedules as /flow:status does', /exactly as `\/flow:status` step 2 selects them/],
    ];
    return needs.filter(([, re]) => !re.test(text)).map(([label]) => label);
  }

  /** What the resume command must say. */
  function resumeGaps(text: string): string[] {
    const needs: [string, RegExp][] = [
      ['switches back only the recorded ids', /for each id in the list,\s+and for nothing else/],
      ['reads hostSchedules', /`hostSchedules`/],
      ['loads a deferred tool as /flow:status does', /load it as `\/flow:status` step 2 says/],
    ];
    return needs.filter(([, re]) => !re.test(text)).map(([label]) => label);
  }

  it('pause and resume state the whole contract', () => {
    expect(pauseGaps(read('commands/pause.md'))).toEqual([]);
    expect(resumeGaps(read('commands/resume.md'))).toEqual([]);
  });

  it('the guard bites when a limit is dropped', () => {
    // Selecting schedules any other way than /flow:status could switch off
    // another project's schedule.
    const pause = read('commands/pause.md').replace('exactly as `/flow:status` step 2', 'by name');
    expect(pauseGaps(pause)).toEqual(['selects schedules as /flow:status does']);
    const resume = read('commands/resume.md').replace('and for nothing else', 'x');
    expect(resumeGaps(resume)).toEqual(['switches back only the recorded ids']);
  });

  it('the guard bites when resume stops loading its tool the /flow:status way', () => {
    const resume = read('commands/resume.md').replace('load it as `/flow:status` step 2 says', 'x');
    expect(resumeGaps(resume)).toEqual(['loads a deferred tool as /flow:status does']);
  });

  it('a running tick is not interrupted, and pause says so', () => {
    expect(read('commands/pause.md')).toMatch(
      /finishes the item it is on, up to that item's review gate/
    );
  });
});
