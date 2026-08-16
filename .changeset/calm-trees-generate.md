---
"@effect/vitest": patch
"effect": patch
---

Add the experimental Schema-first `effect/unstable/arbitrary/Arbitrary` module for native generation without
fast-check. `Arbitrary.schema` derives an opaque arbitrary from the decoded Schema `Type`, `Arbitrary.sampleEffect`
provides interruptible sampling with typed exhaustion, and `Arbitrary.checkEffect` returns structured property results.
The initial implementation supports bounded discards, shrinking, replay, and recursive and mutually recursive Schemas.

Add `Arbitrary.map`, `Arbitrary.filter`, `Arbitrary.filterMap`, and `Arbitrary.Union` for composing derived Arbitraries
without exposing a second catalog of primitive constructors. Filtering remains bounded and promotes valid shrink
descendants through rejected nodes. `Union` uses the same budget, selection, and cross-branch shrinking policy as
`Schema.Union`. Arbitrary values implement `Pipeable` for composition with data-last combinators.

Add the experimental `Schema.Annotations.toCodecArbitrary` hooks. Declarations can provide a Schema Link optimized for
generation, while filters can contribute native semantic constraints. The callback receives a closed palette of
constraint-aware Schema factories for Effect-owned built-ins. JSON, RegExp, URL, Date, BigDecimal, date-time, time-zone,
byte-array, and collection declarations use these Links for constructive generation, including key-based Map
uniqueness through the palette's Array schema, without exposing an arbitrary
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

| Scenario                            |  Native | fast-check | Native / fast-check |
| ----------------------------------- | ------: | ---------: | ------------------: |
| 32 recursive samples                |  110 µs |     147 µs |               0.75x |
| 128 constrained strings             | 48.8 µs |     707 µs |               0.07x |
| 128 bounded numbers                 | 21.0 µs |    68.6 µs |               0.31x |
| 128 `Uint8Array` samples            | 77.0 µs |    98.0 µs |               0.79x |
| 128 `BigDecimal` samples            | 56.5 µs |    66.4 µs |               0.85x |
| 128 `DateTime.Utc` samples          | 51.0 µs |    70.7 µs |               0.72x |
| 128 named time zones                | 28.9 µs |    52.2 µs |               0.55x |
| 128 time zones                      | 31.5 µs |    63.4 µs |               0.50x |
| 128 zoned date-times                |  110 µs |     128 µs |               0.86x |
| 32 samples through Schema filter    | 45.9 µs |    64.8 µs |               0.71x |
| 32 unique arrays                    |  125 µs |     151 µs |               0.83x |
| 128 literal samples                 | 3.87 µs |    39.7 µs |               0.10x |
| 128 mapped samples                  | 13.0 µs |    65.8 µs |               0.20x |
| 128 samples through passing filter  | 13.0 µs |    62.0 µs |               0.21x |
| 32 samples through selective filter | 39.4 µs |    64.2 µs |               0.61x |
| 128 `filterMap` samples             | 28.1 µs |    72.6 µs |               0.39x |
| 128 `Union` samples                 | 8.66 µs |    50.6 µs |               0.17x |
| Passing property, 100 runs          | 27.2 µs |    41.8 µs |               0.65x |
| `TestSchema`, 100 generations       | 37.2 µs |    44.7 µs |               0.83x |
| First failure plus one shrink       | 1.33 µs |    9.41 µs |               0.14x |
| Replay recorded failure             | 1.14 µs |    6.38 µs |               0.18x |

Cold recursive derivation is not included because the native fixture constructs and compiles a Schema, while the
fast-check fixture constructs a hand-written arbitrary; it is not a like-for-like warm-generator comparison.

Add a guide for the native module and a migration guide from the fast-check bridge published in `effect@4.0.0-rc.109`.
