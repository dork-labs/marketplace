/**
 * CLI validator for a `/flow` config object — checks it against the committed
 * `config/config.schema.json` JSON Schema using a small, hand-written, recursive
 * JSON-Schema-subset checker. Reads the config from stdin (or `--input <path>`)
 * and emits `{ ok: true, config, warnings }` (the validated config, echoed back)
 * on success or `{ ok: false, errors, warnings }` (one `{ path, message }` per
 * violation) on failure.
 *
 * **An unknown key is a warning, never an error** (the DorkOS config rule from
 * DOR-1221: unknown keys must never condemn the file). The committed schema
 * stays strict — `additionalProperties: false` on every block — so an editor
 * still underlines a typo like `planAproval`; this validator reports that same
 * violation under `warnings`, naming the key and saying it is ignored, and keeps
 * `ok: true`. A setting removed by a later flow therefore never sends an
 * install back to `/flow:init`, and a typo is still surfaced loudly.
 *
 * **This validator deliberately avoids `zod`, so it can run before dependencies
 * are installed.** That is a property of this file, not of the plugin: several
 * other shipped oracles do need `zod` on disk (see `dispatch.ts`). Keeping the
 * config validator dependency-free is what lets it answer "is this config valid?"
 * on a fresh checkout where `npm install --omit=dev` has not run yet.
 *
 * So it imports neither the Zod runtime nor the `config-schema.ts` module — it
 * reads the committed schema artifact as a file and walks it directly. Zod
 * remains the DEV-time source of truth: `config-schema.ts` authors the schema and
 * `generate-config-schema.ts` (dev-only) GENERATES `config.schema.json` from it
 * via `z.toJSONSchema`. This oracle validates against that generated artifact, so
 * the two never drift while this file stays import-free of third-party modules.
 * The artifact describes the parse INPUT, so a field with a default may be absent
 * (DOR-2246); `config-schema.test.ts` checks this verdict against Zod's for the
 * omission of every field. Unknown keys are the one deliberate difference from
 * Zod: its top level is `.strict()`, while this validator only warns.
 *
 * @module @dorkos/flow/cli/validate-config
 */

import { readFileSync } from 'node:fs';
import { invokedDirectly, parseArgs, readRawInput } from './_shared.ts';

const HELP = `validate-config — validate a /flow config object against config/config.schema.json.

Reads a config object as JSON from stdin (or --input <path>).

Writes the result as JSON to stdout:
  { "ok": true,  "config": <the validated config>, "warnings": [...] } // exit 0
  { "ok": false, "errors": [...], "warnings": [...] }                  // exit 1
Each error and warning is { "path": string, "message": string }. A warning is an
unknown key: it is reported and ignored, and never makes the config invalid.

Exit codes: 0 valid | 1 invalid (schema violation or unreadable/non-JSON input).
`;

/** A JSON Schema node — an open bag of keywords; we read the subset we support. */
export type SchemaNode = Record<string, unknown>;

/**
 * Top-level keys that belong only in the gitignored `config.local.json`. Found in
 * the committed `config.json` they are still only a warning (unknown keys never
 * condemn the file), but the message says what is actually wrong: credentials
 * sitting in a file that gets committed.
 */
const LOCAL_ONLY_KEYS: Readonly<Record<string, string>> = {
  secrets:
    'credentials never go in the committed config.json; move "secrets" to config.local.json (gitignored). Flow ignores it here',
};

/** One finding about a config: a precise location plus a human-readable reason. */
export interface ValidationIssue {
  /** JSON-pointer-style location of the offending value (`(root)` at the top). */
  path: string;
  /** What is wrong, in plain language. */
  message: string;
}

/** Everything the validator found, split by whether it condemns the config. */
export interface ValidationReport {
  /** Violations that make the config invalid (wrong type, enum, pattern, bound, missing required field). */
  errors: ValidationIssue[];
  /** Unknown keys: reported, ignored, and never a reason to reject the config. */
  warnings: ValidationIssue[];
}

/** Render a path segment list as a JSON-pointer-style string (`(root)` when empty). */
function pointer(segments: readonly (string | number)[]): string {
  return segments.length === 0 ? '(root)' : `/${segments.join('/')}`;
}

/** Name the JSON type of a value the way the schema's `type` keyword spells it. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Whether `value` satisfies a single JSON-Schema `type` keyword token. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'null':
      return value === null;
    default:
      // An unsupported `type` token: don't manufacture a failure.
      return true;
  }
}

/** Resolve a local `#/$defs/...` `$ref` against the root schema, or `undefined`. */
function resolveRef(ref: string, root: SchemaNode): SchemaNode | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let cursor: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (cursor && typeof cursor === 'object' && part in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor as SchemaNode;
}

/**
 * Recursively validate `value` against `schema`, appending a {@link ValidationIssue}
 * to `report.errors` for each violation and to `report.warnings` for each
 * unknown key (an `additionalProperties: false` hit). Covers exactly the keyword subset `config.schema.json`
 * uses: `$ref`/`$defs`, `anyOf`, `type`, `enum`, `pattern`, `properties`,
 * `required`, `additionalProperties` (false), `items`, `minItems`, and the numeric bounds
 * `minimum` / `maximum` / `exclusiveMinimum` (`exclusiveMaximum` handled too for
 * symmetry). `default` is schema metadata and is intentionally ignored.
 */
function validate(
  value: unknown,
  schema: SchemaNode,
  segments: readonly (string | number)[],
  root: SchemaNode,
  report: ValidationReport
): void {
  const { errors } = report;
  // $ref — resolve into the root schema's $defs and validate against the target.
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, root);
    if (!resolved) {
      errors.push({
        path: pointer(segments),
        message: `unresolvable $ref "${schema.$ref}"`,
      });
      return;
    }
    validate(value, resolved, segments, root, report);
    return;
  }

  // anyOf — valid if the value matches at least one branch; siblings are ignored
  // (in this schema, anyOf nodes carry only a `default` alongside). Unknown keys
  // do not disqualify a branch; the first matching branch's warnings are kept.
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as SchemaNode[];
    const matched = branches.some((branch) => {
      const probe: ValidationReport = { errors: [], warnings: [] };
      validate(value, branch, segments, root, probe);
      if (probe.errors.length > 0) return false;
      report.warnings.push(...probe.warnings);
      return true;
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
  if (typeof type === 'string') {
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
    const ok = allowed.some((entry) => JSON.stringify(entry) === JSON.stringify(value));
    if (!ok) {
      errors.push({
        path: pointer(segments),
        message: `value ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`,
      });
    }
  }

  // pattern — a string must match the schema's regex. Load-bearing since `tracker`
  // became an open adapter slug (F1): `pattern` is the only keyword still holding
  // that field to a shape, so skipping it here would turn the widened schema into
  // no validation at all.
  if (typeof schema.pattern === 'string' && typeof value === 'string') {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push({
        path: pointer(segments),
        message: `value ${JSON.stringify(value)} does not match the required pattern /${schema.pattern}/`,
      });
    }
  }

  // numeric bounds
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({
        path: pointer(segments),
        message: `must be >= ${schema.minimum} (got ${value})`,
      });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({
        path: pointer(segments),
        message: `must be <= ${schema.maximum} (got ${value})`,
      });
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      errors.push({
        path: pointer(segments),
        message: `must be > ${schema.exclusiveMinimum} (got ${value})`,
      });
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      errors.push({
        path: pointer(segments),
        message: `must be < ${schema.exclusiveMaximum} (got ${value})`,
      });
    }
  }

  // object — required, declared properties, and additionalProperties: false
  // (an unknown key is a warning, never an error: see the module doc).
  if (matchesType(value, 'object')) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, SchemaNode> | undefined) ?? {};
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
        validate(obj[key], props[key], [...segments, key], root, report);
      } else if (schema.additionalProperties === false) {
        const localOnly =
          segments.length === 0 && Object.prototype.hasOwnProperty.call(LOCAL_ONLY_KEYS, key)
            ? LOCAL_ONLY_KEYS[key]
            : undefined;
        report.warnings.push({
          path: pointer([...segments, key]),
          message:
            localOnly ?? `unknown property "${key}" is ignored (check the spelling, or remove it)`,
        });
      }
    }
  }

  // array — minItems and a single `items` subschema applied to every element.
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({
        path: pointer(segments),
        message: `must have at least ${schema.minItems} item(s) (got ${value.length})`,
      });
    }
    const items = schema.items;
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      value.forEach((element, index) =>
        validate(element, items as SchemaNode, [...segments, index], root, report)
      );
    }
  }
}

/** Load and parse the committed JSON Schema next to this script (no imports). */
function loadSchema(): SchemaNode {
  const schemaUrl = new URL('../config/config.schema.json', import.meta.url);
  return JSON.parse(readFileSync(schemaUrl, 'utf8')) as SchemaNode;
}

/**
 * Check a parsed config object against a given JSON Schema with the
 * dependency-free checker. The seam the tests use to exercise schema shapes the
 * committed artifact does not contain today (an object inside `anyOf`).
 *
 * @param config - The parsed config object to check.
 * @param schema - The root JSON Schema; local `$ref`s resolve against it.
 * @returns The errors (empty when the config is valid) and the unknown-key warnings.
 */
export function validateAgainst(config: unknown, schema: SchemaNode): ValidationReport {
  const report: ValidationReport = { errors: [], warnings: [] };
  validate(config, schema, [], schema, report);
  return report;
}

/**
 * Check a parsed config object against the committed `config.schema.json`.
 * Exported so the tests can compare this verdict with the Zod schema's for
 * every field, in process.
 *
 * @param config - The parsed config object to check.
 * @returns The errors (empty when the config is valid) and the unknown-key warnings.
 */
export function validateConfig(config: unknown): ValidationReport {
  return validateAgainst(config, loadSchema());
}

/**
 * Run the validate-config CLI: parse args, read the config payload, validate it
 * against the committed `config.schema.json` with the dependency-free checker,
 * and write the typed result to stdout. Returns `0` only when the config is
 * valid (warnings alone never fail it); both a schema violation and unreadable /
 * non-JSON input return `1` with `{ ok: false, errors, warnings }`. Human
 * diagnostics, warnings included, go to stderr; the JSON result to stdout.
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
    process.stderr.write(`validate-config: invalid input — ${(err as Error).message}\n`);
    process.stdout.write(
      `${JSON.stringify({ ok: false, errors: [{ path: '(root)', message: `invalid JSON: ${(err as Error).message}` }], warnings: [] })}\n`
    );
    return 1;
  }

  const { errors, warnings } = validateConfig(parsed);
  for (const warning of warnings) {
    process.stderr.write(`validate-config: warning at ${warning.path} — ${warning.message}\n`);
  }

  if (errors.length === 0) {
    process.stdout.write(`${JSON.stringify({ ok: true, config: parsed, warnings })}\n`);
    return 0;
  }

  process.stderr.write(`validate-config: config is invalid — ${errors.length} error(s)\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, errors, warnings })}\n`);
  return 1;
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
