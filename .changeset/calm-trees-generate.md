---
"effect": patch
---

Add the experimental Schema-first `effect/unstable/arbitrary/Arbitrary` module for native, interruptible sampling and
property checking without fast-check. The initial implementation supports bounded discards, shrinking, replay, and
recursive and mutually recursive Schemas.

Add the experimental `Schema.Annotations.toCodecArbitrary` hooks. Declarations can provide a Schema Link optimized for
generation, while filters can contribute native semantic constraints independently from the legacy fast-check
annotations. The callback receives a closed palette of constraint-aware Schema factories for Effect-owned built-ins.
JSON, RegExp, URL, Date, BigDecimal, date-time, time-zone, byte-array, and collection declarations use these Links for
constructive generation without exposing an arbitrary builder, registry, or second AST.

Change `Schema.Annotations.ToArbitrary.GenerationConstraint.patterns` to retain each regular expression as
`{ source, flags }`. Legacy fast-check derivation continues to consume the source, while native derivation preserves the
complete regular-expression semantics.

Migrate `TestSchema.Asserts.verifyLosslessTransformation` and `TestSchema.Asserts.arbitrary().verifyGeneration` to the
native runner. Both methods now accept native check options directly, bound unsuccessful generation, and include the
minimized counterexample and replay token in property failures.
