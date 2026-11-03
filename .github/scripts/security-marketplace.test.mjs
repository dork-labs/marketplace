/* global URL, console, process */
// Marketplace only. The label-at-head, verdict and gate suites beside this are
// dorkos's; these run its code against this repo's real lists and paths, and pin
// what this repo adds to it.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import {
  checkMergeGroup,
  checkPullRequest,
  securityDeepPathPattern,
  securityPathPattern,
  touchesSecurity,
} from './security-gate.mjs';
import { approvalMode } from './security-label-at-head.mjs';
import { runVerdict, trustedLists, verdictForPullRequest } from './security-verdict.mjs';

const pattern = securityPathPattern();
const deepPattern = securityDeepPathPattern();
const lists = { pattern, deepPattern, botUserId: '0' };
const SENSITIVE = 'plugins/flow/hooks/gate.sh';
const DOCS = 'specs/drain.md';
const SHA = 'head1';
const REF = 'security-gate';
const EARLY = '2026-11-03T10:00:00Z';
const LATE = '2026-11-03T11:00:00Z';
const VERDICT = '2026-11-03T11:00:05Z';
const event = {
  pull_request: {
    number: 1,
    head: { sha: SHA },
    base: { ref: 'main', sha: 'base' },
    updated_at: LATE,
  },
};
const group = {
  merge_group: { base_ref: 'refs/heads/main', base_sha: 'base', head_sha: 'group1' },
};

const labelled = (at, name = 'security-reviewed') => ({
  event: 'labeled',
  label: { name },
  created_at: at,
  actor: { login: 'someone', type: 'User' },
});
const push = (at) => ({ after: SHA, ref: `refs/heads/${REF}`, timestamp: at });

/** A fake GitHub with the one PR and the one queue entry these cases need. */
function fakeGitHub({ files = [SENSITIVE], labels = [], timeline = [], activity = [] } = {}) {
  const statuses = [];
  const api = {
    pr: async () => ({
      number: 1,
      head: { sha: SHA, ref: REF },
      base: { ref: 'main', sha: 'base' },
      changed_files: files.length,
      labels: labels.map((name) => ({ name })),
    }),
    files: async () => files.map((filename) => ({ filename })),
    statuses: async () => statuses,
    setStatus: async (sha, state, description) => {
      const status = {
        context: 'security-review',
        state,
        description,
        created_at: VERDICT,
        creator: { login: 'github-actions[bot]' },
      };
      statuses.unshift(status);
      return status;
    },
    timeline: async () => timeline,
    activity: async () => activity,
    comments: async () => [],
    comment: async () => {},
    compare: async (base) => ({
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      files: files.map((filename) => ({ filename })),
    }),
    queue: async () => [
      {
        baseCommit: { oid: 'base' },
        headCommit: { oid: 'group1' },
        pullRequest: { number: 1, headRefOid: SHA },
      },
    ],
  };
  return { api, statuses };
}

/** No real waiting in tests: a fake clock that each sleep moves on, and `onSleep` runs on each. */
const fastPoll = (onSleep = () => {}) => {
  const poll = {
    intervalMs: 5000,
    timeoutMs: 90_000,
    slept: 0,
    now: () => poll.slept,
    sleep: async (ms) => {
      poll.slept += ms;
      onSleep();
    },
  };
  return poll;
};
const verifier = (api, poll = fastPoll()) =>
  checkPullRequest(api, event, pattern, { botUserId: '0', deepPattern, poll });
const queued = (api) => checkMergeGroup(api, group, pattern, '0', deepPattern);
/** Main's verdict on the head, then the status it left. */
async function verdict(gh) {
  await verdictForPullRequest(gh.api, event, lists);
  return gh.statuses[0];
}
/** Main's verdict has written its status on this head, then the PR's gate reads it. */
async function verifiedAfterVerdict(gh) {
  await verdict(gh);
  return verifier(gh.api);
}

describe('label-at-head on this repo’s lists', () => {
  test('this repo runs label-at-head: no App id is set', () => {
    assert.equal(approvalMode(lists.botUserId), 'label-at-head');
  });

  test('a label newer than the head passes the verdict, the PR run and the queue', async () => {
    const proof = {
      labels: ['security-reviewed'],
      timeline: [labelled(LATE)],
      activity: [push(EARLY)],
    };
    assert.equal((await verdict(fakeGitHub(proof))).state, 'success');
    assert.equal(await verifiedAfterVerdict(fakeGitHub(proof)), 'Security status verified');
    assert.match(await queued(fakeGitHub(proof).api), /Security status verified/);
  });

  test('a label older than the head fails all three', async () => {
    const stale = {
      labels: ['security-reviewed'],
      timeline: [labelled(EARLY)],
      activity: [push(LATE)],
    };
    const status = await verdict(fakeGitHub(stale));
    assert.equal(status.state, 'failure');
    assert.match(status.description, /older than the last push/);
    await assert.rejects(verifier(fakeGitHub(stale).api), /older than the last push/);
    await assert.rejects(queued(fakeGitHub(stale).api), /older than the last push/);
  });

  test('a hold label fails all three, even with a fresh review label', async () => {
    const held = {
      labels: ['security-reviewed', 'hold'],
      timeline: [labelled(LATE)],
      activity: [push(EARLY)],
    };
    const status = await verdict(fakeGitHub(held));
    assert.equal(status.state, 'failure');
    assert.match(status.description, /hold label is on/);
    await assert.rejects(verifier(fakeGitHub(held).api), /hold label is on/);
    await assert.rejects(queued(fakeGitHub(held).api), /hold label is on/);
  });

  test('a docs-only PR passes all three with no label', async () => {
    const docs = { files: [DOCS, 'README.md'] };
    const status = await verdict(fakeGitHub(docs));
    assert.deepEqual([status.state, status.description], ['success', 'no security paths']);
    assert.equal(await verifier(fakeGitHub(docs).api), 'no security paths (computed)');
    assert.match(await queued(fakeGitHub(docs).api), /no security paths \(computed\)/);
  });

  // The PR's own check only waits (dorkos #3435): main's verdict and the queue are
  // what refuse, so "fails" here means those two.
  test('a security-path PR with no label fails the verdict and the queue; its PR run waits', async () => {
    const none = { activity: [push(EARLY)] };
    const status = await verdict(fakeGitHub(none));
    assert.equal(status.state, 'failure');
    assert.match(status.description, /no security-reviewed label/);
    await assert.rejects(queued(fakeGitHub(none).api), /no security-reviewed label/);
    assert.match(await verifier(fakeGitHub(none).api), /^Waiting for Security: no security-reviewed/);
  });

  test('a workflow or a file of the gate needs security-deep-reviewed too', async () => {
    for (const file of [
      '.github/workflows/lint.yml',
      '.github/workflows/security-gate.yml',
      '.github/scripts/security-verdict.mjs',
    ]) {
      const status = await verdict(
        fakeGitHub({
          files: [file],
          labels: ['security-reviewed'],
          timeline: [labelled(LATE)],
          activity: [push(EARLY)],
        })
      );
      assert.equal(status.state, 'failure', file);
      assert.match(status.description, /security-deep-reviewed/, file);
    }
  });
});

describe('the PR’s gate waits for main’s fresh verdict, on this repo’s lists (DOR-3710)', () => {
  const approved = {
    labels: ['security-reviewed'],
    timeline: [labelled(LATE)],
    activity: [push(EARLY)],
  };
  /** The status main's verdict left before this label. */
  const stale = (gh) => {
    gh.statuses.unshift({ context: 'security-review', state: 'failure', created_at: EARLY });
    return gh;
  };

  test('the first run after a label waits out the old failure, logs each read, and passes', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const gh = stale(fakeGitHub(approved));
    const poll = fastPoll(() => gh.api.setStatus(SHA, 'success', 'Security label covers this SHA'));
    assert.equal(await verifier(gh.api, poll), 'Security status verified');
    assert.equal(poll.slept, 5000);
    const lines = log.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((line) => line.startsWith('security-review poll'));
    assert.equal(lines.length, 2);
    assert.match(lines[0], new RegExp(`^security-review poll 1: failure at ${EARLY}; `));
    assert.match(lines[1], new RegExp(`^security-review poll 2: success at ${VERDICT}; `));
  });

  test('no verdict in time fails closed, naming the rerun', async () => {
    const poll = fastPoll();
    await assert.rejects(
      verifier(stale(fakeGitHub(approved)).api, poll),
      /verdict not yet written for this head.*rerun security-gate/
    );
    assert.equal(poll.slept, 90_000);
  });

  test('a fresh refusal from main fails, and hold fails without waiting', async () => {
    const refused = fakeGitHub(approved);
    await refused.api.setStatus(SHA, 'failure', 'verdict errored');
    await assert.rejects(verifier(refused.api), /security-review is failure/);
    const poll = fastPoll();
    await assert.rejects(
      verifier(fakeGitHub({ ...approved, labels: ['security-reviewed', 'hold'] }).api, poll),
      /hold label is on/
    );
    assert.equal(poll.slept, 0);
  });

  test('the merge queue doesn’t wait: it judges the labels as before', async () => {
    assert.match(await queued(fakeGitHub(approved).api), /Security status verified/);
  });
});

describe('what this repo adds to dorkos’s code', () => {
  test('the P0 list names the gate’s own files, each of them a security path too', () => {
    for (const filename of [
      '.github/workflows/security-gate.yml',
      '.github/workflows/security-review-initialize.yml',
      '.github/workflows/lint.yml',
      '.github/workflows/nested/x.yml',
      '.github/scripts/security-gate.mjs',
      '.github/scripts/security-new.mjs',
      'scripts/security-new.sh',
      '.GitHub/Workflows/lint.yml',
    ]) {
      assert.ok(touchesSecurity([{ filename }], deepPattern), filename);
      assert.ok(touchesSecurity([{ filename }], pattern), `not a security path: ${filename}`);
      assert.ok(
        touchesSecurity([{ filename: 'specs/moved.md', previous_filename: filename }], deepPattern),
        `rename: ${filename}`
      );
    }
    for (const filename of [
      SENSITIVE,
      DOCS,
      '',
      '.github/SECURITY-GATE.md',
      '.github/workflows-old/lint.yml',
      '.github/scripts/other.mjs',
      'scripts/securityish.sh',
      'scripts/should-arm-automerge.sh',
      'plugins/flow/scripts/security-x.sh',
      'specs/.github/workflows/lint.yml',
    ]) {
      assert.equal(touchesSecurity([{ filename }], deepPattern), false, filename);
    }
  });

  test('the gate’s own check asks for the deep label on a P0 path, not just the status', async () => {
    for (const file of [
      '.github/workflows/lint.yml',
      '.github/scripts/security-gate.mjs',
      'scripts/security-new.sh',
    ]) {
      // No security-review status at all: only the P0 list can ask for the label here.
      const reviewed = {
        files: [file],
        labels: ['security-reviewed'],
        timeline: [labelled(LATE)],
        activity: [push(EARLY)],
      };
      assert.match(
        await verifier(fakeGitHub(reviewed).api),
        /^Waiting for Security: no security-deep-reviewed label yet/,
        file
      );
      await assert.rejects(queued(fakeGitHub(reviewed).api), /no security-deep-reviewed label/, file);

      const both = {
        ...reviewed,
        labels: ['security-reviewed', 'security-deep-reviewed'],
        timeline: [labelled(LATE), labelled(LATE, 'security-deep-reviewed')],
      };
      assert.equal(await verifiedAfterVerdict(fakeGitHub(both)), 'Security status verified', file);
      assert.match(await queued(fakeGitHub(both).api), /Security status verified/, file);
    }
  });

  test('a forged success on a P0 path does not stand in for the deep label', async () => {
    const gh = fakeGitHub({
      files: ['.github/workflows/lint.yml'],
      labels: ['security-reviewed'],
      timeline: [labelled(LATE)],
      activity: [push(EARLY)],
    });
    await gh.api.setStatus(SHA, 'success', 'Security label covers this SHA');
    await assert.rejects(queued(gh.api), /no security-deep-reviewed label/);
  });

  test('a security path outside the P0 list still needs only security-reviewed', async () => {
    const proof = {
      files: ['specs/x/AGENTS.md'],
      labels: ['security-reviewed'],
      timeline: [labelled(LATE)],
      activity: [push(EARLY)],
    };
    assert.equal(await verifiedAfterVerdict(fakeGitHub(proof)), 'Security status verified');
    assert.match(await queued(fakeGitHub(proof).api), /Security status verified/);
  });

  test('an engine test is no free pass: flow’s shipped self-test runs that folder', async () => {
    const edit = { files: ['plugins/flow/engine-tests/gate.test.ts'], activity: [push(EARLY)] };
    const status = await verdict(fakeGitHub(edit));
    assert.equal(status.state, 'failure');
    assert.match(status.description, /no security-reviewed label/);
    await assert.rejects(queued(fakeGitHub(edit).api), /no security-reviewed label/);
    assert.match(await verifier(fakeGitHub(edit).api), /^Waiting for Security: no security-reviewed/);
  });

  test('main’s verdict refuses when its lists won’t load, over an older success', async () => {
    const loadLists = () => {
      throw new Error('Security path list missing');
    };
    for (const [name, payload] of [
      ['pull_request_target', event],
      ['merge_group', group],
    ]) {
      const gh = fakeGitHub();
      await gh.api.setStatus(SHA, 'success', 'Security label covers this SHA');
      await assert.rejects(runVerdict(gh.api, payload, name, loadLists), /list missing/);
      assert.equal(gh.statuses[0].state, 'failure', name);
      assert.match(gh.statuses[0].description, /^verdict errored: /, name);
    }
  });

  test('with no loader named, main’s verdict judges from the workflow’s own lists', async () => {
    const gh = fakeGitHub({ files: ['plugins/x/README.md'], activity: [push(EARLY)] });
    await runVerdict(gh.api, event, 'pull_request_target');
    assert.equal(gh.statuses[0].state, 'failure');
    assert.match(gh.statuses[0].description, /no security-reviewed label/);
  });

  test('an event the verdict doesn’t judge writes nothing', async () => {
    const gh = fakeGitHub();
    await assert.rejects(runVerdict(gh.api, event, 'push'), /runs only on/);
    assert.deepEqual(gh.statuses, []);
  });

  // Every plugin PR already bumps plugin.json, a security path, so nothing here reads a
  // plugin's files to decide what counts. A manifest that doesn't parse used to wedge the gate.
  test('the list is the workflow’s alone, and nothing in a checkout can change or break it', () => {
    const workflow = readFileSync(
      new URL('../workflows/security-gate.yml', import.meta.url),
      'utf8'
    );
    assert.doesNotMatch(workflow, /security-manifest-paths/);
    assert.match(workflow, /^ {8}run: node \.github\/scripts\/security-gate\.mjs$/m);
    assert.match(workflow, /ref: \$\{\{ env\.SECURITY_BASE_SHA \}\}/);
    assert.equal(existsSync(new URL('./security-manifest-paths.mjs', import.meta.url)), false);
    const dir = mkdtempSync(join(tmpdir(), 'security-verdict-'));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, 'plugins/a'), { recursive: true });
      writeFileSync(join(dir, 'plugins/a/.mcp.json'), '{ not json');
      writeFileSync(join(dir, 'plugins/a/run.sh'), 'bash ../w/tests/x.sh\n');
      process.chdir(dir);
      assert.equal(trustedLists().pattern, pattern);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a plugin PR of only a test or only a doc needs the label, like any other', async () => {
    for (const file of [
      'plugins/flow/engine-tests/gate.test.ts',
      'plugins/visual-companion/tests/install-smoke.sh',
      'plugins/x/skills/s/tests/a.cjs',
      'plugins/x/README.md',
      'plugins/x/CHANGELOG.md',
      'plugins/x/LICENSE',
    ]) {
      const none = { files: [file], activity: [push(EARLY)] };
      const status = await verdict(fakeGitHub(none));
      assert.equal(status.state, 'failure', file);
      assert.match(status.description, /no security-reviewed label/, file);
      await assert.rejects(queued(fakeGitHub(none).api), /no security-reviewed label/, file);
      assert.match(
        await verifier(fakeGitHub(none).api),
        /^Waiting for Security: no security-reviewed/,
        file
      );

      const proof = { ...none, labels: ['security-reviewed'], timeline: [labelled(LATE)] };
      assert.equal((await verdict(fakeGitHub(proof))).state, 'success', file);
      assert.equal(await verifiedAfterVerdict(fakeGitHub(proof)), 'Security status verified', file);
      assert.match(await queued(fakeGitHub(proof).api), /Security status verified/, file);
    }
  });
});
