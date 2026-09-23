/**
 * In-process tests for the dependency-free config checker behind
 * `scripts/validate-config.ts`. The command-line behaviour is covered in
 * `scripts-cli.test.ts`; these tests reach shapes the committed
 * `config.schema.json` does not contain today through the `validateAgainst`
 * seam, so the checker is correct before the schema grows into them.
 */

import { describe, expect, it } from 'vitest';
import { validateAgainst, validateConfig, type SchemaNode } from '../scripts/validate-config.ts';

/** A closed object schema with one property of the given type. */
function closedObject(property: string, type: string): SchemaNode {
  return {
    type: 'object',
    properties: { [property]: { type } },
    additionalProperties: false,
  };
}

describe('validateAgainst — unknown keys inside anyOf', () => {
  // `x` is either null or a closed object. The config gives the object form
  // plus a key the object does not declare.
  const schema: SchemaNode = {
    type: 'object',
    properties: { x: { anyOf: [{ type: 'null' }, closedObject('a', 'string')] } },
    additionalProperties: false,
  };
  const config = { x: { a: 'set', extra: 1 } };

  // An unknown key is a warning, not an error, so it must not disqualify the
  // object branch. Fails if a branch's warnings are counted against it: no
  // branch would match and the config would get an anyOf error.
  it('a branch whose only findings are warnings still matches', () => {
    expect(validateAgainst(config, schema).errors).toEqual([]);
  });

  // The matching branch's warnings are the ones the operator needs to see.
  // Fails if they are dropped once the branch is found to match.
  it("carries the matching branch's warnings into the report", () => {
    expect(validateAgainst(config, schema).warnings).toEqual([
      {
        path: '/x/extra',
        message: 'unknown property "extra" is ignored (check the spelling, or remove it)',
      },
    ]);
  });

  // Only the branch that matched speaks. A branch that failed on a real error
  // may have seen the same unknown key; reporting it too would duplicate the
  // warning. Fails if a failed branch's warnings leak into the report.
  it('drops the warnings of a branch that did not match', () => {
    const twoObjects: SchemaNode = {
      anyOf: [closedObject('a', 'number'), closedObject('a', 'string')],
    };
    expect(validateAgainst({ a: 'set', extra: 1 }, twoObjects)).toEqual({
      errors: [],
      warnings: [
        {
          path: '/extra',
          message: 'unknown property "extra" is ignored (check the spelling, or remove it)',
        },
      ],
    });
  });
});

describe('validateConfig — local-only keys in the committed config', () => {
  // `secrets` belongs in the gitignored config.local.json. In config.json it is
  // still only a warning (an unknown key never condemns the file), but the
  // message has to say what is wrong: credentials in a committed file. Fails if
  // it falls back to the generic "unknown property" wording.
  it('names a top-level secrets block as credentials in the wrong file', () => {
    const report = validateConfig({ secrets: { trackerToken: 'x' } });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      {
        path: '/secrets',
        message:
          'credentials never go in the committed config.json; move "secrets" to config.local.json (gitignored). Flow ignores it here',
      },
    ]);
  });

  // The special case is the top-level block config.local.json defines, not the
  // word anywhere. Fails if a nested key named `secrets` gets the credentials
  // message.
  it('keeps the generic message for a nested key that happens to be named secrets', () => {
    const report = validateConfig({ gates: { secrets: true } });
    expect(report.warnings).toEqual([
      {
        path: '/gates/secrets',
        message: 'unknown property "secrets" is ignored (check the spelling, or remove it)',
      },
    ]);
  });
});
