---
name: verifying-work
description: The /flow engine's VERIFY stage — trace recent work for correctness, run the verification gate, put the branch through an independent adversarial review before any PR opens, gather proof-of-completion scaled to the change, attach it to the work item under a deliberately chosen closing or non-closing reference, and hand off to the human-review gate. Use when running /flow:verify or advancing a work item into the VERIFY stage.
---

# Verifying Work — the VERIFY stage

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

VERIFY proves, with evidence, that the change does what the spec asked, then parks at
the human-review gate. It never declares the work done. Tracker writes
(`attachEvidence`, `assignToHuman`, `comment`, `transition`) go through the adapter at
`adapter.path`.

**In a `flow drain` run** (its worker brief says so), skip this skill's review and PR
steps: run `flow report <id> pushed`, then wait for the supervisor.

## 1. Correctness trace

For each file and function changed since the base: what it does, its callers and
callees; trace the logic and fix what is wrong. This is the only review of your own work.

## 2. The verification gate

**No completion claim without fresh evidence:** run the proving command in this pass
and read its whole output. Scale to the change: tests (0 failures), lint, typecheck,
build, and for a bug the symptom test going red→green. Prefer package-filtered commands.
Check the VCS diff; never trust an agent's "success".

## 3. Advisory review — only when step 4 is off

With `review.adversarial` false, have a fresh reviewer (or the harness's code-review
skill) read the diff against the task and the project's standards. It is advisory: you
may open the PR with a finding outstanding if the PR body says so.

## 4. Adversarial review — before the PR exists

With `review.adversarial` true (the default), the PR does not open until an
independent review converges. Run it before the evidence: converging changes the diff.

- Dispatch `review.reviewers` (default 1) fresh reviewers, **never the agent that
  implemented the change, from its own context**.
- Name each reviewer's model: the `review` class, per the Delegation Policy in
  `<flow-root>/skills/executing-specs/SKILL.md`.
- Give each **the diff, the rubric and the intent**: the base/head SHAs; the
  `review.rubric` file (default `REVIEW.md`; relative to the repo root, else the
  current folder; absolute as is); the item's description or its `03-tasks.json` task.
  Never your account of what you did.
- **When the reviewer agent may ship** (`flow autonomy --kind ship --json` says
  `reviewer-agent`), the reviewer must be a session of its own, not a subagent here: a
  subagent shares this session, and only another session's verdict is token-bound. Start
  it with `flow report <id> review-launch --sha <head> --json`; it gets its own worktree
  and token and records its verdict with `flow report <id> verdict --token …`. Wait for
  that verdict (the run's `review.verdict` in `.dork/flow/flow-state.json`). Otherwise dispatch as below; a
  verdict written any other way does not count.
- Pool findings from all reviewers: **any blocking finding blocks unless rebutted.**
- **Converge:** fix what is justified, rebut in writing what is wrong, re-review the new
  diff, until a pass finds nothing blocking.
- Record each pass: `flow journal record review --item <id> --round <n> --sha7 <sha>
--verdict clean|changes`, with finding counts.
- A fix made here invalidates step 2: re-run the gate before step 5.

**Degradation.** Never review your own branch from your own working context. Every
floor below is disclosed in the run report and the PR's review-status line:

- **No rubric file:** resolve `review.rubric` to a path and check it first. If missing,
  review on general discipline (correctness, blast radius, data loss, secrets, tests)
  and print, in the run output,
  `no rubric at <resolved path> — reviewing without one; run /flow:init to scaffold it`,
  and name the same resolved path in the evidence comment and review-status line.
- **`review.adversarial` false:** skip this step and say so.
- **No second agent:** review in a fresh context handed only the diff, the rubric and
  the intent, and record that it ran degraded.

## 5. Proof of completion

Evidence is config-driven, never hand-picked: follow the `EvidencePlan` that
`selectEvidence` returns for the change `kind`, `liveSession` and the `evidence` block.

- **UI** (`kind: "ui"`): Playwright on the touched surface. `evidence.ui: "auto"` gives
  an annotated GIF (`gif_creator`) in a live session, a WebM (`recordVideo`) unattended;
  `"screenshot"` a still; `"off"` nothing.
- **Temporal:** `evidence.temporal` `"video"` (default), `"gif"` or `"off"`.
- **Logic:** `evidence.logic` `"test-summary"` (default), `"full-output"` or `"off"`.

The format keys off whether a live session is attached now, never off autonomy. v1
attaches links, not binary uploads. A capture that cannot be produced is reported as a
gap; never fake proof.

## 6. Attach the evidence and open the PR

`attachTo` (default `["pr", "tracker"]`) decides:

- **`"pr"`:** the bundle (test summary, recording links, the linked item) in a PR
  comment; open or update the PR from `templates/pr.md`, including its review-status
  line (gate ran, skipped by config, or degraded, and which rubric).
- **`"tracker"`:** `attachEvidence(item, evidence)` with a link to each artifact and the PR.

A `"none"` capture has nothing to attach; say so.

### Provenance

The signature is defined in [`<flow-root>/docs/provenance.md`](../../docs/provenance.md);
do not redefine it here. It carries `harness`, `sessionId`, `account`, `host`,
`surface`, and — under DorkOS only — `instanceId` and `resumeUrl`, from the run's
`flow-state.json` record. Emit `agent:provenance`; `flow:provenance` is the legacy name
readers still accept.

**The signature itself is per-write: every body written outward carries it, every
time.** The once-per-run cadence applies to **the PR-body stamp only**: its last line,
written here and not re-stamped on later pushes. The comment this stage posts
carries its own signature like any other outward write, beside the identity `marker`.
Add an `attachEvidence` link only for a resumable session URL.

It must be valid JSON (spec §6). With no provenance from EXECUTE, stamp what this
session knows (spec §5). If the repository is public, follow the spec's
public-repository rules: truncate `sessionId` and omit `resumeUrl`.

### Closing form

**Does this PR complete the item?** Merge automation is diff-blind.

- Yes: `Closes <identifier>` in the body.
- No: `Refs <identifier>`, and the identifier nowhere the tracker treats as closing,
  the title first.
- The branch name can close it too. After a partial PR merges, read the item's state;
  if automation closed it, `transition` it back to the stage the remaining work is at
  and say automation closed it. Recommend once that the adopter turn off branch-name
  auto-close. The adapter documents what the tracker honours.

## 7. Hand off to the review gate

The review gate is always checked. VERIFY never advances to DONE.

1. `flow stage <id> review --checkpoint-file <f>`.
2. `flow autonomy --kind ship --json`. `answeredBy: person`: `assignToHuman(item)` and
   **stop**. Otherwise, when the launched reviewer recorded a clean verdict at the branch
   head: `flow review <id> --approve --by reviewer-agent --json`, never `--wait` (it
   outlives your command timeout). `"verdict": "pending"`: checks still running; leave the
   item at the gate, unassigned: the drain re-checks it (`flow-drain` step 2a). Any other
   refusal, or no clean verdict: `assignToHuman(item)` and stop.
3. REVIEW has no skill: never invent one, never approve without a clean check. After the
   PR merges, `/flow:done <issue>` closes the item.

No linked item or no tracker: skip the tracker steps and report the evidence inline.

**Calibration.** VERIFY is an execution stage: the ambiguous middle proceeds on the best
default and logs the assumption; the floor is still checked (`answeredBy`) via `needsInput`.
