import type * as Types from "../../Types.ts"

/** @internal */
export const ToArbitraryKey = "~toArbitrary"

/** @internal */
export interface Arbitrary<out A> {
  readonly _A: Types.Covariant<A>
}

/** @internal */
export interface Constructors {
  readonly Json: <A>() => Arbitrary<A>
  readonly RegExp: () => Arbitrary<globalThis.RegExp>
}

/** @internal */
export interface ToArbitrary<out A> {
  (typeParameters: ReadonlyArray<Arbitrary<unknown>>): (constructors: Constructors) => Arbitrary<A>
}
