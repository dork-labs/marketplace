/**
 * JSON Schema generation for the plugin's `config/config.json`.
 *
 * `buildConfigJsonSchema()` bridges the authoritative {@link FlowConfigSchema}
 * Zod source to a JSON Schema (via `z.toJSONSchema`, mirroring
 * `apps/server/src/services/core/config-manager.ts`). The `scripts/`
 * generator and the unit tests both call this so the on-disk artifact stays
 * in lockstep with the Zod source — there is one bridge, never two.
 *
 * Serialization/formatting (Prettier) lives in `scripts/generate-config-schema.ts`,
 * not here, to keep the engine's runtime surface free of build-tooling deps.
 *
 * @module @dorkos/flow/generate-config-schema
 */

import { z } from 'zod';
import { FlowConfigSchema } from './config-schema.ts';

/** Path (relative to a script in `scripts/`) of the generated artifact. */
export const CONFIG_SCHEMA_RELATIVE_PATH = '../config/config.schema.json';

/**
 * Build the JSON Schema for `.agents/flow/config.json` from the authoritative
 * Zod schema. Uses the same `jsonSchema2019-09` target as the `conf` config
 * bridge so the two generators behave identically.
 *
 * The schema describes the file a person writes — the INPUT to
 * `FlowConfigSchema.parse` — not the resolved config it returns (DOR-2246).
 * With `io: 'output'` (Zod's default) every `.default(...)` field comes out
 * `required`, because it is always present after parsing. That made every
 * install "invalid" the day a new defaulted field shipped, although the loader
 * reads such a file fine. `validate-config.ts` and editors both check against
 * this artifact, so it has to accept what the parse accepts.
 *
 * One deliberate difference from the input type stays: Zod's input mode drops
 * `additionalProperties: false` from every non-strict object, because Zod
 * silently strips unknown nested keys. A stripped key is a setting that never
 * takes effect, so the `override` keeps `additionalProperties: false`: editors
 * underline a misspelled field, and `validate-config.ts` reports it as a warning
 * at its path (never an error) instead of letting it pass as a silent no-op.
 *
 * @returns The JSON Schema object, ready to serialize.
 */
export function buildConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(FlowConfigSchema, {
    target: 'jsonSchema2019-09',
    io: 'input',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema._zod.def.type === 'object' && zodSchema._zod.def.catchall === undefined) {
        jsonSchema.additionalProperties = false;
      }
    },
  }) as Record<string, unknown>;
}
