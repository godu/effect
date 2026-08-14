---
"effect": patch
---

Add the experimental Schema-first `effect/unstable/arbitrary/Arbitrary` module for native, interruptible sampling and
property checking without fast-check. The initial implementation supports bounded discards, shrinking, replay, and
recursive and mutually recursive Schemas.

Add the experimental `Schema.Annotations.toCodecArbitrary` hooks. Declarations can provide a Schema Link optimized for
generation, while filters can contribute native semantic constraints independently from the legacy fast-check
annotations. Built-in JSON, RegExp, URL, Date, byte-array, and collection declarations use these Links for constructive
generation without exposing a builder or a second arbitrary AST.

Change `Schema.Annotations.ToArbitrary.GenerationConstraint.patterns` to retain each regular expression as
`{ source, flags }`. Legacy fast-check derivation continues to consume the source, while native derivation preserves the
complete regular-expression semantics.
