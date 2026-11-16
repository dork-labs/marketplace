# Delivered DorkOS contract proof

This opt-in contributor suite drives the real Flow launcher against DorkOS
v0.135.12, commit `885b00fa627fad4bcefa918a93105d427f1a0f7c` (checked 2026-11-16).
The config refuses another commit or tracked source edits. It resolves workspace
exports to that checkout’s matching source, avoiding stale builds.

Use an owned disposable checkout of that commit. Install its server dependencies
normally, with `pnpm --filter @dorkos/server... install --frozen-lockfile`. Then,
from `plugins/flow`, after its normal `npm ci --include=dev`:

```sh
DORKOS_SOURCE_ROOT=/absolute/path/to/owned/dorkos \
  ./node_modules/.bin/vitest run \
  --config engine-tests/launchers/current-server/vitest.config.ts
```

The suite creates its own data directory, database, agent tokens and account
policy. It clears inherited credentials and redirects home/profile paths before
importing server modules. It does not edit the source checkout or installed Flow.

The actual API middleware chain, MCP authentication, token resolution, gated
registration, start handler, launch policy, session routes, audit and visibility
rules all run. A recording runtime and the final turn-dispatch sink replace
inference. Accepted runtime identity comes from the real persisted binding and
actual dispatch arguments; accepted billing comes from the dispatched account
hint. No provider binary or paid inference runs.

The ordinary unit suite remains independent of DorkOS source. This suite does not
claim to test provider execution, transport setup in production startup, or
prepared-start behavior.
