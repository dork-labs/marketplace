/**
 * The arm guard's decision (DOR-3262): whether flow may arm auto-merge on one
 * pull request, from facts already gathered. Pure, so every refusal is pinned
 * by the cases in `scripts/fixtures/arm-decisions.json`, which the repo's own
 * arming gate (`scripts/should-arm-automerge.sh`) runs too.
 *
 * This is a guard rail, not the gate. Flow runs inside the agent, so anything
 * it decides the agent could in principle step around; the gate that holds is
 * on GitHub (a required security status and the ruleset). The guard only ever
 * refuses, and it never sets that status or the security label itself.
 *
 * It refuses, in this order (the first that applies is the answer):
 *
 * | Slug | When |
 * | --- | --- |
 * | `not-open` | the PR is not open (or the facts are not an object) |
 * | `draft` | the PR is a draft |
 * | `held-by-label` | it carries `hold`, `do-not-merge`, `wip` or `blocked` |
 * | `fork` | it comes from a fork, or the forge did not say |
 * | `base-not-main` | it merges into anything but `main` |
 * | `unreviewed` | no full reviewed SHA was recorded |
 * | `head-moved` | the head is not the reviewed SHA |
 * | `freeze` | a release freeze is on |
 * | `changes-requested` | a reviewer asked for changes |
 * | `failing-checks` | a required check failed or was cancelled |
 * | `files-unreadable` | the file list is incomplete, and the PR has no security label |
 * | `security-path-unlabelled` | it touches a security path without the security label |
 * | `security-label-unverified` | it needs the security label, and flow cannot tell when the label was added or when the head arrived |
 * | `security-label-stale` | it needs the security label, and the label was added before the head arrived |
 *
 * The security label counts only when it was added after the current head
 * arrived (`securityLabelledAt` against `headArrivedAt`, server times a
 * commit's own dates cannot move: `Forge.labelledAt` and `Forge.headPushedAt`).
 * A label on a PR that needs none is never read.
 *
 * A pending check passes (GitHub's auto-merge waits for it; a check stuck
 * pending is the watcher's job). Which checks are required comes from the
 * forge; when it cannot say, every check counts as required.
 *
 * Package manifests, lockfiles and flow's own committed config are security
 * paths in every repository ({@link BUILTIN_SECURITY_GLOBS}); the repository
 * adds its own list in `land.securityPaths`.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/land/arm-decision
 */

import { foldingPattern, matchesAny } from './glob.ts';

/**
 * Paths that count as security paths whatever the repository's own list says:
 * what installs and runs code on every machine that builds it (package
 * manifests and lockfiles, across the common ecosystems), and flow's committed
 * config, which holds the commands flow runs before it arms.
 */
export const BUILTIN_SECURITY_GLOBS: readonly string[] = [
  // JavaScript and TypeScript, and the code package managers run on install.
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/pnpm-lock.yaml',
  '**/pnpm-workspace.yaml',
  '**/.pnpmfile.cjs',
  // Patches pnpm and patch-package apply to installed dependencies.
  '**/patches/**',
  '**/.yarn/patches/**',
  '**/yarn.lock',
  '**/.yarnrc',
  '**/.yarnrc.yml',
  '**/.yarn/releases/**',
  '**/.yarn/plugins/**',
  '**/bun.lock',
  '**/bun.lockb',
  '**/bunfig.toml',
  '**/.npmrc',
  '**/deno.json',
  '**/deno.jsonc',
  '**/deno.lock',
  // Rust, Go, Python, Ruby, PHP, JVM, Swift.
  '**/Cargo.toml',
  '**/Cargo.lock',
  '**/go.mod',
  '**/go.sum',
  '**/pyproject.toml',
  '**/setup.py',
  '**/setup.cfg',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Pipfile',
  '**/Pipfile.lock',
  '**/requirements*.txt',
  '**/requirements/**',
  '**/constraints*.txt',
  '**/Gemfile',
  '**/Gemfile.lock',
  '**/*.gemspec',
  '**/composer.json',
  '**/composer.lock',
  '**/pom.xml',
  '**/build.gradle',
  '**/build.gradle.kts',
  '**/settings.gradle',
  '**/settings.gradle.kts',
  '**/gradle.lockfile',
  '**/Package.swift',
  '**/Package.resolved',
  // Build wrappers that download and run a tool.
  '**/gradlew*',
  '**/gradle/wrapper/**',
  '**/gradle/libs.versions.toml',
  '**/gradle.properties',
  '**/mvnw*',
  '**/.mvn/**',
  // More toolchains and lockfiles.
  '**/.cargo/config*',
  '**/rust-toolchain*',
  '**/.pnp.cjs',
  '**/.pnp.loader.mjs',
  '**/*.csproj',
  '**/nuget.config',
  '**/Directory.Packages.props',
  '**/Directory.Build.props',
  '**/packages.lock.json',
  '**/mix.lock',
  '**/mix.exs',
  '**/pubspec.*',
  '**/Podfile*',
  '**/*.podspec',
  // Code fetched from elsewhere at checkout.
  '.gitmodules',
  // Flow's own committed config, which holds the commands it runs before arming.
  '.agents/flow/config.json',
];

/**
 * Labels that mean "a person is not done with this yet": the same list, in
 * the same spelling, as `scripts/should-arm-automerge.sh` and dork-labs/dorkos.
 */
export const HOLD_LABELS: readonly string[] = [
  'hold',
  'do-not-merge',
  'do not merge',
  'wip',
  'blocked',
];

/** The only base the guard arms into. */
export const ARM_BASE = 'main';

/** The repository's security-path list and label (from `land.securityPaths`). */
export interface ArmPolicy {
  /** Globs, on top of {@link BUILTIN_SECURITY_GLOBS}. */
  securityGlobs: readonly string[];
  /** A regular expression tested against each path, or `null`. */
  securityPattern: string | null;
  /** The label that says Security has looked. */
  securityLabel: string;
}

/** Why the guard refused. */
export type RefusalSlug =
  | 'not-open'
  | 'draft'
  | 'held-by-label'
  | 'fork'
  | 'base-not-main'
  | 'unreviewed'
  | 'head-moved'
  | 'freeze'
  | 'changes-requested'
  | 'failing-checks'
  | 'files-unreadable'
  | 'security-path-unlabelled'
  | 'security-label-unverified'
  | 'security-label-stale';

/** The guard's answer. */
export type ArmDecision =
  | { verdict: 'ARM' }
  | {
      verdict: 'REFUSE';
      /** A stable, machine-readable reason. */
      reason: RefusalSlug;
      /** One sentence for a person: what is wrong and what to do. */
      detail: string;
    };

/** A plain object, or `undefined`. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A string field, or `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** A short SHA for a sentence. */
function short(sha: string | undefined): string {
  return sha === undefined ? 'nothing' : sha.slice(0, 7);
}

/** The PR's label names, lower-cased, from objects or bare strings. */
function labelNames(facts: Record<string, unknown>): string[] {
  const labels = Array.isArray(facts.labels) ? facts.labels : [];
  return labels.map((label) =>
    (record(label) !== undefined ? (str(record(label)?.name) ?? '') : String(label)).toLowerCase()
  );
}

/** The refusal shape. */
function refuse(reason: RefusalSlug, detail: string): ArmDecision {
  return { verdict: 'REFUSE', reason, detail };
}

/**
 * The red checks that count: failed or cancelled, and required (every check,
 * when the required list is unknown).
 */
function redRequiredChecks(facts: Record<string, unknown>): string[] {
  const checks = Array.isArray(facts.checks) ? facts.checks : [];
  const required = Array.isArray(facts.requiredChecks)
    ? new Set(facts.requiredChecks.filter((n): n is string => typeof n === 'string'))
    : null;
  const red: string[] = [];
  for (const entry of checks) {
    const check = record(entry);
    const bucket = (str(check?.bucket) ?? '').toLowerCase();
    if (bucket !== 'fail' && bucket !== 'cancel') continue;
    const name = str(check?.name) ?? '(unnamed check)';
    if (required === null || required.has(name)) red.push(name);
  }
  return red;
}

/**
 * The security paths among `files`, or `null` when the policy's pattern is not
 * a valid regular expression (a list that cannot be read never matches nothing).
 */
function securityHits(files: readonly string[], policy: ArmPolicy): string[] | null {
  let pattern: ((file: string) => boolean) | null = null;
  if (policy.securityPattern !== null && policy.securityPattern !== '') {
    pattern = foldingPattern(policy.securityPattern);
    if (pattern === null) return null;
  }
  // Every security path matches in any case, the built-ins and the repo's own
  // alike: on a case-insensitive disk (macOS's default) `Package.json` and
  // `APPS/Server/src/auth/x.ts` are the files the tools read.
  return files.filter(
    (file) =>
      matchesAny(file, BUILTIN_SECURITY_GLOBS, { ignoreCase: true }) ||
      matchesAny(file, policy.securityGlobs, { ignoreCase: true }) ||
      (pattern?.(file) ?? false)
  );
}

/**
 * The security paths among `files`, under `policy` and the built-in list.
 *
 * @param files - Repo-relative paths.
 * @param policy - The repository's security paths.
 * @returns The paths that are security paths; every path when the policy's
 *   pattern cannot be read (so nothing is ever ruled out by a broken list).
 */
export function securityPathsTouched(files: readonly string[], policy: ArmPolicy): string[] {
  return securityHits(files, policy) ?? [...files];
}

/**
 * Decide whether flow may arm auto-merge on a pull request.
 *
 * @param input - The facts, in the shape of `scripts/fixtures/arm-decisions.json`'s
 *   `green` payload: the PR as `gh` reports it (state, isDraft, labels,
 *   reviewDecision, checks with `bucket`s, headRefOid, baseRefName,
 *   isCrossRepository), plus `requiredChecks` (`null`: unknown), `files` (every
 *   path the PR touches, both names of a rename; `null`: the list is
 *   incomplete), `reviewedSha` (the commit the review covered) and `freeze`
 *   (`null`, or the freeze marker), and, for a PR with the security label,
 *   `securityLabelledAt` (when it was last added) and `headArrivedAt` (when
 *   the head arrived), ISO-8601 or `null` when unknown.
 * @param policy - The repository's security paths and label.
 * @returns `ARM`, or a refusal with its reason.
 */
export function decideArm(input: unknown, policy: ArmPolicy): ArmDecision {
  const facts = record(input);
  if (facts === undefined || str(facts.state)?.toUpperCase() !== 'OPEN') {
    return refuse('not-open', 'the pull request is not open');
  }
  if (facts.isDraft === true) {
    return refuse('draft', 'the pull request is a draft; mark it ready for review first');
  }
  const labels = labelNames(facts);
  const hold = HOLD_LABELS.find((h) => labels.includes(h));
  if (hold !== undefined) {
    return refuse('held-by-label', `the pull request is labelled "${hold}"; a person lifts that`);
  }
  if (facts.isCrossRepository !== false) {
    return refuse(
      'fork',
      facts.isCrossRepository === true
        ? 'the pull request comes from a fork; flow never arms one'
        : 'the forge did not say whether the pull request comes from a fork'
    );
  }
  const base = str(facts.baseRefName);
  if (base !== ARM_BASE) {
    return refuse(
      'base-not-main',
      `the pull request merges into ${base === undefined || base === '' ? 'an unknown branch' : `"${base}"`}, not ${ARM_BASE}`
    );
  }
  const reviewed = str(facts.reviewedSha);
  if (reviewed === undefined || !FULL_SHA.test(reviewed)) {
    return refuse(
      'unreviewed',
      reviewed === undefined
        ? 'no reviewed commit is recorded; review the head first'
        : `the reviewed commit "${reviewed}" is not a full SHA; name the whole commit`
    );
  }
  const head = str(facts.headRefOid);
  if (head === undefined || head.toLowerCase() !== reviewed.toLowerCase()) {
    return refuse(
      'head-moved',
      `the head moved to ${short(head)} after ${short(reviewed)} was reviewed; review the new commits first`
    );
  }
  const freeze = record(facts.freeze);
  if (facts.freeze !== null && facts.freeze !== undefined) {
    const reason = str(freeze?.reason);
    return refuse(
      'freeze',
      `a release freeze is on${reason ? ` (${reason})` : ''}; flow arms nothing until "flow freeze off"`
    );
  }
  if (str(facts.reviewDecision)?.toUpperCase() === 'CHANGES_REQUESTED') {
    return refuse('changes-requested', 'a reviewer asked for changes');
  }
  const red = redRequiredChecks(facts);
  if (red.length > 0) {
    return refuse('failing-checks', `required checks are red: ${red.join(', ')}`);
  }
  const labelled = labels.includes(policy.securityLabel.toLowerCase());
  const files = Array.isArray(facts.files)
    ? facts.files.filter((f): f is string => typeof f === 'string')
    : null;
  if (files === null || files.length !== (facts.files as unknown[]).length) {
    if (!labelled) {
      return refuse(
        'files-unreadable',
        `the forge did not give the full list of changed files, so flow cannot rule out a security path; it needs the "${policy.securityLabel}" label`
      );
    }
    return labelFresh(facts, policy.securityLabel, reviewed);
  }
  const hits = securityHits(files, policy);
  if (hits === null) {
    if (!labelled) {
      return refuse(
        'files-unreadable',
        `land.securityPaths.pattern is not a valid regular expression, so flow cannot rule out a security path; it needs the "${policy.securityLabel}" label`
      );
    }
    return labelFresh(facts, policy.securityLabel, reviewed);
  }
  if (hits.length === 0) return { verdict: 'ARM' };
  if (!labelled) {
    return refuse(
      'security-path-unlabelled',
      `it touches security paths (${hits.join(', ')}) and has no "${policy.securityLabel}" label; Security reviews it first`
    );
  }
  return labelFresh(facts, policy.securityLabel, reviewed);
}

/**
 * Whether the security label on a PR that needs it was added after the head
 * arrived. An unknown or unreadable time on either side refuses, and so does a
 * tie: the label has to come after the head, not with it.
 */
function labelFresh(facts: Record<string, unknown>, label: string, head: string): ArmDecision {
  const labelledAt = Date.parse(str(facts.securityLabelledAt) ?? '');
  const arrivedAt = Date.parse(str(facts.headArrivedAt) ?? '');
  if (Number.isNaN(arrivedAt)) {
    return refuse(
      'security-label-unverified',
      `flow cannot tell when ${short(head)} arrived as the head, so it cannot tell whether "${label}" covers it`
    );
  }
  if (Number.isNaN(labelledAt)) {
    return refuse(
      'security-label-unverified',
      `flow cannot tell when "${label}" was added, so it cannot tell whether it covers ${short(head)}`
    );
  }
  if (labelledAt <= arrivedAt) {
    return refuse(
      'security-label-stale',
      `"${label}" predates the head: it was added before ${short(head)} arrived, so Security looks at the new commits and adds it again`
    );
  }
  return { verdict: 'ARM' };
}

/**
 * A decision as one line, in the fixtures' spelling: `ARM` or `REFUSE <slug>`.
 *
 * @param decision - The decision.
 * @returns The line.
 */
export function formatDecision(decision: ArmDecision): string {
  return decision.verdict === 'ARM' ? 'ARM' : `REFUSE ${decision.reason}`;
}
