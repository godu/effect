import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Option from "../../Option.ts"
import * as Pull from "../../Pull.ts"
import type * as Random from "../../Random.ts"

/** @internal */
export interface Sample<out A> {
  readonly value: A
  readonly shrinks: Pull.Pull<Sample<A>> | undefined
}

/** @internal */
export interface Generated<out A> {
  readonly _tag: "Generated"
  readonly sample: Sample<A>
}

/** @internal */
export interface Discarded {
  readonly _tag: "Discarded"
}

/** @internal */
export type Attempt<A> = Generated<A> | Discarded

/** @internal */
export interface GenerationState {
  readonly size: number
  readonly shrinks: boolean
  readonly random: typeof Random.Random.Service
  readonly budget: {
    remaining: number
  }
}

/** @internal */
export interface Compiled<A> {
  minCost: number
  recursive: boolean
  dependencies: ReadonlyArray<Compiled<any>>
  computeMinCost: () => number
  generate: (state: GenerationState) => Effect.Effect<Attempt<A>>
}

/** @internal */
export const discarded: Discarded = { _tag: "Discarded" }

/** @internal */
export const generated = <A>(sample: Sample<A>): Attempt<A> => ({ _tag: "Generated", sample })

/** @internal */
export function pullFromArray<A>(values: ReadonlyArray<A>): Pull.Pull<A> {
  let index = 0
  return Effect.suspend(() => index >= values.length ? Cause.done() : Effect.succeed(values[index++]))
}

/** @internal */
export function mapPull<A, B>(self: Pull.Pull<A>, f: (value: A) => B): Pull.Pull<B> {
  return Effect.map(self, f)
}

/** @internal */
export function concatPulls<A>(pulls: ReadonlyArray<Pull.Pull<A>>): Pull.Pull<A> {
  let index = 0
  const loop = (): Pull.Pull<A> =>
    Effect.suspend(() => {
      if (index >= pulls.length) return Cause.done()
      return Pull.matchEffect(pulls[index], {
        onSuccess: Effect.succeed,
        onDone: () => {
          index++
          return loop()
        },
        onFailure: Effect.failCause
      })
    })
  return loop()
}

/** @internal */
export const makeSample = <A>(value: A, shrinks?: Pull.Pull<Sample<A>>): Sample<A> => ({ value, shrinks })

/** @internal */
export function sampleFromShrink<A>(value: A, shrink: (value: A) => ReadonlyArray<A>): Sample<A> {
  const values = shrink(value)
  return makeSample(
    value,
    values.length === 0 ? undefined : mapPull(pullFromArray(values), (value) => sampleFromShrink(value, shrink))
  )
}

/** @internal */
export function mapSample<A, B>(self: Sample<A>, f: (value: A) => B): Sample<B> {
  return makeSample(
    f(self.value),
    self.shrinks === undefined ? undefined : mapPull(self.shrinks, (sample) => mapSample(sample, f))
  )
}

function filterMapPull<A, B>(
  source: Pull.Pull<Sample<A>>,
  f: (value: A) => Effect.Effect<Option.Option<B>>
): Pull.Pull<Sample<B>> {
  const queue: Array<Pull.Pull<Sample<A>>> = [source]
  const loop = (): Pull.Pull<Sample<B>> =>
    Effect.suspend(() => {
      const current = queue[0]
      if (current === undefined) return Cause.done()
      return Pull.matchEffect(current, {
        onFailure: Effect.failCause,
        onDone: () => {
          queue.shift()
          return loop()
        },
        onSuccess: (sample) =>
          Effect.flatMapEager(f(sample.value), (mapped) => {
            if (Option.isSome(mapped)) {
              return Effect.succeed(makeSample(
                mapped.value,
                sample.shrinks === undefined ? undefined : filterMapPull(sample.shrinks, f)
              ))
            }
            if (sample.shrinks !== undefined) queue.unshift(sample.shrinks)
            return loop()
          })
      })
    })
  return loop()
}

function filterPull<A>(source: Pull.Pull<Sample<A>>, predicate: (value: A) => boolean): Pull.Pull<Sample<A>> {
  const queue: Array<Pull.Pull<Sample<A>>> = [source]
  const loop = (): Pull.Pull<Sample<A>> =>
    Effect.suspend(() => {
      const current = queue[0]
      if (current === undefined) return Cause.done()
      return Pull.matchEffect(current, {
        onFailure: Effect.failCause,
        onDone: () => {
          queue.shift()
          return loop()
        },
        onSuccess: (sample) => {
          if (predicate(sample.value)) {
            return Effect.succeed(makeSample(
              sample.value,
              sample.shrinks === undefined ? undefined : filterPull(sample.shrinks, predicate)
            ))
          }
          if (sample.shrinks !== undefined) queue.unshift(sample.shrinks)
          return loop()
        }
      })
    })
  return loop()
}

/** @internal */
export const filterMapSample = <A, B>(
  self: Sample<A>,
  f: (value: A) => Effect.Effect<Option.Option<B>>
): Effect.Effect<Option.Option<Sample<B>>> =>
  Effect.mapEager(
    f(self.value),
    (value) =>
      Option.isNone(value)
        ? Option.none<Sample<B>>()
        : Option.some(makeSample(
          value.value,
          self.shrinks === undefined ? undefined : filterMapPull(self.shrinks, f)
        ))
  )

/** @internal */
export const filterSample = <A>(self: Sample<A>, predicate: (value: A) => boolean): Option.Option<Sample<A>> =>
  predicate(self.value)
    ? Option.some(
      self.shrinks === undefined
        ? self
        : makeSample(self.value, filterPull(self.shrinks, predicate))
    )
    : Option.none()

/** @internal */
export function makeCompiled<A>(
  dependencies: ReadonlyArray<Compiled<any>>,
  computeMinCost: () => number,
  generate: Compiled<A>["generate"]
): Compiled<A> {
  return {
    minCost: Number.POSITIVE_INFINITY,
    recursive: false,
    dependencies,
    computeMinCost,
    generate
  }
}

/** @internal */
export function makePlaceholder<A>(): Compiled<A> {
  return makeCompiled([], () => Number.POSITIVE_INFINITY, () => Effect.succeed(discarded))
}

/** @internal */
export const randomIndex = (state: GenerationState, length: number): number =>
  Math.floor(state.random.nextDoubleUnsafe() * length)

/** @internal */
export const randomInt = (state: GenerationState, minimum: number, maximum: number): number => {
  minimum = Math.ceil(minimum)
  maximum = Math.floor(maximum)
  if (minimum === maximum) return minimum
  const width = maximum - minimum + 1
  const numberOfDoubleValues = 0x20000000000000
  if (width <= numberOfDoubleValues) {
    // Equal-size buckets plus rejection apply the same unbiased selection principle as pure-rand v8.4.1's uniformInt
    // (MIT), used by fast-check v4.9.0. Keeping contiguous buckets also preserves the previous mapping for ordinary
    // small ranges except for the rejected tail.
    // https://github.com/dubzzz/pure-rand/blob/v8.4.1/src/distribution/uniformInt.ts
    const bucketSize = Math.floor(numberOfDoubleValues / width)
    const maximumAccepted = bucketSize * width
    while (true) {
      const value = Math.floor(state.random.nextDoubleUnsafe() * numberOfDoubleValues)
      if (value < maximumAccepted) return minimum + Math.floor(value / bucketSize)
    }
  }
  return Number(randomBigInt(state, BigInt(minimum), BigInt(maximum)))
}

/** @internal */
export const randomBigInt = (state: GenerationState, minimum: bigint, maximum: bigint): bigint => {
  if (minimum === maximum) return minimum
  const width = maximum - minimum + BigInt(1)
  const bitLength = (width - BigInt(1)).toString(2).length
  const leadingBits = (bitLength - 1) % 32 + 1
  const leadingRange = 2 ** leadingBits
  // Arbitrary-width rejection sampling follows the same principle as pure-rand v8.4.1's uniformBigInt (MIT), used by
  // fast-check v4.9.0. This implementation draws unsigned words from Effect Random instead of pure-rand's generator.
  // https://github.com/dubzzz/pure-rand/blob/v8.4.1/src/distribution/uniformBigInt.ts
  while (true) {
    let value = BigInt(Math.floor(state.random.nextDoubleUnsafe() * leadingRange))
    for (let remaining = bitLength - leadingBits; remaining > 0; remaining -= 32) {
      const word = BigInt(Math.floor(state.random.nextDoubleUnsafe() * 0x100000000))
      value = value << BigInt(32) | word
    }
    if (value < width) return minimum + value
  }
}

// The monotone IEEE-754 index and adjacent-number navigation follow the model used by fast-check v4.9.0's
// DoubleHelpers (MIT). This implementation uses a direct 64-bit bit cast instead of its exponent decomposition.
// https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/helpers/DoubleHelpers.ts
const numberBuffer = new ArrayBuffer(8)
const numberView = new DataView(numberBuffer)
const numberSignMask = BigInt(1) << BigInt(63)
const numberBitsMask = (BigInt(1) << BigInt(64)) - BigInt(1)

/** @internal */
export function numberToIndex(value: number): bigint {
  numberView.setFloat64(0, value)
  const bits = numberView.getBigUint64(0)
  return (bits & numberSignMask) === BigInt(0) ? bits | numberSignMask : ~bits & numberBitsMask
}

/** @internal */
export function indexToNumber(index: bigint): number {
  const bits = (index & numberSignMask) === BigInt(0) ? ~index & numberBitsMask : index ^ numberSignMask
  numberView.setBigUint64(0, bits)
  return numberView.getFloat64(0)
}

/** @internal */
export function nextNumber(value: number): number {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) return value
  if (value === 0) return Number.MIN_VALUE
  return indexToNumber(numberToIndex(value) + BigInt(1))
}

/** @internal */
export function previousNumber(value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return value
  if (value === 0) return -Number.MIN_VALUE
  return indexToNumber(numberToIndex(value) - BigInt(1))
}

/** @internal */
export const randomNumber = (state: GenerationState, minimum: number, maximum: number): number =>
  indexToNumber(randomBigInt(state, numberToIndex(minimum), numberToIndex(maximum)))

/** @internal */
export const randomBetween = (state: GenerationState, minimum: number, maximum: number): number =>
  state.random.nextDoubleUnsafe() * (maximum - minimum) + minimum

/** @internal */
export const randomBoolean = (state: GenerationState): boolean => state.random.nextDoubleUnsafe() > 0.5

/** @internal */
export function shuffle<A>(state: GenerationState, elements: Iterable<A>): Array<A> {
  const buffer = Array.from(elements)
  for (let index = buffer.length - 1; index >= 1; index--) {
    const target = Math.min(index, Math.floor(state.random.nextDoubleUnsafe() * (index + 1)))
    const value = buffer[index]!
    buffer[index] = buffer[target]!
    buffer[target] = value
  }
  return buffer
}
