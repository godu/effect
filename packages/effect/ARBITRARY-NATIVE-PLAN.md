# Native Schema-first Arbitrary implementation plan

## Status

This is the authoritative implementation plan produced after the design and grilling sessions. The broader ZIO and
cross-library research remains in `ARBITRARY.md` and `ARBITRARY-ZIO-PORT.md`; proposals in those documents for a public
constructor algebra, a public builder, `flatMap`, `filter`, `terminal`, or `Arbitrary<A, R>` are superseded here.

The production vertical slice described below has now been implemented under the unstable module path. The document
still separates the proven slice from later parity work; it is not a claim that the legacy fast-check compiler can be
removed yet.

## Objective

Remove the eventual runtime and public-type dependency of core `effect` on a particular fast-check major by owning the
generation, shrinking, sampling, checking, interruption, and replay semantics needed by Schema.

The first implementation is intentionally unstable:

```text
effect/unstable/arbitrary/Arbitrary
```

It is Schema-first. The first milestone does not expose a general constructor catalog or allow users to construct an
`Arbitrary` without starting from a Schema.

The implementation is additive. The existing `Schema.toArbitrary(schema)(FastCheck)` path and its current
`toArbitrary` annotations remain unchanged until native coverage is sufficient to remove them.

## Why Effect should own this module

The justification is not merely that Effect could hide fast-check v4 and replace it with v5 later. That would move the
dependency without giving Effect ownership of the semantics. A native module provides the following concrete benefits:

- core public types stop mentioning the fast-check module, `fast-check.Arbitrary`, `DepthIdentifier`, or
  fast-check-specific recursion options;
- applications can choose their own fast-check major without that choice determining Schema's core representation;
- Schema generation can interpret `SchemaAST` directly and keep the Schema AST as the only public AST;
- each `Declaration` continues to own its structural or specialized generation recipe locally, with no global registry;
- recursive and mutually recursive Schemas can use SCC analysis, shared budgets, and finite base routes derived from
  the complete Schema graph;
- recognized Schema checks can be pushed into native generation, while residual rejection is bounded and returns
  `Exhausted` instead of hanging;
- sampling and checking use Effect's laziness, interruption, defects, typed errors, scoping, and fiber-local Random
  semantics directly;
- failures can replay the initial attempt and complete shrink path rather than only restoring a seed;
- generation randomness can be isolated from randomness used by an effectful property;
- Effect can optimize the private pull and shrink representation for TypeScript and Schema workloads without changing
  the public type;
- Schema derivation, direct sampling, checking, and later `@effect/vitest` integration share one kernel instead of
  maintaining translation layers;
- the final architecture removes a mandatory third-party runtime engine and gives Effect control of bundle composition;
- the unstable namespace permits breaking changes while recursion, replay, distributions, and runner results are
  exercised in production.

The bounded-rejection benefit is observable in the legacy comparison. An impossible Schema filter compiles to
`fast-check.Arbitrary.filter`, whose generation does not return because it must produce a value before the runner can
apply its own skip budget. The native compiler instead exposes a discarded attempt to `sample` or `check`, which
deterministically returns `SampleError` or `Exhausted` after the configured bound.

These benefits have a real maintenance cost. Effect becomes responsible for generator quality, bounded random
selection, shrinking invariants, replay, recursion, filter behavior, performance, and catalog coverage. Removal of the
legacy implementation therefore requires parity and performance gates; it must not happen merely because the new
module exists.

## Settled architecture

### Public interface

The public module is deliberately small:

```ts
export interface Arbitrary<out A> {
  readonly [TypeId]: typeof TypeId
  readonly "~A": Types.Covariant<A>
}

export function schema<S extends Schema.Constraint>(schema: S): Arbitrary<S["Type"]>

export function sample<A>(
  self: Arbitrary<A>,
  options?: SampleOptions
): Effect.Effect<ReadonlyArray<A>, SampleError>

export function check<A, E, R>(
  self: Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  options?: CheckOptions
): Effect.Effect<CheckResult<A, E>, never, R>
```

The exact option defaults remain implementation-tuning decisions. The first public model contains only concepts already
required by the vertical slice: sample count, run count, size, discard budget, shrink budget, seed, and replay.

The module does not initially export:

- primitive or composite constructors;
- `map`, `flatMap`, or `filter`;
- `Sample`, a shrink tree, or raw `Pull`;
- `suspend`, `recursive`, `terminal`, or a recursion context;
- a builder, HKT interpreter, tagless-final algebra, or engine adapter;
- Vitest integration, parallel checking, formatted reporting, or configuration services.

Internal code has the constructors and combinators needed to interpret Schema. Their names and representations are not
part of the public compatibility contract.

For a `Union`, every branch that is productive within the current generation budget has equal selection probability.
Selection is by declared branch rather than by domain cardinality: overlapping branches are not reweighted or
deduplicated. This preserves coverage of narrow alternatives such as a `Literal` beside an unbounded `String`.
Shrinking crosses to another branch only when that branch has a strictly lower structural generation cost, such as a
finite base branch of a recursive union. Equal-cost branches do not use declaration order as an artificial simplicity
ordering.

For an object with optional named properties, generation first selects the property count uniformly across the legal
range and then selects a subset uniformly at that count. This gives empty, complete, and intermediate object shapes
equal representation by size while retaining a 50% marginal presence probability for each property when unconstrained.

During `check`, `size` is a maximum generation budget rather than a constant budget for every run. The runner grows
linearly from zero to the configured maximum according to successful runs; discards do not advance the progression. A
single-run check uses the configured size directly. `sample` continues to use the configured size for every value.
Unconstrained `String`, `Array`, and indexed-object cardinality scale directly with the current size without separate
fallback ceilings. One size unit permits one code unit, element, or property; explicit Schema minima and mandatory
members are honored even when they exceed the current size, and explicit maxima clamp it.
The compiler propagates private `mayRecurse` metadata from recursive SCC edges. When multiple siblings can recurse,
their generation slots are shuffled per attempt while results retain their declared positions. This preserves one
shared total budget and replay determinism without assigning depth systematically by Struct or tuple order.
The specialized `Schema.Json` generator follows the same cardinality and length-bias policy for its strings, arrays,
and objects while retaining the shared recursive budget; specialization is not a separate size model. JSON object
member names use the same native `String` generation and bounded constructive uniqueness rather than a `keyN` catalog.
If bounded key retries cannot complete the requested shape, the attempt is discarded.
Native `String` generation occasionally injects the approved Effect-owned JavaScript edge corpus when its members fit
the active length bounds. Ordinary printable-ASCII generation remains the default path, and constructive patterns keep
their dedicated compiler.
Generic and JSON string shrinking first reduces length and then, from left to right, halves each UTF-16 code unit toward
the null unit. Pattern strings retain their separate structural shrinker, and all Schema filters continue to guard
candidate delivery.
Object shrinking removes optional properties first, then shrinks values, then shrinks generated keys. Key candidates
are normalized to JavaScript property keys and retain constructive uniqueness; collisions are skipped while their
potentially valid shrink descendants remain searchable. Fixed named Struct properties do not acquire key shrinking.

Follow-up: design an explicit Schema-level way to request general Unicode or binary string generation before expanding
the ordinary `Schema.String` distribution. The design must choose code units, code points, or graphemes deliberately;
full UTF-16 coverage is not added silently to the default. Until then, printable ASCII plus the approved JavaScript
edge corpus remains aligned with fast-check's mature default while still exercising targeted runtime boundaries.

Within the legal range at the current size, `String` and `Array` lengths occasionally target the minimum or maximum
boundary according to the same private run-dependent bias schedule as numeric generation. All intermediate lengths
remain uniformly reachable. Constructive regular-expression generation applies the policy to its ordered set of valid
lengths, so an impossible intermediate length is never selected.

Shrinking follows the first candidate that still falsifies the property and continues recursively from that candidate.
It therefore finds a local minimum according to each domain's ordered shrink candidates rather than attempting a
global comparison between arbitrary values. `maxShrinks` bounds candidate evaluations across this traversal.
Any falsification can continue the shrink, whether it returned `false` or produced a typed property error. The final
`failure` always describes the final `counterexample`; the runner does not claim to identify or compare underlying bugs
across arbitrary error values.
Effectful properties must produce the same outcome for the same input and initial environment. The runner does not
clone or restore mutable services between generation, shrinking, or replay evaluations; a stateful property owns an
independent fixture and cleanup inside each evaluation.
Property success is explicit: synchronous and Effectful properties must return `true`. Returning `void` is not
supported; `false` and typed Effect failures remain the two falsification forms.
For `Falsified`, `runs` counts main property evaluations through and including the falsifying evaluation; shrink
evaluations are excluded. An immediate falsification and a replay therefore both report one run.

`Arbitrary<A>` remains a pure description. Canonical codecs do not require Effect services, so no public `R` parameter
is needed. `sample` and `check` return `Effect` for laziness, deterministic Random provisioning, interruption,
effectful properties, typed property failures, and composition—not to provide codec services.

### Public module location

The source module is:

```text
packages/effect/src/unstable/arbitrary/Arbitrary.ts
```

with TypeId:

```text
~effect/unstable/arbitrary/Arbitrary
```

`packages/effect/package.json` needs an explicit source and publish export for
`./unstable/arbitrary/Arbitrary`; the current top-level wildcard is not the intended contract for this nested module.
There is no stable `effect/Arbitrary` alias.

### Declaration resolution

The initial compiler uses only annotations that already exist, plus the private native override. Resolution order is:

```text
1. ~toArbitrary
2. toCodecJson
3. toCodec
4. derivation error
```

The current fast-check `toArbitrary` key is not consulted by the native compiler. This keeps the two implementations
independent and makes missing native coverage visible.

`toCodecArbitrary` remains a candidate extension, not an API that the first slice must add. Its proposed shape would be
the same as the other canonical codec callbacks:

```ts
readonly toCodecArbitrary?:
  | ((typeParameters: TypeParameters.Encoded<TypeParameters>) => SchemaAST.Link)
  | undefined
```

It would select an alternate representation intended to be more productive or efficient for generation. The current
built-in audit does not justify making that seam public: a built-in can use private `~toArbitrary`, while an ordinary
declaration can already expose `toCodecJson` or `toCodec`. The compiler should add `toCodecArbitrary` only when a real
user-authored declaration needs an alternate generation representation and its canonical codec demonstrably cannot
meet the validity, exhaustion, shrink-quality, or performance gates.

If the annotation is introduced provisionally during migration, it has a deletion test before the unstable API is
considered complete:

1. list production occurrences, excluding compiler branch tests and synthetic fixtures;
2. replace every built-in-only occurrence with either its canonical codec or private `~toArbitrary`;
3. retain the public annotation only if at least one non-built-in use case needs an alternate structural Link;
4. otherwise remove the annotation type, compiler branch, tests, and annotation-exclusion entry together.

An annotation used only to test itself does not pass this test.

`~toArbitrary` is a private key for trusted Effect built-ins. It returns the opaque native arbitrary directly and has
precedence over all codec routes. It is not added to the public `Schema.Annotations.Declaration` interface and cannot be
provided by application code. Its private callback signature may receive internal constructors and compiled type
parameters, but it exposes no public builder or context.

`toCodecJson: () => undefined` means that a declaration is already canonical JSON; it does not reveal a structural
shape. It is an explicit self-canonical result rather than an instruction to try `toCodec`. If `~toArbitrary` has not
handled that declaration, derivation fails. `Schema.Json` therefore needs an explicit native path.

If all three routes are absent, `Arbitrary.schema` fails immediately. It never falls back to `Unknown`, `Any`, or the
generic `Json` declaration for an opaque type.

### Immediate derivation errors

`Arbitrary.schema` compiles immediately and reports deterministic structural errors before returning an arbitrary:

- an unsupported `Declaration`;
- contradictory recognized constraints;
- a recursive component with no finite productive route;
- an unsupported AST case in the current unstable implementation.

These are programmer or Schema-definition errors and are distinct from runtime `Exhausted`, which means that bounded
generation or decoding discarded too many candidates.

### No global runtime validation

Production sampling does not decode the complete original Schema again for every generated value or shrink. That would
duplicate compiler work and impose a large cost on nested and recursive values.

Instead:

- primitive and structural generators are correct by construction;
- every node-local Schema check is retained as a residual filter even when it supplied a constructive hint;
- codec routes necessarily run the selected Link decoding;
- `~toArbitrary` is trusted and verified by Effect's conformance tests;
- no second, whole-Schema validation pass runs after generation.

This does not allow `~toArbitrary` to bypass checks attached by a caller. The direct built-in recipe is trusted for the
base Declaration domain; subsequent node-local checks still run through the ordinary filter layer.

`arbitrary.constraint` therefore remains a generation hint rather than a proof that a filter can be removed. This is
required for compositions such as multiple regular-expression patterns: the merged hints can improve candidate
generation without being a constructive representation of their conjunction. No exactness marker or built-in filter
registry is introduced.

## Deep module seams

The design has one external seam and two private seams:

```text
External seam
  Arbitrary.schema / sample / check

Private seam A
  SchemaAST compiler -> opaque kernel constructors

Private seam B
  trusted ~toArbitrary callback -> private built-in constructor kit
```

The external module is deep: callers learn three operations while the implementation owns graph compilation,
constraint interpretation, rejection, shrinking, replay, and execution.

The second private seam is necessary to keep `~toArbitrary` local without introducing a runtime cycle:

```text
Schema.ts --import type--> private annotation contract
Schema.ts annotation callback --receives at invocation--> private constructor kit
Arbitrary schema compiler --runtime imports--> SchemaAST + private kernel
```

Built-in callbacks refer only to their argument. `Schema.ts` does not statically import the native kernel, so ordinary
Schema consumers do not load the kernel and the public module can still import Schema without a runtime cycle. This is
an internal builder in the implementation sense, not an interface exposed to users; it may change freely with the
unstable compiler.

`~toArbitrary` must be added to the annotation-exclusion list used when emitting generic Schema annotations.
Executable callbacks must never leak into JSON Schema or other representations. If `toCodecArbitrary` later passes its
deletion test, it receives the same treatment.

### Schema Representation as a structural compiler candidate

The relevant pipeline is:

```text
SchemaAST.toType(schema.ast)
  -> SchemaRepresentation.toRepresentation(typeAst)
```

Calling `toType` first means that `toRepresentation` selecting the last encoding is not a loss: ordinary Schema
transformations have already been intentionally lowered to their decoded `Type` domain. This makes Representation a
real candidate for the structural part of the compiler.

| What `Representation` simplifies                                       | What still needs an executable bridge                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Suspend` cycles become a finite `references` graph                    | `SchemaAST.Filter.run` is replaced by metadata, so residual filters cannot execute                          |
| sharing and identifiers become explicit `Reference` nodes              | a `Declaration` remains opaque where the compiler must select `~toArbitrary`, `toCodecJson`, or `toCodec`   |
| Arrays, Objects, Unions, optionality, and mutability become plain data | codec expansion must retain the selected `SchemaAST.Link` so generated representation values can be decoded |
| graph traversal no longer evaluates recursive TypeScript calls         | codec callbacks require the original type-parameter Schemas, not only their lowered Representation values   |

The first column is valuable. The second column is not solved by `toType`: it follows from Representation being an
open model for persistence and code generation. Opaque declarations and checks are reconstructed with revivers.
Requiring those revivers for arbitrary derivation would introduce the global registry that this design is avoiding,
and application filters without representation annotations still could not be executed.

There is one viable hybrid to measure: add a private callback to the existing lowering pass that records
`Representation node -> source SchemaAST node` in a `WeakMap`. The Arbitrary compiler could then use Representation for
structure and references while consulting the source node only for executable filters and Declaration routes. This is
acceptable only if the bridge stays local and removes more graph machinery than it adds; it must not become a second
public AST or a reviver registry.

The initial direct implementation instead keeps executable `SchemaAST` as the source of truth and builds a private
graph index:

```text
SchemaAST node identity -> node id + outgoing recursive edges
```

That index is compiler metadata for memoization, SCCs, productivity, and shared budgets; it is not another public AST
and does not replace the original nodes. Declaration-route selection happens before its recursive edges are finalized,
so recursion exposed through `toCodecJson` or `toCodec` participates in the same graph.

This choice has a comparison gate before the compiler layout is considered settled. Use a recursive and mutually
recursive Schema containing a residual filter and an Option codec to compare:

1. direct SchemaAST graph indexing;
2. `toRepresentation(toType(ast))` plus the private source-node bridge.

Keep the Representation path only if it reduces implementation and bundle cost without a parallel AST walk, a reviver
registry, or special recursion behavior for codec-expanded declarations. Otherwise retain the direct index and factor
only genuinely duplicated reference-discovery code from `toRepresentation`.

The implemented slice makes the tradeoff more concrete. Calling `toType` first does remove the encoded-side objection,
but `Representation` still does not simplify the compiler as a whole:

- the native compiler selects a Declaration codec while traversing and only then discovers the codec target's graph
  edges; a Representation document lowered beforehand cannot contain those edges;
- lowering every selected codec target as a second document would require reference-environment merging and a source
  side table, while changing the Representation lowering callback to expand declarations would couple it to Arbitrary;
- executable residual filters and the selected Link transformation still require the original AST nodes;
- the existing Representation conversion performs an occurrence/reference discovery pass and allocates a second
  structural object graph before the Arbitrary compiler can calculate productivity.

For the current slice, the direct `SchemaAST` identity graph is therefore the smaller seam: one traversal selects
Declaration routes, records recursive edges, and retains executable checks. Representation remains useful as a source
of reference-discovery techniques, but is not used as the compiler input. Revisit this only if SchemaRepresentation
later gains an internal executable-source bridge for another reason.

## Private kernel

### Attempt and sample model

The recommended internal shape is conceptually:

```ts
interface ArbitraryImpl<A> {
  readonly generate: (state: GenerationState) => Effect.Effect<Attempt<A>>
  readonly productivity: Productivity
}

type Attempt<A> = Generated<A> | Discarded

interface Generated<A> {
  readonly _tag: "Generated"
  readonly sample: Sample<A>
}

interface Discarded {
  readonly _tag: "Discarded"
}

interface Sample<A> {
  readonly value: A
  readonly shrinks: Pull.Pull<Sample<A>>
}
```

This is private implementation structure, not a second public AST. `Productivity` and finite base plans summarize facts
needed by the compiler; they do not duplicate the Schema domain or become user-authored syntax.

The existing `effect/Pull` is the right carrier for one lazy shrink step. `Pull` is an `Effect`, so decoding and shrink
search are interruptible at pull boundaries. The current module does not provide collection combinators, so Arbitrary
will need a small private pull toolkit for empty, prepend, map, concatenation, and effectful filter-map. That toolkit is
not exported.

Generation is an attempt rather than an infinite stream. Bounded retry belongs to `sample` and `check`; this makes
discard accounting and `Exhausted` explicit and prevents impossible filters from waiting forever.

### Internal constraints

The generation state carries private node-local constraints, size, Random, and recursive-component budgets. No such
context appears in public annotations.

During coexistence, the compiler can consume the semantic portion of the current filter arbitrary metadata:

- length/cardinality bounds;
- integer, finite, NaN, and infinity flags;
- ordered bounds tagged by their `Order`;
- patterns;
- uniqueness.

It must not invoke legacy candidates whose callbacks accept the fast-check module. When the legacy implementation is
removed, semantic generation hints can move out of the legacy `ToArbitrary` namespace without changing the unstable
public module.

Recognized impossible constraints fail in `Arbitrary.schema`. Unknown predicates remain bounded runtime filters.

At minimum the vertical slice pushes down:

- string `minLength` and `maxLength`;
- number integer, finite, inclusive/exclusive min, and inclusive/exclusive max;
- array length and uniqueness;
- tuple optional/rest layout;
- struct required/optional property counts;
- declaration collection cardinality when its selected representation preserves size.

General regular-expression synthesis, all legacy candidates, exotic orders, and the complete built-in catalog are
parity work after the vertical slice unless required by one of its fixtures.

### Random isolation

The runner owns a master seed. Attempt `i` runs generation with a private PRNG state derived directly from
`(masterSeed, i)`. The state is carried only by the generation kernel and is not installed as the ambient Effect
`Random` service.

The property itself runs outside that local provision and observes the caller's Random service. Property draws cannot
shift the generated sequence, and changing the number of draws in attempt `i` cannot perturb later attempts. Replay can
jump directly to one attempt rather than executing all previous attempts.

When no seed is supplied, the runner obtains a master seed once from Effect Random and records it in replay data.

## Compiling Schema

### Node pipeline

Each Schema node compiles in the same order:

```text
collect node checks
  -> merge recognized generation constraints
  -> reject statically impossible intersections
  -> compile the base AST or selected Declaration route
  -> apply every original check as a local residual filter
  -> expose a private Compiled value with normal generation + productivity/base facts
```

Child nodes start with a reset node-local constraint context. Container constraints do not leak into elements or
fields.

For a Declaration, the selected codec target is compiled with the current node-local constraints. Root constructors
consume only constraints meaningful to their own domain; ordered constraints already identify their `Order`. This lets
canonical Array representations of Set, Map, and Chunk receive outer cardinality bounds without exposing options to the
annotation callback. Original source checks still run after decoding.

### Codec links and shrinking

For a selected `toCodecJson` or `toCodec` Link:

1. create the canonicalized Declaration AST by installing the Link as its encoding;
2. compile `link.to` as the representation arbitrary;
3. generate a representation `Sample<E>`;
4. decode its root through the canonicalized Declaration parser;
5. on success, expose the decoded `A` and lazily decode its shrink descendants;
6. on failure at the initial root, return `Discarded`;
7. on failure at a shrink node, omit that node but continue through and promote its descendants;
8. count every visited shrink candidate against the shrink budget.

Promoting descendants matters. Pruning an invalid shrink node together with its subtree can hide smaller valid values.
The private effectful pull filter-map therefore flattens invalid nodes rather than terminating that branch.

All selected codec Links use this identical behavior. If `toCodecArbitrary` is ever added, it must use the same
decoding, discard, and shrinking semantics; it would differ only in precedence and in the author's intent to provide a
productive representation.

Link transformations may be non-injective, so duplicate decoded shrink candidates are allowed initially. Dedupe is a
performance optimization only if benchmarks demonstrate a problem.

### Recursive and mutually recursive Schemas

`SchemaAST.Suspend` is compiled as a graph, not by recursive TypeScript calls:

1. memoize a placeholder before evaluating each suspended body;
2. record graph edges and compute strongly connected components;
3. compute productivity as a least fixed point for each SCC;
4. save the first rank-decreasing finite base plan for every productive member;
5. treat an SCC with no productive member as an empty branch and fail `Arbitrary.schema` only when the root has no
   finite generation path;
6. allocate one per-sample complexity budget shared by the entire SCC;
7. decrement or partition that budget across every internal recursive edge;
8. at zero budget, use only the saved rank-decreasing base plan.

Codec expansion participates in the same traversal. For example, recursive `Option<A>` becomes a structural `None |
Some<A>` branch through `toCodec`, so `None` contributes the finite base case without a public `terminal` recipe.

Mutually recursive types share one SCC budget; crossing from `A` to `B` never resets it. Multiple recursive children
must partition or consume a shared allowance so total structure size remains bounded rather than growing
exponentially.

A trusted `~toArbitrary` carries private productivity information produced by its internal constructors. The annotation
does not receive or return `terminal`, recursion identifiers, or SCC state.

## Sampling, checking, interruption, and replay

### Outcomes

Ordinary check outcomes are data:

```ts
type CheckResult<A, E> =
  | { readonly _tag: "Passed"; readonly runs: number; readonly discards: number }
  | {
    readonly _tag: "Falsified"
    readonly initialInput: A
    readonly counterexample: A
    readonly failure: ReturnedFalse | PropertyError<E>
    readonly runs: number
    readonly discards: number
    readonly shrinks: number
    readonly replay: Replay
  }
  | {
    readonly _tag: "Exhausted"
    readonly runs: number
    readonly discards: number
  }
```

Property semantics are fixed:

- `true` or `Effect.succeed(true)` passes;
- `false` or `Effect.succeed(false)` is a shrinkable falsification;
- `Effect.fail(error)` is a shrinkable typed property error;
- defects and synchronously thrown exceptions remain defects;
- fiber interruption propagates as interruption and is not converted into a `CheckResult`;
- properties must treat generated values as immutable.

The runner does not clone a value before passing it to a property. This keeps the kernel small and avoids inventing a
universal clone protocol for Schema declarations, class instances, collections, aliased structures, and values decoded
through codecs. Mutating a sample is unsupported because a generated value or one of its children may also be retained
for failure reporting, shrinking, or replay. This is a property contract, not a runtime check; the runner does not
freeze values or attempt to detect mutation.

The first runner is sequential. Parallel checking and scheduler-dependent winner selection are outside the vertical
slice. Deterministic per-attempt PRNG splitting is already part of the sequential runner.

### Replay

Replay is part of the vertical slice. Its public value is a copyable opaque string that internally records only
operational coordinates:

```text
master seed
attempt index
effective size
complete shrink path
```

There is no public `formatVersion` or `algorithmVersion`, and no promise of cross-release replay compatibility.

Replay restores the complete reported failure, including the final counterexample. Restoring only the initial sample
would force the runner to rediscover the same shrink traversal and could produce a different report.

If the attempt no longer fails or the shrink path cannot be followed, replay reports an explicit mismatch instead of
silently running an unrelated property check.

`maxShrinks` bounds every candidate property evaluation performed during shrinking, including candidates that pass.
The `shrinks` count in `Falsified` records only accepted failing descents. The runner follows the first failing child at
each level and therefore seeks a local minimum according to the private shrink order, not a global minimum over the
domain.

## Built-in Declaration audit

The current source contains 25 explicit legacy arbitrary annotations, including the recipe used by Schema-backed Class
declarations. Three additional built-ins (`File`, `FormData`, and `URLSearchParams`) are codec-only today. Almost every
Declaration already has a canonical codec. The table below classifies the intended native path before benchmark tuning.

| Declaration            | Existing structural route  | Initial native route      | Reason                                                          |
| ---------------------- | -------------------------- | ------------------------- | --------------------------------------------------------------- |
| `Json` / `MutableJson` | self-canonical JSON        | `~toArbitrary`            | opaque recursive declaration; `toCodecJson` returns undefined   |
| `Option`               | `toCodec`                  | `toCodec`                 | exact tagged union with a visible `None` base                   |
| `Result`               | `toCodec`                  | `toCodec`                 | exact tagged union                                              |
| `Redacted`             | `toCodecJson`              | `toCodecJson`             | maps the type-parameter representation directly                 |
| `CauseReason`          | `toCodec`                  | `toCodec`                 | exact tagged union with an interrupt base                       |
| `Cause`                | `toCodec`                  | `toCodec`                 | exact array representation                                      |
| `ErrorInstance`        | `toCodecJson`              | `toCodecJson`             | structural JSON error; recursive cause reaches native Json      |
| `Exit`                 | `toCodec`                  | `toCodec`                 | exact success/failure union                                     |
| `ReadonlyMap`          | `toCodec` array of entries | `toCodec`, then benchmark | add a direct recipe only if constrained key uniqueness needs it |
| `HashMap`              | `toCodec` array of entries | `toCodec`, then benchmark | add a direct recipe only if constrained key uniqueness needs it |
| `ReadonlySet`          | `toCodec` array            | `toCodec`, then benchmark | duplicates may require private constructive generation          |
| `HashSet`              | `toCodec` array            | `toCodec`, then benchmark | Effect equality may require private constructive generation     |
| `Chunk`                | `toCodec` array            | `toCodec`                 | exact representation; cardinality maps to array length          |
| `RegExp`               | `toCodecJson` struct       | `~toArbitrary`            | generic source/flags have a poor acceptance rate                |
| `URL`                  | `toCodecJson` string       | `~toArbitrary`            | an unconstrained string almost never decodes                    |
| `Date`                 | `toCodecJson` string       | `~toArbitrary`            | validity and ordered Date constraints need construction         |
| `Duration`             | `toCodecJson` tagged union | `toCodecJson`             | exact constructive union                                        |
| `BigDecimal`           | `toCodecJson` string       | `~toArbitrary`            | scale and ordered bounds need constructive generation           |
| `File`                 | `toCodecJson` struct       | `~toArbitrary`            | use bytes directly instead of synthesizing Base64               |
| `FormData`             | `toCodecJson` entry array  | `toCodecJson`             | structural and productive once File is handled                  |
| `URLSearchParams`      | `toCodecJson` string       | `toCodecJson`             | every string constructs a value                                 |
| `Uint8Array`           | `toCodecJson` Base64       | `~toArbitrary`            | direct byte generation gives constructive length and shrinking  |
| `DateTimeUtc`          | `toCodecJson` string       | `~toArbitrary`            | valid strings are sparse; ordered constraints need support      |
| `TimeZoneOffset`       | `toCodecJson` integer      | `toCodecJson`             | the canonical codec is already constructive                     |
| `TimeZoneNamed`        | `toCodecJson` string       | `~toArbitrary`            | unconstrained strings almost never name an IANA zone            |
| `TimeZone`             | `toCodecJson` string       | `~toArbitrary`            | generate the bounded-offset / useful-name union directly        |
| `DateTimeZoned`        | `toCodecJson` string       | `~toArbitrary`            | valid strings are sparse; ordered constraints need support      |
| Schema-backed `Class`  | `toCodec`                  | `toCodec`                 | direct structural class-field representation                    |

This audit produces three conclusions:

1. codec reuse removes most declaration-specific arbitrary recipes;
2. `~toArbitrary` is still necessary for domains whose useful distributions or constraints are not represented by an
   existing Schema;
3. collection cardinality and uniqueness are the main pressure on how node-local constraints cross a Link.

The classification is a migration plan, not a requirement to add every annotation in the vertical slice. Each direct
override must retain its place only if conformance or performance evidence justifies it.

### Measured parity snapshot

The first parity audit exercised public native `check` with 100 runs, size 10, a fixed seed, and at most 5,000
discards. It is a productivity diagnostic rather than a distribution-equivalence claim.

All deterministic Schema AST families completed 100 valid runs with zero discards: `Any`, `Unknown`, `Void`, `Null`,
`String`, `Number`, `Boolean`, `BigInt`, `Symbol`, `UniqueSymbol`, `ObjectKeyword`, literals, enums, template literals,
unions, tuples, arrays, structs, string and symbol records, and structs with index-signature rest. `Never` remains an
intentional immediate derivation error. Numeric template-literal segments initially exposed non-finite values; the
compiler now supplies finite numeric constraints through union members. The audit also found and fixed `Symbol` being
mistaken for unproductive recursion because its internal String dependency had bypassed the compiler graph.

Canonical Declaration routes split into three measured groups:

| Status                    | Declarations                                                                                   | Result for 100 runs                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- |
| constructive codec        | `Result`, `Redacted`, `ReadonlySet`, `HashSet`, `ReadonlyMap`, `HashMap`, `Chunk`, `Duration`, | passed with zero discards             |
|                           | `Cause`, `Exit`, `TimeZoneOffset`                                                              |                                       |
| valid but rejection-heavy | `Date`, `RegExp`, `BigDecimal`, `DateTimeUtc`, `Uint8Array`                                    | 4,296 / 2,056 / 1,514 / 4,069 / 1,431 |
|                           |                                                                                                | discards respectively                 |
| not productive at bound   | `URL`, `TimeZoneNamed`, `TimeZone`, `DateTimeZoned`                                            | exhausted after 5,001 discards        |

The constructive group does not justify a private override. The rejection-heavy and exhausted groups are the concrete
worklist for trusted `~toArbitrary` recipes. `File` and `FormData` remain unaudited in this first Node-only snapshot.

## Production vertical slice

### Scope

The first slice is production code under the unstable path. It proves the complete architecture rather than catalog
parity.

It includes:

- opaque `Arbitrary<A>` and private `Sample<A>` / `Pull` kernel;
- `schema`, `sample`, and sequential `check`;
- deterministic per-attempt Random isolation;
- interruption through generation, codec decoding, property execution, and shrinking;
- full replay coordinates and replay mismatch;
- primitive `Null`, `Undefined` / `Void`, `String`, `Number`, `Boolean`, and `Literal` compilation;
- Arrays sufficient for fixed/optional/rest tuples and homogeneous arrays;
- Objects sufficient for Struct and string-keyed Record;
- Union and Suspend;
- String length, numeric range/integer/finite, array length/unique, and object-property constraints;
- bounded residual filters and codec decode discards;
- recursive and mutually recursive SCC productivity;
- all three initial Declaration resolution branches exercised by production or test declarations;
- legacy/native coexistence;
- the two materialized bundle fixtures.

The slice does not claim support for every Schema AST tag, every regular expression, every legacy filter candidate, all
built-in declarations, public custom arbitrary construction, Vitest, TestSchema migration, parallel checking, or
formatted reports. An unsupported deterministic AST or Declaration fails immediately rather than silently degrading.

The numeric substrate is no longer a simplified constraint placeholder. `Int` selects without modulo bias across the
complete safe integer domain and rejects out-of-domain constraints. Constrained `Number` intervals map non-NaN
IEEE-754 values to a monotone 64-bit index, use exact adjacent representations for exclusive bounds, preserve signed
zero, support subnormals and infinities, and shrink with a nearest-passing index context. Numeric generation now uses
the private attributed fast-check v4/v5 run schedule and edge-range weighting as its initial bug-finding baseline.
Unbounded `Number` covers the complete double representation interval plus one NaN choice instead of using ad hoc
`1/24` injections. Exact frequencies remain outside the public contract.

### Suggested file layout

```text
packages/effect/src/unstable/arbitrary/Arbitrary.ts
  public opaque type, options, results, schema/sample/check

packages/effect/src/internal/arbitrary/model.ts
  private ArbitraryImpl, Sample, Attempt, productivity, pull helpers

packages/effect/src/internal/arbitrary/constructors.ts
  private primitive/composite constructors and shrinkers

packages/effect/src/internal/arbitrary/schema.ts
  SchemaAST compiler, annotations, constraints, codecs, SCCs

packages/effect/src/internal/arbitrary/runner.ts
  sampling, checking, shrinking, Random isolation, replay

packages/effect/src/internal/arbitrary/annotation.ts
  type-only private ~toArbitrary callback contract and key

packages/effect/test/unstable/arbitrary/Arbitrary.test.ts
packages/effect/typetest/unstable/arbitrary/Arbitrary.tst.ts
```

The exact split may be compressed if the implementation remains clearer in fewer files. The important dependency rule
is that the private annotation contract can be imported type-only by Schema without importing the kernel.

### Implementation sequence and gates

#### Slice 1: private kernel and sampling

- implement private samples, pull helpers, primitive shrinkers, attempts, and size;
- implement `sample` with seed, count, size, and bounded discard;
- verify deterministic sequences, interruption, exhaustion, and shrink-domain invariants.

Gate: no Schema integration yet, but a private arbitrary can be sampled deterministically and an impossible private
filter exhausts.

#### Slice 2: structural Schema compiler

- implement immediate compilation, memoization, paths, constraints, and residual checks;
- compile the primitive, Arrays, Objects, Union, and Suspend subset;
- compute SCC productivity and shared budgets;
- add direct and mutual recursion tests.

Gate: the representative recursive Schema derives without fast-check, generated samples satisfy its local checks,
unproductive recursive branches are treated as empty, and derivation fails only when the root has no finite generation
path.

#### Slice 3: Declaration codecs and annotations

- add private `~toArbitrary` key and type-only callback seam;
- implement the initial resolution order and missing-annotation error;
- implement effectful decoding of representation sample trees with invalid-descendant promotion;
- exercise `~toArbitrary` with native Json, `toCodecJson` with `URLSearchParams`, and `toCodec` with Option.

Gate: each initial route produces valid values, decode failure is a bounded discard, shrink decoding can skip an
invalid node and still reach a valid descendant, and core Schema has no runtime import of the kernel. Record any case
that appears to need `toCodecArbitrary`; do not add it for a synthetic branch test.

#### Slice 4: checking and replay

- implement pure/effectful property execution;
- shrink returned false and typed Effect failure;
- keep defects and interruption outside ordinary results;
- record and consume master seed, raw attempt index, size, and full shrink path;
- report replay mismatch explicitly.

Gate: one returned replay reproduces the reported minimal counterexample directly; changing property Random usage does
not change later generated attempts.

#### Slice 5: bundle fixtures and migration proof

Add together:

```text
packages/tools/bundle/fixtures/schema-toArbitrary-materialized-fast-check.ts
packages/tools/bundle/fixtures/schema-toArbitrary-materialized-native.ts
```

Both files duplicate the same representative Schema source containing:

- a constrained primitive;
- a constrained collection;
- Option as a Declaration;
- a recursive Tree.

The legacy fixture exports:

```ts
export const arbitrary = Schema.toArbitrary(schema)(FastCheck)
```

The native fixture exports:

```ts
export const arbitrary = Arbitrary.schema(schema)
```

Neither calls `sample` or `check`. The existing lazy factory fixture is not used as the comparison baseline. There is no
third tree-shaking fixture.

Gate: report both absolute minified/gzipped sizes and `native - fast-check`; inspect bundle composition if native is
larger before changing the interface.

Measured on the implemented slice with the two materialized fixtures:

| Fixture                    | Minified + gzip |
| -------------------------- | --------------: |
| fast-check v4 materialized |        78.91 KB |
| native `Arbitrary.schema`  |        27.79 KB |
| native minus fast-check    |       -51.12 KB |

The native fixture is approximately 64.8% smaller. Kernel hardening added 1.83 KB to the initial 25.96 KB native
measurement; the final numeric edge policy accounts for 0.96 KB and the stack-safety/interruption pass for 0.16 KB of
that increase. Because the resulting fixture remains substantially smaller, no composition analysis was needed for
this gate.

### Runtime performance baseline

The repository now has an `arbitrary` runtimeperf suite. Native and legacy fixtures run in separate Node processes and
use only their public APIs. The cold case includes derivation and the first sample so the legacy implementation cannot
appear cheaper merely by deferring recursive materialization. The remaining cases derive once and measure complete
sample batches, including `Effect.runSync` on the native side.

The initial correctness-first implementation measured as follows with five process rounds on Node 24.12.0 / Apple M3
and fast-check 4.9.0:

| Scenario                             |  Native | fast-check v4 | Native / fast-check |
| ------------------------------------ | ------: | ------------: | ------------------: |
| recursive cold derive + first sample |  350 µs |         64 µs |               5.42x |
| 32 recursive samples                 | 4.49 ms |        318 µs |              14.09x |
| 128 constrained strings, length 32   | 1.34 ms |        707 µs |               1.89x |
| 128 literal samples                  |  747 µs |         40 µs |              18.83x |

The recursive comparison is not normalized for identical distributions because neither public API exposes that
contract. For this deterministic fixture, however, the native batch produced 80 total tree nodes while fast-check
produced 95, so the observed gap is not explained by the native side doing more structural work.

The literal case isolated the main runner cost: every attempt initialized a full ISAAC generator through
`Random.withSeed`. The runner now hashes the master seed once, derives a small state from `(master seed, attempt)`, and
uses the public-domain [xoshiro128** 1.1](https://prng.di.unimi.it/xoshiro128starstar.c) transition internally. Replay
still jumps directly to an attempt, adjacent attempts have independent state, and property Random remains outside the
generation service. Seeded output sequences intentionally changed inside the unstable module.

The first optimized recursive measurement also exposed late constructive discards: an early recursive child could
consume budget required by later siblings. Generation now reserves every later child's minimum productive cost and
restores the budget of rejected unique candidates. The same reservation rule now covers dynamically generated record
entries: before that correction, a recursive record with two required entries discarded 17 of 100 attempts because an
early entry consumed the later entry's minimum cost; it now completes all 100 attempts without discards. The
representative productive tree consequently reports zero discards instead of retrying partially generated trees.

The recursive distributions are engine-specific, so numeric `size` values are not comparable. The permanent fixtures
now use engine-specific settings and reject the run unless the fixed seed produces comparable structural work: 99
native tree nodes and 95 fast-check nodes in the 32-sample batch, and two nodes on both sides in the cold case.

After those corrections:

| Scenario                             | Native | fast-check v4 | Native / fast-check |
| ------------------------------------ | -----: | ------------: | ------------------: |
| recursive cold derive + first sample |  86 µs |         66 µs |               1.30x |
| 32 recursive samples                 | 766 µs |        320 µs |               2.40x |
| 128 constrained strings, length 32   | 633 µs |        710 µs |               0.89x |
| 128 literal samples                  |  27 µs |         40 µs |               0.68x |

The systematic runner regression is resolved: literals and constrained strings are faster than fast-check v4, and the
cold compiler path is close. Recursive structural generation remains approximately 2.4x slower for comparable output,
so the migration performance gate remains open for investigation of composite samples, codec decoding, and the private
shrink carrier. The legacy implementation must not be removed based only on the primitive results.

The public runner paths were then measured separately. Both failure fixtures start from `1000`, fail the same property,
and shrink to `1` in one step:

| Scenario                      | Native | fast-check v4 | Native / fast-check |
| ----------------------------- | -----: | ------------: | ------------------: |
| passing property, 100 runs    | 135 µs |         42 µs |               3.22x |
| first failure plus one shrink | 4.1 µs |        9.7 µs |               0.42x |
| replay recorded failure       | 2.7 µs |        6.6 µs |               0.41x |

The passing loop was the remaining runner regression. Profiling isolated two costs: every primitive random operation
looked up an Effect `Random` service installed separately for each attempt, and every synchronous property result went
through `Effect.suspend`, `Effect.result`, and a `Result` allocation. Generation now carries its private attempt PRNG in
the private generation state, primitive generators return an immediate Effect success instead of `Effect.gen`, and
property evaluation returns an immediate success for booleans while using `Effect.matchEager` for already resolved
Effects. The ambient `Random` visible to an effectful property remains isolated from generation.

Profiling the remaining recursive gap reduced it to a non-recursive tuple of constant structs. The main cost was not SCC
analysis but composite construction: every child crossed an Effect generator boundary, samples with no shrink still
carried a completed Pull, and structural shrink samples were recursively materialized during initial generation.
Composite traversal now consumes already-resolved child Effects eagerly without recursive JavaScript calls, absence of
shrink is represented explicitly inside the private sample model, and structural shrink samples are materialized only
when their Pull is consumed. A dedicated public regression test verifies that lazy structural shrinking and replay keep
the same counterexample and path.

After that optimization, the complete suite measured:

| Scenario                             | Native | fast-check v4 | Native / fast-check |
| ------------------------------------ | -----: | ------------: | ------------------: |
| recursive cold derive + first sample |  75 µs |         65 µs |               1.15x |
| 32 recursive samples                 | 425 µs |        320 µs |               1.33x |
| 128 constrained strings, length 32   |  97 µs |        711 µs |               0.14x |
| 128 literal samples                  | 8.9 µs |         40 µs |               0.22x |
| passing property, 100 runs           |  41 µs |         42 µs |               0.99x |
| first failure plus one shrink        | 2.1 µs |        9.4 µs |               0.23x |
| replay recorded failure              | 1.4 µs |        6.6 µs |               0.22x |

Replay remains only a public end-to-end comparison, not identical internal work: native replay verifies the original
failure and follows the complete recorded shrink path, whereas fast-check can begin directly at its recorded path. The
next profile added a rare residual filter and a fixed-length unique array. It found two avoidable costs: synchronous
Schema filters were routed through the effectful codec filter-map, and `sample` materialized complete shrink trees that
only `check` and replay can consume. Residual Schema checks now use a synchronous eager path while retaining lazy
filtering of every shrink descendant. Direct sampling disables shrink construction; checking and replay still build and
validate the same trees. The unique collection loop also consumes already-resolved child Effects eagerly.

The complete suite after those changes measured:

| Scenario                             | Native | fast-check v4 | Native / fast-check |
| ------------------------------------ | -----: | ------------: | ------------------: |
| recursive cold derive + first sample |  73 µs |         68 µs |               1.07x |
| 32 recursive samples                 | 263 µs |        327 µs |               0.80x |
| 128 constrained strings, length 32   |  74 µs |        729 µs |               0.10x |
| 32 samples through a 1-in-16 filter  | 105 µs |        119 µs |               0.89x |
| 32 unique arrays of length 32        | 243 µs |        316 µs |               0.77x |
| 128 literal samples                  | 9.0 µs |         41 µs |               0.22x |
| passing property, 100 runs           |  27 µs |         43 µs |               0.62x |
| first failure plus one shrink        | 1.8 µs |        9.8 µs |               0.18x |
| replay recorded failure              | 1.1 µs |        6.7 µs |               0.17x |

The cold recursive case is the only remaining slower scenario in this suite, by approximately 7%; every steady-state
sampling and runner scenario is faster. That measurement is recorded in
`tmp/runtimeperf/results/2026-08-13T14-54-28-261Z-93149-0781cc-single-arbitrary.json`.

A subsequent kernel-hardening pass added arbitrary-width `BigInt` rejection sampling, context-aware integer shrinking,
lazy union fallback toward structurally cheaper branches, string replay tokens, and evaluation-bounded `maxShrinks`.
The same public runtime suite after those changes measured:

| Scenario                             | Native | fast-check v4 | Native / fast-check |
| ------------------------------------ | -----: | ------------: | ------------------: |
| recursive cold derive + first sample |  74 µs |         68 µs |               1.09x |
| 32 recursive samples                 | 267 µs |        333 µs |               0.80x |
| 128 constrained strings, length 32   |  76 µs |        728 µs |               0.11x |
| 32 samples through a 1-in-16 filter  | 109 µs |        119 µs |               0.91x |
| 32 unique arrays of length 32        | 253 µs |        314 µs |               0.81x |
| 128 literal samples                  | 9.3 µs |         40 µs |               0.23x |
| passing property, 100 runs           |  27 µs |         42 µs |               0.64x |
| first failure plus one shrink        | 1.3 µs |       10.0 µs |               0.13x |
| replay recorded failure              | 1.4 µs |        7.0 µs |               0.19x |

The lazy union fallback does not affect direct sampling, and the performance shape remains unchanged: only the cold
recursive case is slower, by approximately 9%; all steady-state scenarios are faster. The measurement is recorded in
`tmp/runtimeperf/results/2026-08-13T15-35-07-859Z-97250-3942f9-single-arbitrary.json`.

The ordered IEEE-754 pass then added a bounded `Number` scenario. This compares public throughput but not identical
distributions: native selects from the 64-bit representation interval, while the legacy Schema compiler delegates this
Schema to fast-check's 32-bit `float`. One five-round run measured:

| Scenario                             | Native | fast-check v4 | Native / fast-check |
| ------------------------------------ | -----: | ------------: | ------------------: |
| recursive cold derive + first sample | 164 µs |        166 µs |               0.99x |
| 32 recursive samples                 | 493 µs |        548 µs |               0.90x |
| 128 constrained strings, length 32   | 135 µs |       1.23 ms |               0.11x |
| 128 bounded Number samples           |  78 µs |        102 µs |               0.76x |
| 32 samples through a 1-in-16 filter  | 174 µs |        190 µs |               0.92x |
| 32 unique arrays of length 32        | 436 µs |        513 µs |               0.85x |
| 128 literal samples                  |  16 µs |         65 µs |               0.24x |
| passing property, 100 runs           |  48 µs |         71 µs |               0.69x |
| first failure plus one shrink        | 2.3 µs |       16.6 µs |               0.14x |
| replay recorded failure              | 2.2 µs |       11.6 µs |               0.19x |

Both implementations were slower in absolute terms than in the preceding run, so these numbers should be read as
within-run comparisons rather than a cross-run regression. Exact 64-bit selection did not introduce a visible native
throughput penalty: the new bounded case remained about 24% faster in this fixture. That is evidence that the native
carrier can be efficient, not evidence of equal statistical distributions. The measurement is recorded in
`tmp/runtimeperf/results/2026-08-13T16-07-58-139Z-636-a849a4-single-arbitrary.json`.

## Test plan

### Kernel and runner

- primitive shrink examples and termination;
- array/struct shape-preserving shrinks;
- every invalid residual shrink is hidden from the property;
- discard budget produces `Exhausted`;
- fixed seed and options produce the same attempts;
- different attempt indexes use independent sequences;
- returned false and typed property failure both shrink;
- defects remain defects;
- interruption stops generation, decoding, property execution, and shrink search;
- replay restores the complete failure and reports mismatch when it cannot.

### Schema compiler

- immediate error for unsupported Declaration and unsupported deterministic AST;
- immediate error for contradictory recognized constraints;
- no global validation pass is invoked;
- string, number, array, tuple, struct, record, and union samples satisfy checks;
- Number covers signed zero, adjacent exclusive bounds, subnormals, finite extremes, infinities, NaN, and local
  representable shrink boundaries;
- Int reaches both parities across the complete safe range and rejects bounds outside it;
- optional tuple/struct positions and tuple rest are generated and shrunk correctly;
- recursive and mutually recursive Schemas terminate with one shared SCC budget;
- unproductive recursive branches are treated as empty and fail before sampling only when the root has no finite path;
- constraints do not leak to child nodes;
- Option recursion discovers `None` through its codec as a base route;
- each initial Declaration resolution branch has a focused test;
- a custom user Declaration can derive through `toCodecJson` or `toCodec` but cannot provide typed `~toArbitrary`;
- legacy and native annotations can coexist on the same declaration.

### Differential and parity work

Differential tests against fast-check compare only validity, termination, and broad coverage. They do not require equal
seeds, exact values, distributions, shrink order, or minimal counterexamples.

After the vertical slice, port the semantic assertions from the current 1,700-line
`packages/effect/test/schema/toArbitrary.test.ts` in groups: remaining AST tags, patterns/candidates, collections,
ordered Effect types, built-in declarations, and transformations.

## Validation commands for the eventual implementation

Use the narrowest repository checks while building:

```text
pnpm lint-fix
pnpm test --run packages/effect/test/unstable/arbitrary/Arbitrary.test.ts
pnpm test-types packages/effect/typetest/unstable/arbitrary/Arbitrary.tst.ts
pnpm check
pnpm build
pnpm --dir packages/tools/bundle report <the two materialized fixtures>
node --test packages/effect/runtimeperf/test/*.test.mts
pnpm runtimeperf arbitrary
```

Exact test command paths should follow the package scripts at implementation time. Do not run the entire test suite.

Exported runtime and type changes require a patch changeset for `effect`.

## Numeric bias runtime results

The approved numeric edge policy was measured against the preceding native implementation with nine alternating
base/head rounds, 500 ms per observation and a 150 ms warmup. These are implementation diagnostics, not public
performance guarantees:

| Scenario                         |                   Native change | Interpretation                                                                                              |
| -------------------------------- | ------------------------------: | ----------------------------------------------------------------------------------------------------------- |
| bounded `Number`, 128 samples    |   `-6.11%` (`-10.29%...-3.08%`) | Precomputing the ordered IEEE interval more than pays for the extra bias decision.                          |
| rare numeric filter, 32 samples  |  `-15.39%` (`-19.80%...-9.36%`) | Zero- and edge-adjacent values satisfy the fixture's predicate more often, reducing discards.               |
| passing `Int` property, 100 runs | `+20.85%` (`+11.53%...+23.30%`) | The additional per-leaf bias decision is visible when generation and the property are otherwise very cheap. |
| fixed unique array, 32 values    | `+34.65%` (`+27.89%...+45.84%`) | Edge bias intentionally repeats a small set of values, so constructive uniqueness performs more retries.    |

In separate five-round cross-engine diagnostics, native bounded `Number` took `66.28 us` versus fast-check v4's
`90.17 us`, and the passing check took `47.07 us` versus `63.87 us`. The unique fixture took `499.36 us` versus
`453.70 us`, making it the measured exception. These timings do not imply equivalent algorithms or distributions;
the harness validates only comparable work and output invariants.

No correctness concession produced the faster cases: ordered-domain validity, broad coverage, shrinking and replay
remain intact. A unique collection inherits the full item bias: placing an Arbitrary inside `Unique` does not silently
change its distribution. This keeps leaf generation independent of its parent container, accepting that biased values
can cause more duplicate retries.

## Stack safety and interruption hardening

Permanent public-seam tests now cover compilation and sampling of a 5,000-node mutually recursive component, a
10,000-node acyclic `Suspend` chain, and traversal of 1,000 lazy child shrinks. Compilation is iterative, SCC detection
uses an iterative two-pass graph traversal, and productivity propagation uses a dependent work queue instead of whole-
graph fixed-point passes. The 10,000-node suspend probe dropped from roughly 2.2 seconds to 0.17 seconds locally after
the work-queue change.

Interruption is covered during deep suspended generation, a synchronous residual-filter discard loop, property
execution, and shrink evaluation. Residual-filter loops yield according to the runtime's `Scheduler.MaxOpsBeforeYield`
reference rather than an Arbitrary-specific constant. A nine-round base/head comparison classified the ordinary rare-
filter fixture as parity (`+1.29%`, interval `-2.26%...+5.38%`). Cold recursive derivation, steady recursive sampling,
and unique generation were also statistically inconclusive, with point estimates of `+2.23%`, `+0.93%`, and `+0.50%`.

Constructive uniqueness now keeps primitive values in a native `Set` and reserves `Hash.hash` buckets plus
`Effect.Equal` collision checks for objects and functions. This preserves the Schema equality contract, including
structural object equality, without changing the numeric item distribution. The remaining unique cost is primarily
duplicate regeneration caused by the approved item bias; distribution-aware attenuation is deliberately excluded.

## Migration beyond the vertical slice

1. complete Schema AST and built-in Declaration parity;
2. implement or port constructive pattern generation and replace legacy candidate recipes with native semantic hints;
3. extend the existing filter, unique-collection, and recursion benchmarks to constructive patterns and ordered
   domains as those generators are added;
4. migrate `TestSchema` and then `@effect/vitest` to the native runner;
5. compare bundle and runtime performance against the materialized fast-check path;
6. remove legacy `toArbitrary`, `Schema.toArbitrary`, `effect/testing/FastCheck`, and the fast-check dependency only after
   downstream adoption and parity gates pass;
7. decide whether the unstable interface is ready for `effect/Arbitrary` stabilization.

## Holistic follow-up after parity

Do not implement the following items independently during the vertical slice. Once Schema and built-in parity is
complete, evaluate them together against correctness, counterexample quality, runtime performance, and bundle size:

- [ ] compare the current `Sample` tree with trace-informed shrinking and private structural spans;
- [ ] evaluate private finite-domain metadata for constructive `unique` generation;
- [ ] add structured discard reasons and runner health diagnostics;
- [ ] evaluate automatic persistence and reuse of concrete counterexamples;
- [ ] review boundary-oriented distributions across the complete constructor catalog.

No `@effect/fast-check-v4` package or adapter is part of this plan.

## Principal risks

### Catalog maintenance

JavaScript number edge cases, `anything`, regular expressions, URLs, date/time, byte arrays, and Effect collections are
substantial work not supplied by the ZIO conceptual port. The vertical slice must not be presented as full replacement
until these domains pass parity tests.

### Constraint semantics through codecs

Cardinality usually maps naturally from a collection Declaration to an Array codec target, while ordered domain
constraints such as Date or BigDecimal do not. Tagged `Order` identity prevents primitive targets from accidentally
consuming a different ordered domain; specialized `~toArbitrary` remains necessary where the representation cannot
carry the constraint constructively.

### Codec shrink quality

Structural shrinking guarantees valid decoded candidates after filtering, not necessarily the most meaningful order in
the decoded domain. Private `~toArbitrary` is the escalation path for Effect built-ins. A public alternate-codec
annotation is added only if a real custom Declaration needs the same escape hatch and passes the deletion test.

### Bundle size

The private callback seam prevents core Schema from importing the kernel, but the compiler's central `Constructors`
object currently retains every specialized built-in implementation whenever native Arbitrary is bundled. After adding
URL and Date, the materialized Tree fixture measured 32.33 KB for native versus 78.92 KB for fast-check, and bundle
analysis confirmed that the unused URL and Date implementations were present. The native bundle remains substantially
smaller, but pay-for-use built-in tree-shaking is explicitly deferred until the catalog is complete. It is a final bundle
gate before stabilization, not a reason to introduce a marker, registry, second AST, or larger private algebra now.

### Replay stability

Replay is deterministic for the implementation that produced it, but has no cross-release promise. The stable
regression artifact remains the materialized counterexample copied into an example test.

### Property purity

Properties must not mutate generated inputs. The runner intentionally provides neither defensive cloning nor deep
freezing. This matches Effect's immutable-data conventions and avoids requiring clone semantics from private
`~toArbitrary` annotations and codec-derived declarations. Mutation isolation can be reconsidered only as a separate
feature with explicit semantics for identity, prototypes, aliases, mutable built-ins, and decode effects.

## Completion criteria for removing fast-check

The migration is complete only when all of the following are true:

- every supported Schema AST tag and built-in Declaration has native coverage or an intentional derivation error;
- recursive and mutually recursive validity/productivity tests pass;
- recognized constraints generate constructively and unknown filters exhaust predictably;
- every observed sample and shrink satisfies its node-local Schema invariants;
- replay, typed property failures, defects, and interruption behave as specified;
- native `TestSchema` and `@effect/vitest` paths no longer require fast-check;
- the materialized bundle comparison is understood and accepted;
- runtime generation and shrinking benchmarks have no unexplained critical regressions;
- no public or internal native type imports fast-check;
- the old compiler, annotations, re-export, and dependency can be deleted together.
