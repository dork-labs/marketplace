# Conformance harness (`validate-adapter.ts`)

Step 4 in detail. What each invariant asserts is [`<flow-root>/adapters/SPEC.md`](../../../adapters/SPEC.md) section 4; this file is how to pass them.

## Run it

```bash
node --experimental-strip-types "<flow-root>/scripts/validate-adapter.ts" --fixture <fixture.json>
```

- In: a JSON file of the normalized `WorkItem`s your read verbs return.
- Out: `{ "ok": boolean, "failures": [ { "invariant": "INV-n", "detail": "..." } ] }` on stdout.
- Exit `0` is pass, nonzero is fail. Gate on the exit code; read `failures` to fix.

## Build the fixture

Serialize what your adapter's read verbs actually return from a real or recorded tracker, never a hand-written ideal. The harness only checks the cases present, so a thin fixture passes falsely. Cover:

| Case                                                                                        | Exercises |
| ------------------------------------------------------------------------------------------- | --------- |
| One item per `stateCategory`, plus one from the tracker's holding state                     | `INV-1`   |
| Some items with `priority` / `size` / `project` / `createdAt`, some without                 | `INV-2`   |
| A `blockedBy` that resolves in the fixture, and one pointing at a closed or out-of-set item | `INV-3`   |
| Labels from `agent/*`, `stage/*` and `type/*`                                               | `INV-4`   |
| A dispatchable item with `agent/ready` and one without                                      | `INV-5`   |

## Prove it bites

Before trusting green, run a throwaway fixture of broken items; each must fail as named:

- Bare `ready` instead of `agent/ready`: `INV-4` and `INV-5`.
- `priority: 0` on an item with no native priority: `INV-2`.
- A native id in `blockedBy` instead of an `identifier`: `INV-3`.
- A made-up sixth `stateCategory`: `INV-1`.

None fail: your fixture or invocation is wrong. Fix that first.

## The loop

Run, read each failure, fix the **mapping** that produced it, re-run. Never edit the fixture to pass: it is the adapter's output, so that hides a real bug. The only fixture edit allowed adds a missing case. Done means `ok: true`, exit `0`.

| Failure | Usual cause                                                                                                     | Fix                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `INV-1` | Tracker's own state `type` passed through, or the holding state given its own bucket                            | Map every state to one of the five (worksheet 2a); holding state to `backlog`                              |
| `INV-2` | Missing `priority`/`size` defaulted to `0` or smallest; missing `parent` as `""`; a required field dropped      | Missing optional is `undefined`; top-level `parent` is `null`; fill every required field                   |
| `INV-3` | Native node ids in relation arrays, relations parsed from prose, or an out-of-set reference treated as blocking | Map endpoints to `identifier`s; read only the typed graph; out-of-set is non-blocking                      |
| `INV-4` | Native leaves passed straight through (`ready`), the most common adapter bug                                    | Apply the worksheet 2b map in every read verb                                                              |
| `INV-5` | Readiness as a bare leaf or separate field, or the candidate read pre-filtered to `agent/ready`                 | Readiness is only `agent/ready`; return the full candidate set (pre-filtering breaks starvation detection) |

## Versioning

The harness reads output, so it cannot check your declared contract version; keeping it honest is yours. On a contract bump, re-run the harness (the bump rules are SPEC section 5). Pin the version you generated against so drift shows at validation, not at runtime.
