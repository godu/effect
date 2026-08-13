---
"effect": patch
---

Add the experimental Schema-first `effect/unstable/arbitrary/Arbitrary` module for native, interruptible sampling and
property checking without fast-check. The initial implementation supports bounded discards, shrinking, replay, and
recursive and mutually recursive Schemas.

Change `Schema.Annotations.ToArbitrary.GenerationConstraint.patterns` to retain each regular expression as
`{ source, flags }`. Legacy fast-check derivation continues to consume the source, while native derivation can preserve
the complete regular-expression semantics.
