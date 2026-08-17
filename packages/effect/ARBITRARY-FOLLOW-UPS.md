# Native Arbitrary Follow-ups

The native Schema-first Arbitrary implementation is complete. Further work should proceed as independently
verifiable slices rather than as one combined redesign. Each slice must preserve the module's existing guarantees:

- Schema remains the only catalog of primitive and structural generator constructors;
- discarded roots are bounded by `maxDiscards`;
- inspected shrink candidates, including rejected nodes, are bounded by `maxShrinks`;
- shrinking and replay remain deterministic for supported pure callbacks;
- recursive and mutually recursive Schemas retain their productivity guarantees;
- `Sample`, `Pull`, the PRNG, generation budgets, and Schema compiler metadata remain private;
- runtime performance and bundle cost are measured before and after every slice.

## Approved direction

The public interface is growing in this order:

```text
schema
  -> map, filter, filterMap [implemented]
  -> Union [implemented]
  -> Schema-local `arbitrary` annotation [implemented]
  -> flatMap [implemented]
```

`map`, `filter`, `filterMap`, `Union`, and `flatMap` compose existing Arbitraries. They do not introduce a public
catalog of primitive or collection constructors alongside Schema.

The following architectural decisions are settled:

- Schema-local customization uses a public `arbitrary` factory that returns a complete replacement generator for the
  exact annotated Schema; the factory does not receive the implicit default Arbitrary;
- checks directly attached to the annotated node remain authoritative and are applied once as residual filters;
- a Schema that captures an external generator such as Faker accepts that dependency's production bundle cost;
- static choice is named `Union` and receives its members as an array, matching `Schema.Union`;
- `flatMap` shrinks the source first and the selected dependent value second; after a dependent shrink is selected, the
  source is closed rather than reopened;
- rejected shrink nodes remain observable to the runner exactly once, so `maxShrinks` bounds descendant promotion
  without evaluating the property for those nodes;
- ZIO's source-reopening topology and a replayable replacement for the current one-shot `Pull` are not required.

## Prioritized implementation path

| Priority | Slice                                   | Status                             | Main result                                                |
| -------- | --------------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| P0       | Baseline and existing bundle regression | Complete                           | Reliable comparison point                                  |
| P1       | Private `Generator` seam                | Complete                           | Schema compiler metadata stays local to the compiler       |
| P2       | `map`, `filter`, and `filterMap`        | Complete                           | General transformation and bounded residual rejection      |
| P3       | `Union` and seeded external generators  | `Union` complete; adapter userland | Static choice and a userland Faker integration             |
| P4       | Schema-local `arbitrary` annotation     | Complete                           | Nested distribution customization without paths/registries |
| P5       | Single-pass `flatMap`                   | Complete                           | Dependent generation with deterministic shrinking/replay   |
| P6       | Quality and optimization research       | Pending                            | Diagnostics, generation quality, and later optimizations   |

Each phase should be implemented as one coherent slice after its architectural decisions are approved. Do not land a
series of partially usable internal mechanisms.

## P0: baseline and existing bundle regression

Use the current branch as a baseline, then make the existing bundle regression the first isolated production slice:

1. run the complete Arbitrary runtime-performance family on the current `HEAD` and record the commit and result
   artifact;
2. retain all 22 warm native/fast-check comparisons and the existing cold scenario;
3. run the complete bundle comparison and record exact results for `config.ts` and `schema-toArbitrary.ts`;
4. record the measured `config.ts` result as the initial production-bundle baseline;
5. use the current commit as the bundle baseline for subsequent slices;
6. run the existing Arbitrary tests, typetests, and package checks.

The comparison at `6fd1d0d1` measured `config.ts` at 21.26 KB versus 21.10 KB on `main`, a 0.16 KB gzip increase. P0
accepted that result provisionally to avoid a URL-only special case. The later holistic Declaration-seam review resolved
the underlying issue uniformly: Effect-owned built-in representations moved into the Arbitrary compiler, while the
public palette was eliminated.

The performance table at the P0 baseline was a historical reference, not the baseline for later slices. At that
baseline, the recorded measurements outperformed the corresponding fast-check fixture in all 22 reported warm
scenarios, so further optimization work had to be driven by a new measurement rather than by the old profiling tasks.

Exit gate:

- reproducible before/after runtime and bundle baselines tied to exact commits;
- existing seeded samples, shrunk inputs, shrink counts, and replay tests recorded as characterization tests;
- no production change for the accepted `config.ts` delta.

## P1: private `Generator` seam

### Rationale

`Model.Compiled` currently mixes two responsibilities:

- the executable generator required by `Arbitrary`, `sampleEffect`, and `checkEffect`;
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

Implementation result: `Arbitrary.gen`, combinators, and the runner now depend only on `Generator`; mutable dependency
and fixed-point fields remain on `Compiled`. The complete existing seeded test suite is unchanged. The focused
`schema-toArbitrary.ts` fixture moved from 33.48 KB to 33.49 KB gzip, a measured +0.01 KB (+0.04%).

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
- hidden traversal through rejected shrink nodes does not count as a new attempt or evaluate the property;
- every inspected shrink node consumes one unit of the shared `maxShrinks` budget, including rejected nodes;
- nested filters propagate one `Discarded` event, so a node consumes the budget once rather than once per combinator;
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
- thrown exceptions become defects of the `Effect` returned by `sampleEffect` or `checkEffect`;
- callback invocation counts are not part of the interface.

### Verification

- dual/data-last typing and refinement inference;
- complete-tree mapping and non-injective mapping without deduplication;
- bounded reject-all behavior for both `sampleEffect` and `checkEffect`;
- promotion of accepted descendants through rejected nodes;
- successful transformation and rejection through `filterMap`;
- deterministic seed and replay;
- callback defects and interruption;
- warm scenarios for mapping, passing filtering, selective filtering, and `filterMap`;
- focused bundle fixture, with all Schema-only and unrelated fixtures unchanged.

Implementation result: runtime tests cover complete-tree mapping, bounded root rejection, a total shrink-candidate
budget, descendant promotion, transformation, replay, defects, and `Union` parity separately. Type tests cover both
dual forms and refinement inference. In the five-round Node 24 matrix, native `map`, passing `filter`, selective
`filter`, and `filterMap` measured
12.98, 12.96, 39.44, and 28.12 microseconds respectively, versus 65.78, 62.00, 64.15, and 72.63 microseconds for the
equivalent fast-check v4 operations. The later filtered-failure scenario, including rejected shrink candidates,
measured 7.18 microseconds native versus 12.98 microseconds for fast-check v4. The focused
`arbitrary-combinators.ts` fixture is 33.49 KB gzip. After adding the standard `Pipeable` method, the existing
`schema-toArbitrary.ts` fixture is 33.51 KB versus 33.48 KB at the baseline, a measured +0.03 KB.

Making rejected shrink nodes visible to the shared `maxShrinks` budget added 47 bytes gzip to
`arbitrary-combinators.ts`, 39 bytes to `schema-toArbitrary.ts`, and 66 bytes to a temporary fixture that retained the
complete `checkEffect` runner. `config.ts` remained byte-for-byte unchanged.

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

`Arbitrary.Union` deliberately reuses the complete internal generation policy of `Schema.Union`:

- members whose minimum cost fits the remaining budget are eligible;
- an eligible member is selected uniformly;
- the static minimum is the lowest member minimum;
- the selected member preserves its own shrink tree;
- when the selected member has a higher minimum cost, shrinking first tries the earliest member with the lowest
  minimum cost, then continues through the selected member's tree;
- selection, shrinking, and replay remain deterministic.

The implementation and Schema compiler call the same private helper rather than maintaining two equivalent copies.
The public test compares their complete seeded output for a recursive, budget-sensitive union. Native static choice
measured 8.66 microseconds for 128 samples, versus 50.57 microseconds for equivalent fast-check v4 `oneof`.

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

## P4: Schema-local `arbitrary` annotation

### Required experience

Customization is attached to the exact Schema before that Schema is embedded in a containing structure:

```ts
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

const PersonArbitrary = Arbitrary.schema(Person)
```

Only the `name` occurrence uses the custom distribution. Other `Schema.String` or `Schema.NonEmptyString` occurrences
continue to use standard generation.

The `effect/unstable/arbitrary/Arbitrary` module augments `Schema.Annotations.Bottom<T, TypeParameters>` with a public,
type-safe `arbitrary?: () => Arbitrary<T>` annotation. `Schema.ts` does not import the unstable module, and no separate
`Arbitrary.override` helper is exposed. The annotation must be excluded from Schema persistence because it contains an
executable generator rather than serializable metadata.

### Semantics

The annotation factory is evaluated eagerly by `Arbitrary.schema` and replaces the default generator for that exact
Schema. For `Schema.NonEmptyString`, the compiler conceptually:

1. searches for `arbitrary` from the outermost check toward the inner checks and finally the base node;
2. evaluates the first factory it finds and uses its `Arbitrary<string>` instead of the ordinary `String` generator;
3. applies the `NonEmptyString` check once to roots and shrink nodes.

An explicitly present `arbitrary: undefined` stops the search and clears an inner override. All checks on the node are
applied, including checks outside the annotation. If the containing Schema has its own override, it replaces the whole
subtree and child overrides are not evaluated.

The replacement is trusted to produce the declared Type. The compiler does not run the complete Schema parser for
every sample. It continues to enforce the checks directly attached to the annotated node, so a replacement cannot
bypass `NonEmptyString`, a pattern, or another local refinement on that node. Structural correctness and checks nested
inside a composite Type remain the replacement Arbitrary's contract.

The initial factory takes no arguments. It does not expose the compiler's default Arbitrary, recognized constraints,
or decoded type-parameter Schemas. An input object can be added later without invalidating existing zero-argument
factories. Combining an already derived `Arbitrary.schema(BaseName)` with the replacement would cause the outer
compiler to run `BaseName`'s checks again. Supporting augmentation without duplicate validation would require private
branch provenance and is a separate follow-up. The approved fixed-names/Faker use case supplies a complete replacement
and does not require it.

The factory must not call `Arbitrary.schema` on the same annotated Schema. The compiler detects this self-reference
and throws during eager derivation instead of recursing until the JavaScript stack overflows.

### Scope and bundle consequences

Schemas are immutable. The annotation must be applied before `Name` is embedded in `Person`; annotating another `Name`
value later cannot alter the AST already stored by `Person`. A plain alias such as `const Name = Schema.String` also
has no runtime identity distinct from another use of the same singleton until a new annotated Schema is created.

An `arbitrary` annotation that captures Faker makes Faker and its locale data reachable from the production module
exporting that Schema. This is an accepted opt-in cost. Avoiding it would require a provider, registry, path override,
or rebuilding the containing Schema, none of which belong to the initial interface.

### Compiler integration and verification

The compiler integration is verified against:

- a checked leaf nested in `Person`;
- root and shrink outputs that fail `NonEmptyString`;
- a custom check, verifying that it runs once;
- an annotation inside recursive and mutually recursive containing Schemas;
- a replacement supplied by `Arbitrary.schema` on a recursive Schema;
- eager derivation errors and accidental self-reference;
- deterministic sampling, shrinking, and replay;
- bounded exhaustion when the replacement has zero density;
- `arbitrary` annotations placed before and after checks, repeated annotations, explicit clearing, and outermost-first
  precedence;
- exclusion from persisted Schema annotations.

The compiler wrapper must preserve the replacement's finalized `minCost`. A replacement derived from a recursive
Schema already owns its finalized compilation graph. The production implementation keeps it opaque to the containing
Schema compiler and does not add graph metadata to the public `Arbitrary` interface.

Exit gate:

- the `Person.name` experience above works without a field path, registry, or provider;
- checks directly attached to the annotated node remain authoritative and execute once;
- recursive containing Schemas retain productivity;
- no full-parser validation is added per sample;
- Schema fixtures that do not opt into the override are bundle-invariant;
- the opting-in fixture reports the complete Arbitrary override cost; an external generator remains an explicit
  application dependency.

Implementation result: the unstable Arbitrary module augments the public Schema annotation type without introducing
a runtime dependency from `Schema.ts`. The compiler resolves factories from the outermost check inward, supports
explicit clearing, applies all local checks once, rejects self-reference eagerly, and treats parent replacements as
opaque subtrees. Runtime tests cover checked leaves, recursive and mutually recursive containers, opaque recursive
replacements, shrink promotion, replay, exhaustion, precedence, clearing, and persistence; typetests cover the precise
factory result type.

In the complete five-round Node 24 matrix, 128 nested `Person` samples using a Schema-local replacement measured
25.70 microseconds versus 80.96 microseconds for the corresponding hand-written fast-check v4 arbitrary. All 22 warm
native scenarios remained faster than their fast-check fixtures. Against the pre-slice commit, `config.ts` was
unchanged, while `schema-toArbitrary.ts`, `arbitrary-combinators.ts`, and the opting-in `arbitrary-schema-local.ts`
fixtures grew by 0.14, 0.13, and 0.14 KB gzip respectively.

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
dependent domains, callers should precompile the possible Arbitraries. The implementation does not add implicit
memoization or a registry.

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
against `maxDiscards`; shrink-time discards do not count as attempts but do consume `maxShrinks`.

### PRNG and budget isolation

The recommended implementation adds checkpoint and clone operations to the private xoshiro implementation without
changing its draw algorithm:

- with `shrinks: false`, generate source and dependent directly against the enclosing state and allocate no checkpoint;
- with `shrinks: true`, generate the source in an isolated state and capture a checkpoint after source generation;
- the initial dependent and every source-shrink dependent receive independent clones of that post-source checkpoint;
- commit only the initial dependent's final PRNG and budget to the enclosing state;
- lazy shrink branches never mutate their siblings or the enclosing generation state.

Checkpointing after the source means that a smaller source value changes the dependent constraint while retaining the
same subsequent random choices. Fast-check instead checkpoints before the source. The P5 prototype compared both
policies on deterministic output, shrinking quality, runtime, and bundle cost; the post-source policy was approved.
The production attribution credits only the source-first, close-after-dependent topology shared with fast-check.

The recommended budget policy is:

```text
r = budget remaining after the source
m = dependent minimum cost
dependent budget = r + m
committed budget = min(r, dependent remaining budget)
```

The corresponding static `flatMap` minimum is the source minimum. The clamp prevents an unused dependent minimum-cost
top-up from becoming additional optional size. Every source-shrink branch starts from the same residual allowance plus
its own dependent minimum and never commits its state. The prototype compared this with giving each dependent an
independent size allowance; shared residual fuel was approved because it preserves productivity without amplifying
optional recursion across nested `flatMap` calls.

### Verification

- source-controlled target length or bounds;
- source and dependent shrinking in the specified order;
- source remains available below a selected source shrink;
- source is never reevaluated below a selected dependent shrink;
- initial source and dependent discards;
- promotion through a discarded source-shrink dependent branch;
- all-discard shrink frontier stops at `maxShrinks` and long promotion remains interruptible;
- deterministic seed and replay through source, dependent, and promoted branches;
- dependent minimum larger than the residual budget at size zero;
- nested `flatMap` does not amplify optional size;
- recursive and mutually recursive Schema-derived source and dependent Arbitraries;
- dependent defects and interruption;
- sampling allocates neither checkpoints nor new shrink carriers;
- warm sampling, dependent collection, failure, shrinking, and replay scenarios;
- focused bundle fixture and no regression to unrelated fixtures.

The production slice implements and tests this complete policy. The comparison prototype found that the post-source
checkpoint reduced every failure in its 512-seed dependent-length workload to length one, versus 46% for the
pre-source policy, and that shared residual fuel never exceeded the configured eight optional recursive steps. The
three production warm fixtures measured 67.8 versus 120 microseconds for 128 samples, 5.93 versus 19.4 microseconds for
failure plus shrinking, and 5.82 versus 12.8 microseconds for replay, against fast-check 4.9.0. The opting-in
A same-checkout reachability ablation measured `arbitrary-combinators.ts` at 33.99 KB gzip with `flatMap` and 33.62 KB
without the `flatMap` member, a 0.37 KB opt-in cost. The earlier cross-checkout comparison found
`schema-toArbitrary.ts`, `arbitrary-schema-local.ts`, and `config.ts` unchanged.

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

## Holistic design review findings

The following findings are open design questions, not approved implementation requirements. Discuss and resolve them
one at a time in the listed order. When a finding is resolved, record the decision, its verification gate, and whether
it produces a production slice or is intentionally closed without changes.

1. **Resolved: Vitest property failures participate in shrinking and replay.** Twelve of the sixteen runtime property
   tests present during the review used `assert` or `expect`; only four used a purely boolean property. On `main`,
   fast-check treated every synchronous throw and asynchronous rejection from a property as a shrinkable failure, not
   only `AssertionError`. The native adapter now restores that behavior by converting every non-interruption Cause into
   a typed property failure while re-emitting interruption. Focused tests verify shrinking for a synchronous defect and
   an assertion defect, plus single-evaluation interruption; public JSDoc and both Arbitrary and Vitest guides document
   the policy.
2. **Closed without changes: replay decoding remains partial and unversioned.** Replay tokens are operational values
   produced by this unstable module, and compatibility across releases is already excluded. Validating arbitrary token
   strings, versioning the private tuple, and expanding `ReplayMismatch` would add interface and verification cost
   without enough leverage. Malformed tokens may therefore continue to defect.
3. **Resolved: exhaustion reports the effective seed.** `SampleError` and `Exhausted` retain the resolved seed, so an
   automatically seeded exhausted run can be reproduced directly. Structured discard origins, inspected-shrink counts,
   and a diagnostic mode remain excluded: they would widen the interface or add rejection-path work without a concrete
   consumer.
4. **Resolved: the public Declaration seam exposes only general compiler vocabulary.** `GenerationConstraint` remains
   a flat normalized constraint bag because third-party Links need its bounds. The callback otherwise receives only
   decoded type-parameter Schemas. Compiler-owned built-ins, including the policies for Map, Set, HashMap, HashSet, and
   Chunk, are selected privately from their existing representation identities after any explicit user
   `toCodecArbitrary` hook and before canonical codec fallback. Graph remains an explicit declaration-local exception
   because it never used the palette. This records the chosen priority: protect production Schema bundles, while
   treating Arbitrary bundle growth as a measured test-tooling tradeoff. Against `bbeb6689`, the current design measures
   `config.ts` at 21.07 KB instead of 21.26 KB, `schema-toCodeDocument.ts` at 24.20 KB instead of 24.33 KB, and the
   test-only `schema-toArbitrary.ts` at 36.57 KB instead of 33.55 KB. A temporary Schema-only fixture using ReadonlyMap,
   HashMap, ReadonlySet, HashSet, and Chunk measured 20.36 KB instead of 20.57 KB.
5. **Declaration type parameters are eager graph dependencies even when the selected Link ignores them.** The compiler
   compiles every type parameter and adds it to the dependency graph, although generation executes only the selected
   `link.to`. Verify the phantom or unsupported parameter case, then decide whether dependencies should be derived only
   from the reachable Link target.
6. **Incompatible `Order` identities cause eager derivation failure.** Two semantically compatible bounds using
   distinct `Order` function objects are rejected during constraint merging. Decide whether the compiler should instead
   abandon constructive lowering for those bounds and rely on the authoritative residual checks.
7. **`size` combines a local generation scale with shared recursion fuel.** It is not a global bound on total output
   size: sibling strings, arrays, and properties can each observe it, while recursive edges share a consumable budget.
   Clarify the public contract and internal terminology before adding further size-sensitive combinators.
8. **The Schema-local `arbitrary` annotation is a trusted structural override.** The compiler reapplies checks attached
   directly to the annotated node but does not run the complete Schema parser over every replacement value. Decide
   whether the current advanced contract is explicit enough or whether the interface needs stronger validation or
   stronger naming.
9. **Independent product composition escapes the Arbitrary seam.** `@effect/vitest` currently turns Arbitraries into
   annotated `Schema.Unknown` values in order to build tuples and records. Evaluate a single `Arbitrary.all` operation
   for tuple and record products without introducing a parallel primitive or collection catalog.
10. **The first shrink frontier is not fully lazy.** Several samples compute their initial candidate collection before
    the property result is known, so successful checks can pay for shrinking that is never consumed. Prototype moving
    candidate construction behind the first `Pull`, preserving order, replay, bundle size, and warm failure runtime.
11. **Resolved: rejected-node promotion uses a stack.** Filter, `filterMap`, and `flatMap` preserve the existing
    depth-first promotion order with `push`/`pop`, avoiding quadratic front-array operations. The Arbitrary tests and
    seeded replay tests pass, the full warm benchmark matrix reports no regression, and the combined internal cleanup
    reduces the measured Arbitrary fixtures by 153–155 bytes gzip without changing the production fixtures.
12. **Runtime speed does not establish generation quality.** Audit semantic-class coverage, boundary frequency,
    collision rate, shrink quality, and entropy across the Schema catalog. Add permanent generation and shrinking
    coverage for RegExp, whose compiler is too substantial to remain visible only to temporary probes.
13. **The maintenance surface has poor locality.** The main Arbitrary test file mixes public contracts, seeded kernel
    characterization, compiler behavior, distributions, and scheduler properties; the guide, technical appendix, and
    completed P0-P5 history also overlap. Split tests by responsibility and archive settled design history without
    deleting useful characterization coverage.
14. **The service requirement of Declaration Links is implicit.** `Arbitrary<A>` has no environment parameter, while a
    Link decode can in principle be Effectful. Prove and enforce that Links used for Arbitrary generation are
    service-free, or explicitly decide whether environment requirements belong in the Arbitrary interface.

## Independent research backlog

After the review findings above are resolved, these remain separate research projects:

1. evaluate private finite-domain metadata when constructive `unique` generation demonstrates real exhaustion cases;
2. profile decoded collection and Declaration Links only if a new baseline identifies a regression;
3. compare the current `Sample` tree with trace-informed shrinking and private structural spans;
4. evaluate automatic persistence and reuse of concrete failing inputs last.

Concrete failing-input persistence is distinct from replay-token persistence. After `map` or `flatMap`, an Arbitrary
may no longer have a Schema or codec capable of serializing its output, while the existing opaque replay token remains
persistable.

The current public interface and migration guidance are documented in [ARBITRARY.md](ARBITRARY.md) and
[ARBITRARY-MIGRATION.md](ARBITRARY-MIGRATION.md).
