/* global URL, process */
// Marketplace only. The label-at-head, verdict and gate suites beside this are
// dorkos's; these run its code against this repo's real lists and paths, and pin
// what this repo adds to it.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const event = {
  pull_request: { number: 1, head: { sha: SHA }, base: { ref: 'main', sha: 'base' } },
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

const verifier = (api) => checkPullRequest(api, event, pattern, { botUserId: '0', deepPattern });
const queued = (api) => checkMergeGroup(api, group, pattern, '0', deepPattern);
/** Main's verdict on the head, then the status it left. */
async function verdict(gh) {
  await verdictForPullRequest(gh.api, event, lists);
  return gh.statuses[0];
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
    assert.equal(await verifier(fakeGitHub(proof).api), 'Security status verified');
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
      '.github/scripts/security-manifest-paths.mjs',
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
      assert.equal(await verifier(fakeGitHub(both).api), 'Security status verified', file);
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
    assert.equal(await verifier(fakeGitHub(proof).api), 'Security status verified');
    assert.match(await queued(fakeGitHub(proof).api), /Security status verified/);
  });

  test('main’s verdict takes the manifest rule, so a pointed-at test folder is no free pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'security-verdict-'));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, 'plugins/a/hooks'), { recursive: true });
      writeFileSync(
        join(dir, 'plugins/a/hooks/hooks.json'),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'sh tests/run.sh' }] }] } })
      );
      process.chdir(dir);
      const trusted = trustedLists();
      const files = [{ filename: 'plugins/a/tests/run.sh' }];
      assert.equal(touchesSecurity(files, pattern), false);
      assert.equal(touchesSecurity(files, trusted.pattern), true);
      const gh = fakeGitHub({ files: ['plugins/a/tests/run.sh'], activity: [push(EARLY)] });
      await verdictForPullRequest(gh.api, event, trusted);
      assert.equal(gh.statuses[0].state, 'failure');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
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
    const dir = mkdtempSync(join(tmpdir(), 'security-verdict-'));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, 'plugins/a'), { recursive: true });
      writeFileSync(join(dir, 'plugins/a/.mcp.json'), '{ not json');
      process.chdir(dir);
      for (const [name, payload] of [
        ['pull_request_target', event],
        ['merge_group', group],
      ]) {
        const gh = fakeGitHub();
        await gh.api.setStatus(SHA, 'success', 'Security label covers this SHA');
        await assert.rejects(runVerdict(gh.api, payload, name));
        assert.equal(gh.statuses[0].state, 'failure', name);
        assert.match(gh.statuses[0].description, /^verdict errored: /, name);
      }
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an event the verdict doesn’t judge writes nothing', async () => {
    const gh = fakeGitHub();
    await assert.rejects(runVerdict(gh.api, event, 'push'), /runs only on/);
    assert.deepEqual(gh.statuses, []);
  });

  test('a manifest that does not parse refuses, rather than shrinking the list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'security-verdict-'));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, 'plugins/a'), { recursive: true });
      writeFileSync(join(dir, 'plugins/a/.mcp.json'), '{ not json');
      process.chdir(dir);
      assert.throws(() => trustedLists());
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the verifier keeps its marketplace step, on the base commit', () => {
    const workflow = readFileSync(
      new URL('../workflows/security-gate.yml', import.meta.url),
      'utf8'
    );
    assert.match(workflow, /ref: \$\{\{ env\.SECURITY_BASE_SHA \}\}/);
    assert.match(
      workflow,
      /^ {10}SECURITY_PATH_PATTERN="\$\(node \.github\/scripts\/security-manifest-paths\.mjs\)"$/m
    );
  });
});
