---
"@effect/vitest": patch
"effect": patch
---

Add the experimental Schema-first `effect/unstable/arbitrary/Arbitrary` module for native generation without
fast-check. `Arbitrary.schema` derives an opaque arbitrary from the decoded Schema `Type`, `Arbitrary.sampleEffect`
provides interruptible sampling with typed exhaustion, and `Arbitrary.checkEffect` returns structured property results.
The initial implementation supports bounded discards, shrinking, replay, and recursive and mutually recursive Schemas.
`Arbitrary.isArbitrary` identifies values through the module's nominal protocol.

Add `Arbitrary.map`, `Arbitrary.filter`, `Arbitrary.filterMap`, and `Arbitrary.Union` for composing derived Arbitraries
without exposing a second catalog of primitive constructors. Filtering remains bounded and promotes valid shrink
descendants through rejected nodes. `Union` uses the same budget, selection, and cross-branch shrinking policy as
`Schema.Union`. Arbitrary values implement `Pipeable` for composition with data-last combinators.

Add a public Schema-local `arbitrary` annotation for application-owned replacement distributions. Its factory is
evaluated eagerly during derivation, all checks on the annotated node remain authoritative, and recursive replacement
factories are rejected explicitly. The compiler resolves the outermost factory in a check chain and supports clearing
an inner override with `arbitrary: undefined`.

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

Use the Arbitrary runner for all `@effect/vitest` property tests. Property inputs may combine Schemas and Arbitraries,
and check options are available through `arbitrary`. Raw fast-check arbitraries and the `fastCheck` options object are
no longer supported.

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
| 32 recursive samples                |  112 µs |     143 µs |               0.78x |
| 128 constrained strings             | 48.8 µs |     700 µs |               0.07x |
| 128 bounded numbers                 | 20.7 µs |    68.0 µs |               0.30x |
| 128 `Uint8Array` samples            | 81.1 µs |     103 µs |               0.79x |
| 128 `BigDecimal` samples            | 63.3 µs |    67.1 µs |               0.94x |
| 128 `DateTime.Utc` samples          | 53.8 µs |    71.8 µs |               0.75x |
| 128 named time zones                | 26.2 µs |    51.5 µs |               0.51x |
| 128 time zones                      | 31.7 µs |    63.0 µs |               0.50x |
| 128 zoned date-times                |  116 µs |     129 µs |               0.90x |
| 32 samples through Schema filter    | 45.0 µs |    63.9 µs |               0.70x |
| 32 unique arrays                    |  123 µs |     149 µs |               0.82x |
| 128 literal samples                 | 3.68 µs |    39.6 µs |               0.09x |
| 128 mapped samples                  | 12.8 µs |    58.1 µs |               0.22x |
| 128 samples through passing filter  | 12.4 µs |    57.5 µs |               0.22x |
| 32 samples through selective filter | 39.8 µs |    69.5 µs |               0.57x |
| 128 `filterMap` samples             | 31.5 µs |    73.3 µs |               0.43x |
| 128 `Union` samples                 | 9.83 µs |    51.5 µs |               0.19x |
| 128 Schema-local `Person` samples   | 25.7 µs |    81.0 µs |               0.32x |
| Passing property, 100 runs          | 27.3 µs |    43.0 µs |               0.64x |
| `TestSchema`, 100 generations       | 35.0 µs |    49.6 µs |               0.70x |
| First failure plus one shrink       | 1.28 µs |    9.28 µs |               0.14x |
| Replay recorded failure             | 1.22 µs |    6.82 µs |               0.18x |

Cold recursive derivation is not included because the native fixture constructs and compiles a Schema, while the
fast-check fixture constructs a hand-written arbitrary; it is not a like-for-like warm-generator comparison.

Add a guide for the native module and a migration guide from the fast-check bridge published in `effect@4.0.0-rc.109`.
