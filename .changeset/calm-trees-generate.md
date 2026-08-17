---
"@effect/vitest": patch
"effect": patch
---

Add the experimental Schema-first `effect/unstable/arbitrary/Arbitrary` module for native generation without
fast-check. `Arbitrary.schema` derives an opaque arbitrary from the decoded Schema `Type`, `Arbitrary.sampleEffect`
provides interruptible sampling with typed exhaustion, and `Arbitrary.checkEffect` returns structured property results.
The initial implementation supports bounded discards, shrinking, replay, and recursive and mutually recursive Schemas.
`SampleError` and `Exhausted` include the effective seed so discarded runs remain reproducible even when the caller did
not provide one. `Arbitrary.isArbitrary` identifies values through the module's nominal protocol.

Add `Arbitrary.map`, `Arbitrary.flatMap`, `Arbitrary.filter`, `Arbitrary.filterMap`, and `Arbitrary.Union` for composing
derived Arbitraries without exposing a second catalog of primitive constructors. Filtering remains bounded and
promotes valid shrink descendants through rejected nodes. `maxShrinks` bounds every inspected shrink candidate,
including candidates rejected before property evaluation, while retaining the best shrunk input found when the
budget is exhausted. `flatMap` provides deterministic dependent generation, source-first shrinking, post-source PRNG
checkpoints, and one shared residual recursion budget. `Union` uses the same budget, selection, and cross-branch
shrinking policy as `Schema.Union`. Arbitrary values implement `Pipeable` for composition with data-last combinators.

Add a public Schema-local `arbitrary` annotation for application-owned replacement distributions. Its factory is
evaluated eagerly during derivation, all checks on the annotated node remain authoritative, and recursive replacement
factories are rejected explicitly. The compiler resolves the outermost factory in a check chain and supports clearing
an inner override with `arbitrary: undefined`.

Add the experimental `Schema.Annotations.toCodecArbitrary` hooks. Declarations can provide a Schema Link optimized for
generation, while filters can contribute native semantic constraints. The callback receives decoded type parameters
and normalized constraints. Built-in Map, Set, HashMap, HashSet, and Chunk representations are implemented privately
by the Arbitrary compiler, including key-based Map uniqueness. Efficient representations
for Effect-owned JSON, RegExp, URL, Date, BigDecimal,
date-time, time-zone, and byte-array declarations remain private to the Arbitrary compiler, keeping their generation
sources and decoders out of production Schema bundles without exposing an arbitrary builder, registry, or second AST.

Add `SchemaGetter.forbiddenEncoding`, a reusable getter for the encode side of decode-only Schema transformations.

Remove the fast-check bridge from the `effect` package, including `Schema.toArbitrary`,
`Schema.Annotations.ToArbitrary`, and `effect/testing/FastCheck`. The `effect` package no longer depends on fast-check.

Migrate `TestSchema.Asserts.verifyLosslessTransformation` and `TestSchema.Asserts.arbitrary().verifyGeneration` to the
native runner. Both methods now accept native check options directly, bound unsuccessful generation, and include the
shrunk input and replay token in property failures.

Use the Arbitrary runner for all `@effect/vitest` property tests. Property inputs may combine Schemas and Arbitraries,
and check options are available through `arbitrary`. Raw fast-check arbitraries and the `fastCheck` options object are
no longer supported. As with the previous fast-check adapter, thrown exceptions, defects, and typed failures from a
property are shrinkable falsifications; Effect interruption remains an interruption.

Optimize `BigDecimal.Order` and `BigDecimal.Equivalence` with a shared hybrid comparator. Ordinary scale differences
use cached, bounded coefficient alignment, while large differences are compared without materializing their decimal
zeroes. `BigDecimal.make` now rejects scales that are not safe integers.

Before its removal, the materialized fast-check bridge fixture
`schema-toArbitrary-materialized-fast-check.ts` measured 79.00 KB minified and gzipped.

Representative five-round runtime measurements against corresponding hand-written fast-check 4.9.0 arbitraries are
shown below. Values are median latency on Node 24.12.0 and Apple M3; lower is better. Both implementations validate the
same output domains, although their generation distributions are not identical. Native speedup is fast-check latency
divided by Native latency, so higher is better.

| Scenario                            | fast-check |  Native | Native speedup |
| ----------------------------------- | ---------: | ------: | -------------: |
| 32 recursive samples                |     150 µs |  104 µs |          1.45x |
| 128 constrained strings             |     742 µs | 49.7 µs |         14.86x |
| 128 bounded numbers                 |    68.9 µs | 21.8 µs |          3.18x |
| 128 `Uint8Array` samples            |    98.3 µs | 74.4 µs |          1.32x |
| 128 `BigDecimal` samples            |    66.6 µs | 56.3 µs |          1.18x |
| 128 `DateTime.Utc` samples          |    71.2 µs | 50.5 µs |          1.42x |
| 128 named time zones                |    52.2 µs | 27.9 µs |          1.85x |
| 128 time zones                      |    63.7 µs | 33.8 µs |          1.89x |
| 128 zoned date-times                |     130 µs |  112 µs |          1.16x |
| 32 samples through Schema filter    |    65.9 µs | 49.4 µs |          1.33x |
| 32 unique arrays                    |     156 µs |  132 µs |          1.18x |
| 128 literal samples                 |    40.0 µs | 3.70 µs |         10.78x |
| 128 mapped samples                  |    59.0 µs | 14.1 µs |          4.21x |
| 128 samples through passing filter  |    58.9 µs | 13.9 µs |          4.23x |
| 32 samples through selective filter |    66.1 µs | 42.9 µs |          1.54x |
| 128 `filterMap` samples             |    75.7 µs | 31.5 µs |          2.40x |
| Filtered failure and shrinking      |    12.7 µs | 7.71 µs |          1.66x |
| 128 `Union` samples                 |    51.1 µs | 9.11 µs |          5.61x |
| 128 Schema-local `Person` samples   |    81.7 µs | 26.9 µs |          3.05x |
| 128 dependent `flatMap` samples     |     125 µs | 67.2 µs |          1.86x |
| `flatMap` failure and shrinking     |    20.1 µs | 6.71 µs |          2.99x |
| Replay `flatMap` shrink path        |    14.3 µs | 6.57 µs |          2.17x |
| Passing property, 100 runs          |    42.3 µs | 27.1 µs |          1.56x |
| `TestSchema`, 100 generations       |    44.5 µs | 35.9 µs |          1.24x |
| First failure plus one shrink       |    8.77 µs | 1.30 µs |          6.75x |
| Replay recorded failure             |    6.35 µs | 1.19 µs |          5.36x |

Cold recursive derivation is not included because the native fixture constructs and compiles a Schema, while the
fast-check fixture constructs a hand-written arbitrary; it is not a like-for-like warm-generator comparison.

Add a guide for the native module and a migration guide from the fast-check bridge published in `effect@4.0.0-rc.109`.
