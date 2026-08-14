import type * as Types from "../../Types.ts"

/** @internal */
export const ToArbitraryKey = "~toArbitrary"

/** @internal */
export interface Arbitrary<out A> {
  readonly _A: Types.Covariant<A>
}

/** @internal */
export interface Constructors {
  readonly Date: () => Arbitrary<globalThis.Date>
  readonly Json: <A>() => Arbitrary<A>
  readonly RegExp: () => Arbitrary<globalThis.RegExp>
  readonly Uint8Array: () => Arbitrary<globalThis.Uint8Array<ArrayBufferLike>>
  readonly URL: () => Arbitrary<globalThis.URL>
}

/** @internal */
export interface ToArbitrary<out A> {
  (typeParameters: ReadonlyArray<Arbitrary<unknown>>): (constructors: Constructors) => Arbitrary<A>
}
