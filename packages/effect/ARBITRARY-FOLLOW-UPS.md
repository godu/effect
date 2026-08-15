# Native Arbitrary Follow-ups

The native Schema-first Arbitrary implementation is complete. The following optimizations and extensions should be
evaluated together against correctness, counterexample quality, runtime performance, and bundle size rather than
implemented independently:

- compare the current `Sample` tree with trace-informed shrinking and private structural spans;
- evaluate private finite-domain metadata for constructive `unique` generation;
- add structured discard reasons and runner health diagnostics;
- evaluate automatic persistence and reuse of concrete counterexamples;
- review boundary-oriented distributions across the complete constructor catalog;
- profile and optimize generic decoded-collection Links, including the measured `Array<number>` to `Uint8Array`
  conversion, without adding a declaration-specific generator path;
- profile generic declaration-Link compilation and per-sample target validation for `BigDecimal`, date-time, and
  time-zone sources before considering any specialized native path.

The current public API and migration guidance are documented in [ARBITRARY.md](ARBITRARY.md) and
[ARBITRARY-MIGRATION.md](ARBITRARY-MIGRATION.md).
