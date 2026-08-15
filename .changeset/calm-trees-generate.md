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

Representative five-round runtime measurements against equivalent hand-written fast-check 4.9.0 arbitraries are
shown below. Values are median latency on Node 24.12.0 and Apple M3; lower is better. Both implementations validate the
same output domains, although their generation distributions are not identical.

| Scenario                       |  Native | fast-check | Native / fast-check |
| ------------------------------ | ------: | ---------: | ------------------: |
| 32 recursive samples           |  126 µs |     154 µs |               0.82x |
| 128 constrained strings        | 51.4 µs |     760 µs |               0.07x |
| 128 bounded numbers            | 22.1 µs |    69.3 µs |               0.32x |
| 128 `Uint8Array` samples       | 80.8 µs |    99.8 µs |               0.81x |
| 128 `BigDecimal` samples       | 85.6 µs |    66.4 µs |               1.29x |
| 128 `DateTime.Utc` samples     | 59.3 µs |    73.2 µs |               0.81x |
| 128 named time zones           | 29.6 µs |    51.9 µs |               0.57x |
| 128 time zones                 | 35.6 µs |    63.4 µs |               0.56x |
| 128 zoned date-times           |  121 µs |     132 µs |               0.92x |
| 32 samples through rare filter | 46.0 µs |    65.3 µs |               0.70x |
| 32 unique arrays               |  131 µs |     156 µs |               0.84x |
| 128 literal samples            | 3.73 µs |    39.9 µs |               0.09x |
| Passing property, 100 runs     | 28.0 µs |    42.1 µs |               0.67x |
| `TestSchema`, 100 generations  | 36.9 µs |    44.5 µs |               0.83x |
| First failure plus one shrink  | 1.36 µs |    8.76 µs |               0.16x |
| Replay recorded failure        | 1.24 µs |    6.33 µs |               0.20x |

Cold recursive derivation is not included because the native fixture constructs and compiles a Schema, while the
fast-check fixture constructs a hand-written arbitrary; it is not a like-for-like warm-generator comparison.

Add a guide for the native module and a migration guide from the fast-check bridge published in `effect@4.0.0-rc.109`.
