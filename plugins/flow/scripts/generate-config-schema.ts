/**
 * CLI generator: writes the plugin's `config/config.schema.json` from the
 * authoritative Zod schema. Run via `node --experimental-strip-types
 * plugins/flow/scripts/generate-config-schema.ts`.
 *
 * The artifact is the JSON Schema that the plugin's `config/config.json`'s
 * `$schema` points at; this module keeps it in sync with `config-schema.ts`.
 * Prettier formatting lives here (not in the schema builder) so the engine's
 * runtime surface stays free of build-tooling deps; the unit tests import
 * {@link serializeConfigJsonSchema} from this script to assert the committed
 * artifact is in sync.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import prettier from "prettier";
import {
  CONFIG_SCHEMA_RELATIVE_PATH,
  buildConfigJsonSchema,
} from "./config-schema-builder.ts";

// Resolve the artifact relative to THIS script (plugins/flow/scripts/) so it
// lands at plugins/flow/config/config.schema.json regardless of the cwd.
const outputPath = fileURLToPath(
  new URL(CONFIG_SCHEMA_RELATIVE_PATH, import.meta.url),
);

/**
 * Serialize the generated JSON Schema as Prettier-formatted JSON so the
 * committed artifact survives the repo's pre-commit `format` hook unchanged
 * (the hook runs Prettier over staged files). Resolving the repo's Prettier
 * config keeps the on-disk bytes byte-identical and drift-free.
 *
 * @returns The schema as a Prettier-formatted JSON string.
 */
export async function serializeConfigJsonSchema(): Promise<string> {
  const raw = JSON.stringify(buildConfigJsonSchema(), null, 2);
  const config = await prettier.resolveConfig(outputPath);
  return prettier.format(raw, { ...config, parser: "json" });
}

// Only write when invoked directly (not when imported by tests).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  writeFileSync(outputPath, await serializeConfigJsonSchema(), "utf8");
  process.stdout.write(`Wrote ${outputPath}\n`);
}
