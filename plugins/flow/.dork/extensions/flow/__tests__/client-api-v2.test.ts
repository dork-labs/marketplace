/**
 * DorkOS client API version 2 (DOR-3293): flow's screens run in a frame of
 * their own, with no network and no DorkOS page around them. So the manifest
 * says version 2 and declares its server calls, and nothing the page half
 * runs may reach for what the frame no longer has: `fetch`, the desktop
 * shell's `window.electronAPI`, DorkOS's event stream, `executeCommand`,
 * browser storage, cookies, the parent window, or a download link. Every call
 * goes through `api.request` (`ui/api.ts`).
 *
 * The page half is every file `index.ts` reaches through value imports, read
 * as TypeScript, so a word in a comment or a string never counts.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The first DorkOS with client API version 2. */
const FIRST_V2_HOST = [0, 135, 12];

/** Globals the frame does not have, by the name the code would use. */
const GONE_GLOBALS = new Set([
  'fetch',
  'EventSource',
  'XMLHttpRequest',
  'WebSocket',
  'localStorage',
  'sessionStorage',
  'indexedDB',
]);

/** Names the global object goes by, so `window.fetch` counts as `fetch`. */
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

/** Members the frame does not have: `window.electronAPI`, `document.cookie`, `api.executeCommand`. */
const GONE_MEMBERS = new Set(['electronAPI', 'cookie', 'parent', 'executeCommand', 'sendBeacon']);

/** Packages the page half value-imports, which the frame can't load (it bundles none). */
const packages = new Set<string>();

/** Every file `index.ts` reaches through relative value imports. */
function pageHalf(): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    for (const statement of source.statements) {
      const isImport = ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly;
      const isExport = ts.isExportDeclaration(statement) && !statement.isTypeOnly;
      if (!isImport && !isExport) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
      if (!specifier.text.startsWith('.')) {
        packages.add(`${path.relative(EXTENSION_DIR, file)}: ${specifier.text}`);
        continue;
      }
      visit(path.resolve(path.dirname(file), specifier.text));
    }
  };
  visit(path.join(EXTENSION_DIR, 'index.ts'));
  return [...seen];
}

/** What some code uses that the frame does not have, as `line: what`. */
function goneUses(text: string): string[] {
  const source = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const walk = (node: ts.Node) => {
    if (ts.isIdentifier(node) && GONE_GLOBALS.has(node.text)) {
      const parent = node.parent;
      // `x.fetch` or `{ fetch: … }` is a name, not the global.
      const member =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!member) found.push(`${at(node)}: ${node.text}`);
    }
    if (ts.isPropertyAccessExpression(node) && GONE_MEMBERS.has(node.name.text)) {
      found.push(`${at(node)}: .${node.name.text}`);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      GONE_GLOBALS.has(node.name.text)
    ) {
      found.push(`${at(node)}: ${node.expression.text}.${node.name.text}`);
    }
    // `h('a', { download: … })`: a download link does nothing in the frame.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'download'
    ) {
      found.push(`${at(node)}: download`);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

describe('client API version 2', () => {
  const manifest = JSON.parse(readFileSync(path.join(EXTENSION_DIR, 'extension.json'), 'utf8')) as {
    clientApiVersion?: number;
    capabilities?: { http?: unknown };
    minHostVersion: string;
  };

  it('says version 2 in extension.json, declares its server calls, and needs a DorkOS that has it', () => {
    expect(manifest.clientApiVersion).toBe(2);
    expect(manifest.capabilities?.http).toBe(true);
    const floor = manifest.minHostVersion.split('.').map(Number);
    const atLeast = floor.findIndex((part, i) => part !== FIRST_V2_HOST[i]);
    expect(atLeast === -1 || floor[atLeast] > FIRST_V2_HOST[atLeast]).toBe(true);
  });

  it('reaches the screens’ files from index.ts', () => {
    const files = pageHalf().map((file) => path.relative(EXTENSION_DIR, file));
    expect(files).toContain('ui/api.ts');
    expect(files).toContain('ui/store.ts');
    expect(files).toContain('ui/project-accounts.ts');
  });

  it('loads no package: React and the SDK come from DorkOS, and node builtins never run there', () => {
    pageHalf();
    expect([...packages]).toEqual([]);
  });

  it('uses nothing the frame dropped in any file the page half runs', () => {
    const uses = Object.fromEntries(
      pageHalf()
        .map(
          (file) =>
            [path.relative(EXTENSION_DIR, file), goneUses(readFileSync(file, 'utf8'))] as const
        )
        .filter(([, found]) => found.length > 0)
    );
    expect(uses).toEqual({});
  });

  it('would catch a fetch, the electron bridge, the event stream and a download link', () => {
    expect(
      goneUses(
        [
          "void fetch('/api/x');",
          'const port = (window as never as { electronAPI: unknown }).electronAPI;',
          "new EventSource('/api/events');",
          "h('a', { download: 'x.json' });",
          '// fetch( in a comment, and "fetch(" in a string, are only words.',
          "const words = 'fetch(';",
          'api.request({ fetch: 1 });',
          "void window.fetch('/api/x'); void globalThis.localStorage;",
        ].join('\n')
      )
    ).toEqual([
      '1: fetch',
      '2: .electronAPI',
      '3: EventSource',
      '4: download',
      '8: window.fetch',
      '8: globalThis.localStorage',
    ]);
  });
});
