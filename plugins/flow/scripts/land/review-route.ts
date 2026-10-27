/**
 * The review route (DOR-3341, the Flow half): which review steps a pull request
 * needs, from the paths it touches. Pure.
 *
 * - **Security** is on every route. Nothing here ever takes it off: a `light`
 *   PR still gets Security's read, and one that touches a security path still
 *   needs the security label before the arm guard arms it (`arm-decision.ts`).
 * - **QA** is on unless the PR is `light`: every path it touches is a
 *   dependency manifest or lockfile, docs or copy, a test, or CI. Agent prose
 *   (`SKILL.md`, commands, `.claude/`) is behaviour, so it is never light.
 * - **Design** is on only when the PR touches `review.designPaths`. It runs at
 *   PR open, from the diff, alongside Security, and does not wait for QA.
 *
 * A file list the forge could not give whole is never light, and sends the
 * design step whenever any design path is configured: unknown fails closed.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/land/review-route
 */

import { securityPathsTouched, type ArmPolicy } from './arm-decision.ts';
import { DEPENDENCY_GLOBS } from './dependency-queue.ts';
import { matchesAny } from './glob.ts';

/** Docs: prose a person reads, never code an agent runs. */
export const LIGHT_DOC_GLOBS: readonly string[] = [
  '**/*.md',
  '**/*.mdx',
  '**/docs/**',
  '**/LICENSE',
  '**/LICENSE.*',
];

/** Tests and their snapshots. Fixtures are left out: a script may read one at run time. */
export const LIGHT_TEST_GLOBS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__snapshots__/**',
  '**/test/**',
  '**/tests/**',
  '**/engine-tests/**',
];

/** CI: what runs on the forge, not on a user's machine. */
export const LIGHT_CI_GLOBS: readonly string[] = ['.github/**'];

/**
 * Paths that are never light, even when a light glob matches them: dependency
 * files that are themselves code, and prose an agent executes as instructions
 * (skills, commands, agent definitions, the project's agent rules and review
 * rubric), so a change to them is a change in behaviour.
 */
export const NEVER_LIGHT_GLOBS: readonly string[] = [
  // Dependency files that are code a package manager or build runs, not a
  // list of versions: patches, install hooks, vendored tool releases, wrappers.
  '**/patches/**',
  '**/.yarn/patches/**',
  '**/.pnpmfile.cjs',
  '**/.yarn/releases/**',
  '**/.yarn/plugins/**',
  '**/.pnp.cjs',
  '**/.pnp.loader.mjs',
  '**/setup.py',
  '**/gradlew*',
  '**/gradle/wrapper/**',
  '**/mvnw*',
  '**/.mvn/**',
  // Prose an agent executes.
  '**/REVIEW.md',
  '**/SKILL.md',
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '**/commands/**',
  '**/skills/**',
  '**/agents/**',
  '.claude/**',
  '**/.claude/**',
  '.agents/**',
  '**/.dork/**',
];

/** What the route reads from config. */
export interface RoutePolicy {
  /** The security-path policy (`policyFor(land)`). */
  arm: ArmPolicy;
  /** `review.designPaths`. */
  designPaths: readonly string[];
  /** `review.lightPaths`: the repository's copy paths, on top of the built-ins. */
  lightPaths: readonly string[];
}

/** A PR's review route. */
export interface ReviewRoute {
  /** `light` skips the QA step; nothing else changes. */
  class: 'light' | 'standard';
  /** The steps the PR needs. `security` is always `true`. */
  steps: { security: true; qa: boolean; design: boolean };
  /**
   * Whether the arm guard will want the security label: the PR touches a
   * security path, or its file list is unknown.
   */
  securityLabelRequired: boolean;
  /** The security paths it touches; empty when the list is unknown (`securityLabelRequired` is then `true`). */
  securityPaths: string[];
  /** The design paths it touches. */
  designPaths: string[];
  /** The paths that kept it from `light` (empty when it is light). */
  heavy: string[];
}

/**
 * Whether one path is light under `policy`.
 *
 * @param file - A repo-relative path.
 * @param policy - The route policy.
 * @returns `true` when the path may ride a light PR.
 */
export function isLightPath(file: string, policy: Pick<RoutePolicy, 'lightPaths'>): boolean {
  const opts = { ignoreCase: true };
  if (matchesAny(file, NEVER_LIGHT_GLOBS, opts)) return false;
  return (
    matchesAny(file, DEPENDENCY_GLOBS, opts) ||
    matchesAny(file, LIGHT_DOC_GLOBS, opts) ||
    matchesAny(file, LIGHT_TEST_GLOBS, opts) ||
    matchesAny(file, LIGHT_CI_GLOBS, opts) ||
    matchesAny(file, policy.lightPaths, opts)
  );
}

/**
 * Route a pull request by the paths it touches.
 *
 * @param files - Every path the PR touches (both names of a rename), or `null`
 *   when the forge could not give the whole list.
 * @param policy - The security paths, design paths and copy paths.
 * @returns The route.
 */
export function reviewRoute(files: readonly string[] | null, policy: RoutePolicy): ReviewRoute {
  if (files === null || files.length === 0) {
    // An unknown list (or GitHub's 0 while it still works out a new PR's diff)
    // is never light, and sends the design step whenever one is configured.
    return {
      class: 'standard',
      steps: { security: true, qa: true, design: policy.designPaths.length > 0 },
      securityLabelRequired: true,
      securityPaths: [],
      designPaths: [],
      heavy: [],
    };
  }
  const heavy = files.filter((file) => !isLightPath(file, policy));
  const designPaths = files.filter((file) =>
    matchesAny(file, policy.designPaths, { ignoreCase: true })
  );
  const securityPaths = securityPathsTouched(files, policy.arm);
  const light = heavy.length === 0;
  return {
    class: light ? 'light' : 'standard',
    steps: { security: true, qa: !light, design: designPaths.length > 0 },
    securityLabelRequired: securityPaths.length > 0,
    securityPaths,
    designPaths,
    heavy,
  };
}

/**
 * The route as one line for a person.
 *
 * @param route - The route.
 * @returns For example `light: Security, design (no QA)`.
 */
export function describeRoute(route: ReviewRoute): string {
  const steps = [
    'Security',
    ...(route.steps.qa ? ['QA'] : []),
    ...(route.steps.design ? ['design'] : []),
  ];
  return `${route.class}: ${steps.join(', ')}${route.steps.qa ? '' : ' (no QA)'}${route.securityLabelRequired ? '; needs the security label to arm' : ''}`;
}
