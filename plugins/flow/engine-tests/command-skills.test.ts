import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commands = readdirSync(path.join(root, 'commands')).filter((f) => f.endsWith('.md'));

describe('command-equivalent skill delivery', () => {
  for (const command of commands) {
    it(`${command} remains reachable with only skills installed in the harness`, () => {
      const name = `flow-command-${command.slice(0, -3)}`;
      const entry = path.join(root, 'skills', name, 'SKILL.md');
      expect(existsSync(entry), name).toBe(true);
      const text = readFileSync(entry, 'utf8');
      expect(text).toContain(`name: ${name}\n`);
      // Follow real links: a copied command body would drift at the next edit.
      const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) =>
        path.resolve(path.dirname(entry), m[1])
      );
      expect(links).toContain(path.join(root, 'commands', command));
      expect(links).toContain(path.join(root, 'skills', 'runtime-guide.md'));
      for (const link of links) expect(existsSync(link), link).toBe(true);
      // A skill is not a permission grant or an unattended schedule.
      expect(text).not.toMatch(/^(allowed-tools|schedule):/m);
    });
  }
});
