import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkVersionAgreement,
  collectPackageVersions,
  declaredVersionOf,
} from '../src/versions.ts';

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

/**
 * Build a throwaway repo from a map of repo-relative path to file contents, and
 * return its root. Objects are written as JSON; strings are written verbatim.
 * Fixtures live here and never in the real `plugins/`.
 */
function fixtureRepo(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'schema-check-versions-'));
  scratchDirs.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
      'utf8'
    );
  }
  return root;
}

const MANIFEST = 'plugins/demo/.dork/manifest.json';
const PLUGIN = 'plugins/demo/.claude-plugin/plugin.json';
const PACKAGE = 'plugins/demo/package.json';

describe('checkVersionAgreement', () => {
  it('passes a package whose three version files agree', () => {
    // The healthy case: flow after its 0.7.3 bump looks exactly like this.
    const root = fixtureRepo({
      [MANIFEST]: { name: 'demo', version: '0.7.3' },
      [PLUGIN]: { name: 'demo', version: '0.7.3' },
      [PACKAGE]: { name: 'demo', version: '0.7.3' },
    });
    expect(checkVersionAgreement(root)).toEqual([]);
  });

  it('fails when the manifest and plugin.json disagree, naming both files and values', () => {
    // The exact drift that shipped flow as 0.6.0 in DorkOS and 0.7.2 in Claude Code.
    const root = fixtureRepo({
      [MANIFEST]: { name: 'demo', version: '0.6.0' },
      [PLUGIN]: { name: 'demo', version: '0.7.2' },
    });
    const findings = checkVersionAgreement(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('plugins/demo');
    expect(findings[0]!.message).toBe(
      'Versions disagree: .dork/manifest.json says 0.6.0, .claude-plugin/plugin.json says 0.7.2. Set every file to the same version.'
    );
  });

  it('fails when package.json alone disagrees with the other two', () => {
    // package.json is the third voice; a stale one is as wrong as a stale manifest.
    const root = fixtureRepo({
      [MANIFEST]: { name: 'demo', version: '1.0.0' },
      [PLUGIN]: { name: 'demo', version: '1.0.0' },
      [PACKAGE]: { name: 'demo', version: '0.9.0' },
    });
    const findings = checkVersionAgreement(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('package.json says 0.9.0');
  });

  it('fails when the manifest has a version and plugin.json has none', () => {
    // Claude Code would fall back to the commit while DorkOS reports the manifest's version.
    const root = fixtureRepo({
      [MANIFEST]: { name: 'demo', version: '0.4.0' },
      [PLUGIN]: { name: 'demo' },
    });
    expect(checkVersionAgreement(root)).toEqual([
      {
        file: 'plugins/demo',
        message:
          '.dork/manifest.json says version 0.4.0 but .claude-plugin/plugin.json has no version. Add "version": "0.4.0" to plugin.json so Claude Code and DorkOS agree.',
      },
    ]);
  });

  it('ignores a package.json without a version field', () => {
    // A package.json that only carries scripts or deps is not declaring a version.
    const root = fixtureRepo({
      [MANIFEST]: { name: 'demo', version: '0.2.0' },
      [PLUGIN]: { name: 'demo', version: '0.2.0' },
      [PACKAGE]: { name: 'demo', private: true },
    });
    expect(checkVersionAgreement(root)).toEqual([]);
  });

  it('passes when there is no package.json at all', () => {
    // Most packages in this marketplace have none; the other two agreeing is enough.
    const root = fixtureRepo({
      [MANIFEST]: { name: 'demo', version: '0.2.0' },
      [PLUGIN]: { name: 'demo', version: '0.2.0' },
    });
    expect(checkVersionAgreement(root)).toEqual([]);
  });

  it('passes a plugin.json-only package', () => {
    // The seed packages predate the manifest: one file cannot disagree with itself.
    const root = fixtureRepo({ [PLUGIN]: { name: 'demo', version: '0.1.0' } });
    expect(checkVersionAgreement(root)).toEqual([]);
  });

  it('passes a manifest-only package with no plugin.json', () => {
    // A missing plugin.json is not this check's concern (only a present one without a version is).
    const root = fixtureRepo({ [MANIFEST]: { name: 'demo', version: '0.1.0' } });
    expect(checkVersionAgreement(root)).toEqual([]);
  });

  it('passes a package that declares no version anywhere', () => {
    // No version at all is legal: Claude Code then serves the package by commit.
    const root = fixtureRepo({
      [MANIFEST]: { name: 'demo' },
      [PLUGIN]: { name: 'demo' },
      [PACKAGE]: { name: 'demo' },
    });
    expect(checkVersionAgreement(root)).toEqual([]);
  });

  it('never reads a nested package.json', () => {
    // flow's engine-tests/package.json is a test workspace, not the package's version.
    const root = fixtureRepo({
      [MANIFEST]: { name: 'demo', version: '0.3.0' },
      [PLUGIN]: { name: 'demo', version: '0.3.0' },
      'plugins/demo/engine-tests/package.json': { name: 'engine-tests', version: '9.9.9' },
    });
    expect(checkVersionAgreement(root)).toEqual([]);
  });

  it('reports an unparseable plugin.json once instead of throwing', () => {
    // A syntax error must turn into a finding, never crash the whole gate.
    const root = fixtureRepo({
      [MANIFEST]: { name: 'demo', version: '0.3.0' },
      [PLUGIN]: '{ "name": "demo", ',
    });
    expect(checkVersionAgreement(root)).toEqual([
      { file: PLUGIN, message: "Not valid JSON, so its version can't be read." },
    ]);
  });

  it('stays silent about an unparseable manifest, which validateManifests already reports', () => {
    // One broken file, one finding: the manifest check owns this one.
    const root = fixtureRepo({
      [MANIFEST]: '{ nope',
      [PLUGIN]: { name: 'demo', version: '0.3.0' },
    });
    expect(checkVersionAgreement(root)).toEqual([]);
  });

  it('checks every package independently', () => {
    // A broken package must not hide, or be hidden by, a healthy one beside it.
    const root = fixtureRepo({
      'plugins/a/.claude-plugin/plugin.json': { name: 'a', version: '1.0.0' },
      'plugins/a/.dork/manifest.json': { name: 'a', version: '1.0.0' },
      'plugins/b/.claude-plugin/plugin.json': { name: 'b', version: '2.0.0' },
      'plugins/b/.dork/manifest.json': { name: 'b', version: '1.0.0' },
    });
    const findings = checkVersionAgreement(root);
    expect(findings.map((f) => f.file)).toEqual(['plugins/b']);
  });
});

describe('collectPackageVersions and declaredVersionOf', () => {
  it('reads through any reader, so the bump check can read git revisions', () => {
    // The reader seam is what lets bump.ts reuse this against `git show <rev>:<path>`.
    const files: Record<string, string> = {
      [MANIFEST]: JSON.stringify({ version: '0.1.0' }),
      [PLUGIN]: JSON.stringify({ version: '0.2.0' }),
    };
    const versions = collectPackageVersions((rel) => files[rel], 'plugins/demo');
    expect(versions.manifest).toEqual({ file: MANIFEST, version: '0.1.0' });
    expect(versions.plugin).toEqual({ file: PLUGIN, version: '0.2.0' });
    expect(versions.packageJson).toBeUndefined();
  });

  it('prefers plugin.json, the way Claude Code resolves a version', () => {
    // Claude Code loads plugin.json first; the manifest is only the fallback.
    expect(
      declaredVersionOf({
        manifest: { file: MANIFEST, version: '0.1.0' },
        plugin: { file: PLUGIN, version: '0.2.0' },
      })
    ).toBe('0.2.0');
    expect(declaredVersionOf({ manifest: { file: MANIFEST, version: '0.1.0' } })).toBe('0.1.0');
    expect(
      declaredVersionOf({
        manifest: { file: MANIFEST, version: '0.1.0' },
        plugin: { file: PLUGIN, version: undefined },
      })
    ).toBe('0.1.0');
    expect(declaredVersionOf({})).toBeUndefined();
  });
});
