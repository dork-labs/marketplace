/**
 * The `land` config block (DOR-3262): `land.preArm`, `land.securityPaths` and
 * `land.reviewer`, in the Zod source and the generated JSON Schema alike.
 */

import Ajv2019 from 'ajv/dist/2019.js';
import { describe, expect, it } from 'vitest';

import { FlowConfigSchema, LandSchema } from '../../scripts/config-schema.ts';
import { buildConfigJsonSchema } from '../../scripts/config-schema-builder.ts';

/** The JSON Schema validator (see config-schema.test.ts for the cast). */
function jsonValidator() {
  const Ajv = Ajv2019 as unknown as new (opts: object) => {
    compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown };
  };
  return new Ajv({ strict: false, allErrors: true }).compile(buildConfigJsonSchema());
}

/** Whether Zod and the JSON Schema both accept (or both refuse) `land`. */
function verdicts(land: unknown): { zod: boolean; json: boolean } {
  return {
    zod: FlowConfigSchema.safeParse({ land }).success,
    json: jsonValidator()({ land }),
  };
}

describe('land config', () => {
  it('defaults to no checks, the built-in security paths only, and no reviewer', () => {
    expect(FlowConfigSchema.parse({}).land).toEqual({
      preArm: [],
      securityPaths: { globs: [], pattern: null, label: 'security-reviewed', reviewer: null },
      reviewer: null,
    });
  });

  it('accepts both entry forms and fills the timeout', () => {
    const land = LandSchema.parse({
      preArm: [
        { paths: ['apps/client/**'], run: 'npm run test:browser' },
        { paths: ['apps/**'], wait: 'workflow', workflow: 'browser-shards.yml', timeout: 45 },
      ],
    });
    expect(land.preArm).toEqual([
      { paths: ['apps/client/**'], run: 'npm run test:browser', timeout: 30 },
      { paths: ['apps/**'], wait: 'workflow', workflow: 'browser-shards.yml', timeout: 45 },
    ]);
  });

  it.each([
    ['an entry with no paths', { preArm: [{ paths: [], run: 'npm test' }] }],
    ['an entry with neither form', { preArm: [{ paths: ['a/**'] }] }],
    [
      'an entry with both forms',
      { preArm: [{ paths: ['a/**'], run: 'x', wait: 'workflow', workflow: 'w.yml' }] },
    ],
    ['a misspelt key', { preArm: [{ paths: ['a/**'], runs: 'npm test' }] }],
    ['shell syntax in a command', { preArm: [{ paths: ['a/**'], run: 'npm test && rm -rf /' }] }],
    ['a variable in a command', { preArm: [{ paths: ['a/**'], run: 'echo $HOME' }] }],
    ['a pipe in a command', { preArm: [{ paths: ['a/**'], run: 'npm test | tee x' }] }],
    ['a line break in a command', { preArm: [{ paths: ['a/**'], run: 'npm test\nrm x' }] }],
    [
      'a workflow name with a space',
      { preArm: [{ paths: ['a/**'], wait: 'workflow', workflow: 'browser tests' }] },
    ],
    [
      'a workflow name that is an option',
      { preArm: [{ paths: ['a/**'], wait: 'workflow', workflow: '--repo=x' }] },
    ],
    [
      'a wait other than workflow',
      { preArm: [{ paths: ['a/**'], wait: 'checks', workflow: 'w.yml' }] },
    ],
    ['a timeout of zero', { preArm: [{ paths: ['a/**'], run: 'npm test', timeout: 0 }] }],
    ['a timeout over six hours', { preArm: [{ paths: ['a/**'], run: 'npm test', timeout: 361 }] }],
    ['a reviewer that is not a handle', { reviewer: 'security auditor' }],
    ['a security label with a slash', { securityPaths: { label: 'security/reviewed' } }],
    ['a misspelt land key', { preArms: [] }],
  ])('refuses %s, in Zod and the JSON Schema alike', (_name, land) => {
    expect(verdicts(land)).toEqual({ zod: false, json: false });
  });

  it.each([
    ['a team handle', { reviewer: 'dork-labs/security' }],
    ['an @handle', { reviewer: '@acme-security', securityPaths: { reviewer: 'octocat' } }],
    ['a security pattern', { securityPaths: { pattern: '^apps/server/src/(http|routes)/' } }],
    ['quoted words in a command', { preArm: [{ paths: ['a/**'], run: 'npm run "test browser"' }] }],
  ])('accepts %s, in Zod and the JSON Schema alike', (_name, land) => {
    expect(verdicts(land)).toEqual({ zod: true, json: true });
  });
});
