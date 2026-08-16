import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Option from "../../Option.ts"
import * as Pull from "../../Pull.ts"

/** @internal */
export interface Sample<out A> {
  readonly _tag: "Generated"
  readonly value: A
  readonly shrinks: Pull.Pull<Sample<A>> | undefined
}

/** @internal */
export interface Discarded {
  readonly _tag: "Discarded"
}

/** @internal */
export type Attempt<A> = Sample<A> | Discarded

/** @internal */
export type Computation<A> = A | Effect.Effect<A>

/** @internal */
export type Generation<A> = Computation<Attempt<A>>

/** @internal */
export interface GenerationRandom {
  readonly nextUint32: () => number
  readonly nextDoubleUnsafe: () => number
  readonly clone: () => GenerationRandom
  readonly copyFrom: (source: GenerationRandom) => void
  readonly snapshot: () => readonly [number, number, number, number]
}

/** @internal */
export interface GenerationState {
  readonly size: number
  readonly shrinks: boolean
  readonly biasFactor: number
  readonly random: GenerationRandom
  readonly budget: {
    remaining: number
  }
}

/** @internal */
export interface Generator<A> {
  readonly minCost: number
  readonly generate: (state: GenerationState) => Generation<A>
}

/** @internal */
export interface Compiled<A> extends Generator<A> {
  minCost: number
  recursive: boolean
  mayRecurse: boolean
  dependencies: ReadonlyArray<Compiled<any>>
  computeMinCost: () => number
  generate: (state: GenerationState) => Generation<A>
}

/** @internal */
export const discarded: Discarded = { _tag: "Discarded" }

/** @internal */
export function mapComputation<A, B>(self: Computation<A>, f: (value: A) => B): Computation<B> {
  return Effect.isEffect(self) ? Effect.mapEager(self as Effect.Effect<A>, f) : f(self as A)
}

/** @internal */
export function flatMapComputation<A, B>(
  self: Computation<A>,
  f: (value: A) => Computation<B>
): Computation<B> {
  return Effect.isEffect(self)
    ? Effect.flatMapEager(self as Effect.Effect<A>, (value) => toEffect(f(value)))
    : f(self as A)
}

/** @internal */
export function toEffect<A>(self: Computation<A>): Effect.Effect<A> {
  return Effect.isEffect(self) ? self as Effect.Effect<A> : Effect.succeed(self as A)
}

/** @internal */
export function isAttempt<A>(self: Generation<A>): self is Attempt<A> {
  return (self as Attempt<A>)._tag === "Generated" || (self as Attempt<A>)._tag === "Discarded"
}

/** @internal */
export function mapGeneration<A, B>(
  self: Generation<A>,
  f: (value: Attempt<A>) => Attempt<B>
): Generation<B> {
  return isAttempt(self) ? f(self) : Effect.mapEager(self, f)
}

/** @internal */
export function flatMapGeneration<A, B>(
  self: Generation<A>,
  f: (value: Attempt<A>) => Generation<B>
): Generation<B> {
  return isAttempt(self)
    ? f(self)
    : Effect.flatMapEager(self, (value) => toEffectGeneration(f(value)))
}

/** @internal */
export function toEffectGeneration<A>(self: Generation<A>): Effect.Effect<Attempt<A>> {
  return isAttempt(self) ? Effect.succeed(self) : self
}

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
export const makeSample = <A>(value: A, shrinks?: Pull.Pull<Sample<A>>): Sample<A> => ({
  _tag: "Generated",
  value,
  shrinks
})

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
  f: (value: A) => Computation<Option.Option<B>>
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
          Effect.flatMapEager(toEffect(f(sample.value)), (mapped) => {
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
  f: (value: A) => Computation<Option.Option<B>>
): Computation<Option.Option<Sample<B>>> =>
  mapComputation(
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
export function makeGenerator<A>(minCost: number, generate: Generator<A>["generate"]): Generator<A> {
  return { minCost, generate }
}

/** @internal */
export function makeCompiled<A>(
  dependencies: ReadonlyArray<Compiled<any>>,
  computeMinCost: () => number,
  generate: Compiled<A>["generate"]
): Compiled<A> {
  return {
    minCost: Number.POSITIVE_INFINITY,
    recursive: false,
    mayRecurse: false,
    dependencies,
    computeMinCost,
    generate
  }
}

/** @internal */
export function makePlaceholder<A>(): Compiled<A> {
  return makeCompiled([], () => Number.POSITIVE_INFINITY, () => discarded)
}

/** @internal */
export const randomIndex = (state: GenerationState, length: number): number =>
  length === 1 ? 0 : randomUint32Below(state, length)

/** @internal */
export function generateUnion<A>(members: ReadonlyArray<Generator<A>>, state: GenerationState): Generation<A> {
  const eligible = members.filter((member) => member.minCost <= state.budget.remaining)
  if (eligible.length === 0) return discarded
  const selected = eligible[randomIndex(state, eligible.length)]
  return mapGeneration(selected.generate(state), (attempt) => {
    if (!state.shrinks || attempt._tag === "Discarded") return attempt
    let fallback = members[0]
    for (let index = 1; index < members.length; index++) {
      if (members[index].minCost < fallback.minCost) fallback = members[index]
    }
    if (fallback.minCost >= selected.minCost) return attempt

    // This lazy cross-branch fallback follows fast-check v4.9.0's FrequencyArbitrary withCrossShrink idea (MIT): a
    // value selected from a recursive branch first shrinks toward the productive base branch.
    // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/FrequencyArbitrary.ts
    let pulled = false
    const fallbackPull = Effect.suspend(() => {
      if (pulled) return Cause.done()
      pulled = true
      return Effect.flatMapEager(
        toEffectGeneration(fallback.generate({ ...state, budget: { remaining: fallback.minCost } })),
        (attempt) => attempt._tag === "Generated" ? Effect.succeed(attempt) : Cause.done()
      )
    })
    return makeSample(
      attempt.value,
      attempt.shrinks === undefined ? fallbackPull : concatPulls([fallbackPull, attempt.shrinks])
    )
  })
}

const numberOfUint32Values = 0x100000000

function randomUint32Below(state: GenerationState, rangeSize: number): number {
  // Equal-size buckets plus rejection apply the same unbiased selection principle as pure-rand v8.4.1's
  // uniformIntInternal (MIT), used by fast-check v4.9.0. Small discrete ranges consume one PRNG word instead of
  // constructing a 53-bit double.
  // https://github.com/dubzzz/pure-rand/blob/v8.4.1/src/distribution/uniformInt.ts
  const bucketSize = Math.floor(numberOfUint32Values / rangeSize)
  const maximumAccepted = bucketSize * rangeSize
  let value = state.random.nextUint32()
  while (value >= maximumAccepted) value = state.random.nextUint32()
  return Math.floor(value / bucketSize)
}

function makeRandomUint32Below(rangeSize: number): (state: GenerationState) => number {
  const bucketSize = Math.floor(numberOfUint32Values / rangeSize)
  const maximumAccepted = bucketSize * rangeSize
  return (state) => {
    let value = state.random.nextUint32()
    while (value >= maximumAccepted) value = state.random.nextUint32()
    return Math.floor(value / bucketSize)
  }
}

/** @internal */
export const randomInt = (state: GenerationState, minimum: number, maximum: number): number => {
  minimum = Math.ceil(minimum)
  maximum = Math.floor(maximum)
  if (minimum === maximum) return minimum
  const width = maximum - minimum + 1
  if (width <= numberOfUint32Values) return minimum + randomUint32Below(state, width)
  const numberOfDoubleValues = 0x20000000000000
  if (width <= numberOfDoubleValues) {
    // Equal-size buckets plus rejection apply the same unbiased selection principle as pure-rand v8.4.1's uniformInt
    // (MIT), used by fast-check v4.9.0.
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
export const randomLength = (state: GenerationState, minimum: number, maximum: number): number => {
  if (minimum === maximum) return minimum
  // This applies fast-check v4.9.0's run-dependent numeric edge-bias principle to the small discrete length domain
  // (MIT): occasionally target either boundary, otherwise retain uniform selection across the complete interval.
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/IntegerArbitrary.ts
  if (randomInt(state, 1, state.biasFactor) === 1) return randomBoolean(state) ? minimum : maximum
  return randomInt(state, minimum, maximum)
}

/** @internal */
export const randomBigInt = (state: GenerationState, minimum: bigint, maximum: bigint): bigint => {
  if (minimum === maximum) return minimum
  const width = maximum - minimum + BigInt(1)
  const bitLength = (width - BigInt(1)).toString(2).length
  const leadingBits = (bitLength - 1) % 32 + 1
  const leadingRange = 2 ** leadingBits
  // Arbitrary-width rejection sampling follows the same principle as pure-rand v8.4.1's uniformBigInt (MIT), used by
  // fast-check v4.9.0. This implementation draws unsigned words from the private attempt PRNG instead of pure-rand.
  // https://github.com/dubzzz/pure-rand/blob/v8.4.1/src/distribution/uniformBigInt.ts
  while (true) {
    let value = BigInt(randomUint32Below(state, leadingRange))
    for (let remaining = bitLength - leadingBits; remaining > 0; remaining -= 32) {
      const word = BigInt(state.random.nextUint32())
      value = value << BigInt(32) | word
    }
    if (value < width) return minimum + value
  }
}

function makeRandomInt(minimum: number, maximum: number): (state: GenerationState) => number {
  minimum = Math.ceil(minimum)
  maximum = Math.floor(maximum)
  if (minimum === maximum) return () => minimum
  const width = maximum - minimum + 1
  if (width <= numberOfUint32Values) {
    const randomBelow = makeRandomUint32Below(width)
    return (state) => minimum + randomBelow(state)
  }
  const numberOfDoubleValues = 0x20000000000000
  if (width <= numberOfDoubleValues) {
    const bucketSize = Math.floor(numberOfDoubleValues / width)
    const maximumAccepted = bucketSize * width
    return (state) => {
      while (true) {
        const value = Math.floor(state.random.nextDoubleUnsafe() * numberOfDoubleValues)
        if (value < maximumAccepted) return minimum + Math.floor(value / bucketSize)
      }
    }
  }
  const random = makeRandomBigInt(BigInt(minimum), BigInt(maximum))
  return (state) => Number(random(state))
}

function makeRandomBigInt(minimum: bigint, maximum: bigint): (state: GenerationState) => bigint {
  if (minimum === maximum) return () => minimum
  const width = maximum - minimum + BigInt(1)
  const bitLength = (width - BigInt(1)).toString(2).length
  const leadingBits = (bitLength - 1) % 32 + 1
  const leadingRange = 2 ** leadingBits
  const randomLeading = makeRandomUint32Below(leadingRange)
  return (state) => {
    while (true) {
      let value = BigInt(randomLeading(state))
      for (let remaining = bitLength - leadingBits; remaining > 0; remaining -= 32) {
        value = value << BigInt(32) | BigInt(state.random.nextUint32())
      }
      if (value < width) return minimum + value
    }
  }
}

interface NumberRange {
  readonly minimum: number
  readonly maximum: number
}

interface BigIntRange {
  readonly minimum: bigint
  readonly maximum: bigint
}

// The numeric edge ranges and their 2:1 preference for the edge closest to zero follow fast-check v4.9.0's
// BiasNumericRange, IntegerArbitrary, and BigIntArbitrary (MIT). The policy stays private to the Arbitrary engine.
// https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/helpers/BiasNumericRange.ts
// https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/IntegerArbitrary.ts
// https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/BigIntArbitrary.ts
function numberBiasRanges(minimum: number, maximum: number): ReadonlyArray<NumberRange> {
  if (minimum === maximum) return [{ minimum, maximum }]
  if (minimum < 0 && maximum > 0) {
    const low = Math.floor(Math.log2(-minimum))
    const high = Math.floor(Math.log2(maximum))
    return [
      { minimum: -low, maximum: high },
      { minimum: maximum - high, maximum },
      { minimum, maximum: minimum + low }
    ]
  }
  const gap = Math.floor(Math.log2(maximum - minimum))
  const closeToMinimum = { minimum, maximum: minimum + gap }
  const closeToMaximum = { minimum: maximum - gap, maximum }
  return minimum < 0 ? [closeToMaximum, closeToMinimum] : [closeToMinimum, closeToMaximum]
}

function bigIntLogLike(value: bigint): bigint {
  return value === BigInt(0) ? BigInt(0) : BigInt(value.toString().length)
}

function bigIntBiasRanges(minimum: bigint, maximum: bigint): ReadonlyArray<BigIntRange> {
  if (minimum === maximum) return [{ minimum, maximum }]
  if (minimum < BigInt(0) && maximum > BigInt(0)) {
    const low = bigIntLogLike(-minimum)
    const high = bigIntLogLike(maximum)
    return [
      { minimum: -low, maximum: high },
      { minimum: maximum - high, maximum },
      { minimum, maximum: minimum + low }
    ]
  }
  const gap = bigIntLogLike(maximum - minimum)
  const closeToMinimum = { minimum, maximum: minimum + gap }
  const closeToMaximum = { minimum: maximum - gap, maximum }
  return minimum < BigInt(0) ? [closeToMaximum, closeToMinimum] : [closeToMinimum, closeToMaximum]
}

function selectNumberRange<A extends NumberRange>(state: GenerationState, ranges: ReadonlyArray<A>): A {
  if (ranges.length === 1) return ranges[0]
  const index = randomInt(state, -2 * (ranges.length - 1), ranges.length - 2)
  return index < 0 ? ranges[0] : ranges[index + 1]
}

function selectBigIntRange<A extends BigIntRange>(state: GenerationState, ranges: ReadonlyArray<A>): A {
  if (ranges.length === 1) return ranges[0]
  const index = randomInt(state, -2 * (ranges.length - 1), ranges.length - 2)
  return index < 0 ? ranges[0] : ranges[index + 1]
}

/** @internal */
export function makeRandomNumericInt(
  minimum: number,
  maximum: number
): (state: GenerationState) => number {
  const full = { minimum, maximum, random: makeRandomInt(minimum, maximum) }
  const biased = numberBiasRanges(minimum, maximum).map((range) => ({
    ...range,
    random: makeRandomInt(range.minimum, range.maximum)
  }))
  return (state) => {
    const range = randomInt(state, 1, state.biasFactor) === 1 ? selectNumberRange(state, biased) : full
    return range.random(state)
  }
}

/** @internal */
export function makeRandomNumericBigInt(
  minimum: bigint,
  maximum: bigint
): (state: GenerationState) => bigint {
  const full = { minimum, maximum, random: makeRandomBigInt(minimum, maximum) }
  const biased = bigIntBiasRanges(minimum, maximum).map((range) => ({
    ...range,
    random: makeRandomBigInt(range.minimum, range.maximum)
  }))
  return (state) => {
    const range = randomInt(state, 1, state.biasFactor) === 1 ? selectBigIntRange(state, biased) : full
    return range.random(state)
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
  const unsigned = (bits & numberSignMask) === BigInt(0) ? bits | numberSignMask : ~bits & numberBitsMask
  return unsigned - numberSignMask
}

/** @internal */
export function indexToNumber(index: bigint): number {
  const unsigned = index + numberSignMask
  const bits = (unsigned & numberSignMask) === BigInt(0)
    ? ~unsigned & numberBitsMask
    : unsigned ^ numberSignMask
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
export function makeRandomNumber(
  minimum: number,
  maximum: number,
  allowNaN: boolean
): (state: GenerationState) => number {
  const minimumIndex = numberToIndex(minimum)
  const maximumIndex = numberToIndex(maximum)
  const nanBelow = allowNaN && maximumIndex <= BigInt(0)
  const randomIndex = makeRandomNumericBigInt(
    nanBelow ? minimumIndex - BigInt(1) : minimumIndex,
    allowNaN && !nanBelow ? maximumIndex + BigInt(1) : maximumIndex
  )
  return (state) => {
    const index = randomIndex(state)
    return index < minimumIndex || index > maximumIndex ? Number.NaN : indexToNumber(index)
  }
}

/** @internal */
export const randomBoolean = (state: GenerationState): boolean => (state.random.nextUint32() & 1) === 1

/** @internal */
export function shuffle<A>(state: GenerationState, elements: Iterable<A>): Array<A> {
  const buffer = Array.from(elements)
  for (let index = buffer.length - 1; index >= 1; index--) {
    const target = randomUint32Below(state, index + 1)
    const value = buffer[index]!
    buffer[index] = buffer[target]!
    buffer[target] = value
  }
  return buffer
}
