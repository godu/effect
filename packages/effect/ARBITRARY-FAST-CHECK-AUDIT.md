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
work-bounded shrinking. There is no remaining known numeric correctness blocker. Catalog coverage, constructive
strings and patterns, stack safety, mutable-value semantics, and statistical quality still prevent replacement.

## Decision matrix

| Area                 | fast-check v4 technique                                                                                                                  | Native POC                                                                                               | Assessment                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attempt isolation    | Jumps the PRNG before each toss, so each run has a reproducible position                                                                 | Derives an independent state from `(seed, attempt)`                                                      | Keep native; it gives direct random access for replay. Attribution added because the isolation goal is shared.                                                                |
| Replay               | Stores seed plus a colon-separated initial/shrink path and can start at that path                                                        | Copyable opaque string stores seed, attempt, size and shrink indices                                     | Resolved. Keep the coordinates private and retain the explicit replay-mismatch result.                                                                                        |
| Integer generation   | Usually samples the full bounded range; periodically biases toward zero and boundaries                                                   | Uses exact rejection sampling over safe-integer ranges; unbounded values retain a size-local range       | Unbiased full-range selection is resolved. Do not clone the exact bias schedule; any edge-case injection remains an explicit Effect distribution decision.                    |
| Integer shrinking    | Halves toward zero or the nearest bound and records the closest known passing value as context; includes a last-chance retry             | Retains the closest passing value in the private sample tree and converges by halving                    | Resolved. A permanent test for `n < 10` over `0...100` reaches the local boundary `10`.                                                                                       |
| `BigInt` generation  | Uses `pure-rand`'s arbitrary-width `uniformBigInt`                                                                                       | Draws arbitrary-width unsigned limbs and rejects values outside the exact interval width                 | Resolved. Bounds beyond finite `number` width are covered by a permanent test.                                                                                                |
| `Number` / double    | Maps every IEEE-754 double except NaN to an ordered bigint index; handles `-0`, subnormals, infinities and exact excluded bounds         | Uses a monotone 64-bit index for constrained intervals and contextual shrinking over that index          | Constraint correctness is resolved. Permanent tests cover signed zero, subnormals, finite extremes, infinities, adjacent exclusive bounds, NaN, and local shrink boundaries.  |
| Arrays               | Applies length shrinking before element shrinking; tracks per-element contexts; avoids deep recursive materialization                    | Lazily emits structural shrinking before child shrinking                                                 | Direction is good and attribution added. Add deep stack-safety and adversarial shrink tests.                                                                                  |
| Union / frequency    | Can shrink from a selected branch to the preferred first branch with `withCrossShrink`; depth increases preference for the base branch   | Selects affordable branches uniformly and lazily prepends a shrink toward the lowest-cost productive one | Resolved for structurally cheaper branches. A recursive nullable node now shrinks to `null`; equal-cost branch policy remains intentionally unspecified.                      |
| Recursive generation | Uses shared depth contexts and progressively biases toward the first/base branch                                                         | Computes SCCs and a least fixed point for finite productivity, then shares a complexity budget           | Keep native. It gives a stronger derivation-time guarantee and handles mutual recursion without exposing depth identifiers.                                                   |
| Uniqueness           | Uses specialized set builders, bounded consecutive duplicate failures and uniqueness-preserving shrink cleanup                           | Uses `Effect.Equal`, a linear scan per candidate and ten retries per position                            | Correct semantics, but quadratic. Add hash/set-backed builders for equality modes that support them and make the retry bound capacity-aware. Attribution added.               |
| Filters              | `Arbitrary.filter` retries internally until it finds a value and filters shrink streams                                                  | Generation returns `Discarded`; runner enforces a global bound; invalid shrink nodes promote descendants | Native is safer for Schema. Keep bounded exhaustion and descendant promotion.                                                                                                 |
| Strings              | Generates printable ASCII graphemes by default, shrinks length and character units, and occasionally injects dangerous JS property names | Generates printable ASCII code units and shrinks length only                                             | Missing professional coverage: add character shrinking and a small Effect-owned edge-case corpus such as `__proto__`, `constructor`, empty and whitespace/control boundaries. |
| Regex constraints    | Parses regexes to an AST, generates constructively, aggregates adjacent constants and retains a final length filter                      | Pattern metadata is collected but not used constructively yet                                            | Major catalog item. Porting or independently implementing a supported regex subset needs its own scope and attribution/licence review.                                        |
| Hot paths            | Contains dedicated sync loops, avoids allocations and tests stack safety at depths beyond the JS call stack                              | Uses `Effect.*Eager` in many compiler paths and lazy `Pull`, but lacks adversarial depth tests           | Add stack-safety and allocation benchmarks before expanding the catalog.                                                                                                      |

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
arithmetic midpoint. `NaN` remains an explicitly injected case for unconstrained `Number` and shrinks through the
ordinary target. The unconstrained common-value branch retains its existing size-local arithmetic distribution; moving
that branch to ordered-index selection or adding boundary frequencies remains a separate distribution decision.

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

Effect should own a smaller policy tied to Schema domains. The contract should promise neither exact frequencies nor
fast-check's run-dependent bias schedule. What matters is that ordinary sampling covers representative values while a
bounded fraction of attempts target boundaries and runtime-sensitive strings.

### Collection size and recursion interaction

fast-check treats large collection length as additional recursion depth, so a large array tends to contain shallower
children. Its
[`ArrayArbitrary`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/ArrayArbitrary.ts)
also separates biasing the length from biasing the items.

Effect's shared cost budget is a better Schema-level foundation, but the chosen collection cardinality should reserve
or partition child cost before generation. The POC already does this for later siblings. Permanent tests should cover
wide recursive arrays and records, not only depth.

### Stack safety and mutable values

fast-check has explicit end-to-end tests that shrink arrays and tuples much deeper than the JavaScript call stack. The
native `Pull` carrier is lazy and the runner loop is iterative, which is promising, but recursive sample construction
and codec descendant promotion still need adversarial tests.

fast-check also tracks cloneable values so property mutation does not contaminate later reads or shrink context; see
[`Value`](https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/check/arbitrary/definition/Value.ts).
The Schema-first API currently returns values directly. Before integrating with a general test runner, decide whether
mutation is unsupported, values are regenerated before every evaluation, or selected mutable built-ins provide a clone
policy. Silent reuse is unsafe.

## Techniques intentionally not copied

- The exact `runIdToFrequency` bias schedule is an engine detail and would make Effect distributions track fast-check.
- `DepthIdentifier` and mutable depth contexts are unnecessary because the Schema compiler owns a complete graph and
  SCC metadata.
- `Arbitrary.filter`'s unbounded internal retry is inappropriate for Schema; explicit `Discarded` plus bounded
  exhaustion is safer.
- `canShrinkWithoutContext` exists largely for user-supplied examples and fast-check's public arbitrary protocol. It is
  unnecessary while Effect exposes no arbitrary constructors or examples option.
- fast-check's clone protocol should not be copied before Effect decides the public semantics of property mutation.
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
- lazy union cross-shrinking toward the lowest-cost productive branch;
- arbitrary-width `BigInt` rejection sampling following `pure-rand`'s technique;
- constructive uniqueness with bounded duplicate retry.

The SCC/productivity algorithm, reserved shared budget, bounded attempt model, effectful descendant promotion, and
Effect runner semantics are not derived from fast-check and do not receive fast-check attribution.

## Recommended order of work

The completed hardening items are arbitrary-width `BigInt`, unbiased safe integers, ordered IEEE-754 generation and
shrinking, lower-cost union cross-shrinking, copyable replay, and evaluation-bounded shrinking. The remaining order is:

1. Add character shrinking, dangerous-string slices, wide/deep stack-safety tests, mutation tests, and statistical
   smoke tests.
2. Only then add specialized Date, URL, RegExp, BigDecimal, bytes, time-zone, and date-time recipes.

Distribution changes in steps 1–2 remain architectural decisions. They should be benchmarked and approved rather than
silently selected while fixing the correctness blockers.
