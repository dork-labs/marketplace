/**
 * Tracker-confinement guard (spec §3, §Security; task 1.1).
 *
 * The architectural invariant: ALL `/flow` tracker I/O is confined to the single
 * adapter skill (`linear-adapter`). Every `mcp__linear__*` /
 * `mcp__plugin_linear_linear__*` string, every `composio` invocation, and every
 * `LINEAR_*` tracker slug must appear ONLY inside that adapter skill dir (or the
 * reference adapter implementations) — giving the agnosticism win ("all Linear in
 * one place") and a single audit surface for tracker writes.
 *
 * SCOPE — the FLOW PLUGIN BUNDLE ONLY (the plugin is self-contained, so this is
 * the whole shipped surface, not a sub-slice of a larger repo):
 *   - `plugins/flow/skills/**`     (canonical flow stage + adapter + loop skills)
 *   - `plugins/flow/commands/**`   (thin /flow + /flow:<stage> commands)
 *   - `plugins/flow/hooks/**`      (the Stop hook + hooks manifest)
 *   - `plugins/flow/scripts/**`    (the runnable engine oracles, ADR-0294)
 *
 * The `'linear'` enum carve-out: the lowercase `z.enum(['linear'])` literal in
 * `scripts/config-schema.ts` `TrackerSchema` and `scripts/tasks-schema.ts`
 * `ProvenanceTrackerSchema` is the generic tracker *name*, not a tracker API
 * string. It is bare `linear` — it does NOT match the `mcp__linear__` /
 * `LINEAR_[A-Z_]+` / `composio` I/O patterns below, so it passes the guard
 * naturally with no allowlist entry.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

// engine-tests -> plugins/flow (the plugin bundle root)
const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The one skill dir permitted to contain tracker strings. */
const ADAPTER_SKILL_DIR = path.join(pluginRoot, "skills", "linear-adapter");

/**
 * The reference adapter implementations (`linear-composio`, `linear-mcp`) live
 * here. Like the adapter skill, they legitimately carry tracker API strings —
 * they ARE the concrete tracker bindings the adapter seam points at — so they are
 * carved out alongside `linear-adapter`. Included so the carve-out stays correct
 * even if the reference adapters are ever swept into a scanned bundle root.
 */
const REFERENCE_ADAPTERS_DIR = path.join(pluginRoot, "adapters", "reference");

/**
 * The adapter-authoring meta-skill. Like the concrete adapter skill, it
 * legitimately names trackers and reference adapters (e.g. `linear-composio`)
 * while teaching adapter-building, so it is carved out of the bundle scan. The
 * GENERIC stage skills stay strictly guarded by the G8 scan below.
 */
const BUILDING_ADAPTERS_SKILL_DIR = path.join(
  pluginRoot,
  "skills",
  "building-adapters",
);

/**
 * Roots that make up the flow plugin bundle this guard scopes to. Each is a
 * directory walked recursively. Covers the skills, commands, the Stop hook, and
 * the runnable engine oracles, so tracker I/O can't leak into any shipped layer.
 */
const FLOW_BUNDLE_ROOTS = [
  path.join(pluginRoot, "skills"),
  path.join(pluginRoot, "commands"),
  path.join(pluginRoot, "hooks"),
  path.join(pluginRoot, "scripts"),
];

/**
 * Files inside the bundle roots that LEGITIMATELY carry the pattern strings as
 * fixtures / assertions ABOUT the adapter contract rather than as live tracker
 * I/O. In the plugin layout the guard's own pattern literals and the adapter-doc
 * assertions live in `engine-tests/` — which is NOT a bundle root — so they are
 * never scanned and need no entry here. The set is retained as the documented
 * seam for any future in-bundle fixture.
 */
const SCAN_EXCLUSIONS = new Set<string>();

/**
 * Tracker-string patterns that may only live in the adapter skill. Case-sensitive
 * where it matters: `composio` is matched case-insensitively (CLI is lowercase but
 * prose may capitalize); the MCP/slug families are matched as written.
 */
const TRACKER_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "linear MCP tool", re: /mcp__(plugin_)?linear[_a-z]*__/ },
  { label: "composio invocation", re: /\bcomposio\b/i },
  { label: "Composio LINEAR_ slug", re: /\bLINEAR_[A-Z_]+\b/ },
];

/** Recursively collect every file path under `dir` (skips nothing — flow dirs are small). */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Collect every file under a root that may be a directory OR a single file. */
function collectFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return statSync(root).isFile() ? [root] : walkFiles(root);
}

/** Whether `file` sits inside `dir` (path-prefix containment, no `..` escape). */
function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Whether `file` is one of the adapter homes allowed to carry tracker strings. */
function isInsideAdapter(file: string): boolean {
  return (
    isInside(ADAPTER_SKILL_DIR, file) || isInside(REFERENCE_ADAPTERS_DIR, file)
  );
}

/** The tracker-pattern labels a given content blob trips, in pattern order. */
function trackerOffenses(content: string): string[] {
  return TRACKER_PATTERNS.filter(({ re }) => re.test(content)).map(
    ({ label }) => label,
  );
}

/**
 * Scan a set of (file, content) pairs and return offender descriptions, applying
 * the adapter carve-out and the fixture allowlist. The real scan and the
 * planted-offender unit both run through this one function so they exercise the
 * same matching + exclusion logic.
 */
function scanForOffenders(
  files: { file: string; content: string }[],
): string[] {
  const offenders: string[] = [];
  for (const { file, content } of files) {
    if (isInsideAdapter(file)) continue;
    if (isInside(BUILDING_ADAPTERS_SKILL_DIR, file)) continue;
    if (SCAN_EXCLUSIONS.has(file)) continue;
    for (const label of trackerOffenses(content)) {
      offenders.push(
        `${path.relative(pluginRoot, file)} — contains a ${label}`,
      );
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Charter goal G8 — the GENERIC stage skills must name NO tracker (task 2.2).
//
// The bundle-wide rule above forbids tracker *API strings* outside the adapter.
// G8 holds the generic stage skills (every flow stage skill EXCEPT the adapter,
// adapter-authoring, and autonomy/loop infra skills) to a STRICTER rule: they may
// not even *name* a tracker — not the adapter skill's own name, not the "Linear"
// product name, not a concrete ticket id. That keeps the stage layer fully
// PM-agnostic; only the adapter knows the tracker exists.
// ---------------------------------------------------------------------------

/** The flow skills dir whose generic stage skills G8 governs. */
const FLOW_SKILLS_DIR = path.join(pluginRoot, "skills");

/**
 * Non-generic skills exempt from G8. The adapter + adapter-authoring skills
 * legitimately name trackers. `flow-drain` is the autonomous-loop cron tick (the
 * plugin home of the former `.dork/tasks/flow-drain/` bundle root): it is an
 * autonomy/infra skill, not a generic stage skill, and — like the old bundle root
 * — may carry a concrete `DOR-<n>` migration-note ticket ref. It stays governed
 * by the looser bundle rule above (which forbids only tracker API strings), never
 * the strict name-level G8 rule. Excluded by literal name so a newly added
 * generic STAGE skill is never accidentally exempted.
 */
const G8_EXEMPT_SKILLS = new Set([
  "linear-adapter",
  "building-adapters",
  "flow-drain",
]);

/**
 * The generic stage skills — derived dynamically (NOT hardcoded) so a newly
 * added generic skill is auto-covered: keep only directories, then drop the
 * G8-exempt skills and any `*-adapter` dir.
 */
const GENERIC_STAGE_SKILL_DIRS: string[] = readdirSync(FLOW_SKILLS_DIR)
  .filter((entry) => statSync(path.join(FLOW_SKILLS_DIR, entry)).isDirectory())
  .filter((name) => !G8_EXEMPT_SKILLS.has(name) && !name.endsWith("-adapter"))
  .map((name) => path.join(FLOW_SKILLS_DIR, name));

/**
 * The stricter pattern set for the generic stage skills: the three tracker
 * API-string families PLUS the tracker NAME forms. `Linear` is matched
 * case-sensitively (capital L) so the legacy lowercase `/linear:idea` slug refs
 * do NOT trip it; `DOR-<n>` is a concrete Linear (team key `DOR`) ticket id.
 */
const GENERIC_FORBIDDEN_PATTERNS: { label: string; re: RegExp }[] = [
  ...TRACKER_PATTERNS,
  { label: "linear-adapter name", re: /linear-adapter/ },
  { label: 'tracker name "Linear"', re: /\bLinear\b/ },
  { label: "DOR ticket id", re: /\bDOR-[0-9]+/ },
];

/** The generic-forbidden-pattern labels a given content blob trips, in order. */
function genericOffenses(content: string): string[] {
  return GENERIC_FORBIDDEN_PATTERNS.filter(({ re }) => re.test(content)).map(
    ({ label }) => label,
  );
}

/**
 * Scan (file, content) pairs against the STRICTER generic-skill rule. No adapter
 * carve-out (the generic set already excludes every adapter dir) and no fixture
 * allowlist (the generic skills carry none). Offender format mirrors
 * scanForOffenders so failure messages read the same way.
 */
function scanGenericSkills(
  files: { file: string; content: string }[],
): string[] {
  const offenders: string[] = [];
  for (const { file, content } of files) {
    for (const label of genericOffenses(content)) {
      offenders.push(
        `${path.relative(pluginRoot, file)} — contains a ${label}`,
      );
    }
  }
  return offenders;
}

describe("tracker confinement — the flow plugin keeps all tracker I/O in linear-adapter", () => {
  it("the adapter skill exists and is the single confinement target", () => {
    expect(existsSync(path.join(ADAPTER_SKILL_DIR, "SKILL.md"))).toBe(true);
  });

  it("no tracker string appears in the flow bundle OUTSIDE the linear-adapter skill", () => {
    const files = FLOW_BUNDLE_ROOTS.flatMap((root) =>
      collectFiles(root).map((file) => ({
        file,
        content: readFileSync(file, "utf8"),
      })),
    );
    const offenders = scanForOffenders(files);

    expect(
      offenders,
      `tracker strings leaked outside linear-adapter:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the scan is non-vacuous — it actually visits files in every bundle root", () => {
    // Guard against an empty or mis-rooted scan silently passing: each bundle
    // root must contribute at least one scanned file.
    for (const root of FLOW_BUNDLE_ROOTS) {
      expect(
        collectFiles(root).length,
        `root produced no files: ${root}`,
      ).toBeGreaterThan(0);
    }
  });

  it("a planted mcp__linear__ string in any bundle root fails the guard", () => {
    // Unit on the matcher + scan logic, not real files: plant an offender directly
    // under the engine scripts, the commands, and the Stop hook, and assert each
    // is caught (proving the roots are genuinely scanned, not allowlisted).
    const planted = 'await mcp__linear__create_issue({ title: "x" });';
    const plantedRoots = [
      path.join(pluginRoot, "scripts", "__planted-offender__.ts"),
      path.join(pluginRoot, "commands", "flow", "__planted-offender__.md"),
      path.join(pluginRoot, "hooks", "flow-loop.mjs"),
    ];
    for (const file of plantedRoots) {
      const offenders = scanForOffenders([{ file, content: planted }]);
      expect(
        offenders.length,
        `planted offender not caught at ${file}`,
      ).toBeGreaterThan(0);
    }
  });

  it("the adapter skill DOES carry tracker strings (proves the guard is meaningful, not vacuous)", () => {
    const skill = readFileSync(
      path.join(ADAPTER_SKILL_DIR, "SKILL.md"),
      "utf8",
    );
    // If the adapter had no tracker strings, the "zero outside" assertion would be
    // trivially true. Pin that the adapter is where they actually live.
    expect(TRACKER_PATTERNS.some(({ re }) => re.test(skill))).toBe(true);
  });
});

describe("charter goal G8 — generic stage skills name no tracker (stricter than the bundle rule)", () => {
  it("no generic stage skill contains any tracker NAME or API string", () => {
    const files = GENERIC_STAGE_SKILL_DIRS.flatMap((dir) =>
      collectFiles(dir).map((file) => ({
        file,
        content: readFileSync(file, "utf8"),
      })),
    );
    const offenders = scanGenericSkills(files);

    expect(
      offenders,
      `generic stage skills must name no tracker (G8):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the generic scan is non-vacuous — the set is non-empty and every dir contributes a file", () => {
    // Guard against a mis-rooted or over-filtered set silently passing: the
    // generic set must be non-empty AND each dir must yield at least one file.
    expect(GENERIC_STAGE_SKILL_DIRS.length).toBeGreaterThan(0);
    for (const dir of GENERIC_STAGE_SKILL_DIRS) {
      expect(
        collectFiles(dir).length,
        `generic skill dir produced no files: ${dir}`,
      ).toBeGreaterThan(0);
    }
  });

  it("the stricter patterns catch a planted tracker NAME (not just an API string)", () => {
    // Mirrors the bundle-wide planted-offender unit, but proves the *name*-level
    // patterns bite: a bare adapter-skill name and a bare "Linear" product name —
    // neither of which trips the looser TRACKER_PATTERNS — must each be flagged.
    const adapterName = scanGenericSkills([
      {
        file: path.join(
          FLOW_SKILLS_DIR,
          "capturing-work",
          "__planted-offender__.md",
        ),
        content: "route this through the linear-adapter skill",
      },
    ]);
    expect(
      adapterName.length,
      'planted "linear-adapter" name not caught',
    ).toBeGreaterThan(0);

    const productName = scanGenericSkills([
      {
        file: path.join(
          FLOW_SKILLS_DIR,
          "capturing-work",
          "__planted-offender__.md",
        ),
        content: "create the issue in Linear",
      },
    ]);
    expect(
      productName.length,
      'planted "Linear" product name not caught',
    ).toBeGreaterThan(0);
  });
});
