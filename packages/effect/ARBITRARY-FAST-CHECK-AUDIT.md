# Native Arbitrary audit against fast-check v4 and the v5 development branch

## Scope and source baseline

This audit compares the current native Schema-first POC with the official fast-check `v4.9.0` source at commit
[`0d3c2547`](https://github.com/dubzzz/fast-check/tree/0d3c2547dce556f72413607849377530d18ea283). The tag was
also cloned at `/private/tmp/fast-check-v4.9.0` for local inspection. fast-check is MIT licensed; the current POC does
not copy source text, but code comments attribute the non-trivial strategies it follows.

The comparison is about kernel quality, not API parity or identical distributions. fast-check has many years of
hardening around random selection, shrinking and JavaScript edge cases. Effect also deliberately has semantics that
fast-check does not provide, notably bounded Schema-filter exhaustion, Effect interruption and typed property errors,
SCC productivity analysis, and attempt-local random isolation.

## fast-check v5 development branch snapshot — 2026-08-13

The official branch name is [`next-v4_9_0`](https://github.com/dubzzz/fast-check/tree/next-v4_9_0), not
`next_v4-9-0`. The maintainer's official
[`Plans for next major (aka V5)` discussion](https://github.com/dubzzz/fast-check/discussions/6793) identifies the same
architecture work now present on this branch, including native iterators, asynchronous properties by default, ESM
only, and a smaller `Random` surface. At the time of this audit its HEAD is
[`5ebd1f9f`](https://github.com/dubzzz/fast-check/commit/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef), authored on
2026-08-12 at 15:59:54 CEST. It is an exact descendant of `v4.9.0`: the
[`v4.9.0...next-v4_9_0` comparison](https://github.com/dubzzz/fast-check/compare/v4.9.0...next-v4_9_0) contains 42
commits. The development branch and `main` both start from `v4.9.0` but have since diverged, with 42 branch-only and 26
main-only commits in the locally fetched official refs.

This is an actively maintained integration branch, not a stable v5 release contract. The HEAD
[`Build Status` workflow](https://github.com/dubzzz/fast-check/actions/runs/31604379286) succeeds, but there is no
associated integration PR, the package still reports version `4.9.0`, and unreleased changesets mark multiple entries
as major. The snapshot is also visibly transitional: its
[`package.json`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/package.json)
still declares Node `>=12.17.0`, while the package
[`tsconfig.json`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/tsconfig.json)
targets ES2025 and the source relies on the new global `Iterator` helpers. Runtime and TypeScript compatibility fields
should therefore be re-audited from the eventual release rather than treated as settled now.

### Breaking architecture and public API

| Area           | Change in `next-v4_9_0`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Relevance to native Effect Arbitrary                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shrink carrier | Public `Stream` and `stream` are removed. [`Arbitrary.shrink`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/check/arbitrary/definition/Arbitrary.ts) now returns `IteratorObject<Value<T>>`; internal composition uses native iterator helpers through [`utils/iterator.ts`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/utils/iterator.ts). | This independently validates keeping shrink traversal lazy without a full Stream dependency. Effect should keep its private use of the existing `effect/Pull` module, which already integrates Effect interruption and avoids depending on ES2025 iterator helpers. |
| Property model | `property` and the sync/async interface split are removed. [`asyncProperty`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/check/property/AsyncProperty.ts) accepts either sync or async predicates, while [`check` and `assert`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/check/runner/Runner.ts) always return promises.                 | Effect already has one execution carrier for sync and async work, so it does not need the compatibility split that v5 is deleting. This supports `check` returning `Effect` rather than exposing separate runners.                                                  |
| Module surface | Default import and the CommonJS bundle are removed; the package becomes named-export ESM only and drops support for TypeScript below 5.7. Property interfaces are consolidated as `Property` and `PropertyWithHooks`.                                                                                                                                                                                                                                                     | Another reason not to expose fast-check-shaped types from `effect/unstable/arbitrary/Arbitrary`: even the upstream protocol is changing at the major boundary.                                                                                                      |
| Random API     | [`Random`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/random/generator/Random.ts) keeps bounded `nextInt`, `nextBigInt`, cloning and state, but drops `next(bits)`, `nextBoolean`, unbounded `nextInt`, and `nextDouble`. Runner `randomType` no longer accepts string aliases, only a factory.                                                                                                           | This is surface simplification, not a new generation algorithm. The native internal PRNG API is already smaller and should remain private.                                                                                                                          |
| Other removals | `asyncReporter` is folded into a reporter that may return a promise; `defaultReportMessage` absorbs its async variant; `infiniteStream` becomes a constrained, mostly finite `iterator`.                                                                                                                                                                                                                                                                                  | None is required by the current vertical slice. Reporting and generated iterators remain separate future scopes.                                                                                                                                                    |

### Recursion, size and depth

There is no new v5 recursion model in this branch. [`letrec`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/arbitrary/letrec.ts)
still ties mutable lazy arbitraries, [`memo`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/arbitrary/memo.ts)
still passes a decreasing numeric depth, and
[`FrequencyArbitrary`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/arbitrary/_internals/FrequencyArbitrary.ts)
still shares a mutable depth context and increasingly prefers its first branch. Arrays still increase that context by
the amount their generated length exceeds the biased small length; the `Size`, `DepthSize`, default `small`, and depth
bias formulas remain the ones audited in v4.9.0.

Consequently the branch does not add productivity analysis for recursive or mutually recursive graphs. Effect's SCC
least-fixed-point analysis remains the stronger Schema-specific guarantee, and there is no v5 change to port into it.
The only relevant v5 change is the replacement of the lazy shrink `Stream` carrier by an iterator carrier.

### Filters, discards, runner and replay

The two fast-check rejection mechanisms remain distinct:

- [`Arbitrary.filter`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/check/arbitrary/definition/Arbitrary.ts)
  still loops internally without a retry limit until generation satisfies the predicate, then filters the shrink
  iterator.
- `fc.pre` still reports a `PreconditionFailure`; the
  [`Runner`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/check/runner/Runner.ts)
  bounds those skips globally at `numRuns * maxSkipsPerRun`.

The v5 branch therefore does not solve the non-termination risk of a highly selective arbitrary-level filter. Effect
should retain `Discarded` as data and its explicit bounded exhaustion for Schema filters.

Replay also keeps the v4 model. [`Parameters.path`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/check/runner/configuration/Parameters.ts)
is still a colon-separated initial-run/shrink path paired with a seed, and
[`PathWalker`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/check/runner/utils/PathWalker.ts)
still walks exactly those coordinates. No public format or algorithm version was added. This supports the native
decision to expose one opaque copyable replay token without public version fields, while accepting that an unstable
engine change may invalidate old tokens.

### Numeric and collection kernel delta

The inspected integer, `BigInt`, double, float, array and unique-array implementations contain no new generation or
shrinking strategy relative to `v4.9.0`. Their substantive algorithms remain:

- bounded `pure-rand` selection for integers and arbitrary-width `BigInt`;
- ordered numeric indexes for float and double, including NaN as an adjacent synthetic choice;
- contextual halving toward zero or the nearest bound;
- length-first array shrinking, depth impact from wide collections, and set-builder-based uniqueness.

Changes in these files are the mechanical `Stream`-to-`IteratorObject` migration, bigint literal syntax, and the
deliberate removal of captured "safe" globals and several runtime defensive checks. The latter is a v5
simplification/performance tradeoff, not a correctness technique Effect should copy automatically. Most importantly,
the branch reveals no additional numeric edge-case handling missing from the current native hardening pass and does not
require new attribution comments beyond the v4.9.0/pure-rand techniques already attributed.

### Numeric distribution audit — 2026-08-13

fast-check does not have one numeric distribution. It composes an unbiased uniform selection over a discrete domain
with a run-dependent chance of replacing that domain by a small interval around zero or an endpoint. The runner passes
the zero-based run number to the property, and
[`runIdToFrequency`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/check/property/IRawProperty.ts#L92-L95)
computes

```text
F(r) = 2 + floor(log10(r + 1))
```

for non-negative run identifiers. Each numeric arbitrary then takes a biased route when a fresh uniform draw from
`1...F(r)` equals `1`; this is a probability, not a deterministic selection of every `F(r)`-th sample. The schedule is
therefore:

| Runs       | Bias factor | Per-number bias probability |
| ---------- | ----------- | --------------------------- |
| `0...8`    | 2           | 50%                         |
| `9...98`   | 3           | 33.333%                     |
| `99...998` | 4           | 25%                         |
| `999...`   | 5, then 6…  | 20%, then 16.667%…          |

Across the default 100 runs this produces 34.75 biased numeric decisions in expectation; across 1,000 runs it produces
259.7, or 25.97%. Across the 100,000-run diagnostic below, the exact expected count is
`9/2 + 90/3 + 900/4 + 9,000/5 + 90,000/6 + 1/7 = 17,059.642857`, or 17.0596%. `fc.noBias` and the runner's `unbiased`
option remove this route entirely. Sampling uses the same tossing path and therefore applies bias by default; see
[`Sampler`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/check/runner/Sampler.ts)
and
[`Tosser`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/check/runner/Tosser.ts).

When bias is activated,
[`biasNumericRange`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/arbitrary/_internals/helpers/BiasNumericRange.ts)
builds the following inclusive subranges:

- If `min < 0 < max`, it builds `[−L(−min), L(max)]`, `[max − L(max), max]`, and
  `[min, min + L(−min)]`. The first, zero-adjacent range is selected with probability `2/3` conditional on bias; each
  endpoint range is selected with probability `1/6`.
- For a one-sided non-singleton range it builds a range of width `L(max − min) + 1` at each endpoint. The endpoint
  closer to zero is selected with probability `2/3` conditional on bias and the other with probability `1/3`.
- Selection inside the chosen subrange remains uniform. Small domains can make the subranges overlap, so their
  probability masses then add rather than forming a partition.

For `number`-backed integer indexes, `L(v) = floor(log2(v))`. For `bigint`-backed indexes, `L(v)` is the number of
decimal digits in `v`, not a binary logarithm. The latter makes the double ranges deliberately narrower than the float
ranges in practice. [`IntegerArbitrary`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/arbitrary/_internals/IntegerArbitrary.ts#L24-L37)
precomputes these ranges; [`BigIntArbitrary`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/arbitrary/_internals/BigIntArbitrary.ts#L18-L35)
computes them only on a biased draw.

The important consequence for `float` and `double` is that "uniform" means uniform over the monotone IEEE-754
representation index, not uniform over arithmetic distance. Each exponent band contains roughly the same number of
representations, so an unbiased sample broadly spreads mass across exponents. `NaN` is represented by one synthetic
index immediately outside the effective interval. Excluded bounds shift the effective index by one, while
`noDefaultInfinity` and `noNaN` remove those respective choices before numeric bias is applied; see
[`float`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/arbitrary/float.ts)
and
[`double`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/arbitrary/double.ts).

The exact default-domain biased intervals are:

| Arbitrary   | Full discrete domain                                   | Zero-adjacent interval  | Low/high endpoint intervals | Conditional weight  |
| ----------- | ------------------------------------------------------ | ----------------------- | --------------------------- | ------------------- |
| `integer()` | `−2^31...2^31−1`                                       | `−31...30` (62 values)  | 32 / 31 values              | `2/3`, `1/6`, `1/6` |
| `bigInt()`  | `−2^255...2^255−1`                                     | `−77...77` (155 values) | 78 / 78 values              | `2/3`, `1/6`, `1/6` |
| `float()`   | 4,278,190,083 indexes including one `NaN`              | `−30...30` (61 values)  | 31 / 31 values              | `2/3`, `1/6`, `1/6` |
| `double()`  | 18,437,736,874,454,810,627 indexes including one `NaN` | `−19...19` (39 values)  | 20 / 20 values              | `2/3`, `1/6`, `1/6` |

For the default float domain, a biased draw chooses each signed zero and each smallest signed subnormal with
probability `2 / (3 × 61) ≈ 1.093%`; it chooses each `NaN`, infinity and extreme finite endpoint with probability
`1 / (6 × 31) ≈ 0.538%`. For double the corresponding probabilities are `2 / (3 × 39) ≈ 1.709%` and
`1 / (6 × 20) ≈ 0.833%`. These are conditional on bias and must still be multiplied by `1 / F(r)` for a particular
run. The bias is thus a contiguous representation-edge strategy: it reliably promotes signed zeros, subnormals,
infinities, `NaN`, and values adjacent to effective constraints, but it does not maintain a hand-written corpus of
ordinary values such as `1`, `−1`, or powers of two.

#### Deterministic distribution measurement

A local diagnostic sampled 100,000 values with seed `42` from the public native and legacy Schema seams. It is a
snapshot for architectural comparison, not a proposed compatibility contract.

For `Int` constrained to `−1,000,000...1,000,000`, the edge classifiers deliberately match fast-check's exact biased
subranges: low `−1,000,000...−999,981`, zero-adjacent `−19...19`, and high `999,981...1,000,000`. The octiles are
eight equal-width arithmetic intervals across the complete domain.

| Implementation        | Low band | Zero band | High band | Arithmetic octiles (%)                                         |
| --------------------- | -------- | --------- | --------- | -------------------------------------------------------------- |
| Native before bias    | 0.001%   | 0.001%    | 0%        | 12.604, 12.457, 12.477, 12.419, 12.524, 12.676, 12.353, 12.490 |
| Native with bias      | 2.935%   | 11.440%   | 2.829%    | 13.145, 10.271, 10.254, 16.280, 15.962, 10.626, 10.446, 13.016 |
| fast-check v4 integer | 2.721%   | 11.310%   | 2.877%    | 13.213, 10.206, 10.325, 16.178, 15.986, 10.437, 10.440, 13.215 |

The pre-bias native implementation was close to uniform. The approved native policy now has the expected mixture:
unbiased draws preserve broad coverage, while biased draws add mass to the two endpoint octiles and, especially, the
two central octiles containing `−19...19`. It still produced 81,222 distinct values in the 100,000-value sample.

For `Number` constrained to `2...4`, the low and high classifiers are respectively `value <= 2.00002` and
`value >= 3.99998`; the quartiles are `[2, 2.5)`, `[2.5, 3)`, `[3, 3.5)`, and `[3.5, 4]`. The legacy Schema compiler
currently delegates this case to `fc.float`; direct `fc.double` is included to separate that legacy recipe choice from
fast-check's 64-bit arbitrary.

| Implementation                   | Low edge | High edge | Arithmetic quartiles (%)       |
| -------------------------------- | -------- | --------- | ------------------------------ |
| Native before bias               | 0%       | 0.002%    | 25.045, 24.993, 24.878, 25.084 |
| Native with bias                 | 11.438%  | 5.762%    | 32.146, 20.596, 20.597, 26.661 |
| Legacy Schema / fast-check float | 11.347%  | 5.347%    | 32.152, 20.980, 21.036, 25.832 |
| Direct fast-check double         | 11.320%  | 5.586%    | 31.771, 21.013, 20.908, 26.308 |

The native ordered-index distribution is arithmetic-uniform here because `2...4` is one complete binary exponent
band. Both fast-check variants show the one-sided `2/3` versus `1/3` conditional endpoint preference on top of their
uniform representation-index route.

For unconstrained `Number`, the diagnostic counted exact `NaN`, negative infinity, positive infinity, either signed
zero, and finite non-zero values with `abs(value) <= 10^-6`. The categories are intentionally independent and do not
form a complete histogram.

| Implementation                   | `NaN`  | `−Infinity` | `+Infinity` | Signed zero | Tiny non-zero |
| -------------------------------- | ------ | ----------- | ----------- | ----------- | ------------- |
| Native before bias               | 4.185% | 4.198%      | 4.137%      | 0%          | 0%            |
| Native with bias                 | 0.140% | 0.150%      | 0.132%      | 0.585%      | 51.696%       |
| Legacy Schema / fast-check float | 0.097% | 0.087%      | 0.086%      | 0.342%      | 45.742%       |
| Direct fast-check double         | 0.127% | 0.136%      | 0.142%      | 0.592%      | 51.436%       |

The approved implementation removes the ad hoc `1/24` injections and generates the complete non-NaN IEEE-754 domain
through its ordered representation index, with one synthetic NaN choice. The shared bias policy then targets zero,
subnormals and representation endpoints. The current native sample is consequently close to direct fast-check double,
while remaining independently seeded and implemented; 82.667% of its values were in the broad intermediate exponent
range used by the permanent smoke test.

The v5 development branch preserves all these formulas and probabilities. At
[`5ebd1f9f`](https://github.com/dubzzz/fast-check/commit/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef),
the schedule has only moved to
[`ToFrequency.ts`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/check/property/_internals/ToFrequency.ts),
while `BiasNumericRange`, `IntegerArbitrary`, `BigIntArbitrary`, `float`, and `double` retain the v4 generation logic.
The diffs are iterator-carrier changes, bigint literal syntax, and removal of captured global aliases, not distribution
changes. The v5 copies of the float and double end-to-end tests are 98%-similar renames and retain the same assertions;
see the official
[`v4.9.0...next-v4_9_0` comparison](https://github.com/dubzzz/fast-check/compare/v4.9.0...next-v4_9_0).
The branch also resolves fast-check's runtime dependency to the same `pure-rand` 8.4.1 version in its
[`pnpm-lock.yaml`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/pnpm-lock.yaml),
and
[`Tosser`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/check/runner/Tosser.ts)
still jumps the same generator before passing the same run identifier. The v4 observations above therefore apply to
the current v5 branch snapshot; reporting a second execution as an independent v5 measurement would be misleading
when the generating algorithm, random dependency and scheduling are identical.

#### Testing practices worth adopting

fast-check tests this policy at several layers instead of treating a precise output histogram as its public contract:

1. Unit tests inject a fake random source and prove the exact unbiased route, activation draw, preferred-range
   weighting and selected bounds. Separate property tests prove that every computed biased interval stays inside the
   requested domain; see
   [`IntegerArbitrary.spec.ts`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/test/unit/arbitrary/_internals/IntegerArbitrary.spec.ts)
   and
   [`BiasNumericRange.spec.ts`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/test/unit/arbitrary/_internals/helpers/BiasNumericRange.spec.ts).
2. Reusable arbitrary assertions vary seeds, constraints, bias factors and shrink paths to verify determinism, domain
   validity, context-free shrinkability and strict shrink progress; see
   [`ArbitraryAssertions.ts`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/test/unit/arbitrary/__test-helpers__/ArbitraryAssertions.ts).
3. Float and double end-to-end tests compare biased and `noBias` samples over 25,000 runs: every targeted IEEE extreme
   must occur under bias, must not occur in the unbiased sample, and more than half of both samples must remain in broad
   intermediate exponent ranges. This checks bug-finding usefulness without fixing exact percentages; see
   [`DoubleArbitrary.spec.ts`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/test/e2e/arbitraries/DoubleArbitrary.spec.ts)
   and
   [`FloatArbitrary.spec.ts`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/test/e2e/arbitraries/FloatArbitrary.spec.ts).
4. CI chooses and logs a fresh global seed for tests, making invariant tests explore new paths while leaving failures
   reproducible; see the official
   [`build-status.yml`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/.github/workflows/build-status.yml#L288-L301)
   and
   [`vitest.setup.mjs`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/vitest.setup.mjs).

Effect now has deterministic public-seam tests for coarse bucket occupancy, bounded integer and `BigInt` edges, all
nine targeted IEEE-754 extremes, and broad intermediate-domain preservation. They deliberately avoid exact
percentages, which would turn a private search heuristic into an accidental compatibility contract.

#### Resolved Effect decision

The numeric distribution decision is now:

- `Arbitrary` is a bug-finding search strategy rather than a statistically neutral application-data sampler;
- `sample` and `check` share the same generated sequence;
- numeric leaves independently decide whether to use an edge range, avoiding lockstep extreme tuples;
- the v4/v5 run-dependent schedule and numeric range weighting are the initial private, attributed baseline;
- unbounded `Number` uses the complete ordered double domain plus one NaN choice, with no separate `1/24` injection;
- the public API promises validity and reproducibility, not exact distribution percentages or controls.

This is an implementation baseline, not seed or distribution parity with fast-check. It can change while the module is
unstable, provided edge coverage, broad-domain exploration, replay and performance remain measured.

### Effect conclusion from the v5 snapshot

The current design does not need to pivot for fast-check v5. The branch strengthens four decisions already made:

1. keep the arbitrary representation and lazy shrink carrier private;
2. use one Effect-based runner for pure and effectful properties;
3. retain Effect's bounded discard and SCC productivity semantics instead of copying fast-check's filter and depth
   mechanics;
4. treat distribution policy as an Effect decision, because v5 has not replaced the v4 numeric algorithms or bias
   model.

The branch should be checked again at its release candidate or final v5 tag. Until then it is useful architectural
evidence, but not a stable interface to port or target.

## Executive conclusion

The architecture remains viable, but the POC is not ready to replace fast-check. The hardening passes completed
arbitrary-width unbiased `BigInt` selection, unbiased safe-integer selection, exact ordered IEEE-754 `Number`
generation and bounds, context-aware numeric shrinking, lower-cost union cross-shrinking, a copyable replay token, and
work-bounded shrinking. There is no remaining known numeric correctness, edge-coverage, or stack-safety blocker for
the exercised kernel. Catalog coverage and constructive strings and patterns still prevent replacement.

## Decision matrix

| Area                 | fast-check v4 technique                                                                                                                  | Native POC                                                                                                 | Assessment                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attempt isolation    | Jumps the PRNG before each toss, so each run has a reproducible position                                                                 | Derives an independent state from `(seed, attempt)`                                                        | Keep native; it gives direct random access for replay. Attribution added because the isolation goal is shared.                                                                |
| Replay               | Stores seed plus a colon-separated initial/shrink path and can start at that path                                                        | Copyable opaque string stores seed, attempt, size and shrink indices                                       | Resolved. Keep the coordinates private and retain the explicit replay-mismatch result.                                                                                        |
| Integer generation   | Usually samples the full bounded range; periodically biases toward zero and boundaries                                                   | Uses exact rejection sampling plus the private attributed run-dependent edge policy                        | Resolved. Unbounded integers retain a size-local range; constrained intervals preserve broad coverage while targeting zero and both boundaries.                               |
| Integer shrinking    | Halves toward zero or the nearest bound and records the closest known passing value as context; includes a last-chance retry             | Retains the closest passing value in the private sample tree and converges by halving                      | Resolved. A permanent test for `n < 10` over `0...100` reaches the local boundary `10`.                                                                                       |
| `BigInt` generation  | Uses `pure-rand`'s arbitrary-width `uniformBigInt` and biased decimal-digit edge ranges                                                  | Draws arbitrary-width unsigned limbs with rejection and applies the attributed edge ranges                 | Resolved. Permanent tests cover arbitrary-width bounds, zero, both endpoints, and broad-domain uniqueness.                                                                    |
| `Number` / double    | Maps every non-NaN IEEE-754 double to an ordered bigint index and adds one NaN choice                                                    | Uses an independent monotone 64-bit bit-cast index, the same private bias policy, and contextual shrinking | Resolved. Permanent tests cover all nine targeted extremes, broad intermediate values, exact bounds, and local shrinking.                                                     |
| Arrays               | Applies length shrinking before element shrinking; tracks per-element contexts; avoids deep recursive materialization                    | Lazily emits structural shrinking before child shrinking                                                   | Resolved for the exercised carrier: a permanent test traverses 1,000 lazy child shrinks without overflowing.                                                                  |
| Union / frequency    | Can shrink from a selected branch to the preferred first branch with `withCrossShrink`; depth increases preference for the base branch   | Selects affordable branches uniformly and lazily prepends a shrink toward the lowest-cost productive one   | Resolved for structurally cheaper branches. A recursive nullable node now shrinks to `null`; equal-cost branch policy remains intentionally unspecified.                      |
| Recursive generation | Uses shared depth contexts and progressively biases toward the first/base branch                                                         | Computes SCCs and a least fixed point for finite productivity, then shares a complexity budget             | Keep native. It gives a stronger derivation-time guarantee and handles mutual recursion without exposing depth identifiers.                                                   |
| Uniqueness           | Uses specialized set builders, bounded consecutive duplicate failures and uniqueness-preserving shrink cleanup                           | Uses `Hash.hash` buckets, `Effect.Equal` collision checks, and a requested-length consecutive retry bound  | Correct and expected-linear lookup. Numeric edge bias increases duplicates for large fixed unique collections; capacity-aware retry policy remains future work.               |
| Filters              | `Arbitrary.filter` retries internally until it finds a value and filters shrink streams                                                  | Generation returns `Discarded`; runner enforces a global bound; invalid shrink nodes promote descendants   | Native is safer for Schema. Keep bounded exhaustion and descendant promotion.                                                                                                 |
| Strings              | Generates printable ASCII graphemes by default, shrinks length and character units, and occasionally injects dangerous JS property names | Generates printable ASCII code units and shrinks length only                                               | Missing professional coverage: add character shrinking and a small Effect-owned edge-case corpus such as `__proto__`, `constructor`, empty and whitespace/control boundaries. |
| Regex constraints    | Parses regexes to an AST, generates constructively, aggregates adjacent constants and retains a final length filter                      | Pattern metadata is collected but not used constructively yet                                              | Major catalog item. Porting or independently implementing a supported regex subset needs its own scope and attribution/licence review.                                        |
| Hot paths            | Contains dedicated sync loops, avoids allocations and tests stack safety at depths beyond the JS call stack                              | Uses `Effect.*Eager`, lazy `Pull`, iterative graph compilation/SCC analysis and scheduler-aware discards   | Permanent tests cover a 5,000-node SCC, a 10,000-node suspend chain, 1,000 child shrinks and interruption across generation/property/shrink.                                  |

### `RegExp` values versus matching strings

fast-check v4.9.0 exposes
[`stringMatching(regex, { maxLength?, size? }): Arbitrary<string>`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/arbitrary/stringMatching.ts#L29-L46),
not an arbitrary that generates `RegExp` objects. Its
[`fast-check-default` public surface](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/fast-check-default.ts#L350-L374)
exports `stringMatching`, and a source-wide audit found no dedicated `Arbitrary<RegExp>`. Consequently the finite
source and flag catalog in Effect's existing `Schema.RegExp` annotation is an Effect-owned policy, not fast-check
parity.

`stringMatching` is constructive rather than a generate-and-filter wrapper. It tokenizes the supplied regexp, adds
leading or trailing `.*` when the corresponding anchor is absent, clamps the token tree when `maxLength` is specified,
then composes `constant`, `integer`, `string`, `tuple`, `oneof`, and small negative-class filters. The final
`maxLength` filter counts Unicode code points. See the
[`stringMatching` compiler](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/arbitrary/stringMatching.ts#L79-L297),
[`addMissingDotStar`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/arbitrary/_internals/helpers/SanitizeRegexAst.ts#L1-L118),
and
[`clampRegexAst`](https://github.com/dubzzz/fast-check/blob/0d3c2547dce556f72413607849377530d18ea283/packages/fast-check/src/arbitrary/_internals/helpers/ClampRegexAst.ts#L9-L174).
Shrinking is therefore inherited compositionally: repetitions shrink their length and units, ranges shrink through
`integer`, alternatives retain their selected `oneof` branch, and concatenations shrink their tuple children. There
is no separate `RegExp`-object shrinker.

The constructor accepts flags `d`, `g`, `m`, `s`, and `u`, but rejects `i` and `y`. Unicode properties are supported;
word-boundary assertions, lookarounds, and backreferences are tokenized but rejected during compilation. The current
v5 preparation snapshot preserves those semantics and the same public API; its
[`stringMatching` implementation](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/arbitrary/stringMatching.ts#L16-L283)
only differs here through the branch-wide removal of captured safe globals. It likewise exports `stringMatching` and
no dedicated `Arbitrary<RegExp>` from its
[`public entrypoint`](https://github.com/dubzzz/fast-check/blob/5ebd1f9f3c9972ce98acaf6690ca02f88bb341ef/packages/fast-check/src/fast-check.ts#L185-L200).

## Confirmed defects and gaps

### Arbitrary-width `BigInt`

The audited POC computed `width = maximum - minimum + 1n`, converted `width` to `number`, multiplied it by a random
double and converted the result back to `BigInt`. The conversion was both biased beyond 53 significant bits and
invalid once the width became `Infinity`. The permanent regression uses:

```ts
Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: 1n << 1024n })
)
```

The old implementation defected with `RangeError: The number Infinity cannot be converted to a BigInt`. fast-check
avoids both issues by using arbitrary-width rejection sampling in
[`Random.nextBigInt`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/random/generator/Random.ts),
delegating to `pure-rand`'s `uniformBigInt`.

Effect now uses random 32-bit limbs and rejection sampling over the interval bit width. This correction is attributed
next to the implementation because it follows the same principle as `pure-rand`'s MIT-licensed `uniformBigInt`.

### Numeric shrinking needs search context

The audited POC's nearest-zero-or-bound target matched the general strategy of
[`IntegerArbitrary`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/IntegerArbitrary.ts),
but its shrink tree is precomputed as target plus one midpoint. It cannot learn that the target passed and continue the
binary search between that passing value and the current failure.

fast-check's
[`shrinkInteger`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/helpers/ShrinkInteger.ts)
stores the previously tried candidate as context. The native sample tree now carries this private context and includes
the adjacent-value retry without exposing fast-check's class or context representation. The runner still promises only
a locally minimal result according to its shrink order, not a global minimum over the domain.

### Cross-branch shrinking

The audited union compiler forwarded only the chosen child's sample. It therefore had no union-level shrink edge.
fast-check's
[`FrequencyArbitrary`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/FrequencyArbitrary.ts)
can retain a cloned random state for a fallback to the first alternative and can increase the probability of the first
branch as depth grows.

Effect already knows more than a general `oneof`: `minCost` identifies productive base routes. The compiler now lazily
prepends a shrink generated from the lowest-cost member when it is structurally cheaper than the selected member. It
does not adopt fast-check's public `withCrossShrink` or `DepthIdentifier`, and it does not impose an arbitrary order on
equal-cost members.

### IEEE-754 coverage

Arithmetic interpolation does not sample the discrete space of JavaScript doubles uniformly or cover it
systematically. Adding `Number.EPSILON` to implement an exclusive lower bound is also incorrect for most magnitudes;
the next representable value depends on the exponent.

fast-check's
[`double`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/double.ts) maps doubles to
an ordered bigint index and generates over that interval. The associated
[`DoubleHelpers`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/helpers/DoubleHelpers.ts)
handle signed zero, subnormals, finite extremes and infinities.

Effect now uses the same mathematical model with an independent direct 64-bit bit-cast implementation. Inclusive zero
bounds preserve both signed zeros, exclusive bounds move to the exact adjacent representation, finite constraints
exclude infinities constructively, and impossible or NaN bounds fail during derivation. Selection is exact over each
compiled constrained index interval. Shrinking performs its binary search in the same ordered space and remembers the
nearest passing representation, so it can reach a local floating-point failure boundary rather than stopping at an
arithmetic midpoint. For unconstrained `Number`, `NaN` occupies one synthetic index adjacent to the ordinary ordered
domain and shrinks through the ordinary target. The generator applies the shared numeric edge policy across that
extended interval, replacing the former size-local arithmetic branch and separate `1/24` injections.

Safe integers also required a discrete correction. Multiplying a random double by the full safe-integer interval loses
low bits and can make one parity unreachable. The native implementation now partitions the `2^53` possible PRNG
fractions into equal buckets with rejection, falling back to the arbitrary-width `BigInt` selector when the interval is
wider. Permanent tests cover both parities across the complete safe range and reject constraints outside that range.

### Replay usability and shrink accounting

The replay coordinates remain private but are now encoded as an opaque string, so a test-runner failure can print and
copy the token into another invocation. No public `formatVersion` or `algorithmVersion` is exposed, and compatibility
across releases of the unstable module is not promised.

`maxShrinks` now counts every candidate property evaluation, including passing candidates. `Falsified.shrinks` remains
the number of accepted failing descents, which preserves its diagnostic meaning while bounding the runner's actual
work.

## Professional techniques worth adding after blockers

### Edge-case injection independent from shrinking

fast-check does not rely on shrinking alone to reach useful cases. Its numeric bias periodically samples ranges near
zero and both bounds. Its string arrays can inject cached slices containing JavaScript-sensitive names such as
`__proto__`, `constructor`, `toString`, `key`, and `ref`; see
[`SlicesForStringBuilder`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/helpers/SlicesForStringBuilder.ts).

Effect now applies the attributed run-dependent policy privately to `Int`, `BigInt`, and `Number`, while keeping exact
frequencies out of the contract. Runtime-sensitive string slices remain future work.

### Collection size and recursion interaction

fast-check treats large collection length as additional recursion depth, so a large array tends to contain shallower
children. Its
[`ArrayArbitrary`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/ArrayArbitrary.ts)
also separates biasing the length from biasing the items.

Effect's shared cost budget is a better Schema-level foundation, but the chosen collection cardinality should reserve
or partition child cost before generation. The POC already does this for later siblings. Permanent tests should cover
wide recursive arrays and records, not only depth.

### Stack safety and property purity

fast-check has explicit end-to-end tests that shrink arrays and tuples much deeper than the JavaScript call stack. The
native `Pull` carrier is lazy and the runner loop is iterative, which is promising, but recursive sample construction
and codec descendant promotion still need adversarial tests.

fast-check also tracks explicitly cloneable values so their mutation does not contaminate later reads or shrink
context; see
[`Value`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/check/arbitrary/definition/Value.ts).
Effect deliberately does not port that protocol in this slice. Properties must treat generated values as immutable;
the runner does not clone or freeze them. This is documented on the public `check` API because mutation may corrupt
failure reporting, shrinking, or replay.

## Techniques intentionally not copied

- `DepthIdentifier` and mutable depth contexts are unnecessary because the Schema compiler owns a complete graph and
  SCC metadata.
- `Arbitrary.filter`'s unbounded internal retry is inappropriate for Schema; explicit `Discarded` plus bounded
  exhaustion is safer.
- `canShrinkWithoutContext` exists largely for user-supplied examples and fast-check's public arbitrary protocol. It is
  unnecessary while Effect exposes no arbitrary constructors or examples option.
- fast-check's clone protocol is unnecessary under the explicit property-purity contract.
- Exact distribution, seed compatibility, shrink order and identical counterexamples are not parity goals.

## Attribution audit

Attribution comments have been added next to these current techniques:

- attempt isolation corresponding to fast-check's jump-before-toss goal;
- the first-failing-child shrink traversal and sibling-index replay path;
- structural-before-element array shrinking;
- context-aware integer shrinking toward the nearest zero-or-bound target;
- equal-bucket integer rejection sampling following `pure-rand`'s unbiased-selection principle;
- monotone IEEE-754 indexing, exact interval selection, and contextual `Number` shrinking corresponding to
  fast-check's `double` and `DoubleHelpers` model;
- the run-dependent numeric bias schedule, zero/boundary range construction, and conditional range weighting;
- lazy union cross-shrinking toward the lowest-cost productive branch;
- arbitrary-width `BigInt` rejection sampling following `pure-rand`'s technique;
- constructive uniqueness with bounded duplicate retry.

The SCC/productivity algorithm, reserved shared budget, bounded attempt model, effectful descendant promotion, and
Effect runner semantics are not derived from fast-check and do not receive fast-check attribution.

## Recommended order of work

The completed hardening items are arbitrary-width `BigInt`, unbiased safe integers, ordered IEEE-754 generation and
shrinking, lower-cost union cross-shrinking, copyable replay, evaluation-bounded shrinking, cooperative interruption,
and adversarial stack safety. The remaining order is:

1. Add character shrinking and dangerous-string slices.
2. Only then add specialized Date, URL, RegExp, BigDecimal, bytes, time-zone, and date-time recipes.

Further distribution changes in steps 1–2 remain architectural decisions. They should be benchmarked and approved
rather than silently selected while fixing correctness blockers.
