/**
 * Derives, samples, and checks generated values from Effect Schema.
 *
 * @since 4.0.0
 */
import type * as Effect from "../../Effect.ts"
import * as Internal from "../../internal/arbitrary/runner.ts"
import type * as Schema from "../../Schema.ts"
import type * as Types from "../../Types.ts"

/**
 * Runtime type identifier for native `Arbitrary` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: unique symbol = Symbol.for("~effect/unstable/arbitrary/Arbitrary")

/**
 * Type of the runtime identifier for native `Arbitrary` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = typeof TypeId

/**
 * Represents a pure description of values that can be generated and shrunk.
 *
 * **When to use**
 *
 * Use as the result of {@link schema} and as the input to {@link sample} or {@link check}.
 *
 * @category models
 * @since 4.0.0
 */
export interface Arbitrary<out A> {
  readonly [TypeId]: typeof TypeId
  readonly "~A": Types.Covariant<A>
}

/**
 * Configures direct sampling from an `Arbitrary`.
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
 * `maxShrinks` bounds the number of candidate property evaluations performed while shrinking. The `shrinks` field in
 * a `Falsified` result counts only candidates that were accepted as smaller failures.
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
 * Derives a native `Arbitrary` from the decoded `Type` of a Schema.
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
export function schema<S extends Schema.Constraint>(schema: S): Arbitrary<S["Type"]> {
  return Internal.schema(schema) as unknown as Arbitrary<S["Type"]>
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
export function sample<A>(
  self: Arbitrary<A>,
  options?: SampleOptions
): Effect.Effect<ReadonlyArray<A>, SampleError> {
  return Internal.sample(self as unknown as Internal.Arbitrary<A>, options)
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
 * @category running
 * @since 4.0.0
 */
export function check<A, E = never, R = never>(
  self: Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  options?: CheckOptions
): Effect.Effect<CheckResult<A, E>, never, R> {
  return Internal.check(
    self as unknown as Internal.Arbitrary<A>,
    property,
    options as Internal.CheckOptions | undefined
  ) as Effect.Effect<CheckResult<A, E>, never, R>
}
