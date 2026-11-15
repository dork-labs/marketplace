/**
 * `land.securityPaths.labelOn` (DOR-3768): which PRs need a person's security
 * label before an agent may arm them.
 *
 * - `every-pr` (the default): every PR, whatever it touches (DOR-3724).
 * - `security-paths`: only a PR that touches a security path. An agent may arm
 *   any other PR with no person's label once its review is clean, as flow did
 *   before 0.86.0, and GitHub merges it once the required checks pass.
 *
 * With `security-paths`, the guard (`arm-guard.ts`) holds the agent's arm to
 * four rules on top of the usual ones:
 *
 * 1. The setting counts only as the default branch on `origin` has it
 *    (`base-config.ts`). A PR that changes it touches flow's committed config,
 *    a security path, so it never takes the unlabelled route.
 * 2. The default branch must require at least one check besides Security's
 *    verdict checks (which pass on a PR that touches no security path): with
 *    none, GitHub merges an armed PR at once, so nothing would stand between a
 *    misled agent and the merge. Unknown counts as none.
 * 3. {@link LABEL_ON_SECURITY_GLOBS}, the review rubric and every submodule
 *    count as security paths, on top of the built-in list and the repository's
 *    own. The repository can add paths, never remove these.
 * 4. A `review:deep` PR still needs the security label and the deep label, and
 *    so does a PR that ever was one: an agent could take the label off.
 *
 * This is not a boundary. A misled agent can merge a bad change that passes the
 * checks and stays off the path list; only a GitHub ruleset is a real boundary.
 *
 * Dependency-free: the Flow panel reads it too.
 *
 * @module @dorkos/flow/land/label-on
 */

/** The values `land.securityPaths.labelOn` takes. */
export const LABEL_ON_VALUES = ['every-pr', 'security-paths'] as const;

/** Which PRs need a person's security label before an agent arms them. */
export type LabelOn = (typeof LABEL_ON_VALUES)[number];

/**
 * Paths that count as security paths while `labelOn` is `security-paths`, on
 * top of the built-in list: what steers an agent or a build (agent and editor
 * settings, CI, git hooks, scripts, task runners, container builds, and the
 * configs that decide what CI checks). Package manifests, lockfiles, patches
 * and flow's committed config are already built in. Each matches at any depth
 * but `.github/**` and `REVIEW.md`, which only mean something at the root.
 */
export const LABEL_ON_SECURITY_GLOBS: readonly string[] = [
  '.github/**',
  // What steers an agent, or runs when a checkout is opened.
  '**/.claude/**',
  '**/.agents/**',
  '**/.dork/**',
  '**/AGENTS.md',
  '**/CLAUDE*.md',
  '**/GEMINI.md',
  '**/.mcp.json',
  '**/.cursor/**',
  '**/.cursorrules',
  '**/.codex/**',
  '**/.gemini/**',
  '**/.windsurfrules',
  '**/.clinerules',
  '**/.vscode/**',
  '**/.devcontainer/**',
  '**/.envrc',
  '**/mise.toml',
  '**/.mise.toml',
  // The review rubric's default name; a configured one is added beside it.
  'REVIEW.md',
  // What git does to a diff, so a reviewer may not see a change.
  '**/.gitattributes',
  // Scripts, task runners and container builds that CI and installs run.
  '**/scripts/**',
  '**/Makefile',
  '**/*.mk',
  '**/justfile',
  '**/Justfile',
  '**/Taskfile.y*ml',
  '**/Dockerfile*',
  '**/*.dockerfile',
  '**/Containerfile*',
  // What decides which code CI checks, so a change could quietly narrow it.
  '**/tsconfig*.json',
  '**/vite.config.*',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/jest.config.*',
  '**/playwright.config.*',
  '**/eslint.config.*',
  '**/.eslintrc*',
  '**/.eslintignore',
  '**/.prettierignore',
  '**/turbo.json',
  '**/nx.json',
  '**/babel.config.*',
  '**/.babelrc*',
  '**/conftest.py',
  '**/pytest.ini',
  '**/tox.ini',
  '**/noxfile.py',
  '**/build.rs',
  // Git hooks, and the tools that install them.
  '**/.githooks/**',
  '**/.git-hooks/**',
  '**/.husky/**',
  '**/.lefthook/**',
  '**/lefthook*.yml',
  '**/lefthook*.yaml',
  '**/.lefthook*.yml',
  '**/.lefthook*.yaml',
  '**/.pre-commit-config.yaml',
  '**/.pre-commit-hooks.yaml',
  '**/.simple-git-hooks*',
  '**/simple-git-hooks*',
];

/**
 * Read `land.securityPaths.labelOn` loosely from a parsed config file: only
 * the exact string `security-paths` turns it on; anything else is the default.
 *
 * @param config - A parsed `config.json`, or anything.
 * @returns The setting.
 */
export function labelOnOf(config: unknown): LabelOn {
  const land = field(config, 'land');
  const securityPaths = field(land, 'securityPaths');
  return field(securityPaths, 'labelOn') === 'security-paths' ? 'security-paths' : 'every-pr';
}

/**
 * Where `flow status` and the Flow panel read the setting from: the default
 * branch as this checkout last fetched it (`origin/HEAD`, which the guard
 * fetches fresh) and the main checkout's own `config.json`. Either one on is on,
 * so a setting that merged and was never pulled still shows.
 *
 * @param workingTree - The main checkout's `config.json`, parsed, or anything.
 * @param originHead - The same file at `origin/HEAD`, parsed, or anything.
 * @returns The setting.
 */
export function labelOnShown(workingTree: unknown, originHead: unknown): LabelOn {
  return labelOnOf(workingTree) === 'security-paths' || labelOnOf(originHead) === 'security-paths'
    ? 'security-paths'
    : 'every-pr';
}

/**
 * The `git show` arguments for the committed config on origin's default
 * branch as last fetched, tried in order until one answers: `origin/HEAD`,
 * which only a clone or `git remote set-head` sets, then `main` and `master`.
 */
export const ORIGIN_CONFIG_REFS: readonly string[] = [
  'refs/remotes/origin/HEAD:.agents/flow/config.json',
  'refs/remotes/origin/main:.agents/flow/config.json',
  'refs/remotes/origin/master:.agents/flow/config.json',
];

/** JSON.parse that returns `undefined` instead of throwing. */
export function parseOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A plain object's field, or `undefined`. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The review rubric as a security-path glob: `review.rubric` when it is a
 * repo-relative path, else `null` (an absolute path is outside the repository).
 *
 * @param rubric - `review.rubric` as the default branch has it.
 * @returns The glob, or `null`.
 */
export function rubricGlob(rubric: unknown): string | null {
  if (typeof rubric !== 'string') return null;
  const relative = rubric.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (relative === '' || relative.startsWith('/') || /^[A-Za-z]:\//.test(relative)) return null;
  if (relative.split('/').some((segment) => segment === '..' || segment === '')) return null;
  return relative;
}

/**
 * What `flow status` and the Flow panel say while it is on. Plain, and never
 * that it is safe.
 */
export const LABEL_ON_NOTICE =
  'Agents may merge their own PRs here: land.securityPaths.labelOn is "security-paths", so a PR that touches no security path needs no person\'s label, only a clean review and passing required checks. A misled agent can merge a bad change that passes the checks and stays off the path list. Only a GitHub ruleset is a real boundary.';
