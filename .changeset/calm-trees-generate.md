---
"@effect/vitest": patch
"effect": patch
---

Add the experimental Schema-first `effect/unstable/arbitrary/Arbitrary` module for native generation without
fast-check. `Arbitrary.schema` derives an opaque arbitrary from the decoded Schema `Type`, `Arbitrary.sample` provides
interruptible sampling with typed exhaustion, and `Arbitrary.check` returns structured property results. The initial
implementation supports bounded discards, shrinking, replay, and recursive and mutually recursive Schemas.

Add the experimental `Schema.Annotations.toCodecArbitrary` hooks. Declarations can provide a Schema Link optimized for
generation, while filters can contribute native semantic constraints. The callback receives a closed palette of
constraint-aware Schema factories for Effect-owned built-ins. JSON, RegExp, URL, Date, BigDecimal, date-time, time-zone,
byte-array, and collection declarations use these Links for constructive generation without exposing an arbitrary
builder, registry, or second AST.

Remove the fast-check bridge from the `effect` package, including `Schema.toArbitrary`,
`Schema.Annotations.ToArbitrary`, and `effect/testing/FastCheck`. The `effect` package no longer depends on fast-check.

Migrate `TestSchema.Asserts.verifyLosslessTransformation` and `TestSchema.Asserts.arbitrary().verifyGeneration` to the
native runner. Both methods now accept native check options directly, bound unsuccessful generation, and include the
minimized counterexample and replay token in property failures.

Use the native runner for all `@effect/vitest` property tests. Property inputs are now Schemas, and native check options
are available through `arbitrary`. Raw fast-check arbitraries and the `fastCheck` options object are no longer supported.

Before its removal, the materialized fast-check bridge fixture
`schema-toArbitrary-materialized-fast-check.ts` measured 79.00 KB minified and gzipped.

Representative five-round runtime measurements against the former `Schema.toArbitrary` bridge backed by fast-check
4.9.0 are shown below. Values are median latency on Node 24.12.0 and Apple M3; lower is better. Both implementations
validate the same output domains, although their generation distributions are not identical.

| Scenario                      |  Native | fast-check bridge | Native / bridge |
| ----------------------------- | ------: | ----------------: | --------------: |
| 32 recursive samples          |  173 µs |            146 µs |           1.18x |
| 128 constrained strings       | 57.6 µs |            706 µs |           0.08x |
| 128 `Uint8Array` samples      |  139 µs |           98.0 µs |           1.42x |
| Passing property, 100 runs    | 28.4 µs |           42.2 µs |           0.67x |
| First failure plus one shrink | 1.35 µs |           9.16 µs |           0.15x |
| Replay recorded failure       | 1.23 µs |           6.27 µs |           0.20x |

The cold recursive derivation result was statistically inconclusive and is not included in the table.

Add a guide for the native module and a migration guide from the fast-check bridge published in `effect@4.0.0-rc.109`.
