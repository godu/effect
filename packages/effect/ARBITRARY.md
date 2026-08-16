# Arbitrary in Effect

The `effect/unstable/arbitrary/Arbitrary` module derives generated values from Effect Schema and runs property checks
without exposing a third-party property-testing engine.

The module is currently unstable. Its import path, result types, generation policies, and replay format may change as
the implementation is exercised by more applications.

If you are upgrading from the fast-check bridge available in `effect@4.0.0-rc.109`, see the
[migration guide](ARBITRARY-MIGRATION.md).

## Getting Started

Use `Arbitrary.schema` to derive an `Arbitrary` from the decoded `Type` of a Schema, then use `Arbitrary.sampleEffect` to
generate values:

```ts
import { Effect, Schema } from "effect"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const Person = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  age: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 120 }))
})

const people = Arbitrary.schema(Person)

const program = Arbitrary.sampleEffect(people, {
  count: 20,
  seed: "people"
})

await Effect.runPromise(program)
// ReadonlyArray<{ readonly name: string; readonly age: number }>
```

The same seed, Schema, and options produce the same sequence of samples within the same implementation.

`Arbitrary` is intentionally opaque. Schema remains the public language for primitive and structural generation;
there is no second catalog of constructors such as `String` or `Array`. Existing Arbitraries can be composed with
`map`, `filter`, `filterMap`, and `Union`.

## Composing Arbitraries

Use `map` for total transformations, `filter` for predicates or refinements, and `filterMap` when transformation can
reject a value:

```ts
import { Result, Schema } from "effect"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const integers = Arbitrary.schema(Schema.Int)

const nonNegativeLabels = integers.pipe(
  Arbitrary.filter((value) => value >= 0),
  Arbitrary.map((value) => `integer:${value}`)
)

const positiveLabels = Arbitrary.filterMap(
  integers,
  (value) => value > 0 ? Result.succeed(`positive:${value}`) : Result.fail(value)
)
```

`map` transforms the complete shrink tree. `filter` and `filterMap` discard rejected roots, while rejected shrink
nodes are skipped and their valid descendants remain reachable. Root rejection is bounded by `maxDiscards`, so an
impossible predicate produces `SampleError` or `Exhausted` instead of searching forever.

Prefer Schema checks when they describe the domain directly. The Schema compiler may turn recognized checks into
constructive generation, while an arbitrary-level filter must first generate a candidate and then test it.

Use `Union` for static choice among existing Arbitraries:

```ts
const identifier = Arbitrary.Union([
  Arbitrary.schema(Schema.String),
  Arbitrary.schema(Schema.Int)
])
```

`Union` follows the generation policy of `Schema.Union`: it selects uniformly among members compatible with the
current recursion budget. During shrinking, a branch with a higher minimum cost first tries the earliest cheaper
member, then continues through its own shrink tree. The array must contain at least one member.

### Integrating Faker

External deterministic generators can be integrated by generating their seed as ordinary data and mapping it into a
fresh, locally seeded instance. Effect does not depend on Faker or expose its private Arbitrary PRNG:

```ts
import { base, en, Faker, generateMersenne53Randomizer } from "@faker-js/faker"
import { Effect, Schema } from "effect"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const FakerSeed = Arbitrary.schema(
  Schema.Finite.check(Schema.isUint32())
)

const fromFaker = <A>(generate: (faker: Faker) => A): Arbitrary.Arbitrary<A> =>
  FakerSeed.pipe(
    Arbitrary.map((seed) => {
      const faker = new Faker({
        locale: [en, base],
        randomizer: generateMersenne53Randomizer(seed)
      })
      return generate(faker)
    })
  )

const FixedNames = Arbitrary.schema(
  Schema.Literals(["Ada Lovelace", "Grace Hopper", "Edsger Dijkstra"])
)

const FakerNames = fromFaker((faker) => faker.person.fullName())

export const Name = Schema.NonEmptyString.annotate({
  arbitrary: () => Arbitrary.Union([FixedNames, FakerNames])
})

export const Person = Schema.Struct({
  name: Name,
  age: Schema.Int
})

const people = await Effect.runPromise(
  Arbitrary.sampleEffect(Arbitrary.schema(Person), { count: 20, seed: "people" })
)
```

The factory is evaluated eagerly when `Arbitrary.schema(Person)` is derived. The replacement changes only the exact
annotated occurrence, so other string fields keep their standard distribution. Every check attached to `Name`,
including checks added after the annotation, is still applied once to generated roots and shrink candidates.

If more than one `arbitrary` annotation occurs in a check chain, the outermost one wins. Setting an outer annotation to
`undefined` clears an inner override. An override on a containing Schema replaces its complete subtree, so child
override factories are not evaluated.

A fresh Faker instance for each generated or shrink value prevents mutable Faker state from leaking across replay or
concurrent checks. Reproduction requires the Faker version, locale data, callback, and other inputs to remain fixed.
Date-related Faker generators should also receive a fixed reference date. Shrinking the seed is deterministic, but it
does not guarantee a semantically simpler generated value.

Combinator callbacks must be synchronous, deterministic, terminating, and must not mutate generated values. They may
be evaluated again during shrinking and replay. A thrown exception remains a defect of the `Effect` returned by
`sampleEffect` or `checkEffect`.

## Checking Properties

`Arbitrary.checkEffect` evaluates a pure or Effectful property and shrinks the first failure it finds:

```ts
import { Effect, Schema } from "effect"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const values = Arbitrary.schema(Schema.Array(Schema.Int))

const program = Arbitrary.checkEffect(
  values,
  (input) => input.slice().reverse().reverse().every((value, index) => value === input[index]),
  { runs: 100, seed: "reverse" }
)

await Effect.runPromise(program)
// { _tag: "Passed", runs: 100, discards: 0 }
```

An Effectful property may use services and may fail with a typed error:

```ts
import { Effect, Schema } from "effect"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const program = Arbitrary.checkEffect(
  Arbitrary.schema(Schema.String),
  (value) => Effect.succeed(value.length >= 0)
)
```

A property failure is data rather than a thrown assertion. Inspect the `_tag` of the returned `CheckResult`:

| Result           | Meaning                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `Passed`         | Every requested run passed.                                                                    |
| `Falsified`      | A property returned `false` or its Effect failed. Includes the minimized counterexample found. |
| `Exhausted`      | Generation exceeded `maxDiscards` before completing the requested runs.                        |
| `ReplayMismatch` | A replay token no longer identifies the same failure or shrink path.                           |

When an Effectful property fails, `Falsified.failure` is a `PropertyError` containing the typed error. Returning
`false` produces `ReturnedFalse`.

Defects and fiber interruption are not converted into `CheckResult` values. They continue through the Effect returned
by `checkEffect`. This means a property check can be interrupted normally by an Effect timeout, a test timeout, or its
parent fiber.

Properties must be deterministic for the same input and environment. They must also treat generated values as
immutable. The runner may evaluate a value more than once while shrinking or replaying, and it does not clone values or
restore mutated services between evaluations.

## Replaying a Failure

Every `Falsified` result contains an opaque `replay` token. The token identifies both the original generated value and
the complete shrink path that led to the reported counterexample:

```ts
import { Effect, Schema } from "effect"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const arbitrary = Arbitrary.schema(Schema.Int)

const program = Effect.gen(function*() {
  const first = yield* Arbitrary.checkEffect(arbitrary, (value) => value < 10, {
    seed: "integer-bound"
  })

  if (first._tag === "Falsified") {
    const replayed = yield* Arbitrary.checkEffect(
      arbitrary,
      (value) => value < 10,
      { replay: first.replay }
    )
    return replayed
  }

  return first
})
```

Store the token in logs or failure output when you need to reproduce a failure locally. Replay compatibility is not
guaranteed across releases of this unstable module. For a permanent regression test, add the materialized
counterexample as an ordinary example-based test.

A `ReplayMismatch` is returned when the Schema, property, or implementation has changed enough that the recorded
attempt or shrink path no longer reproduces the same failure.

## Sampling Options

`Arbitrary.sampleEffect` accepts the following options:

| Option        | Default                      | Meaning                                                      |
| ------------- | ---------------------------- | ------------------------------------------------------------ |
| `count`       | `10`                         | Number of values to return.                                  |
| `size`        | `10`                         | Complexity budget for each generated value.                  |
| `maxDiscards` | `max(100, count * 10)`       | Maximum rejected attempts before failing with `SampleError`. |
| `seed`        | A value from Effect `Random` | String or number used to reproduce the generated sequence.   |

If generation exhausts its discard budget, the Effect fails with a `SampleError` containing the number of values that
were generated and the number of discarded attempts.

## Check Options

`Arbitrary.checkEffect` accepts the following options:

| Option        | Default                      | Meaning                                                                |
| ------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `runs`        | `100`                        | Number of successful generations and property evaluations to complete. |
| `size`        | `10`                         | Maximum complexity budget. It grows with completed runs.               |
| `maxDiscards` | `max(100, runs * 10)`        | Maximum rejected attempts before returning `Exhausted`.                |
| `maxShrinks`  | `100`                        | Maximum candidate evaluations while shrinking a failure.               |
| `seed`        | A value from Effect `Random` | String or number used to reproduce generation.                         |
| `replay`      | None                         | Opaque token from a previous `Falsified` result.                       |

Discarded attempts do not count as completed runs and do not advance the progressive size. When `runs` is `1`, the
configured `size` is used directly.

`size` is a generation budget, not a universal collection-length limit. Required Schema members and explicit minima
are still honored, while explicit maxima clamp generation.

## How Schema Derivation Works

`Arbitrary.schema` generates the decoded `Type` of the input Schema. For example, deriving from
`Schema.NumberFromString` generates numbers, not encoded strings.

Derivation is eager. If the current implementation cannot derive a generator, `Arbitrary.schema` throws immediately
instead of returning an `Arbitrary` that fails later.

### Constraints and Filters

The compiler understands common Schema checks constructively, including:

- numeric and ordered bounds;
- finite and integer numbers;
- string, collection, and property-count bounds;
- supported regular-expression patterns;
- uniqueness constraints.

Constructive generation narrows the source domain before producing a value. Other custom checks remain authoritative
and are applied as residual filters. A candidate rejected by a residual filter is a discard.

Discarding is always bounded by `maxDiscards`. An impossible or extremely selective custom filter therefore produces
`SampleError` or `Exhausted` instead of leaving the runner searching indefinitely for a value.

### Recursive Schemas

Recursive and mutually recursive Schemas are supported when every recursive component has a finite generation path:

```ts
import { Schema } from "effect"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

interface Node {
  readonly value: string
  readonly children: ReadonlyArray<Node>
}

const Node: Schema.Codec<Node> = Schema.Struct({
  value: Schema.String,
  children: Schema.Array(Schema.suspend(() => Node)).check(Schema.isMaxLength(3))
})

const nodes = Arbitrary.schema(Node)
```

The empty `children` array is a finite path, so the Schema is productive. The compiler analyzes mutually recursive
components together and shares a per-sample budget across each component. This prevents recursive siblings from each
spending the full budget independently.

If a recursive component has no finite route, derivation throws immediately. The caller does not need to provide a
terminal arbitrary, a depth identifier, or another recursion-specific annotation.

### Declaration Schemas

For a `Schema.declare` or another opaque declaration, the compiler resolves a generation representation in this order:

1. `toCodecArbitrary`;
2. `toCodecJson`;
3. `toCodec`.

Most declarations with a useful canonical codec need no arbitrary-specific annotation. Add `toCodecArbitrary` only
when the canonical representation is opaque or is statistically unsuitable for generation.

If a `toCodecJson` annotation is present but returns `undefined`, the declaration is explicitly JSON-canonical and
opaque. Derivation fails rather than falling through to `toCodec`.

`toCodecArbitrary` returns a Schema `Link`, not an `Arbitrary`. The source Schema describes a representation that can
be generated constructively, and the transformation decodes that representation into the declaration type:

```ts
import { Schema, SchemaTransformation } from "effect"

class UserId {
  readonly value: number
  constructor(value: number) {
    this.value = value
  }
}

const UserIdSchema = Schema.instanceOf(UserId, {
  toCodecArbitrary: () =>
    Schema.link<UserId>()(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
      SchemaTransformation.transform({
        decode: (value) => new UserId(value),
        encode: (id) => id.value
      })
    )
})
```

The compiler validates decoded candidates against the original declaration. A partial Link is allowed: unsuccessful
decodes or values rejected by the declaration become bounded discards, and valid descendants remain available while
shrinking.

The callback also receives:

- decoded `typeParameters` for parametric declarations;
- normalized recognized `constraint` values for the declaration;
- a closed `schemas` palette for Effect-owned built-ins such as `Json`, `RegExp`, `URL`, `Date`, and `Uint8Array`.

The palette also provides `Array(Item, options)` for declaration representations backed by arrays. Its options support
constructive length bounds and uniqueness by a selected value, such as a Map entry key.

The palette lets built-ins choose efficient generation representations without exposing a constructor registry or an
arbitrary builder to application code.

## Using `@effect/vitest`

`@effect/vitest` accepts tuple or struct collections containing Schemas, Arbitraries, or both:

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const Name = Arbitrary.schema(Schema.Literals(["Ada", "Grace"]))

it.prop(
  "integer addition is commutative",
  [Schema.Int, Schema.Int],
  ([a, b]) => a + b === b + a,
  { arbitrary: { runs: 200, seed: "addition" } }
)

it.effect.prop(
  "generated values can be checked in an Effect",
  { name: Name, value: Schema.Int },
  ({ name, value }) =>
    Effect.sync(() => {
      assert.include(["Ada", "Grace"], name)
      assert.isTrue(Number.isInteger(value))
    }),
  { arbitrary: { runs: 50 } }
)
```

Raw fast-check arbitraries and the `fastCheck` options object are not supported. Use Arbitraries when a property input
needs composition beyond a Schema.

`@effect/vitest` turns `Falsified`, `Exhausted`, and `ReplayMismatch` results into test failures. Falsified output
includes the minimized counterexample and replay token.

## Current Scope

The unstable module intentionally keeps its constructor surface small. It does not currently expose:

- a public arbitrary constructor catalog or dependent `flatMap`;
- assertion formatting outside the `@effect/vitest` integration;
- parallel property evaluation;
- a replay compatibility guarantee across releases.

These boundaries keep generation semantics owned by Schema while leaving the internal generator and shrink
representation replaceable.
