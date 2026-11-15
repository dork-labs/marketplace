# Pitfalls: things that pass your tests and fail in DorkOS

## 1. Extension `.ts` files compile as TSX

DorkOS compiles `.ts` files, server files included, as TSX. A generic arrow function
parses as a JSX tag and breaks the build:

```ts
// Breaks in DorkOS
const first = <T>(items: T[]) => items[0];

// Works
function first<T>(items: T[]): T | undefined {
  return items[0];
}
```

`node --test` or `tsc` on the same file passes, so only DorkOS shows the error, often only
in the server log. Use plain `function` declarations for generics. If the app has its
own tests, add one that fails on a generic arrow (a grep for `= <` followed by an
identifier and `>(` is enough).

## 2. Untyped tool inputs are refused, after approval

Every agent tool's `inputSchema` must be closed: each object sets
`"additionalProperties": false`, and every field has a type. No `patternProperties`,
`propertyNames` or `$ref`. A field with no type, or an open map, is refused when the
server registers its handlers. That happens at start, after the person approved, so:

- the manifest loads and the app shows "compiled",
- `test_extension` can still pass,
- the server doesn't start, and one refused tool can stop the whole server.

For a value that may be a map or any shape, take it as a JSON string and parse it in the
handler. After install, check `serverStatus: active` and each tool's `status: active`.

`act` and `destructive` tools also need `approvalDisplayFields`, so the person sees what
they're approving.

## 3. "compiled" isn't "started"

`create_extension` and `list_extensions` say `compiled` when the bundle builds. A server
that fails at start still says `compiled`. Read `serverStatus`, each tool's status,
`get_extension_errors` and the server log. If `get_extension_errors` is empty but
`serverStatus` isn't `active`, trust `serverStatus`.

## 4. UI copy must point at something that exists

Text that sends the person somewhere ("approve it under Needs you", "open Settings →
Keys", "click Sync") must match the real state the app is in. An empty state that
points at a card or button that isn't there is a bug. Check each such line against the
app in that exact state (empty, loading, error, full) before you hand it over.

## 5. Small things

- Client code can't import npm packages like `lucide-react`. Inline small SVGs.
- `registerComponent` options: `label` names a right-panel tab; the host draws the tab
  strip and header, so render only the body.
- Subscribing to events needs `capabilities.events` in the manifest; undeclared kinds are
  dropped.
- Agent tool names are lowercase words joined by single underscores, and agents see them
  as `ext_<id with - as _>__<name>`. Keep the whole thing within 64 characters.
- Bump `version` on every change, so the person and the extension list can tell builds
  apart.
