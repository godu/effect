/**
 * Derives, samples, and checks generated values from Effect Schema.
 *
 * @since 4.0.0
 */
import type * as Effect from "../../Effect.ts"
import type * as Filter from "../../Filter.ts"
import { dual } from "../../Function.ts"
import type * as Model from "../../internal/arbitrary/model.ts"
import * as Internal from "../../internal/arbitrary/runner.ts"
import type { Pipeable } from "../../Pipeable.ts"
import { hasProperty, type Predicate, type Refinement } from "../../Predicate.ts"
import type * as Schema_ from "../../Schema.ts"
import type * as Types from "../../Types.ts"

declare module "../../Schema.ts" {
  namespace Annotations {
    interface Bottom<T, TypeParameters extends ReadonlyArray<Schema_.Constraint>> {
      /**
       * Provides a replacement `Arbitrary` factory for the annotated Schema.
       *
       * **When to use**
       *
       * Use when a particular Schema occurrence needs a custom generation distribution.
       *
       * **Details**
       *
       * The factory is evaluated when `Arbitrary.schema` derives the containing Schema. Checks attached to the node are
       * still applied to generated roots and shrink candidates.
       *
       * **Gotchas**
       *
       * The outermost `arbitrary` annotation in a check chain takes precedence. Setting it to `undefined` clears an
       * inner annotation. The factory must not derive the same annotated Schema recursively.
       *
       * @since 4.0.0
       */
      readonly arbitrary?: (() => Arbitrary<T>) | undefined
    }
  }
}

/**
 * Runtime type identifier for `Arbitrary` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = Internal.TypeId

/**
 * Type of the runtime identifier for `Arbitrary` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/unstable/arbitrary/Arbitrary"

/**
 * Represents a pure description of values that can be generated and shrunk.
 *
 * **When to use**
 *
 * Use as the result of {@link schema} and as the input to {@link sampleEffect} or {@link checkEffect}.
 *
 * **Details**
 *
 * Arbitraries implement `Pipeable`, so data-last combinators can be composed with `.pipe(...)`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Arbitrary<out A> extends Pipeable {
  readonly [TypeId]: TypeId
  readonly "~A": Types.Covariant<A>
  /** @internal */
  readonly gen: Model.Generator<A>
}

/**
 * Checks whether a value is an `Arbitrary`.
 *
 * **When to use**
 *
 * Use when accepting both Arbitrary values and other input descriptions.
 *
 * @category guards
 * @since 4.0.0
 */
export const isArbitrary = (u: unknown): u is Arbitrary<unknown> => hasProperty(u, TypeId)

/**
 * Configures direct sampling from an `Arbitrary`.
 *
 * **Details**
 *
 * `size` bounds the cardinality or complexity of unconstrained generated values. Strings, arrays, and object
 * properties scale with it without an additional internal ceiling. Explicit Schema minima and required members are
 * still honored, while explicit maxima clamp generation.
 *
 * @category models
 * @since 4.0.0
 */
export interface SampleOptions {
  readonly count?: number | undefined
  readonly size?: number | undefined
  readonly maxDiscards?: number | undefined
  readonly seed?: string | number | undefined
}

/**
 * Describes sampling exhaustion before the requested number of values was generated.
 *
 * @category errors
 * @since 4.0.0
 */
export interface SampleError {
  readonly _tag: "SampleError"
  readonly generated: number
  readonly discards: number
}

/**
 * Opaque string token that replays a falsification and its complete shrink path.
 *
 * **When to use**
 *
 * Use with {@link CheckOptions.replay} to copy, store, and reproduce a `Falsified` result from the same
 * implementation.
 *
 * **Gotchas**
 *
 * Replay compatibility is not guaranteed across releases of this unstable module.
 *
 * @category models
 * @since 4.0.0
 */
export type Replay = string

/**
 * Configures property checking, shrinking, and replay.
 *
 * **Details**
 *
 * `size` is the maximum generation budget. Checking starts with smaller values and grows to that budget according to
 * completed runs; discarded attempts do not advance the progression. A single-run check uses the configured size.
 * Unconstrained strings, arrays, and object properties use the current budget without an additional internal ceiling;
 * explicit Schema bounds and required members still apply.
 *
 * `maxShrinks` bounds the number of shrink candidates inspected after the initial failure. Candidates rejected by a
 * Schema check, `filter`, `filterMap`, or dependent generation consume the same budget even though the property is not
 * evaluated. When the budget is exhausted, checking returns the best counterexample found so far. The `shrinks` field
 * in a `Falsified` result counts only candidates that were accepted as smaller failures.
 *
 * Replay follows an existing shrink path instead of searching for one, so `maxShrinks` is ignored when `replay` is
 * present.
 *
 * @category models
 * @since 4.0.0
 */
export interface CheckOptions {
  readonly runs?: number | undefined
  readonly size?: number | undefined
  readonly maxDiscards?: number | undefined
  readonly maxShrinks?: number | undefined
  readonly seed?: string | number | undefined
  readonly replay?: Replay | undefined
}

/**
 * Identifies a property that returned `false`.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReturnedFalse {
  readonly _tag: "ReturnedFalse"
}

/**
 * Preserves a typed failure produced by an effectful property.
 *
 * @category models
 * @since 4.0.0
 */
export interface PropertyError<out E> {
  readonly _tag: "PropertyError"
  readonly error: E
}

/**
 * Represents the reason a property was falsified.
 *
 * @category models
 * @since 4.0.0
 */
export type PropertyFailure<E> = ReturnedFalse | PropertyError<E>

/**
 * Reports that every requested property run passed.
 *
 * @category models
 * @since 4.0.0
 */
export interface Passed {
  readonly _tag: "Passed"
  readonly runs: number
  readonly discards: number
}

/**
 * Reports a generated failure and its shrunk counterexample.
 *
 * **Details**
 *
 * `runs` counts main property evaluations through the falsifying evaluation. It excludes evaluations performed while
 * shrinking. A replay reports one run.
 *
 * @category models
 * @since 4.0.0
 */
export interface Falsified<out A, out E> {
  readonly _tag: "Falsified"
  readonly initialInput: A
  readonly counterexample: A
  readonly failure: PropertyFailure<E>
  readonly runs: number
  readonly discards: number
  readonly shrinks: number
  readonly replay: Replay
}

/**
 * Reports that bounded generation discarded too many candidates.
 *
 * @category models
 * @since 4.0.0
 */
export interface Exhausted {
  readonly _tag: "Exhausted"
  readonly runs: number
  readonly discards: number
}

/**
 * Reports that replay coordinates no longer reproduce the recorded failure.
 *
 * @category models
 * @since 4.0.0
 */
export interface ReplayMismatch {
  readonly _tag: "ReplayMismatch"
  readonly reason: "AttemptDiscarded" | "PropertyPassed" | "ShrinkPathUnavailable" | "ShrinkPassed"
}

/**
 * Represents every ordinary outcome of property checking.
 *
 * **Details**
 *
 * Defects and fiber interruption are not converted to this data type and continue through the returned `Effect`.
 *
 * @category models
 * @since 4.0.0
 */
export type CheckResult<A, E> = Passed | Falsified<A, E> | Exhausted | ReplayMismatch

/**
 * Derives an `Arbitrary` from the decoded `Type` of a Schema.
 *
 * **When to use**
 *
 * Use when you want Schema-aware generation without exposing a third-party property-testing engine.
 *
 * **Gotchas**
 *
 * Derivation is immediate and throws when the current unstable implementation cannot compile the Schema or prove a
 * finite route through a recursive component.
 *
 * @category constructors
 * @since 4.0.0
 */
export function schema<S extends Schema_.Constraint>(schema: S): Arbitrary<S["Type"]> {
  return Internal.schema(schema)
}

/**
 * Transforms every generated value and its shrink candidates.
 *
 * **When to use**
 *
 * Use when you want to derive generated values from an existing `Arbitrary` without changing its generation or shrink
 * structure.
 *
 * @category mapping
 * @since 4.0.0
 */
export const map: {
  <A, B>(f: (value: A) => B): (self: Arbitrary<A>) => Arbitrary<B>
  <A, B>(self: Arbitrary<A>, f: (value: A) => B): Arbitrary<B>
} = dual(2, <A, B>(self: Arbitrary<A>, f: (value: A) => B): Arbitrary<B> => Internal.map(self, f))

/**
 * Keeps generated values and shrink candidates that satisfy a predicate or refinement.
 *
 * **When to use**
 *
 * Use when a condition cannot be expressed constructively by the source Schema or after values have been transformed.
 *
 * **Gotchas**
 *
 * Rejected generated values count against `maxDiscards`. Prefer Schema checks when possible because the Schema compiler
 * may generate matching values directly.
 *
 * @see {@link filterMap} for transforming and filtering simultaneously
 * @category filtering
 * @since 4.0.0
 */
export const filter: {
  <A, B extends A>(refinement: Refinement<A, B>): (self: Arbitrary<A>) => Arbitrary<B>
  <A>(predicate: Predicate<A>): <B extends A>(self: Arbitrary<B>) => Arbitrary<B>
  <A, B extends A>(self: Arbitrary<A>, refinement: Refinement<A, B>): Arbitrary<B>
  <A>(self: Arbitrary<A>, predicate: Predicate<A>): Arbitrary<A>
} = dual(2, <A>(self: Arbitrary<A>, predicate: Predicate<A>): Arbitrary<A> => Internal.filter(self, predicate))

/**
 * Transforms accepted generated values and discards rejected values.
 *
 * **When to use**
 *
 * Use when transformation and validation need to happen in one step after constructing an `Arbitrary`.
 *
 * **Gotchas**
 *
 * Failed filters discard generated roots and count against `maxDiscards`. Failures are not exposed in sampling or
 * checking results.
 *
 * @see {@link map} for transformations that cannot reject
 * @see {@link filter} for retaining original values that satisfy a condition
 * @category filtering
 * @since 4.0.0
 */
export const filterMap: {
  <A, B, X>(f: Filter.Filter<A, B, X>): (self: Arbitrary<A>) => Arbitrary<B>
  <A, B, X>(self: Arbitrary<A>, f: Filter.Filter<A, B, X>): Arbitrary<B>
} = dual(
  2,
  <A, B, X>(self: Arbitrary<A>, f: Filter.Filter<A, B, X>): Arbitrary<B> => Internal.filterMap(self, f)
)

/**
 * Sequentially selects an `Arbitrary` from a generated value.
 *
 * **When to use**
 *
 * Use when the domain or shape of a generated value depends on another generated value.
 *
 * **Details**
 *
 * Shrinking first tries smaller source values and regenerates their dependent Arbitraries. It then shrinks the
 * selected dependent value. After a dependent shrink is selected, source shrinking is closed for that branch.
 *
 * **Gotchas**
 *
 * The callback must be synchronous, deterministic, and terminating. It can be evaluated again during shrinking and
 * replay. Deriving a Schema inside the callback also repeats that derivation, so precompile finite dependent
 * Arbitraries when possible.
 *
 * @see {@link map} for total transformations that do not select another Arbitrary
 * @see {@link Union} for static alternatives
 * @category sequencing
 * @since 4.0.0
 */
export const flatMap: {
  <A, B>(f: (value: A) => Arbitrary<B>): (self: Arbitrary<A>) => Arbitrary<B>
  <A, B>(self: Arbitrary<A>, f: (value: A) => Arbitrary<B>): Arbitrary<B>
} = dual(2, <A, B>(self: Arbitrary<A>, f: (value: A) => Arbitrary<B>): Arbitrary<B> => Internal.flatMap(self, f))

/**
 * Combines an array of existing Arbitraries into one `Arbitrary`.
 *
 * **When to use**
 *
 * Use when generated values should come from one of several static alternatives.
 *
 * **Details**
 *
 * Members compatible with the current generation budget are selected uniformly. Shrinking first tries the earliest
 * globally minimum-cost member when it is strictly cheaper, then continues within the selected member.
 *
 * **Gotchas**
 *
 * Throws when `members` is empty. The initial interface does not support weighted alternatives.
 *
 * @category constructors
 * @since 4.0.0
 */
export function Union<const Members extends ReadonlyArray<Arbitrary<any>>>(
  members: Members
): Arbitrary<Types.Covariant.Type<Members[number]["~A"]>> {
  return Internal.union(members)
}

/**
 * Generates a bounded collection of values from an `Arbitrary`.
 *
 * **When to use**
 *
 * Use when you need generated examples without running a property.
 *
 * @category running
 * @since 4.0.0
 */
export function sampleEffect<A>(
  self: Arbitrary<A>,
  options?: SampleOptions
): Effect.Effect<ReadonlyArray<A>, SampleError> {
  return Internal.sampleEffect(self, options)
}

/**
 * Checks a pure or effectful property and shrinks the first falsification.
 *
 * **When to use**
 *
 * Use when you want deterministic, interruptible property checking with typed property failures and replay.
 *
 * **Details**
 *
 * Returning `false` and failing an Effect are shrinkable falsifications. Defects and interruption continue through the
 * returned Effect instead of becoming `CheckResult` values.
 *
 * **Gotchas**
 *
 * Properties must treat generated values as immutable. The runner does not clone values before evaluation, so
 * mutation can change reported counterexamples or interfere with shrinking and replay.
 *
 * A property must also produce the same outcome for the same input and initial environment. The runner may evaluate
 * it repeatedly and does not restore mutable services between evaluations. Stateful properties should acquire and
 * release an independent fixture inside each evaluation.
 *
 * @category running
 * @since 4.0.0
 */
export function checkEffect<A, E = never, R = never>(
  self: Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  options?: CheckOptions
): Effect.Effect<CheckResult<A, E>, never, R> {
  return Internal.checkEffect(self, property, options)
}
