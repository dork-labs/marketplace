/**
 * CLI validator for a `/flow` config object — checks it against the committed
 * `config/config.schema.json` JSON Schema using a small, hand-written, recursive
 * JSON-Schema-subset checker. Reads the config from stdin (or `--input <path>`)
 * and emits `{ ok: true, config }` (the validated config, echoed back) on success
 * or `{ ok: false, errors }` (one `{ path, message }` per violation) on failure.
 *
 * Zero-runtime-dep by design: the shipped `/flow` plugin runs its oracles via
 * `node --experimental-strip-types` with NO `node_modules`, so a shipped script
 * may not import any npm package. This validator therefore imports neither the
 * Zod runtime nor the `config-schema.ts` module — it reads the committed schema
 * artifact as a file and walks it directly. Zod remains the DEV-time source of
 * truth: `config-schema.ts` authors the schema and `generate-config-schema.ts`
 * (dev-only) GENERATES `config.schema.json` from it via `z.toJSONSchema`. This
 * oracle validates against that generated artifact, so the two never drift while
 * the runtime stays import-free of third-party modules.
 *
 * @module @dorkos/flow/cli/validate-config
 */

import { readFileSync } from "node:fs";
import { invokedDirectly, parseArgs, readRawInput } from "./_shared.ts";

const HELP = `validate-config — validate a /flow config object against config/config.schema.json.

Reads a config object as JSON from stdin (or --input <path>).

Writes the result as JSON to stdout:
  { "ok": true,  "config": <the validated config> }                  // exit 0
  { "ok": false, "errors": [{ "path": string, "message": string }] } // exit 1

Exit codes: 0 valid | 1 invalid (schema violation or unreadable/non-JSON input).
`;

/** A JSON Schema node — an open bag of keywords; we read the subset we support. */
type SchemaNode = Record<string, unknown>;

/** One schema violation: a precise location plus a human-readable reason. */
interface ValidationError {
  /** JSON-pointer-style location of the offending value (`(root)` at the top). */
  path: string;
  /** What is wrong, in plain language. */
  message: string;
}

/** Render a path segment list as a JSON-pointer-style string (`(root)` when empty). */
function pointer(segments: readonly (string | number)[]): string {
  return segments.length === 0 ? "(root)" : `/${segments.join("/")}`;
}

/** Name the JSON type of a value the way the schema's `type` keyword spells it. */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Whether `value` satisfies a single JSON-Schema `type` keyword token. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    default:
      // An unsupported `type` token: don't manufacture a failure.
      return true;
  }
}

/** Resolve a local `#/$defs/...` `$ref` against the root schema, or `undefined`. */
function resolveRef(ref: string, root: SchemaNode): SchemaNode | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let cursor: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (
      cursor &&
      typeof cursor === "object" &&
      part in (cursor as Record<string, unknown>)
    ) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor as SchemaNode;
}

/**
 * Recursively validate `value` against `schema`, appending a `ValidationError`
 * for each violation. Covers exactly the keyword subset `config.schema.json`
 * uses: `$ref`/`$defs`, `anyOf`, `type`, `enum`, `properties`, `required`,
 * `additionalProperties` (false), `items`, `minItems`, and the numeric bounds
 * `minimum` / `maximum` / `exclusiveMinimum` (`exclusiveMaximum` handled too for
 * symmetry). `default` is schema metadata and is intentionally ignored.
 */
function validate(
  value: unknown,
  schema: SchemaNode,
  segments: readonly (string | number)[],
  root: SchemaNode,
  errors: ValidationError[],
): void {
  // $ref — resolve into the root schema's $defs and validate against the target.
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, root);
    if (!resolved) {
      errors.push({
        path: pointer(segments),
        message: `unresolvable $ref "${schema.$ref}"`,
      });
      return;
    }
    validate(value, resolved, segments, root, errors);
    return;
  }

  // anyOf — valid if the value matches at least one branch; siblings are ignored
  // (in this schema, anyOf nodes carry only a `default` alongside).
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as SchemaNode[];
    const matched = branches.some((branch) => {
      const probe: ValidationError[] = [];
      validate(value, branch, segments, root, probe);
      return probe.length === 0;
    });
    if (!matched) {
      errors.push({
        path: pointer(segments),
        message: `value ${JSON.stringify(value)} does not match any of the ${branches.length} allowed schemas`,
      });
    }
    return;
  }

  // type — a structural mismatch makes deeper keyword checks meaningless, so stop.
  const type = schema.type;
  if (typeof type === "string") {
    if (!matchesType(value, type)) {
      errors.push({
        path: pointer(segments),
        message: `expected type "${type}" but got "${typeName(value)}"`,
      });
      return;
    }
  } else if (Array.isArray(type)) {
    if (!(type as string[]).some((token) => matchesType(value, token))) {
      errors.push({
        path: pointer(segments),
        message: `expected one of types ${JSON.stringify(type)} but got "${typeName(value)}"`,
      });
      return;
    }
  }

  // enum — value must deep-equal one allowed entry (entries are JSON-safe).
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    const ok = allowed.some(
      (entry) => JSON.stringify(entry) === JSON.stringify(value),
    );
    if (!ok) {
      errors.push({
        path: pointer(segments),
        message: `value ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`,
      });
    }
  }

  // numeric bounds
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({
        path: pointer(segments),
        message: `must be >= ${schema.minimum} (got ${value})`,
      });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({
        path: pointer(segments),
        message: `must be <= ${schema.maximum} (got ${value})`,
      });
    }
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      errors.push({
        path: pointer(segments),
        message: `must be > ${schema.exclusiveMinimum} (got ${value})`,
      });
    }
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    ) {
      errors.push({
        path: pointer(segments),
        message: `must be < ${schema.exclusiveMaximum} (got ${value})`,
      });
    }
  }

  // object — required, declared properties, and additionalProperties: false.
  if (matchesType(value, "object")) {
    const obj = value as Record<string, unknown>;
    const props =
      (schema.properties as Record<string, SchemaNode> | undefined) ?? {};
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push({
          path: pointer([...segments, key]),
          message: `missing required property "${key}"`,
        });
      }
    }
    for (const key of Object.keys(obj)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        validate(obj[key], props[key], [...segments, key], root, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: pointer([...segments, key]),
          message: `unexpected property "${key}" (additionalProperties: false)`,
        });
      }
    }
  }

  // array — minItems and a single `items` subschema applied to every element.
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push({
        path: pointer(segments),
        message: `must have at least ${schema.minItems} item(s) (got ${value.length})`,
      });
    }
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      value.forEach((element, index) =>
        validate(
          element,
          items as SchemaNode,
          [...segments, index],
          root,
          errors,
        ),
      );
    }
  }
}

/** Load and parse the committed JSON Schema next to this script (no imports). */
function loadSchema(): SchemaNode {
  const schemaUrl = new URL("../config/config.schema.json", import.meta.url);
  return JSON.parse(readFileSync(schemaUrl, "utf8")) as SchemaNode;
}

/**
 * Run the validate-config CLI: parse args, read the config payload, validate it
 * against the committed `config.schema.json` with the dependency-free checker,
 * and write the typed result to stdout. Returns `0` only when the config is
 * valid; both a schema violation and unreadable / non-JSON input return `1` with
 * `{ ok: false, errors }`. Human diagnostics go to stderr; the JSON result to
 * stdout.
 *
 * @param argv - Process args after node + script (`process.argv.slice(2)`).
 * @returns The exit code: 0 valid, 1 invalid.
 */
export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readRawInput(args.inputPath));
  } catch (err) {
    process.stderr.write(
      `validate-config: invalid input — ${(err as Error).message}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ ok: false, errors: [{ path: "(root)", message: `invalid JSON: ${(err as Error).message}` }] })}\n`,
    );
    return 1;
  }

  const schema = loadSchema();
  const errors: ValidationError[] = [];
  validate(parsed, schema, [], schema, errors);

  if (errors.length === 0) {
    process.stdout.write(`${JSON.stringify({ ok: true, config: parsed })}\n`);
    return 0;
  }

  process.stderr.write(
    `validate-config: config is invalid — ${errors.length} error(s)\n`,
  );
  process.stdout.write(`${JSON.stringify({ ok: false, errors })}\n`);
  return 1;
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
