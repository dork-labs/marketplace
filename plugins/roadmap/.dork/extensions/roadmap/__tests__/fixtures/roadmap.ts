/**
 * Synthetic roadmaps for the tests. Every bet, ask, handle and date here is
 * invented: this repository is public, and the real roadmap.json lives in a
 * private repository, so nothing from it may ever be copied in.
 */

/** A valid roadmap with three horizons, a decision ask and a permission ask. */
export function sampleRoadmap(): Record<string, unknown> {
  return {
    version: 1,
    milestones: [
      { id: 'beta', title: 'Public beta', date: '2030-03-02' },
      { id: 'gala', title: 'Kitchen gala', date: '2030-05-11' },
    ],
    items: [
      {
        id: '01HZZZZZZZZZZZZZZZZZZZZZA1',
        kind: 'project',
        title: 'Teach the kettle to whistle in tune',
        horizon: 'now',
        moscow: 'must',
        owner: 'kettle-bot',
        target: '2030-02-14',
        status: 'building',
        why: 'Every morning starts with a flat note.',
        links: [
          { kind: 'linear', ref: 'TEA-12' },
          { kind: 'url', ref: 'https://example.com/kettle', label: 'Notes' },
        ],
        needs: [
          {
            id: '01HZZZZZZZZZZZZZZZZZZZZZN1',
            kind: 'decision',
            ask: 'Pick the whistle pitch',
            recommend: 'A440, the one orchestras tune to.',
            askedBy: 'kettle-bot',
            by: '2030-02-01',
            thread: 'room:01HZZZZZZZZZZZZZZZZZZZZZR1#01HZZZZZZZZZZZZZZZZZZZZZE1',
          },
        ],
        futureKey: { kept: true },
      },
      {
        id: '01HZZZZZZZZZZZZZZZZZZZZZA2',
        kind: 'project',
        title: 'Toaster that tells you the weather',
        horizon: 'now',
        moscow: 'should',
        owner: 'chef',
        target: 'milestone:beta',
        status: 'planned',
        why: 'Toast is the first screen anyone sees.',
        needs: [
          {
            id: '01HZZZZZZZZZZZZZZZZZZZZZN2',
            kind: 'permission',
            ask: 'Let the toaster read the forecast',
            askedBy: 'chef',
            by: '2030-01-20',
            approval: 'apr_01HZZZZZZZZZZZZZZZZZZZZZP1',
          },
        ],
      },
      {
        id: '01HZZZZZZZZZZZZZZZZZZZZZA3',
        kind: 'project',
        title: 'Fridge inventory by smell',
        horizon: 'next',
        moscow: 'could',
        owner: 'nose',
        status: 'exploring',
        why: 'Nobody reads the list on the door.',
      },
      {
        id: '01HZZZZZZZZZZZZZZZZZZZZZA4',
        kind: 'project',
        title: 'Self-folding laundry',
        horizon: 'later',
        moscow: 'wont',
        owner: 'chef',
        status: 'planned',
        why: 'Maybe one day.',
      },
      {
        id: '01HZZZZZZZZZZZZZZZZZZZZZA5',
        kind: 'project',
        title: 'The old blender',
        horizon: 'now',
        moscow: 'must',
        owner: 'chef',
        status: 'shipped',
        why: 'Done and dusted.',
      },
    ],
  };
}

/** The sample roadmap as file text. */
export function sampleText(edit?: (doc: Record<string, unknown>) => void): string {
  const doc = sampleRoadmap();
  edit?.(doc);
  return JSON.stringify(doc, null, 2);
}

/** The items array of a roadmap document, for edits. */
export function itemsOf(doc: Record<string, unknown>): Record<string, unknown>[] {
  return doc.items as Record<string, unknown>[];
}
