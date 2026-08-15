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

Add `SchemaGetter.forbiddenEncoding`, a reusable getter for the encode side of decode-only Schema transformations.

Remove the fast-check bridge from the `effect` package, including `Schema.toArbitrary`,
`Schema.Annotations.ToArbitrary`, and `effect/testing/FastCheck`. The `effect` package no longer depends on fast-check.

Migrate `TestSchema.Asserts.verifyLosslessTransformation` and `TestSchema.Asserts.arbitrary().verifyGeneration` to the
native runner. Both methods now accept native check options directly, bound unsuccessful generation, and include the
minimized counterexample and replay token in property failures.

Use the native runner for all `@effect/vitest` property tests. Property inputs are now Schemas, and native check options
are available through `arbitrary`. Raw fast-check arbitraries and the `fastCheck` options object are no longer supported.

Optimize `BigDecimal.Order` and `BigDecimal.Equivalence` with a shared hybrid comparator. Ordinary scale differences
use cached, bounded coefficient alignment, while large differences are compared without materializing their decimal
zeroes. `BigDecimal.make` now rejects scales that are not safe integers.

Before its removal, the materialized fast-check bridge fixture
`schema-toArbitrary-materialized-fast-check.ts` measured 79.00 KB minified and gzipped.

Representative five-round runtime measurements against equivalent hand-written fast-check 4.9.0 arbitraries are
shown below. Values are median latency on Node 24.12.0 and Apple M3; lower is better. Both implementations validate the
same output domains, although their generation distributions are not identical.

| Scenario                       |  Native | fast-check | Native / fast-check |
| ------------------------------ | ------: | ---------: | ------------------: |
| 32 recursive samples           |  117 µs |     147 µs |               0.79x |
| 128 constrained strings        | 48.7 µs |     745 µs |               0.07x |
| 128 bounded numbers            | 21.3 µs |    68.6 µs |               0.31x |
| 128 `Uint8Array` samples       | 77.0 µs |    97.8 µs |               0.79x |
| 128 `BigDecimal` samples       | 60.4 µs |    66.6 µs |               0.91x |
| 128 `DateTime.Utc` samples     | 54.5 µs |    70.9 µs |               0.77x |
| 128 named time zones           | 29.2 µs |    51.5 µs |               0.57x |
| 128 time zones                 | 34.2 µs |    63.4 µs |               0.54x |
| 128 zoned date-times           |  115 µs |     130 µs |               0.89x |
| 32 samples through rare filter | 45.6 µs |    64.8 µs |               0.70x |
| 32 unique arrays               |  129 µs |     153 µs |               0.84x |
| 128 literal samples            | 3.70 µs |    39.9 µs |               0.09x |
| Passing property, 100 runs     | 28.4 µs |    42.0 µs |               0.68x |
| `TestSchema`, 100 generations  | 35.6 µs |    44.4 µs |               0.80x |
| First failure plus one shrink  | 1.33 µs |    9.01 µs |               0.15x |
| Replay recorded failure        | 1.22 µs |    6.36 µs |               0.19x |

Cold recursive derivation is not included because the native fixture constructs and compiles a Schema, while the
fast-check fixture constructs a hand-written arbitrary; it is not a like-for-like warm-generator comparison.

Add a guide for the native module and a migration guide from the fast-check bridge published in `effect@4.0.0-rc.109`.
