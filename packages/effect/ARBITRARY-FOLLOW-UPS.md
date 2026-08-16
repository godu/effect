# Native Arbitrary Follow-ups

The native Schema-first Arbitrary implementation is complete. Further work should proceed as independently
verifiable slices rather than as one combined redesign. Each slice must preserve the module's existing guarantees:

- Schema remains the only catalog of primitive and structural generator constructors;
- discarded roots are bounded by `maxDiscards`;
- shrinking and replay remain deterministic for supported pure callbacks;
- recursive and mutually recursive Schemas retain their productivity guarantees;
- `Sample`, `Pull`, the PRNG, generation budgets, and Schema compiler metadata remain private;
- runtime performance and bundle cost are measured before and after every slice.

## Approved direction

The next public interface should grow in this order:

```text
schema
  -> map, filter, filterMap
  -> Union
  -> Schema-local override
  -> flatMap
```

`map`, `filter`, `filterMap`, `Union`, and `flatMap` compose existing Arbitraries. They do not introduce a public
catalog of primitive or collection constructors alongside Schema.

The following architectural decisions are settled:

- Schema-local customization is a direct replacement of the generator for the exact annotated Schema, not a callback
  that transforms an implicit default Arbitrary;
- checks directly attached to the annotated node remain authoritative and are applied once as residual filters;
- a Schema that captures an external generator such as Faker accepts that dependency's production bundle cost;
- static choice is named `Union` and receives its members as an array, matching `Schema.Union`;
- `flatMap` shrinks the source first and the selected dependent value second; after a dependent shrink is selected, the
  source is closed rather than reopened;
- ZIO's source-reopening topology and a replayable replacement for the current one-shot `Pull` are not required.

## Prioritized implementation path

| Priority | Slice                                   | Relative complexity | Main result                                                |
| -------- | --------------------------------------- | ------------------- | ---------------------------------------------------------- |
| P0       | Baseline and existing bundle regression | Small               | Reliable comparison point                                  |
| P1       | Private `Generator` seam                | Small to medium     | Schema compiler metadata stays local to the compiler       |
| P2       | `map`, `filter`, and `filterMap`        | Medium              | General transformation and bounded residual rejection      |
| P3       | `Union` and seeded external generators  | Medium              | Static choice and a userland Faker integration             |
| P4       | Direct Schema-local override            | Medium to large     | Nested distribution customization without paths/registries |
| P5       | Single-pass `flatMap`                   | Large               | Dependent generation with deterministic shrinking/replay   |
| P6       | Quality and optimization research       | Evidence-dependent  | Diagnostics, generation quality, and later optimizations   |

Each phase should be implemented as one coherent slice after its architectural decisions are approved. Do not land a
series of partially usable internal mechanisms.

## P0: baseline and existing bundle regression

Use the current branch as a baseline, then make the existing bundle regression the first isolated production slice:

1. run the complete Arbitrary runtime-performance family on the current `HEAD` and record the commit and result
   artifact;
2. retain all 16 warm native/fast-check comparisons and the existing cold scenario;
3. run the complete bundle comparison and record exact results for `config.ts` and `schema-toArbitrary.ts`;
4. eliminate the current approximately `0.16 KB` `config.ts` regression as an isolated production slice;
5. rerun the runtime and bundle baselines on that slice's final commit;
6. run the existing Arbitrary tests, typetests, and package checks.

Previous ablations identified the URL generation Link captured by `Schema.URL` as the source of the `config.ts`
regression. They also showed that moving every built-in Link into the palette imposes a much larger fixed cost on every
Arbitrary consumer, while replacing URL generation with one general RegExp materially slows sampling. Revalidate those
results on the current `HEAD`; start from the narrow URL-only relocation, but present its exact `config.ts` and
`schema-toArbitrary.ts` tradeoff before applying it.

The performance table in the current changeset is a historical reference, not the baseline for these follow-ups. The
latest recorded measurements outperform the equivalent fast-check fixture in all 16 reported warm scenarios, so
further optimization work must be driven by a new measurement rather than by the old profiling tasks.

Exit gate:

- reproducible before/after runtime and bundle baselines tied to exact commits;
- existing seeded samples, counterexamples, shrink counts, and replay tests recorded as characterization tests;
- no production changes beyond the isolated `config.ts` regression fix.

## P1: private `Generator` seam

### Rationale

`Model.Compiled` currently mixes two responsibilities:

- the executable generator required by `Arbitrary`, `sample`, and `check`;
- the mutable dependency and fixed-point metadata required only while compiling Schema.

Separate them behind a private seam:

```ts
interface Generator<A> {
  readonly minCost: number
  readonly generate: (state: GenerationState) => Generation<A>
}

interface Compiled<A> extends Generator<A> {
  minCost: number
  generate: (state: GenerationState) => Generation<A>
  recursive: boolean
  mayRecurse: boolean
  dependencies: ReadonlyArray<Compiled<any>>
  computeMinCost: () => number
}
```

`Arbitrary.gen`, the private constructor, and the runner depend only on `Generator`. The Schema compiler continues to
construct `Compiled` values and mutate placeholders while resolving recursion and minimum costs. A finalized
`Compiled` and a generator produced by a combinator become the two adapters at this private seam.

This change is behavior-neutral. It must not alter random consumption, budgets, generated values, shrinking, or replay.

Exit gate:

- every existing seeded behavior remains identical;
- all existing runtime scenarios remain within measurement noise;
- all unrelated bundle fixtures are unchanged;
- no compiler metadata is added to the public `Arbitrary` interface.

## P2: `map`, `filter`, and `filterMap`

### Public interface

Add dual/data-last functions usable through `pipe`:

```ts
export const map: {
  <A, B>(f: (value: A) => B): (self: Arbitrary<A>) => Arbitrary<B>
  <A, B>(self: Arbitrary<A>, f: (value: A) => B): Arbitrary<B>
}

export const filter: {
  <A, B extends A>(refinement: Refinement<A, B>): (self: Arbitrary<A>) => Arbitrary<B>
  <A>(predicate: Predicate<A>): <B extends A>(self: Arbitrary<B>) => Arbitrary<B>
  <A, B extends A>(self: Arbitrary<A>, refinement: Refinement<A, B>): Arbitrary<B>
  <A>(self: Arbitrary<A>, predicate: Predicate<A>): Arbitrary<A>
}

export const filterMap: {
  <A, B, X>(f: Filter.Filter<A, B, X>): (self: Arbitrary<A>) => Arbitrary<B>
  <A, B, X>(self: Arbitrary<A>, f: Filter.Filter<A, B, X>): Arbitrary<B>
}
```

`filterMap` can express both mapping and filtering algebraically, but `map` and `filter` keep specialized
implementations. The common paths should not allocate or inspect a `Result` unnecessarily.

### Semantics

`map` transforms the current value and every node in its existing shrink tree. It preserves candidate order, duplicate
positions, tree shape, random consumption, budget, and replay coordinates. It can reuse `Model.mapSample`.

`filter` and `filterMap` use bounded residual rejection:

- a rejected root becomes `Discarded` and counts against `maxDiscards`;
- a rejected shrink node is omitted and its descendants are promoted;
- hidden traversal through rejected shrink nodes does not count as a new attempt;
- `maxShrinks` bounds property evaluations, not the number of hidden rejected nodes inspected while finding the next
  accepted candidate;
- traversal remains lazy and interruptible.

The failure value `X` from `filterMap` is initially discarded. It can be retained later by structured discard
diagnostics without changing the combinator's type.

When a condition can be expressed as a Schema constraint, callers should prefer the Schema because the compiler may
generate constructively. These combinators are the escape hatch after `map`, `flatMap`, or an external deterministic
generator.

### Callback contract

Callbacks are synchronous, deterministic, terminating, and free of externally observable side effects. They may be
evaluated again during shrinking and replay.

- reading time, `Math.random`, or mutable external state is unsupported;
- mutating a generated value is unsupported;
- thrown exceptions become defects of the `Effect` returned by `sample` or `check`;
- callback invocation counts are not part of the interface.

### Verification

- dual/data-last typing and refinement inference;
- complete-tree mapping and non-injective mapping without deduplication;
- bounded reject-all behavior for both `sample` and `check`;
- promotion of accepted descendants through rejected nodes;
- successful transformation and rejection through `filterMap`;
- deterministic seed and replay;
- callback defects and interruption;
- warm scenarios for mapping, passing filtering, selective filtering, and `filterMap`;
- focused bundle fixture, with all Schema-only and unrelated fixtures unchanged.

## P3: `Union` and seeded external generators

### `Union`

`Union` combines a non-empty array of existing Arbitraries:

```ts
const NameDistribution = Arbitrary.Union([
  FixedNames,
  FakerNames
])
```

It does not accept `Schema.Union`'s `mode` option. Schema's option controls validation, while this constructor selects a
generation branch.

Recommended semantics to validate and approve during the P3 prototype:

- select members uniformly;
- derive the static minimum from the member minima and top up the selected member when its minimum is larger than the
  residual budget;
- preserve the selected member's own shrink tree;
- do not introduce cross-member shrinking in the first implementation;
- keep selection and replay deterministic.

Uniform weighting, the absence of cross-member shrinking, and the exact budget policy are not yet settled architectural
decisions. The prototype must measure them and present the alternatives before the public implementation. If the
recommended budget top-up is approved, implement it as a private helper reusable by `flatMap`.

### Faker and similar libraries

External deterministic libraries remain userland adapters. Effect does not add a Faker dependency, Faker-specific
constructor, or public access to the private Arbitrary PRNG. Generate a seed as ordinary data and map it into a fresh,
locally seeded external generator:

```ts
import { base, en, Faker, generateMersenne53Randomizer } from "@faker-js/faker"
import * as Schema from "effect/Schema"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const FakerSeed = Arbitrary.schema(
  Schema.Finite.check(Schema.isUint32())
)

const fromFaker = <A>(generate: (faker: Faker) => A): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(FakerSeed, (seed) => {
    const faker = new Faker({
      locale: [en, base],
      randomizer: generateMersenne53Randomizer(seed)
    })
    return generate(faker)
  })
```

A fresh instance per generated or shrink node isolates mutable Faker state across replay and concurrent checks. The
same Arbitrary replay token reproduces the same seed and external call only while the external library version, locale
data, callback, and other inputs remain fixed. Date-related generators must also use a fixed reference date.

Shrinking smaller seeds is deterministic but does not promise semantically simpler external values. Measure external
generator construction during sampling and shrinking before adding any convenience helper.

Exit gate:

- `Union` selection, budget, shrinking, and replay tests;
- same-seed and replay coverage for a local external generator adapter;
- independent concurrent checks, seed `0`, and fixed reference-date coverage;
- runtime comparison with equivalent static-choice generation;
- unrelated Effect and Schema bundle fixtures remain unchanged.

## P4: direct Schema-local override

### Required experience

Customization is attached to the exact Schema before that Schema is embedded in a containing structure:

```ts
const FixedNames = Arbitrary.schema(
  Schema.Literals(["Ada Lovelace", "Grace Hopper", "Edsger Dijkstra"])
)

const FakerNames = fromFaker((faker) => faker.person.fullName())

export const Name = Schema.NonEmptyString.pipe(
  Arbitrary.override(
    Arbitrary.Union([FixedNames, FakerNames])
  )
)

export const Person = Schema.Struct({
  name: Name,
  age: Schema.Int
})

const PersonArbitrary = Arbitrary.schema(Person)
```

Only the `name` occurrence uses the custom distribution. Other `Schema.String` or `Schema.NonEmptyString` occurrences
continue to use standard generation.

The helper belongs to `effect/unstable/arbitrary/Arbitrary` and stores a private annotation. Stable Schema source must
not import or expose the unstable `Arbitrary` type. The annotation must be excluded from Schema persistence.

### Semantics

The override replaces the default generator for that exact Schema. For `Schema.NonEmptyString`, the compiler
conceptually:

1. resolves the override on the annotated Schema;
2. uses the supplied `Arbitrary<string>` instead of the ordinary `String` generator;
3. applies the `NonEmptyString` check once to roots and shrink nodes.

The replacement is trusted to produce the declared Type. The compiler does not run the complete Schema parser for
every sample. It continues to enforce the checks directly attached to the annotated node, so a replacement cannot
bypass `NonEmptyString`, a pattern, or another local refinement on that node. Structural correctness and checks nested
inside a composite Type remain the replacement Arbitrary's contract.

The initial interface deliberately does not expose the compiler's default Arbitrary to the override. Combining an
already derived `Arbitrary.schema(BaseName)` with the replacement would cause the outer compiler to run `BaseName`'s
checks again. Supporting augmentation without duplicate validation would require private branch provenance and is a
separate follow-up. The approved fixed-names/Faker use case supplies a complete replacement and does not require it.

### Scope and bundle consequences

Schemas are immutable. The override must be applied before `Name` is embedded in `Person`; annotating another `Name`
value later cannot alter the AST already stored by `Person`. A plain alias such as `const Name = Schema.String` also has
no runtime identity distinct from another use of the same singleton until a new annotated Schema is created.

An override that captures Faker makes Faker and its locale data reachable from the production module exporting that
Schema. This is an accepted opt-in cost. Avoiding it would require a provider, registry, path override, or rebuilding
the containing Schema, none of which belong to the initial interface.

### Compiler spike and verification

Before exposing `override`, prototype the compiler integration against:

- a checked leaf nested in `Person`;
- root and shrink outputs that fail `NonEmptyString`;
- a custom check, verifying that it runs once;
- an override inside recursive and mutually recursive containing Schemas;
- an override supplied by `Arbitrary.schema` on a recursive Schema;
- eager derivation errors and accidental self-reference;
- deterministic sampling, shrinking, and replay;
- bounded exhaustion when the replacement has zero density;
- annotations placed before and after checks, plus repeated overrides; the precedence rule must be presented for
  approval if it is not already implied by ordinary Schema annotation ordering;
- exclusion from persisted Schema annotations.

The private wrapper must preserve the replacement's finalized `minCost`. A replacement derived from a recursive Schema
already owns its finalized compilation graph. The prototype must verify that it can remain opaque to the containing
Schema compiler; if it cannot, stop rather than adding graph metadata to the public `Arbitrary` interface.

Exit gate:

- the `Person.name` experience above works without a field path, registry, or provider;
- checks directly attached to the annotated node remain authoritative and execute once;
- recursive containing Schemas retain productivity;
- no full-parser validation is added per sample;
- Schema fixtures that do not opt into the override are bundle-invariant;
- the opting-in fixture reports the complete Arbitrary and Faker cost.

## P5: single-pass `flatMap`

### Public interface

```ts
export const flatMap: {
  <A, B>(f: (value: A) => Arbitrary<B>): (self: Arbitrary<A>) => Arbitrary<B>
  <A, B>(self: Arbitrary<A>, f: (value: A) => Arbitrary<B>): Arbitrary<B>
}
```

Generation is sequential:

1. generate the source `Sample<A>`;
2. evaluate `f(source.value)`;
3. generate the selected `Sample<B>`;
4. expose `B` as the composed value.

The callback follows the same pure, synchronous, deterministic, and terminating contract as the P2 combinators. This
slice does not add a public recursion constructor for Arbitrary; recursive Schema-derived source and dependent
Arbitraries remain in scope.

Calling `Arbitrary.schema` inside the callback recompiles that Schema whenever the callback is evaluated. For finite
dependent domains, callers can precompile the possible Arbitraries. The prototype must measure dynamic compilation and
decide whether to document it as normal usage or discourage it; it must not add implicit memoization or a registry.

### Shrinking

Use a single-pass source-first topology:

1. try source shrinks, regenerating the dependent Arbitrary for each smaller source value;
2. then try shrink candidates from the currently selected dependent sample;
3. a selected source shrink retains its own further source shrinks;
4. after selecting a dependent shrink, do not reopen the source.

Conceptually:

```text
b
|- f(a1)
|  |- f(a2)
|  `- ...
`- b1
   `- dependent shrinks only
```

Under deterministic callbacks, property evaluation, and PRNG checkpoints, reopening `f(a1)` below `b1` would emit the
same candidate already tried at the parent. It cannot discover a new result and would only require a replayable source
tree. The current one-shot `Pull` therefore remains sufficient.

If the dependent generator for a source shrink returns `Discarded`, omit that node and promote the source sample's
descendants. Do not retry internally. An initial source or dependent discard rejects the complete attempt and counts
against `maxDiscards`; shrink-time discards are hidden traversal and do not count as attempts.

### PRNG and budget isolation to prototype

The recommended implementation adds checkpoint and clone operations to the private xoshiro implementation without
changing its draw algorithm:

- with `shrinks: false`, generate source and dependent directly against the enclosing state and allocate no checkpoint;
- with `shrinks: true`, generate the source in an isolated state and capture a checkpoint after source generation;
- the initial dependent and every source-shrink dependent receive independent clones of that post-source checkpoint;
- commit only the initial dependent's final PRNG and budget to the enclosing state;
- lazy shrink branches never mutate their siblings or the enclosing generation state.

Checkpointing after the source means that a smaller source value changes the dependent constraint while retaining the
same subsequent random choices. Fast-check instead checkpoints before the source. The P5 prototype must compare these
two policies on deterministic output, shrinking quality, runtime, and bundle cost, then present the choice for approval.
Add an attribution comment if the implementation follows fast-check's code or strategy.

The recommended budget policy is:

```text
r = budget remaining after the source
m = dependent minimum cost
dependent budget = r + m
committed budget = min(r, dependent remaining budget)
```

The corresponding static `flatMap` minimum is the source minimum. The clamp prevents an unused dependent minimum-cost
top-up from becoming additional optional size. Every source-shrink branch starts from the same residual allowance plus
its own dependent minimum and never commits its state. This policy is not settled: the prototype must compare it with
giving the dependent generator an independent size allowance, then present the productivity, output-size, and nested
`flatMap` tradeoffs for approval.

### Verification

- source-controlled target length or bounds;
- source and dependent shrinking in the specified order;
- source remains available below a selected source shrink;
- source is never reevaluated below a selected dependent shrink;
- initial source and dependent discards;
- promotion through a discarded source-shrink dependent branch;
- all-discard shrink frontier terminates and long promotion remains interruptible;
- deterministic seed and replay through source, dependent, and promoted branches;
- dependent minimum larger than the residual budget at size zero;
- nested `flatMap` does not amplify optional size;
- recursive and mutually recursive Schema-derived source and dependent Arbitraries;
- dependent defects and interruption;
- sampling allocates neither checkpoints nor new shrink carriers;
- warm sampling, dependent collection, failure, shrinking, and replay scenarios;
- focused bundle fixture and no regression to unrelated fixtures.

## Verification policy for public phases

Every public phase must pass:

- the focused Arbitrary runtime test file;
- Arbitrary typetests;
- package type checking and linting;
- all existing runtime scenarios, investigating every regression outside measurement noise;
- a focused runtime scenario for the new interface;
- the complete bundle comparison plus a focused new fixture;
- exact seeded replay tests for the new behavior;
- existing recursive and mutually recursive Schema tests.

The runtime registry currently pairs every Arbitrary scenario with a fast-check implementation. New scenarios should
provide a meaningful fast-check counterpart where one exists. If a native-only invariant has no equivalent, add it to
an explicitly separate diagnostic suite rather than weakening the paired registry silently.

Update public JSDoc, [ARBITRARY.md](ARBITRARY.md), the migration guide, and the changeset only after the relevant phase
passes its semantic, runtime, and bundle gates.

## Independent research backlog

These are separate projects and must not block the prioritized path above:

1. add structured discard reasons and runner health diagnostics after `filterMap` creates a concrete failure payload to
   preserve;
2. evaluate private finite-domain metadata when constructive `unique` generation demonstrates real exhaustion cases;
3. profile decoded collection and Declaration Links only if the new baseline identifies a regression;
4. audit boundary-oriented distributions across the complete Schema catalog without attempting to imitate every
   fast-check frequency;
5. compare the current `Sample` tree with trace-informed shrinking and private structural spans;
6. evaluate automatic persistence and reuse of concrete counterexamples last.

Concrete counterexample persistence is distinct from replay-token persistence. After `map` or `flatMap`, an Arbitrary
may no longer have a Schema or codec capable of serializing its output, while the existing opaque replay token remains
persistable.

The current public interface and migration guidance are documented in [ARBITRARY.md](ARBITRARY.md) and
[ARBITRARY-MIGRATION.md](ARBITRARY-MIGRATION.md).
