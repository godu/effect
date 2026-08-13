# Porting ZIO Test `Gen` to `effect/unstable/arbitrary/Arbitrary`

## Status and scope

This is a design analysis for Effect v4. It does not define a final public API and does not change source code.

The post-grilling implementation decisions are consolidated in
[`ARBITRARY-NATIVE-PLAN.md`](ARBITRARY-NATIVE-PLAN.md). In particular, the native plan supersedes this document's
exploration of public constructors, public combinators, builder annotations, and `Arbitrary<A, R>`.

The question is whether Effect should implement an Effect-owned `effect/unstable/arbitrary/Arbitrary` by porting the
conceptual kernel of ZIO Test, adapting it to TypeScript, Effect v4 conventions, Schema annotations, and
`@effect/vitest`.

The recommendation is **yes, with deliberate deviations**. ZIO Test is a mature and unusually close architectural
reference because Effect already owns the corresponding `Effect`, `Stream`, `Random`, and fiber-local context
machinery. The right port is nevertheless not a line-by-line translation:

- preserve `Gen` as an opaque, compositional generated domain;
- preserve integrated shrinking and dependent shrinking;
- use Effect-native effects, streams, services, interruption, and scoped resources;
- keep `Sample` and its shrink tree internal;
- add explicit exhaustion, replay, and productive recursion, which ZIO Test does not model robustly;
- keep both legacy and native arbitrary annotations local to the Schema declaration that owns them;
- do not expose a fast-check builder, a registry of built-ins, `terminal`, or a second public AST.

Two requirements are release-blocking rather than later refinements:

1. recursive and mutually recursive Schemas must share a decreasing complexity budget across their complete strongly
   connected component, and derivation must reject a cycle that has no productive finite route;
2. recognized Schema constraints must be pushed into native constructors, with only residual predicates implemented by
   bounded rejection. Neither an impossible recursion nor an impossible filter may hang the runner.

During the additive migration, the two derivations can coexist:

```text
SchemaAST + local annotations
       ├── legacy `toArbitrary` ──→ fast-check v4 compiler
       └── namespaced native annotation ──→ unstable native compiler
                                               ↓
                              effect/unstable/arbitrary/Arbitrary
```

The native engine should not import the legacy compiler or fast-check. The temporary fast-check dependency remains in
`effect` only until the legacy path is removed; coexistence is a migration state, not the final decoupled architecture.

## Sources and source-of-truth caveat

The primary specification used here is the ZIO source plus its tests, rather than the prose documentation alone. The
current documentation still shows the older `ZStream[..., Option[Sample]]` representation and some pages still expose
`Sized` in `Gen`'s environment. The page itself warns that its representation is condensed, while current source uses
`ZStream[..., Sample]` and hides `Sized` from `R`
([generator documentation](https://zio.dev/reference/test/property-testing/how-generators-work/),
[current `Gen`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala),
[current `Sized`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sized.scala)).

Effect references in this document point to the current v4 checkout, whose package version is `4.0.0-rc.108` at the
time of writing.

## Current Effect coupling

Today `Schema.Arbitrary<T>` is not an Effect-owned value. It is a function from the fast-check module to a
`fast-check.Arbitrary<T>`:

```ts
type Arbitrary<T> = (fc: typeof FastCheck) => FastCheck.Arbitrary<T>
```

`Schema.toArbitrary` memoizes the Schema compiler but still returns that factory. Declaration annotations receive the
fast-check module, type parameters contain both `arbitrary` and `terminal`, and recursive context contains a
`DepthIdentifier` and `maxDepth` ([public API](src/Schema.ts#L14539),
[annotation types](src/Schema.ts#L16365), [compiler](src/internal/schema/toArbitrary.ts)).

The dependency is wider than Schema:

- `effect/testing/FastCheck` re-exports all of fast-check ([module](src/testing/FastCheck.ts));
- `TestSchema` constructs fast-check properties directly ([module](src/testing/TestSchema.ts));
- `@effect/vitest` imports fast-check at runtime, accepts `FC.Arbitrary` in `it.prop`, converts Schemas through the
  current factory, and exposes `fastCheck` runner options
  ([implementation](../vitest/src/internal/internal.ts), [types](../vitest/src/index.ts));
- `effect` has a runtime dependency on `fast-check: ^4.9.0` ([package manifest](package.json)).

The current Schema compiler is already a substantial semantic layer. It merges ordered and cardinality constraints,
applies candidates and filters, handles optional object fields, arrays, maps, sets and Effect data structures, and
tracks recursive terminal paths. Replacing fast-check is therefore not only a matter of implementing primitive random
numbers. It requires replacing the generator catalog, shrinking behavior, recursion policy, runner, and downstream
testing integration.

## Why a native implementation is worth the migration

The justification should not be merely that Effect can hide fast-check v4 and replace it with v5 later. That would
move the dependency behind an abstraction without giving Effect ownership of the semantics. The stronger case is that
generation, shrinking, Schema derivation, effectful checking, interruption, and replay form one Effect domain whose
public contract should not be defined by a particular release of another property-testing engine.

### Independence and API ownership

- `effect` can eventually remove its runtime dependency on fast-check. A fast-check major release then becomes an
  implementation or integration concern rather than a reason to change core Schema annotation types.
- Public Effect types stop mentioning `fast-check.Arbitrary`, the fast-check module, `DepthIdentifier`, or
  fast-check-specific recursion options. Applications can use a different fast-check major for their own tests without
  its version determining the representation used by Effect.
- Effect owns the compatibility boundary. The opaque `Arbitrary<A>` can change its PRNG, shrink carrier, internal
  recursion algorithm, or generation strategy while the constructor and runner contracts remain meaningful in Effect
  terms.
- The API can follow Effect and Schema vocabulary: PascalCase domain constructors, `Effect` destructors, tagged result
  data, pipeability, and Schema-shaped constraints. It does not need to imitate fast-check merely because fast-check is
  the first implementation.
- Removing a mandatory third-party runtime engine reduces the core dependency and supply-chain surface. This is a
  secondary benefit, not sufficient by itself to justify maintaining a property-testing kernel.

### Schema becomes a first-class generation source

- Schema generation can be designed against `SchemaAST` directly instead of translating Schema semantics into the
  closest fast-check primitive. The Schema AST remains the only AST; no public generator AST or registry is required.
- Each `Declaration` continues to own its generation recipe through a local annotation. Built-ins and user-defined
  declarations do not depend on a global registry, and the annotation no longer exposes an external engine.
- Recursive and mutually recursive Schemas can use Schema graph information that a generic arbitrary library does not
  have: strongly connected components, shared budgets, finite base routes, and preflight productivity checks. This
  makes termination a derivation guarantee rather than a convention based on `terminal` and a fast-check depth token.
- Recognized Schema checks can be pushed into constructors using domain semantics. Length, numeric range, integer,
  finiteness, and collection cardinality constraints avoid rejection where construction is possible; the original
  Schema checks still validate the result for soundness.
- Unrecognized predicates have bounded rejection and produce an explicit exhausted result. Impossible filters and
  unproductive cycles cannot silently hang a test run.
- Invalid or unsupported derivations can report Schema-local errors: conflicting constraints, a missing native
  declaration annotation, or an unproductive recursive component. These diagnostics are more actionable than errors
  leaking from an engine adapter.
- Generation and shrinking can preserve Schema invariants together. A constrained value is not useful if its shrinker
  escapes the domain; owning both lets Effect test that every shrink candidate still satisfies the Schema.

### Native Effect execution semantics

- Sampling and checking are lazy `Effect` values. They compose with ordinary Effect timeout, interruption, scoping,
  supervision, tracing, and service provisioning instead of requiring a synchronous foreign runner around an
  effectful property.
- Effectful properties can fail in the typed error channel and still be shrunk to a minimal counterexample. Defects
  remain defects and fiber interruption remains interruption, preserving the distinctions users already rely on.
- Generation randomness can be isolated from randomness used by the property. A property drawing from `Random` does
  not perturb later generated cases, which improves deterministic reproduction and makes the execution model easier
  to explain.
- `sample`, `check`, exhaustion, falsification, interruption, and replay can share one result model. Downstream tools
  such as `@effect/vitest` and `TestSchema` no longer have to translate between Effect failures and fast-check runner
  details.
- Size, run count, discard budget, and shrink budget can have explicit Effect-owned meanings. Their semantics no
  longer depend on similarly named fast-check settings whose behavior may change across engine versions.

### Reproduction and failure quality

- A failure can carry a replay value that identifies the original attempt and the complete shrink path. Replaying it
  reproduces the counterexample the user saw, not merely the larger value that happened to fail before shrinking.
- Independently derived per-attempt seeds allow direct replay of one attempt and prevent a change in one generator's
  random draw count from shifting all subsequent cases.
- Falsified, exhausted, typed-property-error, and interrupted runs remain distinguishable. This prevents a low
  acceptance filter from being mistaken for a passing property and avoids flattening operational cancellation into a
  test failure.
- Shrink traversal, budget consumption, and counterexample reporting become testable parts of Effect's behavior rather
  than incidental behavior inherited through an adapter.

### Optimization and long-term evolution

- Effect can specialize the internal pull and shrink representation for the common TypeScript and Schema workload,
  avoiding abstractions needed by a general-purpose external engine. Allocation and runtime improvements are possible
  without a public representation change.
- Constraint pushdown can evolve around Schema's actual checks. New Schema knowledge can improve generation without
  waiting for a corresponding fast-check constructor or exposing engine-specific constraint records.
- Domain-specific built-ins can choose distributions and shrinkers that match Effect data types. Their semantics can
  be covered by Effect's own conformance suite instead of being reconstructed repeatedly in annotations.
- The native module creates one kernel for Schema derivation, direct arbitrary construction, sampling, checking, and
  future testing integrations. This removes duplicated translation layers and makes behavior consistent across these
  entry points.
- Bundle cost becomes controllable by Effect. Removing fast-check from the final architecture avoids forcing its
  runtime into consumers that materialize a Schema arbitrary; a specialized native implementation may also be smaller.
  The latter is a hypothesis and must be demonstrated by the two materialized bundle fixtures, not asserted in
  advance.
- The unstable namespace permits the team to learn from production use and make breaking changes before stabilizing
  the contracts. This is especially valuable for dependent generation, replay, recursive sizing, and check results,
  where premature compatibility would be expensive.

### Migration benefits

- A dedicated native annotation allows the old and new compilers to coexist on the same Schema declaration. Coverage
  can move incrementally, and parity can be measured before removing the existing path.
- Because the native compiler never falls back to the legacy annotation, missing coverage is visible. The migration
  cannot appear complete while still loading fast-check transitively.
- Side-by-side semantic tests and materialized bundle fixtures provide objective exit criteria: built-in declaration
  coverage, generation and shrink invariants, recursive termination, constraint efficiency, replay, and bundle impact.
- No versioned `@effect/fast-check-v4` adapter is required for the native route. If an ecosystem integration is ever
  desirable, it can remain outside the core abstraction rather than defining it.

These benefits carry a real cost: Effect becomes responsible for generator quality, unbiased bounded random
generation, shrinking laws, replay, recursion, performance, and maintenance. Consequently the credible justification
is not "one fewer dependency". It is the combination of Schema-native derivation and optimization, Effect-native
execution, stronger termination and exhaustion semantics, reproducible shrinking, and ownership of an API that can
evolve independently of fast-check. The vertical slice and parity gates must prove those advantages before the legacy
engine is removed.

## Additive coexistence strategy

The native implementation should initially use a dedicated annotation rather than reinterpret or replace the existing
`toArbitrary`. Schema annotations are open string-keyed records and `SchemaAST.annotate` preserves unknown keys, so the
new unstable module can own a namespaced key such as:

```ts
export const SchemaAnnotationId = "~effect/unstable/arbitrary/Arbitrary/schema" as const
```

Each declaration can carry both recipes locally:

```ts
const annotations = {
  // Existing fast-check implementation, unchanged
  toArbitrary: legacyFastCheckDeclaration,

  // New native implementation
  [SchemaAnnotationId]: nativeDeclaration
}
```

This is not a registry. Both functions remain attached to the declaration that owns the domain behavior. The legacy
compiler resolves only `toArbitrary`; the unstable compiler resolves only `SchemaAnnotationId`. It must not silently
adapt or fall back to the fast-check recipe, because doing so would hide missing native coverage and retain the engine
coupling.

The native annotation should receive the concrete native constructor module as a parameter while the two
implementations coexist:

```ts
type ArbitraryModule = typeof import("./Arbitrary.ts")

interface NativeDeclaration<T, TypeParameters extends ReadonlyArray<Constraint>> {
  (
    module: ArbitraryModule,
    typeParameters: {
      readonly [K in keyof TypeParameters]: Arbitrary.Arbitrary<TypeParameters[K]["Type"]>
    },
    options: Options
  ): Arbitrary.Arbitrary<T>
}
```

This parameter is not a tagless-final engine abstraction and does not use HKT. Its type is the one concrete
`effect/unstable/arbitrary/Arbitrary` module. Injection prevents `Schema.ts` from statically importing the native engine,
which would otherwise make every Schema consumer load the experimental property-testing implementation before opting
into it. The unstable compiler supplies the module when it evaluates the recipe.

For a custom declaration, the unstable integration can expose a helper that returns the correctly keyed annotation:

```ts
SchemaArbitrary.annotation((A, [value], options) =>
  A.map(A.Array(value, toArrayOptions(options.constraints)), MyCollection.fromIterable)
)
```

The exact helper name is open; callers should not need to type or duplicate the namespaced string.

Filter constraints and candidates need a small distinction during coexistence:

- the existing `GenerationConstraint` fields are semantic generation hints and the native compiler can reuse them;
- a legacy `Candidate.make(fc, ...)` is engine-specific and must not be reused;
- a native candidate, when needed, belongs under the new namespaced annotation.

This avoids duplicating every min/max/cardinality hint while keeping executable candidate recipes isolated by engine.
When the legacy implementation is removed, `GenerationConstraint` can move out of the fast-check-named namespace
without affecting the already unstable native interface.

Coexistence should be deliberately temporary. Its exit criteria are native coverage for all built-in declarations,
semantic parity of the existing Schema generation suite, recursive and mutually recursive coverage, constraint
pushdown benchmarks, and native `@effect/vitest` adoption. Only then are the old annotation, compiler, re-export, and
fast-check dependency removed.

## What exactly would be ported from ZIO

### The stable conceptual kernel

Current ZIO Test has the following representation:

```scala
final case class Gen[-R, +A](
  sample: ZStream[R, Nothing, Sample[R, A]]
)

final case class Sample[-R, +A](
  value: A,
  shrink: ZStream[R, Nothing, Sample[R, A]]
)
```

([`Gen`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala#L34),
[`Sample`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sample.scala#L27)).

This model has existed since ZIO 1.x, together with compositional `map`/`flatMap`, integrated shrinking, size-aware
generation, and an effectful property runner. The representation changed during ZIO 2.x—most notably by temporarily
putting `Option` inside the stream—and Random and Sized disappeared from the visible environment. That history says to
trust the model but not freeze its carrier as Effect's public API
([ZIO 1.0.18](https://github.com/zio/zio/blob/v1.0.18/test/shared/src/main/scala/zio/test/Gen.scala),
[ZIO 2.0.0](https://github.com/zio/zio/blob/v2.0.0/test/shared/src/main/scala/zio/test/Gen.scala),
[ZIO 2.1.0](https://github.com/zio/zio/blob/v2.1.0/test/shared/src/main/scala/zio/test/Gen.scala)).

The following ideas are suitable for a port:

1. A generator is a reusable description, not a sampled value.
2. Generation can depend on services, but normal random and size infrastructure need not pollute its environment type.
3. A generated sample owns the lazy tree of valid smaller samples.
4. `map` maps the complete tree.
5. `flatMap` preserves the dependency between a parent and the generator selected from it.
6. Size is dynamically scoped and can itself be shrunk before rebuilding a structure.
7. The property runner stops at the first initial failure, then explores only its shrink tree up to a budget.

### What should not be copied blindly

The following ZIO behaviors should be treated as implementation evidence, not requirements:

- an empty or impossible filtered generator can wait forever; ZIO only logs a warning after five seconds;
- no `GaveUp` or `Exhausted` result exists;
- `suspend` provides laziness but no deterministic recursion bound;
- invalid generator bounds are often defects (`die(IllegalArgumentException)`);
- standard failure details contain the initial value, shrunk value, and stream index, but not seed, size, PRNG version, or
  shrink path;
- parallel checking can choose a scheduler-dependent first failure;
- the exact shrink traversal and branch order are observable but not presented as a stable cross-version protocol;
- `Gen` and every shrink node allocate ZStream structure, an area that ZIO still optimizes
  ([recent optimization](https://github.com/zio/zio/pull/10267)).

## Mapping ZIO concepts to Effect v4

| ZIO Test                       | Effect v4 candidate                                                | Visibility                   |
| ------------------------------ | ------------------------------------------------------------------ | ---------------------------- |
| `Gen[R, A]`                    | `Arbitrary<A, R>`                                                  | public, opaque               |
| `ZStream[R, Nothing, Sample]`  | internal `Stream<Sample<A, R>, never, R>` or optimized pull kernel | internal                     |
| `Sample[R, A]`                 | `{ value, shrinks }`                                               | internal                     |
| `Sample.shrinkSearch`          | bounded internal shrink search                                     | internal                     |
| `Sized` backed by `FiberRef`   | internal `Context.Reference<number>`                               | internal                     |
| ZIO Random test service        | Effect `Random` plus `Random.withSeed`                             | existing public service      |
| `TestConfig`                   | explicit `CheckOptions` / `SampleOptions`                          | public data                  |
| `TestResult` + failure details | tagged `CheckResult` data                                          | public data                  |
| test aspects                   | Effect combinators and `@effect/vitest` options                    | outside the generator kernel |

Effect already supplies the direct substrate. `Stream<A, E, R>` is pull-based, chunked, backpressured, and has
`fromEffect`, `empty`, `suspend`, `unfold`, `map`, `mapEffect`, sequential `flatMap`, `take`, `runCollect`, `runHead`,
and service provisioning ([`Stream`](src/Stream.ts)). `Random` is a `Context.Reference` with deterministic local
seeding through `Random.withSeed` ([`Random`](src/Random.ts)). In v4, `Context.Reference` is also the appropriate
fiber-local mechanism for size; there is no need to introduce a mandatory `Layer` merely to run a pure Schema-derived
arbitrary.

`Schedule` should not model run count, discard budget, or shrink budget. Those are finite counters, while `Schedule`
models repetition/retry policies with timing and metadata. Timeouts and interruption should remain ordinary Effect
composition around the runner.

## Proposed public module

### Unstable entry point

The first implementation should be exported only from `effect/unstable/arbitrary/Arbitrary`. It should not have an
`effect/Arbitrary` alias: the representation may be opaque, but the combinator surface, constraint options, runner
results, sizing and discard policies, shrinking semantics, and Schema annotation contract all need room for breaking
changes based on real use and benchmarks.

Concretely, the implementation would live at `src/unstable/arbitrary/Arbitrary.ts` with an explicit
`"./unstable/arbitrary/Arbitrary"` package export, because the current `"./*"` wildcard does not cover this nested
unstable path. Its TypeId should follow the complete unstable namespace:

```ts
export const TypeId: TypeId = "~effect/unstable/arbitrary/Arbitrary"
```

Promotion to `effect/Arbitrary` is a later API decision, not part of the initial migration. It should happen only after
the Schema compiler, recursive and mutually recursive generation, constraint pushdown, shrinking, replay, bundle size,
and property-runner behavior have been exercised without requiring further semantic redesigns.

### Opaque type and Effect conventions

The public shell should follow the normal Effect v4 TypeId, variance, Pipeable, dual-combinator, and type-extractor
conventions:

```ts
export const TypeId: TypeId = "~effect/unstable/arbitrary/Arbitrary"

export interface Arbitrary<out A, out R = never> extends Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _R: Types.Covariant<R>
  }
}

export type Success<T> = T extends Arbitrary<infer A, any> ? A : never
export type Services<T> = T extends Arbitrary<any, infer R> ? R : never
```

An `ArbitraryTypeLambda` is mechanically possible:

```ts
export interface ArbitraryTypeLambda extends HKT.TypeLambda {
  readonly type: Arbitrary<this["Target"], this["Out2"]>
}
```

It should only be exported if real generic code uses it. Effect's HKT implementation makes the encoding available, but
that does not imply that the generator should be designed tagless-final. The purpose of the module is to own an engine,
not to abstract every annotation over an arbitrary interpreter.

`R` should represent genuine user services needed by effectful generation. `Random` and size remain default fiber
references, so ordinary primitives and all Schema-derived arbitraries are `Arbitrary<A, never>`. Generation should not
have a public error parameter: the ZIO discipline of `Gen<R, A>` with an infallible generation channel keeps
composition tractable. Invalid construction options are programmer errors; rejected attempts and exhaustion are
runner data; user values such as `Effect<A, E, R>` can themselves be generated as values.

### Minimal construction surface

The naming should deliberately mirror `Schema` wherever an arbitrary constructs the same domain. This makes the module
read as the generative interpreter of Schema and avoids a second vocabulary. Domain constructors are PascalCase;
algebraic combinators that transform an existing arbitrary keep Effect's usual camelCase style.

The initial general algebra needs roughly:

```ts
empty
constant
fromIterable
fromEffect // Effect<A, never, R>
map
flatMap
flatten
filter
weighted
suspend
sized
resize
noShrink
```

Schema migration additionally requires native constructors named after their Schema counterparts:

```ts
Never, Any, Unknown, Null, Undefined, Void
String, Number, Boolean, Symbol, BigInt, Int, Natural
Literal, Literals, TemplateLiteral
Array, NonEmptyArray, UniqueArray, Tuple, Struct, Record, Union
ObjectKeyword, Date, URL, Uint8Array, Json
```

This does not require every Schema declaration to become a central Arbitrary export. Types such as `Option`, `Result`,
`Chunk`, or a user declaration can continue to define their arbitrary locally through annotations and compose the
general algebra with the shared domain constructors. The rule is: when the Arbitrary module does expose a constructor
corresponding to a Schema constructor, its name and capitalization match Schema exactly. There should be no parallel
lowercase `string`, `integer`, `array`, or `jsonValue` aliases.

The second list is the largest implementation cost. ZIO provides a sound kernel, but it cannot supply JavaScript float
edge cases, regular-expression string generation, property-key behavior, URL and Date domains, JSON values,
`Uint8Array`, or Effect's BigDecimal/DateTime/collection semantics. These generators should be implemented as native
Effect combinators and validated against the existing Schema suite.

`Sample`, `reshrink(Sample)`, and the raw sample stream should not initially be public. Exposing them would make the
rose-tree representation part of Effect's compatibility contract and would prevent replacing Stream with a cheaper JS
kernel. A future custom-shrinker API can expose an engine-neutral operation such as ordered candidate values, if a
concrete use case requires it; it need not expose the internal tree type.

### Sampling and checking are destructors

Construction, sampling, and property checking should remain separate even if they share a module:

```ts
Arbitrary.sample(self, options): Effect<Array<A>, SampleError, R>

Arbitrary.check(self, property, options):
  Effect<CheckResult<A, E>, never, R | R2>
```

The signatures above are illustrative. The important contract is:

- `sample` is effectful and seedable;
- `check` accepts an effectful property without converting it to a Promise;
- options are explicit values, not a required service graph;
- outcomes are data; invalid API arguments may still throw synchronously following Effect's existing constructor
  conventions;
- interruption of the runner propagates as interruption and is not reported as a falsified property.

## Internal representation options

### Faithful Stream port

The closest implementation is:

```ts
interface Sample<A, R> {
  readonly value: A
  readonly shrinks: Stream.Stream<Sample<A, R>, never, R>
}

interface ArbitraryImpl<A, R> extends Arbitrary<A, R> {
  readonly samples: Stream.Stream<Sample<A, R>, never, R>
}
```

One evaluation of `samples` may be finite. A random primitive normally emits one sample; the runner repeats the stream.
`fromIterable` may emit every supplied value; `concat` may preserve deterministic enumeration. This distinction is
present in ZIO: `fromZIO` builds a one-element stream, while `runCollectN` repeats the whole sample stream
([constructors and collection](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala#L470-L476)).

Using Effect Stream is attractive for three reasons:

1. It is the direct counterpart of ZStream and has already absorbed resource safety, laziness, stack safety, and
   environment composition.
2. Effect's Stream historically derives from the same ZStream design lineage, lowering conceptual translation risk.
3. Effectful shrinks and effectful generation become ordinary Stream and Effect composition.

It also has two important costs:

1. A `Stream` is a Channel-backed, chunked abstraction. A numeric shrink tree may allocate many Stream, Channel, and
   closure nodes where a specialized pull or iterator would be cheaper in JavaScript.
2. Importing native arbitrary support from `Schema.ts` could pull Stream machinery into Schema's bundle. `Schema.ts`
   currently imports Effect but not Stream, so this must be measured rather than assumed harmless.

The bundle difference is structural. Today `Schema.ts` imports FastCheck only as a type and a caller injects the
fast-check module into `Schema.toArbitrary`; merely importing Schema does not require a runtime import of fast-check.
After the migration, built-in Schema annotations will call `Arbitrary.constant`, `Arbitrary.map`, `Arbitrary.Union`,
and collection constructors directly, so Schema necessarily has a runtime dependency on the Effect Arbitrary
implementation. If that
implementation eagerly imports full `Stream`, which imports `Channel` and its runtime, a Schema-only application may
pay for a property-testing substrate even when it never calls `toArbitrary`.

Tree shaking may eliminate some of that graph in a particular bundler, but the design should not rely on ideal
cross-module elimination. Measure emitted bundles for both `import { Schema } from "effect"` and
`import * as Schema from "effect/Schema"`, with and without an actual `Schema.toArbitrary` call.

Three internal carriers should be compared:

| Carrier                                      | Advantages                                                        | Risks                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| faithful outer `Stream<Sample>`              | closest to ZIO; simplest semantic port; resource-safe             | loses discard attempts; greatest Channel/Stream allocation and bundle cost |
| opaque generator with Stream-backed attempts | public API remains evolvable; reuses Stream everywhere internally | still pays outer Stream cost and needs explicit attempt events             |
| one-attempt Effect + private shrink sequence | explicit discards; small hot path; runner owns repetition         | requires a small custom lazy sequence or selective Stream use              |

The recommended hybrid is the third option: a one-attempt generation Effect plus either a private Stream only for
shrinks or a minimal internal lazy sequence benchmarked against Stream. If even the private shrink Stream materially
affects Schema bundles, the shrink carrier can be replaced with a custom pull without changing `Arbitrary`, annotations,
or the runner result types. This is a primary reason the carrier must remain opaque.

### Recommended hybrid carrier

The leading implementation candidate for TypeScript is a hybrid rather than a literal outer ZStream:

```ts
interface ArbitraryImpl<A, R> extends Arbitrary<A, R> {
  readonly generate: Effect.Effect<GenerationResult<A, R>, never, R>
}

type GenerationResult<A, R> =
  | { readonly _tag: "Generated"; readonly sample: Sample<A, R> }
  | { readonly _tag: "Discarded"; readonly reason: DiscardReason }

interface Sample<A, R> {
  readonly value: A
  readonly shrinks: Stream.Stream<Sample<A, R>, never, R>
}
```

The outer `Effect` represents exactly one generation attempt, making discards countable and preventing an impossible
filter from becoming an empty infinite stream. The private Stream remains a good fit for the lazy, ordered, effectful
shrink tree, where exhaustion is finite and backpressure is useful. `flatMap` propagates a discarded parent or child as
one discarded attempt and combines shrink trees only after both stages generate.

This hybrid deliberately does not preserve ZIO's exhaustive `fromIterable` stream semantics. The native
`fromIterable` can select an element for one attempt; exhaustive checking, if wanted, should be a separate destructor
or input mode rather than an accidental consequence of the carrier. The faithful Stream model can remain the reference
prototype used to compare laws and shrinking behavior.

The public contract must not choose between these representations. The seam is the executable `Arbitrary`, not
`Stream<Sample>`.

The internal model should retain rejection events or attempt counts. Mapping rejection to `Stream.empty`, as ZIO does,
loses the information required to stop impossible filters and return `Exhausted`. An implementation can use a private
stream of `Generated | Rejected`, a pull-per-attempt protocol, or equivalent counters without exposing any of them.

This is not a second public arbitrary AST. `SchemaAST` remains the description of the data schema. `Arbitrary` is an
executable generated-domain value, while `Sample` is runtime search data. Small hidden metadata such as minimum
productive size or branch simplicity is operational metadata, not a second user-visible syntax tree.

## Exact combinator semantics

### `map`

ZIO's `Sample.map` maps both the current value and every descendant. Effect should preserve that law:

```ts
map(sample, f) = Sample(f(sample.value), map(sample.shrinks, child => map(child, f)))
```

No reverse mapping is necessary. The native runner only shrinks values that were generated by the same arbitrary; it
does not need fast-check's reverse/context protocol for externally supplied values.

### `flatMap`

ZIO's `flatMap` is the most valuable part of the port because it provides dependent shrinking. At Sample level:

```scala
val sample = f(value)
Sample(sample.value, sample.shrink ++ shrink.map(_.flatMap(f)))
```

At Gen level it generates the dependent value, regenerates dependents for parent shrinks, and attaches those shrinks to
the produced samples
([`Sample.flatMap`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sample.scala#L45-L48),
[`Gen.flatMap`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala#L104-L114)).

This preserves relationships such as “generate a length, then generate an array of exactly that length.” The initial
port should preserve ZIO's ordering: shrinks introduced by the mapped function are considered before recursively mapped
shrinks of the source sample. The order is observable because the runner uses a greedy search.

The contract should explicitly say that `flatMap` preserves dependency during shrinking and may regenerate dependent
values. It is semantically stronger and potentially more expensive than merely freezing the parent.

`zipWith` may initially follow ZIO and be defined using `flatMap`, but a specialized balanced zip can be considered if
benchmarks show pathological left bias. Any change must come with explicit shrink-order tests.

### `filter`

ZIO 2.x implements `filter` with `flatMap(a => predicate(a) ? const(a) : empty)`, warns that it can be inefficient, and
has no discard budget. Its separate `Sample.filter` recursively promotes descendants of an invalid node, but current
`Gen.filter` does not use that path
([`Gen.filter`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala#L78-L93),
[`Sample.filter`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sample.scala#L35-L43)).

Effect should define two different behaviors:

- during initial generation, a rejected root consumes one discard attempt;
- during shrinking, invalid candidates are not shown to the property, and the search may inspect their descendants for
  valid candidates within the shrink budget.

The runner stops with `Exhausted` after a configured discard budget or discard ratio. This is both safer and more
diagnosable than ZIO's five-second warning followed by an indefinite wait. Schema constraints should still be pushed
into constructive generators whenever possible; `filter` is the correctness backstop, not the normal way to satisfy
rare predicates.

### `Union` and `weighted`

ZIO `oneOf` maps to Effect's Schema-aligned `Arbitrary.Union`. It generates a shrinkable branch index, so the first
branch is both the lowest index and the preferred shrink target. `weighted` uses cumulative ranges over a uniform
number and likewise tends to shrink toward earlier branches
([`oneOf`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala#L675-L676),
[`weighted`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala#L917-L925)).

Effect can retain this useful convention while making the contract clear:

- weight controls generation frequency;
- array order controls shrink preference;
- the first branch should be the semantically simplest branch;
- weights must be finite and positive, validated at construction.

Keeping weight and order as separate inputs avoids making fast-check's weighted-arbitrary shape part of the API.

### Primitive shrinking

ZIO integer and fractional shrinking use recursive bisection toward an explicit `smallest`. Integer ranges shrink toward
the lower bound, while unconstrained integers shrink toward zero. Fractional shrinking has a Scala-specific `0.001`
cutoff
([`Sample` shrinkers](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sample.scala#L93-L123)).

The integer algorithm is a good baseline. The floating-point algorithm should be redesigned for JavaScript rather than
copied literally. It must specify behavior for `NaN`, infinities, signed zero, subnormals, excluded bounds, and
representable adjacent doubles. Existing Schema constraints already distinguish integers, NaN, infinity, and ordered
bounds; the native number arbitrary should consume those concepts directly.

Collections should shrink structure and elements while preserving minimum length, uniqueness, required keys, and other
Schema invariants. ZIO's `buildN` uses nested `flatMap`; it demonstrates correctness but should not be assumed optimal
for JS arrays or records.

## Size and recursion

### Dynamic size

ZIO `Sized` uses a FiberRef with default size 100. `resize` dynamically installs a size for lazy stream evaluation and
restores the previous size after each sample
([`Sized`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sized.scala)).

The Effect equivalent is an internal `Context.Reference<number>` with a default. `sized` reads it and `resize` provides
it locally to the generator's stream or generation effect. It should not appear in `R`, and users should not need a
Layer to sample a normal arbitrary.

ZIO's `small`, `medium`, and `large` select a size under the current maximum. `small` and `medium` reshrink the selected
size toward a minimum and then rebuild the dependent structure, which is an elegant use of `flatMap`
([size combinators](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala#L760-L792)).
This behavior is worth porting, but its exact exponential constants are distribution policy and should be benchmarked,
not treated as laws.

Runner options should record the effective size. A later size-growth policy across test runs may be added, but the
first implementation should prefer a simple explicit maximum over an undocumented run-index formula.

### `suspend` is not sufficient recursion control

ZIO's recursion primitive is only:

```scala
def suspend[R, A](gen: => Gen[R, A]): Gen[R, A] =
  Gen(ZStream.suspend(gen.sample))
```

([source](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Gen.scala#L823-L824)).
Its official recursive list fixture chooses randomly between `Nil` and a suspended recursive branch. Termination is
geometric, not deterministically bounded
([fixture](https://github.com/zio/zio/blob/series/2.x/test-tests/shared/src/test/scala/zio/test/GenUtils.scala#L53-L59)).

Effect should keep `suspend` as a low-level laziness primitive and add productive recursion. A high-level combinator can
have semantics equivalent to:

```ts
Arbitrary.recursive({
  base: Arbitrary<A>,
  step: (self: Arbitrary<A>) => Arbitrary<A>
})
```

At size zero it selects only `base`. At positive size it may select `base` or `step(selfAtSmallerSize)`. Recursive
children must see a strictly smaller budget; combinators with multiple children should split or decrement that budget
according to a documented policy. The exact spelling is open, but the invariants are not:

1. a recursive generation has a finite base route;
2. each recursive descent consumes budget;
3. the maximum structure is bounded by configuration;
4. shrinking never leaves the generated domain;
5. impossible productive recursion is reported instead of hanging.

### Why `terminal` need not remain public

The current Schema compiler propagates `{ arbitrary, terminal }` and gives declarations a fast-check recursion context.
The general concept behind that code—knowing whether a recursive description can produce a finite value—is real. The
particular `terminal` generator and `DepthIdentifier` are fast-check implementation artifacts.

A native arbitrary can carry hidden productivity metadata derived by its own combinators:

- `constant` is productive at size zero;
- `empty` is not;
- `map` preserves productivity;
- `Union` is productive if one member is;
- an empty-capable array is productive even when its item is not;
- a required non-empty collection needs a productive item;
- a struct needs every required field;
- `suspend` resolves the fixed point lazily.

This metadata need not be an AST and need not appear in annotations. Exact analysis is undecidable for arbitrary
effectful user code, so the compiler can reject descriptions known to be impossible and let the runner's exhaustion
budget handle unknown cases. For Schema's built-in combinators the metadata can be precise.

The result preserves the useful current failure for a recursive Schema with no finite path, while avoiding a public
normal/terminal dual API.

Conceptually, the Schema compiler may hold a private result like:

```ts
interface Compiled<A> {
  readonly normal: Arbitrary.Arbitrary<A>
  readonly base: BasePlan<A>
}

type BasePlan<A> =
  | { readonly _tag: "Known"; readonly arbitrary: Arbitrary.Arbitrary<A> }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Unknown" }
```

This is not returned by an annotation and is not public `Arbitrary` API. `Known` means that the compiler has a
well-founded generation route, `Empty` means it can prove there is none, and `Unknown` covers opaque operations such as
an arbitrary user filter. At runtime, a private `GenerationState` associates a remaining recursion budget with each
recursive group. `Options` never carries either structure.

### Mutually recursive Schemas: SCC and shared budget

Mutual recursion makes a per-`Suspend` depth counter insufficient. Consider:

```text
A = null | { b: B }
B = { a: A }
```

`A` and `B` are one strongly connected component (SCC). Resetting a budget when generation moves from `A` to `B` would
permit the `A -> B -> A` cycle to evade the bound. Conversely, this SCC is productive because `A` has a `null` branch
and therefore `B` has the finite value `{ a: null }`. The cycle below is not productive:

```text
A = { b: B }
B = { a: A }
```

The Schema compiler should implement the following internal algorithm:

1. Memoize a lazy placeholder for every `SchemaAST.Suspend` before compiling its body, so cycles do not recurse in the
   TypeScript call stack.
2. Record edges between suspended nodes and compute SCCs, either eagerly with Tarjan's algorithm or incrementally before
   finalizing the compiled component.
3. Compute productivity as a least fixed point inside each SCC. Start every cyclic reference as `Empty`. A branch
   becomes productive when it can construct a value using only non-recursive children and members already proved
   productive in an earlier round. Save the base plan when a member first becomes productive and assign it that round's
   rank; do not keep expanding the base plan with higher-rank recursive alternatives.
4. Report a derivation error with the Schema path and cycle when no member obtains a productive route.
5. Compile the ordinary arbitrary with lazy references to every member and retain the saved rank-decreasing base plan
   beside it in the compiler's private table.
6. Allocate one per-sample complexity budget to the SCC. Every ordinary edge whose source and target are in that SCC
   consumes from the same budget; moving between `A` and `B` never resets it.
7. At zero remaining budget, switch to the saved base plan. Edges inside that plan may only point to lower productivity
   ranks, so they terminate without consuming ordinary recursion fuel. At positive budget, recursive alternatives may
   participate according to their weights.
8. When a node has multiple recursive children, partition the remaining budget between them or use a shared mutable
   budget state. Merely passing the same unchanged numeric size to every child permits exponential growth and does not
   establish a total-size bound.

For the productive example, the fixed point is concrete:

```text
round 0: A becomes productive through null
         base(A) = null

round 1: B becomes productive using the already known base(A)
         base(B) = { a: null }
```

The recursive `{ b: B }` alternative is part of `normal(A)`, but not added later to `base(A)`. Therefore generation at
budget zero has a finite route for both entry points. In the unproductive `A = { b: B }; B = { a: A }` example, no
member becomes productive in any round and derivation fails before sampling.

The runner's maximum `size` and the SCC's remaining complexity are related but distinct. Size is a user-facing upper
bound and input to size-aware collections; SCC budget is internal state used to prove that a single generated recursive
value terminates. A recursive child receives a strictly smaller local allowance even when an enclosing array has its own
length budget.

Local declaration annotations remain part of this analysis without a registry. Native combinators carry hidden
productivity facts: an optional or empty array is productive independently of its parameter; a non-empty collection
requires its element; a mapped type preserves its source; a declaration-written `Union` contributes any productive
member. Because the annotation returns the actual native arbitrary, this information travels with the declaration
itself. For an opaque effectful custom arbitrary whose productivity cannot be proven, the compiler records `unknown`;
the bounded generation attempt and `Exhausted` result remain the safety net.

## Schema integration without a registry

`SchemaAST` remains the only schema AST. The compiler recursively turns nodes into native `Arbitrary` values, just as
the formatter compiler turns nodes into formatter values. A declaration continues to own its local annotation.

The native annotation is owned by the unstable integration module rather than replacing
`Schema.Annotations.ToArbitrary`. Its target shape is approximately:

```ts
export const AnnotationId = "~effect/unstable/arbitrary/Arbitrary/schema" as const

export interface Options {
  readonly constraints?: GenerationConstraint
}

export interface Declaration<T, TypeParameters extends ReadonlyArray<Constraint>> {
  (
    module: typeof Arbitrary,
    typeParameters: {
      readonly [K in keyof TypeParameters]: Arbitrary.Arbitrary<TypeParameters[K]["Type"]>
    },
    options: Options
  ): Arbitrary.Arbitrary<T>
}
```

`Options` is not Effect's `Context` and contains no services. It is only compile-time derivation input supplied by the
Schema compiler. `constraints` is the merged set of generation hints for checks applied to the declaration, such as
ordered bounds or collection cardinality. The annotation can translate recognized hints into domain-local Arbitrary
options; it can ignore the object when no optimization applies. Recursion state, size budgets, Random, and productivity
metadata remain private to the compiler and Arbitrary implementation. `module` is the concrete native constructor
module, injected to avoid a static runtime dependency from core Schema to the unstable engine; it is not a general
engine interface.

For example, the native Option recipe is independent of the legacy recipe on the same declaration:

```ts
const annotations = {
  toArbitrary: legacyFastCheckOption,
  [AnnotationId]: (A, [value]) =>
    A.Union([
      A.constant(Option.none()),
      A.map(value, Option.some)
    ])
}
```

For a declaration that maps a type parameter:

```ts
const annotations = {
  [AnnotationId]: (A, [value]) => A.map(value, (value) => new Box(value))
}
```

A collection declaration can consume the optimization hints explicitly:

```ts
const annotations = {
  [AnnotationId]: (A, [value], options) =>
    A.map(
      A.Array(value, {
        minLength: options.constraints?.minLength,
        maxLength: options.constraints?.maxLength
      }),
      MyCollection.fromIterable
    )
}
```

The compiler still applies the original Schema checks after generation, so these options are optimization hints rather
than a replacement for validation.

For a declaration with a genuine structural base case, the annotation expresses it through ordinary native
combinators. An optional container can generate `none` at size zero; an array can generate `[]`; a non-empty collection
inherits its element's productivity. No central registry needs to know these types.

The other annotation types change similarly:

- a native candidate receives the concrete module plus the same derivation `Options` and returns
  `Arbitrary<unknown> | undefined`;
- `GenerationConstraint` and `OrderedConstraint` remain Schema concepts and continue using Effect's `Order`;
- the old `Context.recursion`, `Recursion.depthIdentifier`, `TypeParameter.terminal`, and `Derivation.terminal`
  disappear;
- during coexistence, the unstable derivation entry point returns `Arbitrary<S["Type"]>` while the existing
  `Schema.toArbitrary(schema)` remains unchanged.

The compiler may use SchemaAST structure and hidden arbitrary productivity metadata to compile a `Suspend`. The
annotation API does not expose the traversal or the recursion budget.

There is no `fc`, `terminal`, or recursion object in this interface. Internally, the Schema compiler evaluates the
annotation once with the ordinary type-parameter arbitraries. While solving the finite fixed point it may evaluate the
same pure annotation again with the currently known base plans, substituting `A.empty` for unresolved parameters.
Evaluation can take several rounds for mutually recursive declarations; this is compiler work, not sample generation.

The hook cannot distinguish those evaluations and does not need to. Ordinary combinators propagate the relevant hidden
productivity facts. For example, an Option annotation given `empty` for its type parameter still produces `none`; a
non-empty collection given `empty` remains empty; a mapped declaration preserves whichever input derivation it receives.
The compiler stores normal and base results privately and exposes only the ordinary `Arbitrary<T>`.

This reproduces the useful precision of the current normal/terminal compilation without making the duality part of the
annotation API. It also handles a custom declaration consistently: all recursion-specific decisions remain in the
compiler and native combinators, while the declaration continues to describe its value using one local annotation.

### Constraint pushdown and residual filtering

Constraint pushdown is an acceptance criterion for the Schema port. The current compiler already collects check
annotations, merges node-local `GenerationConstraint` values, resets structural context when descending to child
values, offers weighted candidate sources, and finally applies every filter predicate
([compiler](src/internal/schema/toArbitrary.ts)). The native compiler should preserve that layered model:

1. Collect every check and arbitrary hint for the current SchemaAST node.
2. Intersect recognized constraints before constructing the base arbitrary. Reject a statically empty intersection,
   such as integer `min > max` or array `minLength > maxLength`, during derivation.
3. Push recognized constraints into the narrowest native constructor.
4. Combine the constrained base source with local candidate sources using their declared weights.
5. Apply every original check as a residual validation layer, including checks already used as hints. This makes a bug
   or incomplete optimization affect efficiency rather than soundness.
6. Count a residual rejection as a discard and stop at the configured budget.

The first implementation must push down at least:

| Schema domain     | Constructive constraints                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| number            | integer, finite, NaN/infinity policy, inclusive/exclusive ordered bounds |
| bigint            | inclusive/exclusive bounds                                               |
| string            | length bounds and recognized regular-expression generation               |
| array / tuple     | length, optional/rest layout, uniqueness                                 |
| object            | required keys, optional-key count, total property count                  |
| Set / Map / Chunk | cardinality, uniqueness, productive terminal shape                       |
| Date / BigDecimal | ordered bounds and representation-specific precision/scale               |

The native constructors therefore need domain-local option types rather than one universal public constraint AST. For
example, the precise names are open, but the shape should be close to:

```ts
Arbitrary.Int({ min, max })
Arbitrary.Number({ min, max, noNaN, noInfinity })
Arbitrary.String({ minLength, maxLength, unit })
Arbitrary.Array(item, { minLength, maxLength })
```

This is the same performance principle used by fast-check's constrained primitive constructors, without exposing
fast-check's option objects as Effect's API. It also avoids moving a registry of all Schema built-ins into Arbitrary:

- primitive SchemaAST nodes are compiled by the primitive Schema interpreter;
- a declaration's own local native annotation receives `Options.constraints` and decides how to construct its native
  arbitrary;
- native constructors only understand their own domain-local options;
- the generic `Arbitrary.filter` does not inspect, rewrite, or pretend to understand an opaque JavaScript predicate.

Consequently, arbitrary predicate optimization is necessarily opt-in at the point where semantic information still
exists. A Schema check can carry both its validating predicate and a generation hint. The compiler may use the hint to
construct values efficiently, but it must retain the predicate as the final soundness check. A bare call such as
`Arbitrary.filter(Arbitrary.Number(), isSpecialNumber)` has no sound general transformation into number bounds unless
the caller supplies a more specific constructor itself.

The distinction matters for API stability. `IntOptions`, `NumberOptions`, and `StringOptions` are stable concepts
owned by Effect; fast-check's `size`, `unit`, depth identifiers, bias frequencies, and internal contexts should only be
adopted when they express a library-independent semantic requirement. Distribution tuning that is not semantic should
remain private engine policy.

Regular-expression generation deserves special care. Multiple patterns mean intersection at validation time; choosing
one generated pattern is only a candidate strategy unless the implementation can construct their intersection. The
residual checks must verify all patterns. Likewise, uniqueness should be built into collection generation when possible,
but collision exhaustion still needs a bounded result for small domains.

Shrinking follows the same rule. Specialized shrinkers should stay inside recognized bounds and structural invariants.
If a residual predicate rejects a proposed shrink, the search skips or promotes its valid descendants within
`maxShrinks`; it never passes the invalid value to the property. This preserves Schema validity for every observed
counterexample.

The key observable guarantees are:

- selective but satisfiable filters terminate or exhaust predictably;
- impossible recognized constraints fail during derivation;
- impossible unrecognized predicates return `Exhausted`, never hang;
- candidate annotations cannot bypass final Schema checks;
- child constraints do not accidentally inherit container constraints;
- all generated and shrunken values satisfy `Schema.is(schema)`.

## Runner design

### Outcome model

The native runner should return tagged data rather than throw for ordinary property outcomes:

```ts
type CheckResult<A, E> =
  | Passed
  | Falsified<A, E>
  | Exhausted

interface Passed {
  readonly _tag: "Passed"
  readonly runs: number
  readonly discards: number
}

interface Falsified<A, E> {
  readonly _tag: "Falsified"
  readonly initialInput: A
  readonly counterexample: A
  readonly failure: ReturnedFalse | PropertyError<E>
  readonly runs: number
  readonly shrinks: number
  readonly replay: Replay
}

interface Exhausted {
  readonly _tag: "Exhausted"
  readonly runs: number
  readonly discards: number
  readonly reason: "Empty" | "TooManyDiscards" | "UnproductiveRecursion"
  readonly replay: Replay
}
```

The final names can follow `Data.TaggedClass` or tagged-enum conventions. The semantic distinctions matter more than
the constructors:

- a property returning false is a falsification;
- an expected typed failure from an effectful property can be a shrinkable falsification;
- a defect in generator infrastructure or the property should normally remain a defect;
- interruption must propagate;
- inability to obtain enough valid values is exhaustion, not success and not a defect.

`@effect/vitest` can turn `Falsified` and `Exhausted` into assertion failures with a formatted report, while lower-level
users can inspect the data without exceptions.

### Sequential baseline algorithm

The first runner should be sequential:

1. validate options;
2. choose or record a seed;
3. install the seeded Random and effective size locally;
4. repeat generator attempts until `numRuns` accepted samples, first falsification, or discard exhaustion;
5. on falsification, retain the initial Sample and property failure;
6. explore its shrink candidates in order, never exceeding `maxShrinks`;
7. keep the most recent failing candidate selected by the shrink policy;
8. return structured result and replay data.

This matches ZIO's high-level runner while making attempts explicit. ZIO maps the property over the whole Sample tree,
drops initial successes, takes the first failure, runs `shrinkSearch`, and chooses the last failing result within the
budget
([runner](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/package.scala#L1064-L1098)).

ZIO's `Sample.shrinkSearch` is greedy depth-first: for a failing node it explores children in order until the first
failing child, then descends into that child and does not return to later siblings. It emits passing attempts as well as
failures
([algorithm](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sample.scala#L62-L68)).
This is a reasonable deterministic baseline. The strategy should remain internal so Effect can later compare breadth,
best-first, or domain-specific searches without changing `Arbitrary` construction APIs.

Parallel checking should be deferred. Sharing a mutable seeded PRNG across parallel samples makes draw order
scheduler-dependent, and “first completed failure” is not reproducible. A future parallel mode needs deterministic PRNG
splitting and an explicit rule for selecting the winning sample.

### Configuration and defaults

Candidate options include:

```ts
interface CheckOptions {
  readonly runs?: number
  readonly maxShrinks?: number
  readonly maxDiscards?: number
  readonly size?: number
  readonly seed?: string | number
  readonly replay?: Replay
}
```

ZIO defaults to 200 samples, 1000 shrinks, and size 100
([`TestConfig`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/TestConfig.scala),
[`Sized`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/Sized.scala)). Those numbers are
useful starting points, not mandatory Effect defaults. JS benchmark results and existing `@effect/vitest` expectations
should determine final values.

Invalid negative counts, non-integer budgets, impossible primitive bounds, and invalid weights should fail immediately
with a clear `RangeError` or Effect-standard illegal-argument error. They should not become random defects during
stream execution.

## Random and replay

Effect `Random` provides `nextDoubleUnsafe` and `nextIntUnsafe` through a `Context.Reference`; public operations include
bounded values, choice, and shuffle. `Random.withSeed(string | number)` installs a deterministic ISAAC generator locally
([source](src/Random.ts)). This is sufficient for a sequential first implementation and does not add `Random` to `R`.

The existing service does not expose the current seed, PRNG position, split, or snapshot. Therefore the runner—not the
service—must own the initial seed and replay metadata. A replay token should be opaque in the public API but internally
contain at least:

```text
token format version
Arbitrary engine/version identifier
seed
initial sample index or accepted-run index
effective size
shrink path or equivalent search progress
```

Rerunning sequentially from the seed to an index is acceptable initially. Recording a shrink path avoids depending only
on the property rediscovering an identical route. The token is still best-effort across versions: a generator algorithm,
PRNG, collection ordering, or shrinker may change. The durable regression artifact is the materialized
counterexample, which should be easy to copy into an example-based test.

ZIO's `TestRandom` is more inspectable and restorable than Effect's current Random, but the standard ZIO
`GenFailureDetails` still records only initial input, shrunk input, and index
([`TestRandom`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/TestRandom.scala),
[`GenFailureDetails`](https://github.com/zio/zio/blob/series/2.x/test/shared/src/main/scala/zio/test/GenFailureDetails.scala)).
Effect should not inherit that gap.

Effectful generation can observe external services and scoped resources. Seed replay cannot promise reproducibility of
non-deterministic services. The report should say that explicitly. Stream/Effect finalizers must run on success, failure,
exhaustion, and interruption.

## `@effect/vitest` and TestSchema migration

The native `it.prop` path should accept `Arbitrary` or `Schema`, derive Schemas through the unstable native Schema
compiler, run properties as Effects, and format native `CheckResult` values. Its options should be named for native
concepts rather than preserving a nested `fastCheck` bag. Raw fast-check arbitraries are outside this API: users who
choose fast-check can use its runner directly. This keeps both `effect` and the native `@effect/vitest` path independent
of every fast-check major without introducing an adapter package.

`TestSchema.verifyLosslessTransformation` and `verifyGeneration` should use the native runner. Returning an Effect is
the most coherent v4 API because verification is effectful, interruptible, and seedable. If source compatibility is
needed during migration, Promise wrappers can delegate to an Effect-returning implementation; synchronous wrappers
should not hide effectful generation.

## Testing strategy

### Kernel conformance

Write new Effect tests, informed by ZIO behavior but not copied line for line:

- `Sample.map` maps every node and satisfies identity/composition;
- `flatMap` preserves dependent constraints and has a fixed shrink order;
- `zip` and collection shrinkers preserve shape invariants;
- integer shrinking reaches its target and terminates;
- `Union` and weighted choice respect distribution tolerance and shrink preference;
- `filter` counts initial discards and never passes an invalid shrink to the property;
- empty and impossible generators produce `Exhausted` within the budget;
- size is locally scoped, restored, and shrinks structures;
- `suspend` is lazy;
- productive recursion respects maximum size and impossible recursion does not hang;
- mutually recursive SCCs share one decreasing complexity budget and do not reset it across type boundaries;
- constraint pushdown handles recognized numeric, string, object, and collection filters constructively;
- residual and candidate filtering is bounded and retains Schema validity;
- generation and shrinking release scoped resources on every exit;
- interruption remains interruption.

ZIO has dedicated `GenSpec`, `GenZIOSpec`, `SampleSpec`, and `CheckSpec`, including monad laws, stack safety, and concrete
shrinking examples. They are valuable behavioral references
([`GenSpec`](https://github.com/zio/zio/blob/series/2.x/test-tests/shared/src/test/scala/zio/test/GenSpec.scala),
[`GenZIOSpec`](https://github.com/zio/zio/blob/series/2.x/test-tests/shared/src/test/scala/zio/test/GenZIOSpec.scala),
[`SampleSpec`](https://github.com/zio/zio/blob/series/2.x/test-tests/shared/src/test/scala/zio/test/SampleSpec.scala),
[`CheckSpec`](https://github.com/zio/zio/blob/series/2.x/test-tests/shared/src/test/scala/zio/test/CheckSpec.scala)).

### Schema compatibility

The current `packages/effect/test/schema/toArbitrary.test.ts` is approximately 1,700 lines and already exercises
constraints, candidates, optional properties, collections, Effect data types, recursive schemas, and the error for no
finite path. Preserve its semantic assertions while replacing fast-check-specific spies and APIs. Add type-level tests
for the new annotation signature and removal of `terminal`, `DepthIdentifier`, and the module builder.

During development, differential tests against the current fast-check compiler are useful only for domain validity:
both engines should generate values satisfying `Schema.is` and transformation round trips. They should not require the
same values, distributions, seeds, or minimal counterexamples.

### Replay tests

For a fixed engine version, test that:

- the same seed and options produce the same initial sequence sequentially;
- a returned replay token finds the same initial failure and shrink path;
- changing the seed changes a representative sequence;
- the report retains both initial and minimal values;
- replay version mismatch produces a clear unsupported-token result;
- a materialized counterexample remains usable without the engine.

### Performance and bundle gates

Benchmark at least:

- primitive sample throughput;
- nested tuples and large structs;
- arrays at sizes 10, 100, and 1,000;
- dependent `flatMap` shrinking;
- recursive trees near the size limit;
- common and pathological filter acceptance rates;
- unique arrays/maps with small domains;
- shrink-to-counterexample latency and allocation count;
- importing `Schema` before and after native Arbitrary integration;
- importing `effect/unstable/arbitrary/Arbitrary` alone compared with the current fast-check path.

Compare the Stream prototype with a specialized pull/attempt kernel. If the specialized implementation is materially
smaller or faster, it can replace the internals without touching Schema annotations or user code—that is precisely why
the public type must be opaque.

#### Materialized Schema arbitrary fixture pair

The existing `packages/tools/bundle/fixtures/schema-toArbitrary.ts` is not a valid legacy baseline for comparing the two
engines. It exports only `Schema.toArbitrary(schema)`, whose result is a lazy factory waiting to receive the fast-check
module. Consequently the fixture does not materialize a `fast-check.Arbitrary` and can omit fast-check from the bundle.
Keep that fixture, if useful, as a historical measurement of the legacy factory itself, but do not compare the native
engine against it.

Add two new fixtures together once the native derivation entry point exists:

```text
schema-toArbitrary-fast-check-materialized.ts
schema-toArbitrary-native-materialized.ts
```

They must duplicate the same representative Schema source so each remains a completely independent Rollup entry. The
Schema should cover a primitive constraint, a collection constraint, a declaration annotation, and recursion; for
example:

```ts
const schema = Schema.Struct({
  name: Schema.NonEmptyString,
  values: Schema.Array(Schema.Int).check(Schema.isLengthBetween(1, 4)),
  metadata: Schema.Option(Schema.String),
  tree: Schema.Tree(Schema.String)
})
```

The legacy fixture must force the second application:

```ts
import * as Schema from "effect/Schema"
import * as FastCheck from "fast-check"

// same schema definition

export const arbitrary = Schema.toArbitrary(schema)(FastCheck)
```

The native fixture must likewise export the fully derived opaque arbitrary rather than only a derivation factory:

```ts
import * as Schema from "effect/Schema"
import * as NativeSchemaArbitrary from "effect/unstable/arbitrary/Schema"

// identical schema definition

export const arbitrary = NativeSchemaArbitrary.toArbitrary(schema)
```

The exact native integration module name can follow the final entry-point decision; the materialization requirement
does not change. Neither fixture should call `sample`, `check`, or a property runner, because that would measure runner
surface in addition to construction of a Schema-derived arbitrary.

The relevant comparison is the two current absolute minified-and-gzipped sizes and their difference. The repository's
normal bundle comparison command compares each filename with the same filename on a base revision; it does not directly
subtract one fixture from the other. CI or the implementation report should therefore display both absolute rows and
explicitly calculate `native materialized - fast-check materialized`. If the native result is unexpectedly larger, run
bundle composition analysis on these exact two entry files before changing the public interface.

## Phased implementation

### Phase 0: additive annotation seam

- Add the namespaced native annotation key and typed helper without changing the existing `toArbitrary` annotation.
- Add an opt-in unstable Schema derivation entry point that reads only the native annotation.
- Keep the legacy compiler, public behavior, tests, and fast-check dependency unchanged.
- Allow built-in and user declarations to carry both local annotations.

Exit criterion: the same SchemaAST can be compiled independently by either implementation, and absence of a native
declaration annotation is reported explicitly rather than falling back to fast-check.

### Phase 1: private kernel prototype

- Implement a one-attempt `Generated | Discarded` carrier with a private Stream-backed Sample shrink tree, plus a
  faithful outer-Stream reference implementation for semantic comparison.
- Port the semantic algorithms for map, dependent flatMap, size, integer shrinking, and bounded greedy search.
- Add exhaustion accounting, productive recursion, SCC-wide complexity budgeting, and constraint pushdown immediately;
  otherwise the prototype cannot answer the hardest design questions.
- Benchmark against a specialized generation-attempt representation.

Exit criterion: laws, deterministic fixtures, mutual recursion, constraint pushdown, bounded residual filtering,
exhaustion, interruption, and resource safety pass; the representation choice is supported by measurements.

### Phase 2: unstable public native module and runner

- Add opaque `effect/unstable/arbitrary/Arbitrary` with the minimal construction surface and no stable alias.
- Add seedable sampling, sequential checking, structured results, and replay tokens.
- Add the JavaScript primitive and structural catalog needed by Schema.
- Keep parallel checking and generated functions out of the first release.

Exit criterion: native properties can be written without Schema or fast-check and failures minimize reproducibly within
one engine version.

### Phase 3: Schema compiler and annotations

- Add native annotations beside the existing fast-check annotations, migrating declarations incrementally.
- Preserve local declaration ownership and constraint/candidate semantics.
- Replace public terminal/depth state with hidden productivity analysis and size-decreasing recursion.
- Keep `Schema.toArbitrary` on the legacy path while the native module is unstable.
- Migrate the existing runtime and type-level Schema suites.

Exit criterion: every supported built-in Schema produces valid values through the opt-in native compiler, recursive
schemas are bounded, and differential validity tests pass without requiring equal values or shrink paths.

### Phase 4: testing integrations

- Move TestSchema to native sampling/checking.
- Move `@effect/vitest` `it.prop` to native Arbitrary/Schema inputs.
- Format Passed/Falsified/Exhausted results and include replay instructions.
- Remove the raw fast-check arbitrary overload and the nested `fastCheck` options.

Exit criterion: the native Effect test workflow has no fast-check runtime or type dependency.

### Phase 5: remove the old fast-check surface

- Remove the legacy `toArbitrary` annotation and compiler only after native coverage is complete.
- Remove `effect/testing/FastCheck`.
- Remove `fast-check` from `effect/package.json` and the native `@effect/vitest` path.
- Do not add a compatibility or adapter package unless a separate concrete use case appears later.

Promotion or renaming of the unstable Schema derivation entry point is a separate decision; coexistence does not require
claiming the stable `Schema.toArbitrary` name for the native implementation.

Because Effect v4 is still in release-candidate development, this is the least expensive point to make the annotation
and `it.prop` breaks explicit. A temporary deprecation window is possible, but the core package is not actually
decoupled until its fast-check dependency and re-export are removed.

## Licensing

ZIO is Apache-2.0 and the relevant source files carry Apache headers
([license](https://github.com/zio/zio/blob/series/2.x/LICENSE)). A close translation of `Gen.scala`, `Sample.scala`, or
their tests is a derivative work and requires preserving the applicable license and attribution, marking changes, and
shipping the Apache license obligations. An MIT repository can contain Apache-2.0 components, but those derived files
do not become MIT-only. This is not legal advice.

The lower-friction implementation path is to reimplement the documented semantics and independently write Effect tests
from behavioral requirements. If code or tests are translated closely, add explicit third-party notices and obtain the
project's normal legal review.

## Explicit non-goals

The first native implementation should not attempt to:

- reproduce fast-check v4 seeds, distributions, shrink paths, or counterexamples;
- promise stable generated sequences across Effect versions;
- expose `Sample`, shrink contexts, Stream channels, or a public arbitrary AST;
- design a universal tagless-final interface over every property-testing engine;
- support lossless conversion from Effect Arbitrary to synchronous fast-check Arbitrary;
- expose `terminal`, `DepthIdentifier`, or engine recursion bookkeeping in Schema annotations;
- use independent per-node recursion counters that reset across mutually recursive Schemas;
- implement every ZIO generator, Scala collection, temporal type, test aspect, or overload;
- implement parallel property checking before deterministic PRNG splitting exists;
- generate functions in the first release;
- treat filtering as the primary mechanism for satisfying Schema constraints;
- allow residual Schema filtering to run without an explicit attempt budget;
- use `Schedule` or mandatory Layers for ordinary run/shrink budgets.

## Final assessment

A ZIO-inspired native engine fits Effect v4 unusually well. The previous ZStream-to-Stream lineage matters because the
required semantics—lazy effectful generation, environment composition, scoped evaluation, and interruption—already
exist in Effect rather than needing to be simulated around fast-check.

The deepest module boundary is not `SchemaAST -> fast-check builder`; it is:

```text
Schema declaration annotation
        ↓ returns
opaque effect/unstable/arbitrary/Arbitrary
        ↓ interpreted by
Effect-native sampler and property runner
```

Port the ZIO `Gen`/`Sample` laws and use its implementation as a mature reference. Keep the carrier private, improve
exhaustion, replay, typed outcomes, and productive recursion, and implement JavaScript-specific generators natively.
That approach genuinely frees `effect` from fast-check v4 and v5 while retaining the feature that every Schema can
declare its own arbitrary locally.
