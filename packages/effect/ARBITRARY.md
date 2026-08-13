# Toward an engine-agnostic `effect/Arbitrary`

## Status

Design research only. This note does not propose a final API and does not change the implementation.

The post-grilling implementation decisions are consolidated in
[`ARBITRARY-NATIVE-PLAN.md`](ARBITRARY-NATIVE-PLAN.md). Where this research explores a broader public construction
interface, the native plan supersedes it.

## Goal

Design an Effect-owned abstraction for generated test data, sampling, and property checking without making the public
contract a restatement of `fast-check` v4. The immediate implementation may use `fast-check` v4 privately, but must be
replaceable by v5 or another engine without changing schema annotations or the public model.

The central conclusion is that an engine-neutral `Arbitrary<A>` should be an **opaque description of a generated
domain**, not a public generator/shrinker protocol. Construction, sampling, property execution, replay, and reporting
are related but distinct interfaces.

## Existing coupling in Effect

The current implementation exposes several `fast-check` implementation concepts:

- `Schema.Arbitrary<T>` is a factory from the `fast-check` module to `FastCheck.Arbitrary<T>`.
- declaration annotations receive the `fast-check` module and return `FastCheck.Arbitrary<T>` or a derivation;
- recursive derivation publicly carries `terminal`, `maxDepth`, and `DepthIdentifier`;
- `effect/testing/FastCheck` re-exports the library;
- `@effect/vitest` constructs and runs `fast-check` properties directly.

These are stronger dependencies than the desired semantic contract. In particular, `fast-check`'s public
`Arbitrary<T>` is itself a low-level engine protocol: it exposes `generate(Random, biasFactor)`, opaque shrink context,
and `shrink(value, context)`. Its `map` accepts an optional reverse mapping to support shrinking values supplied outside
normal generation. Those details should not become Effect's compatibility surface
([fast-check `Arbitrary`](https://fast-check.dev/docs/api/classes/Arbitrary/)).

## Comparison

| System        | Public generated-domain model       | Shrinking model                                                     | Generation effects                            | Size and recursion                                                      | Replay                                     |
| ------------- | ----------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| fast-check v4 | `Arbitrary<A>` protocol             | generator returns a value plus opaque context; arbitrary shrinks it | pure                                          | local constraints plus size, depth budget, and shared depth identifiers | numeric seed plus shrink path              |
| QuickCheck    | `Gen<A>` plus `Arbitrary` typeclass | separate `shrink: A -> List<A>`                                     | pure `Gen`; effectful properties are separate | explicit reader-like size; recursive generators manage it               | seed plus size                             |
| Hedgehog      | `GenT<M, A>`                        | generator produces a shrink tree                                    | generator transformer permits effects         | size-aware ranges; `recursive` separates base and recursive branches    | seed, size, skip, and shrink progress      |
| Hypothesis    | opaque `SearchStrategy<A>`          | runner shrinks an internal choice sequence and reruns the strategy  | strategy draws are controlled by runner       | local bounds; `recursive` uses a leaf budget                            | versioned opaque blob and example database |
| Rust proptest | `Strategy<A>`                       | each generation produces a stateful `ValueTree<A>`                  | pure                                          | local ranges; recursion has distinct depth and target-size controls     | algorithm/seed and persisted engine token  |
| ZIO Test      | `Gen<R, A>`                         | each generated `Sample<R, A>` carries an effectful shrink tree      | environment-dependent generation              | `Sized` service plus bounded constructors                               | deterministic `TestRandom` state           |

This diversity is important: `{ generate, shrink }`, a rose tree, a mutable value tree, and an input trace all implement
roughly the same user capability, but none is a neutral representation of it.

## Findings by system

### fast-check v4 and announced v5 direction

fast-check couples generation and contextual shrinking inside `Arbitrary<T>`. `map`, `chain`, and `filter` preserve the
engine's shrink machinery, but their operational contracts are not trivial: filtering is rejection sampling; dependent
generation retains engine-managed shrinking; manually injected examples need special reverse/context behavior
([`Arbitrary`](https://fast-check.dev/docs/api/classes/Arbitrary/),
[`filter` guidance](https://fast-check.dev/docs/core-blocks/properties/)).

Choice combines several policies. `oneof` supports branch weights, depth behavior, and optional cross-shrinking to the
first branch. Thus distribution weight, semantic alternative, and shrink preference should not be conflated just
because v4 accepts them in one operation
([recursive and choice arbitraries](https://fast-check.dev/docs/core-blocks/arbitraries/combiners/any/)).

Recursive generation uses `letrec` together with `maxDepth`, `depthSize`, and possibly a shared `DepthIdentifier`.
These are engine bookkeeping, not domain concepts. Even inside fast-check this area is evolving: arrays do not currently
use recursive depth in the same way, motivating an open design issue
([recursive structures](https://fast-check.dev/docs/core-blocks/arbitraries/combiners/recursive-structure/),
[depth-aware arrays issue](https://github.com/dubzzz/fast-check/issues/6344)).

Properties and runners are already separate from arbitraries. `property` and `asyncProperty` accept predicates;
`check` returns structured run details while `assert` is the throwing presentation. Sampling also uses runner
parameters, including the seed, and is not part of arbitrary construction
([properties](https://fast-check.dev/docs/core-blocks/properties/),
[`check`](https://fast-check.dev/docs/api/functions/check/),
[`sample`](https://fast-check.dev/docs/api/functions/sample/)).

The maintainer's announced v5 direction includes async properties by default, RNG changes, native streams, depth-aware
arrays, and runner/API changes. These plans are evidence that Effect should hide the low-level protocol, not evidence of
final v5 signatures. No final v5 redesign has been published for `map`, `chain`, `filter`, `oneof`, or replay
([v5 plans](https://github.com/dubzzz/fast-check/discussions/6793)).

### QuickCheck

QuickCheck is the counterexample to assuming that an arbitrary must integrate shrinking. Its `Gen<A>` is essentially
`QCGen -> Size -> A`, is a monad, and has no shrink component. The `Arbitrary` typeclass places `arbitrary: Gen<A>` and
`shrink: A -> List<A>` side by side, while property combinators can accept a generator and shrinker separately
([`Gen`](https://hackage-content.haskell.org/package/QuickCheck-2.18.0.0/docs/Test-QuickCheck-Gen.html#t:Gen),
[`Arbitrary`](https://hackage-content.haskell.org/package/QuickCheck-2.18.0.0/docs/Test-QuickCheck-Arbitrary.html#t:Arbitrary),
[`forAllShrink`](https://hackage-content.haskell.org/package/QuickCheck-2.18.0.0/docs/Test-QuickCheck.html#v:forAllShrink)).

Size is explicit through `sized`, `resize`, and `scale`; list generators interpret it as an upper bound. `oneof` is
uniform, `frequency` uses integer weights, and filtering is expressed by `suchThat`. These operations describe
distribution and generation policy, not only the set of possible values
([generator combinators](https://hackage-content.haskell.org/package/QuickCheck-2.18.0.0/docs/Test-QuickCheck-Gen.html)).

The runner returns `Success | GaveUp | Failure | NoExpectedFailure`, tracks discards, and replays with seed and size.
The documentation explicitly warns that seeds are not stable across QuickCheck versions and recommends persisting the
actual counterexample for durable regression tests
([runner `Result` and `Args`](https://hackage-content.haskell.org/package/QuickCheck-2.18.0.0/docs/Test-QuickCheck.html#t:Result)).

Effectful tests belong to the property layer via `ioProperty` and `PropertyM`, not to `Gen`. Generated functions require
the separate `Function` and `CoArbitrary` capabilities
([monadic properties](https://hackage-content.haskell.org/package/QuickCheck-2.18.0.0/docs/Test-QuickCheck-Monadic.html),
[function generation](https://hackage-content.haskell.org/package/QuickCheck-2.18.0.0/docs/Test-QuickCheck-Function.html)).

### Hedgehog

Hedgehog integrates generation and shrinking with a different representation:
`GenT m a = Size -> Seed -> TreeT (MaybeT m) a`. A generation may be effectful or discarded and yields a shrink tree.
`map`, applicative composition, and monadic bind compose that tree
([`GenT` internals](https://hackage-content.haskell.org/package/hedgehog-1.7/docs/Hedgehog-Internal-Gen.html),
[source](https://github.com/hedgehogqa/haskell-hedgehog/blob/master/hedgehog/src/Hedgehog/Internal/Gen.hs)).

Shrink preference is observable in constructor semantics: numeric ranges shrink toward a declared origin, while
`element`, `choice`, and `frequency` shrink toward their first member. `recursive` explicitly separates non-recursive
and recursive branches, halves the size on recursion, and stops choosing recursive branches at small sizes. Structural
`subterm` combinators add shrinks toward children
([Hedgehog generator API](https://hackage-content.haskell.org/package/hedgehog-1.7/docs/Hedgehog-Gen.html)).

Filtering can eventually discard generation. Hedgehog even exposes two policies: one searches through rejected nodes
for accepted descendants, giving better but slower shrinking; the other prunes those descendants. This shows that a
boolean `filter` signature hides meaningful operational choices.

`PropertyT` and the runner are distinct from `GenT`. Internally outcomes include success, gave up, and failure, plus
test/discard/shrink progress, annotations, diffs, seed, and coverage. Replay requires more than a seed because shrinking
and property execution can be interleaved
([property API](https://hackage-content.haskell.org/package/hedgehog-1.7/docs/Hedgehog.html),
[runner source](https://github.com/hedgehogqa/haskell-hedgehog/blob/master/hedgehog/src/Hedgehog/Internal/Runner.hs)).

### Hypothesis

Hypothesis's `SearchStrategy<A>` is opaque. Internally a strategy interprets a runner-controlled choice sequence; the
runner reduces that representation and re-executes the strategy/property. There is no public `shrink(A)` and no
per-value shrink tree in the user model
([strategy reference](https://hypothesis.readthedocs.io/en/latest/reference/strategies.html),
[choice sequence](https://hypothesis.readthedocs.io/en/latest/glossary.html#term-choice-sequence),
[implementation overview](https://hypothesis.works/articles/how-hypothesis-works/)).

Hypothesis deliberately avoids a universal public frequency or scale contract. Constraints are normally local to
constructors, such as numeric bounds and collection lengths. `recursive(base, extend, max_leaves)` bounds leaves rather
than exposing a global depth identifier. `one_of` uses order as shrink preference
([domain and distributions](https://hypothesis.readthedocs.io/en/latest/explanation/domain.html),
[recursive strategies](https://hypothesis.readthedocs.io/en/latest/reference/strategies.html#hypothesis.strategies.recursive)).

`map`, `flatmap`, and `filter` are core composition tools, but filtering may raise `Unsatisfiable`; property-level
`assume` produces invalid cases. The runner distinguishes invalid inputs from failures and has health checks for
pathological filtering
([filtering](https://hypothesis.readthedocs.io/en/latest/tutorial/adapting-strategies.html),
[`assume`](https://hypothesis.readthedocs.io/en/latest/reference/api.html#hypothesis.assume)).

Replay provides three different concepts: a best-effort seed, a versioned opaque `reproduce_failure` blob, and a cache
of previously failing examples. The docs explicitly state that the blob and database are not stable across versions;
an explicit materialized example is the durable regression mechanism
([replaying failures](https://hypothesis.readthedocs.io/en/latest/tutorial/replaying-failures.html)).

Generated functions are scoped to the execution of the property that created them. Async execution requires runner or
test-framework integration. Both are evidence against treating generated functions or async behavior as elementary
`Arbitrary` constructors.

### Rust proptest

Proptest separates a reusable `Strategy<A>` from the per-generation `ValueTree<A>`. The tree owns the selected value and
mutable state required to simplify and, after a rejected shrink, complicate it again. RNG and budgets belong to a
separate `TestRunner`
([`Strategy`](https://docs.rs/proptest/1.11.0/proptest/strategy/trait.Strategy.html),
[`ValueTree`](https://docs.rs/proptest/1.11.0/proptest/strategy/trait.ValueTree.html),
[`TestRunner`](https://docs.rs/proptest/1.11.0/proptest/test_runner/struct.TestRunner.html)).

Its dependent combinators make an important semantic distinction. `prop_flat_map` shrinks both parent and dependent
child while maintaining their relationship; alternatives either freeze the parent or allow the relation to stop
holding. The preserving version can require regeneration and become expensive. Therefore an engine-neutral `flatMap`
needs a stated dependency-preservation contract; its name alone is not sufficient
([flat-map variants](https://docs.rs/proptest/1.11.0/proptest/strategy/trait.Strategy.html#method.prop_flat_map)).

Proptest separately models generation weight and shrink priority: union weights affect selection, while earlier
branches are simpler shrink targets. Collection size is local; recursive generation distinguishes maximum depth,
desired total size, and expected branch size
([`Union`](https://docs.rs/proptest/1.11.0/proptest/strategy/struct.Union.html),
[recursive strategies](https://proptest-rs.github.io/proptest/proptest/tutorial/recursive.html)).

Case rejection and property failure are distinct. A whole run can succeed, fail with a minimized counterexample, or
abort after excessive rejection. Persistence uses an engine-specific seed representation rather than promising a
portable counterexample encoding
([case result](https://docs.rs/proptest/1.11.0/proptest/test_runner/enum.TestCaseError.html),
[run result](https://docs.rs/proptest/1.11.0/proptest/test_runner/enum.TestError.html),
[failure persistence](https://proptest-rs.github.io/proptest/proptest/failure-persistence.html)).

### ZIO Test

ZIO Test is especially relevant to Effect because it makes environment-dependent generation first-class:
`Gen<R, A>` contains a stream of `Sample<R, A>`. A `Sample` contains the generated value and an effectful stream of
smaller samples. This is another integrated-shrinking representation, but unlike fast-check its dependency is modeled
in the generator type
([`Gen`](https://zio.dev/api/zio/test/gen), [`Sample`](https://zio.dev/api/zio/test/sample)).

ZIO provides `map`, `flatMap`, `filter`, bounded constructors, weighted choice, a `Sized` environment, and generators
from ZIO effects or random effects. Its property `check` itself returns a ZIO effect and works directly with Effect-like
test results. Sampling operations such as `runCollectN` are also effects
([generator model](https://zio.dev/reference/test/property-testing/how-generators-work/),
[built-in generators](https://zio.dev/reference/test/property-testing/built-in-generators),
[operators](https://zio.dev/reference/test/property-testing/operators/)).

This demonstrates that effectful generation is coherent. It does not prove that Effect's initial arbitrary type needs
an environment parameter: schema-derived values are currently pure, while effectful properties provide most of the
practical integration benefit. Environment-dependent generation can be a later capability if a concrete use case
requires it.

### Is ZIO Test a trustworthy basis for a port?

**Verdict: trust the design as a mature reference, but port the concepts rather than the Scala source or its complete
public surface.** As of 13 August 2026, ZIO's latest stable release is 2.1.26, published on 6 May 2026, and GitHub reports
149 further commits on the maintained `series/2.x` branch. ZIO Test is released with ZIO rather than as an abandoned
side project ([2.1.26 release](https://github.com/zio/zio/releases/tag/v2.1.26),
[`series/2.x`](https://github.com/zio/zio/tree/series/2.x)).

The property-testing subsystem is mature by ordinary library evidence. `Gen` and `Sample` already existed in ZIO
1.0.18; the current documentation presents property testing as an ordinary ZIO Test capability, not an experimental
one; and the current `Gen.scala`, `Sample.scala`, and `Sized.scala` sources have no experimental or deprecation marker.
The `zio-test` JVM artifact also runs MiMa compatibility checks with `failOnProblem = true`
([ZIO 1.0.18 `Gen`](https://github.com/zio/zio/blob/v1.0.18/test/shared/src/main/scala/zio/test/Gen.scala),
[current property-testing docs](https://zio.dev/reference/test/property-testing/),
[current `Gen`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala),
[current `Sample`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sample.scala),
[current `Sized`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sized.scala),
[MiMa configuration](https://github.com/zio/zio/blob/series/2.x/project/MimaSettings.scala),
[`zio-test` build](https://github.com/zio/zio/blob/series/2.x/build.sbt#L394-L407)).

The implementation is tested and still receives substantive maintenance. The repository has dedicated suites for
generator behavior and laws, effectful generators, samples, and the property runner; recent work optimized `Gen`
construction and collection generation, while earlier 2.x work added empty-generator diagnostics and property-aware
test aspects
([`GenSpec`](https://github.com/zio/zio/blob/series/2.x/test-tests/shared/src/test/scala/zio/test/GenSpec.scala),
[`GenZIOSpec`](https://github.com/zio/zio/blob/series/2.x/test-tests/shared/src/test/scala/zio/test/GenZIOSpec.scala),
[`SampleSpec`](https://github.com/zio/zio/blob/series/2.x/test-tests/shared/src/test/scala/zio/test/SampleSpec.scala),
[`CheckSpec`](https://github.com/zio/zio/blob/series/2.x/test-tests/shared/src/test/scala/zio/test/CheckSpec.scala),
[#10267](https://github.com/zio/zio/pull/10267), [#10307](https://github.com/zio/zio/pull/10307),
[#9069](https://github.com/zio/zio/pull/9069), [#9076](https://github.com/zio/zio/pull/9076)).

That evidence does not make the exact representation immutable. Across 2.x, `Gen` retained its generated-sample model,
but 2.0 represented absence with `Option[Sample]` inside streams and 2.1 removed that layer as a `flatMap`
optimization. Another 2.x change moved `Sized` out of the generator's visible environment into ZIO Test's internal
test-service context. The long-lived ideas are integrated shrinking, compositional generation, an explicit complexity
parameter, and an effectful runner; the precise carrier and service plumbing have evolved
([ZIO 2.0.0 `Gen`](https://github.com/zio/zio/blob/v2.0.0/test/shared/src/main/scala/zio/test/Gen.scala),
[ZIO 2.1.0 `Gen`](https://github.com/zio/zio/blob/v2.1.0/test/shared/src/main/scala/zio/test/Gen.scala),
[#7874](https://github.com/zio/zio/pull/7874), [#7243](https://github.com/zio/zio/pull/7243)).

A literal port would also import choices that are natural in Scala but are not a neutral TypeScript API. Current
`Gen[-R, +A]` is a `ZStream[R, Nothing, Sample[R, A]]`; `Sample` stores an effectful `ZStream` shrink tree; `Sized` is
implemented using a fiber-local service; and `check` relies on Scala variance, implicit `Trace` and `SourceLocation`,
`Zippable`, overloaded tuple arities, and `CheckConstructor` type-level adaptation. Effect can express the underlying
effects, streams, context, and fiber-local state, but should redesign these seams in its own idiom instead of preserving
the Scala encoding
([`Gen` source](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala),
[`Sample` source](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sample.scala),
[`Sized` source](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sized.scala),
[`check` source](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/package.scala#L396-L517)).

Effect's Stream history makes this kind of adaptation more credible: Effect already has a native `Stream<A, E, R>`
whose representation is backed by Effect `Channel`, so a lazy, effectful shrink tree is implementable without
`fast-check`. It does not imply that `Stream<Sample<A>>` should become the public `Arbitrary` representation. The useful
precedent is to translate the ZIO semantics onto Effect's own runtime and expose a deeper Effect-owned interface, while
keeping `Sample`, shrink traversal, random state, and size policy private
([Effect `Stream`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Stream.ts),
[Effect stream representation](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/internal/stream.ts),
[ZIO `Gen`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala)).

The practical recommendation is therefore to use ZIO Test as the second, non-fast-check implementation model for the
prototype. Port the `Gen`/`Sample` algebra, shrink-search semantics, sizing ideas, and the relevant law and regression
tests; do not initially port public `Sample`, environment-dependent generation, the `ZStream` carrier, Scala-specific
runner overloads, or the whole catalog of generators. If a real source translation is used rather than an independent
implementation of the ideas, ZIO is Apache-2.0: redistributed derivative source must include the license, retain
applicable notices, and mark modified files. That is compatible with distribution inside an MIT project, but it creates
attribution work that a concept-level reimplementation avoids
([ZIO license](https://github.com/zio/zio/blob/series/2.x/LICENSE),
[`Gen.scala` license header](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala#L1-L14)).

## Common semantic core

Across the systems, the stable commonality is narrower than any one API:

1. An arbitrary describes a domain and enough hidden information for the engine to minimize failing cases.
2. Construction is compositional: constants/primitives, pure mapping, independent product, alternatives, collections,
   and some form of dependent generation recur across systems.
3. Constraints should be constructive when possible. Rejection filtering is useful but fallible, may be expensive, and
   can reduce shrink quality.
4. Recursive descriptions require both a finite path and a complexity policy, but `terminal`, global size, leaf count,
   and depth identifiers are different implementations of that requirement.
5. Property execution is separate from arbitrary construction. It owns retries/discards, run limits, shrinking,
   interruption, timeout, replay, persistence, and reporting.
6. Sampling is an interpretation for exploration and debugging, not the primitive from which checking should be built.
7. Replay metadata is engine- and version-specific. A seed is useful input and diagnostic information, but not a stable
   cross-engine replay format.
8. Exact distributions and exact minimal counterexamples are engine behavior, not reasonable compatibility promises.

### Candidate common operations

The research supports beginning with a small opaque construction API:

```ts
interface Arbitrary<out A>

declare const constant: <A>(value: A) => Arbitrary<A>
declare const map: <A, B>(self: Arbitrary<A>, f: (a: A) => B) => Arbitrary<B>
declare const zip: <A, B>(self: Arbitrary<A>, that: Arbitrary<B>) => Arbitrary<readonly [A, B]>
declare const dependent: <A, B>(self: Arbitrary<A>, f: (a: A) => Arbitrary<B>) => Arbitrary<B>
declare const oneOf: <A>(head: Arbitrary<A>, ...tail: ReadonlyArray<Arbitrary<A>>) => Arbitrary<A>
declare const filter: <A>(self: Arbitrary<A>, predicate: Predicate<A>) => Arbitrary<A>
declare const suspend: <A>(evaluate: LazyArg<Arbitrary<A>>) => Arbitrary<A>
```

This is only a starting vocabulary. Before stabilizing it, the contract must answer:

- whether `dependent` must shrink the parent while preserving the dependency;
- whether `oneOf` order declares shrink priority;
- whether filtering has a bounded exhaustion contract and how that is reported;
- whether recursive construction needs a higher-level `recursive(base, extend)` primitive in addition to laziness;
- whether generator mapping is documented as pure and deterministic.

Primitive and collection constructors should use domain-specific constraints:

```ts
Arbitrary.integer({ minimum, maximum })
Arbitrary.array(element, { minLength, maxLength })
```

A single `Constraints` bag should not mix domain validity, distribution hints, recursion bookkeeping, and shrink policy.

## Separate runner and result model

Effect can provide a deeper interface than a Promise-oriented engine by making the property callback effectful while
keeping arbitrary construction pure:

```ts
declare const check: <A, R, E>(
  arbitrary: Arbitrary<A>,
  property: (value: A) => Effect.Effect<CaseResult, E, R>,
  options?: CheckOptions
) => Effect.Effect<CheckResult<A, E>, never, R>
```

The exact error channel policy remains open, but the result should not compress distinct outcomes into a boolean:

```ts
type CheckResult<A, E> =
  | { readonly _tag: "Passed"; readonly tests: number; readonly discarded: number }
  | {
    readonly _tag: "Falsified"
    readonly counterexample: A
    readonly error: E
    readonly replay: ReplayToken
    readonly tests: number
    readonly shrinks: number
  }
  | { readonly _tag: "Exhausted"; readonly discarded: number }
  | { readonly _tag: "Interrupted"; readonly reason: unknown }
```

`ReplayToken` should be opaque and carry private engine/version metadata. A public seed can remain an optional run input,
but Effect should not promise that a v4 seed reproduces the same values, shrink path, or counterexample after switching
to v5. The materialized counterexample is the durable regression artifact.

Sampling belongs beside checking but has a weaker contract:

```ts
declare const sample: <A>(
  arbitrary: Arbitrary<A>,
  options?: SampleOptions
) => Effect.Effect<ReadonlyArray<A>>
```

It should be documented as exploratory: deterministic under a given engine/configuration when requested, but not stable
across engines or Effect releases.

## Features to defer or expose as explicit capabilities

| Feature                          | Reason not to put in the minimal contract                                              |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| public `generate` / `shrink`     | excludes Hypothesis's trace reducer and leaks fast-check/proptest protocols            |
| public shrink tree or `terminal` | valid implementations, not general concepts                                            |
| generic global `size`            | systems assign different meanings; local structural bounds are clearer                 |
| `DepthIdentifier`                | fast-check recursion bookkeeping                                                       |
| exact weighted distribution      | not all engines promise it; Hypothesis intentionally controls distribution             |
| cross-branch shrink flags        | engine-specific search policy                                                          |
| generated functions              | requires hashing/equality, memoization, lifetime, display, and shrinking semantics     |
| effectful generation             | coherent in ZIO/Hedgehog, but adds `R` without a current schema-derivation requirement |
| model/state-machine testing      | runner-level subsystem, not arbitrary construction                                     |
| persistent example database      | cache/service policy, not part of `Arbitrary<A>`                                       |

Weights may still be useful, but should be named a distribution **hint** unless Effect is prepared to guarantee statistical
behavior. Function generation may later be a separate capability with explicit equality/hash and lifetime semantics.

## Implication for Schema annotations

If `effect/Arbitrary` owns the opaque type and constructors, a declaration can keep its local annotation without a
registry and without tagless-final HKTs:

```ts
const annotation = {
  toArbitrary: ([value]) =>
    Arbitrary.oneOf(
      Arbitrary.constant(Option.none()),
      Arbitrary.map(value, Option.some)
    )
}
```

The schema AST remains the only AST. An annotation directly builds the opaque Effect arbitrary; the private interpreter
may represent it with fast-check v4 today and something else later.

Recursive annotations should use only version-neutral constructors. The public annotation should not receive
`DepthIdentifier`, `terminal`, or a fast-check module. Whether Effect's private v4 implementation derives terminal
branches, builds a product carrier, or uses another recursive encoding remains an implementation decision.

## Recommended next design step

Prototype the smallest constructor algebra needed by the existing built-in schema annotations, then implement two
throwaway interpreters or semantic models with materially different shrinking representations:

1. the current fast-check v4 implementation;
2. a small trace- or shrink-tree-based model inspired by Hypothesis/Hedgehog/proptest.

The second model need not be production quality. Its purpose is to reveal which proposed operations accidentally rely
on fast-check context, depth, cross-shrink, or rejection behavior. Stabilize the public interface only after the same
schema annotations can be expressed against both models with defensible semantics.
