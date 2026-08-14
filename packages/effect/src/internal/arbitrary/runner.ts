import * as Effect from "../../Effect.ts"
import * as Option from "../../Option.ts"
import * as Pull from "../../Pull.ts"
import * as Random from "../../Random.ts"
import * as Scheduler from "../../Scheduler.ts"
import type * as Schema from "../../Schema.ts"
import type {
  Arbitrary,
  CheckOptions,
  CheckResult,
  PropertyError,
  PropertyFailure,
  Replay,
  ReturnedFalse,
  SampleError,
  SampleOptions
} from "../../unstable/arbitrary/Arbitrary.ts"
import * as Model from "./model.ts"
import * as Compiler from "./schema.ts"

/** @internal */
export const TypeId = "~effect/unstable/arbitrary/Arbitrary"

interface ReplayData {
  readonly seed: string | number
  readonly attempt: number
  readonly size: number
  readonly path: ReadonlyArray<number>
}

const ArbitraryProto = {
  [TypeId]: TypeId
}

function make<A>(compiled: Model.Compiled<A>): Arbitrary<A> {
  return Object.create(ArbitraryProto, {
    gen: { value: compiled }
  })
}

function makeReplay(data: ReplayData): Replay {
  return JSON.stringify([
    typeof data.seed === "number" ? 0 : 1,
    globalThis.String(data.seed),
    data.attempt,
    data.size,
    data.path
  ])
}

function replayData(replay: Replay): ReplayData {
  const encoded = JSON.parse(replay) as [0 | 1, string, number, number, ReadonlyArray<number>]
  return {
    seed: encoded[0] === 0 ? globalThis.Number(encoded[1]) : encoded[1],
    attempt: encoded[2],
    size: encoded[3],
    path: encoded[4]
  }
}

function natural(value: number | undefined, fallback: number, label: string): number {
  const out = value ?? fallback
  if (!Number.isSafeInteger(out) || out < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return out
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const out = natural(value, fallback, label)
  if (out === 0) throw new Error(`${label} must be greater than zero`)
  return out
}

interface SeedState {
  readonly first: number
  readonly second: number
}

function mix32(value: number): number {
  // MurmurHash3 fmix32 by Austin Appleby, dedicated to the public domain.
  value ^= value >>> 16
  value = Math.imul(value, 0x85ebca6b)
  value ^= value >>> 13
  value = Math.imul(value, 0xc2b2ae35)
  return (value ^ value >>> 16) >>> 0
}

function hashSeed(seed: string | number): SeedState {
  const value = `${typeof seed}:${seed}`
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code ^ index, 0x85ebca6b)
  }
  return {
    first: mix32(first),
    second: mix32(second ^ value.length)
  }
}

function rotateLeft(value: number, shift: number): number {
  return (value << shift | value >>> (32 - shift)) >>> 0
}

function makeAttemptRandom(seed: SeedState, attempt: number): typeof Random.Random["Service"] {
  // This provides the same per-run isolation targeted by fast-check v4.9.0's jump-before-toss strategy (MIT), while
  // deriving the attempt state directly so replay can jump to it without executing preceding attempts.
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/check/runner/Tosser.ts
  const attemptLow = attempt >>> 0
  const attemptHigh = Math.floor(attempt / 0x100000000) >>> 0
  let state0 = mix32(seed.first ^ attemptLow ^ Math.imul(attemptHigh, 0x9e3779b9))
  let state1 = mix32(seed.second ^ attemptHigh ^ Math.imul(attemptLow, 0x85ebca6b))
  let state2 = mix32(seed.first ^ attemptHigh ^ Math.imul(attemptLow, 0xc2b2ae35) ^ 0x243f6a88)
  let state3 = mix32(seed.second ^ attemptLow ^ Math.imul(attemptHigh, 0x27d4eb2f) ^ 0xb7e15162)
  if ((state0 | state1 | state2 | state3) === 0) state0 = 0x9e3779b9

  // xoshiro128** 1.1 by David Blackman and Sebastiano Vigna, dedicated to the public domain.
  // https://prng.di.unimi.it/xoshiro128starstar.c
  const nextUint32 = () => {
    const result = Math.imul(rotateLeft(Math.imul(state1, 5), 7), 9) >>> 0
    const temporary = state1 << 9
    state2 ^= state0
    state3 ^= state1
    state1 ^= state2
    state0 ^= state3
    state2 ^= temporary
    state3 = rotateLeft(state3, 11)
    return result
  }
  const nextDoubleUnsafe = () => {
    const high = nextUint32() >>> 5
    const low = nextUint32() >>> 6
    return (high * 0x4000000 + low) / 0x20000000000000
  }
  return {
    nextIntUnsafe: () =>
      Math.floor(nextDoubleUnsafe() * (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1)) +
      Number.MIN_SAFE_INTEGER,
    nextDoubleUnsafe
  }
}

const generateAttempt = <A>(
  compiled: Model.Compiled<A>,
  seed: SeedState,
  attempt: number,
  size: number,
  shrinks: boolean
): Effect.Effect<Model.Attempt<A>> =>
  Model.toEffectGeneration(compiled.generate({
    size,
    shrinks,
    // This is fast-check v4.9.0's run-dependent numeric bias schedule (MIT). It makes short checks edge-heavy while
    // progressively dedicating more attempts to the complete domain, without becoming part of the public API.
    // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/check/property/IRawProperty.ts#L92-L95
    biasFactor: 2 + Math.floor(Math.log10(attempt + 1)),
    random: makeAttemptRandom(seed, attempt),
    budget: { remaining: compiled.minCost + size }
  }))

const resolveMasterSeed = (seed: string | number | undefined): Effect.Effect<string | number> =>
  seed === undefined ? Random.nextInt : Effect.succeed(seed)

/** @internal */
export function schema<S extends Schema.Constraint>(schema: S): Arbitrary<S["Type"]> {
  return make(Compiler.compile(schema))
}

/** @internal */
export const sample = Effect.fnUntraced(function*<A>(self: Arbitrary<A>, options?: SampleOptions) {
  const count = natural(options?.count, 10, "count")
  const size = natural(options?.size, 10, "size")
  const maxDiscards = natural(options?.maxDiscards, Math.max(100, count * 10), "maxDiscards")
  const maxOpsBeforeYield = yield* Scheduler.MaxOpsBeforeYield
  const seed = yield* resolveMasterSeed(options?.seed)
  const seedState = hashSeed(seed)
  const values: Array<A> = []
  let discards = 0
  let attemptIndex = 0
  while (values.length < count) {
    const attempt = yield* generateAttempt(self.gen, seedState, attemptIndex++, size, false)
    if (attempt._tag === "Generated") {
      values.push(attempt.sample.value)
    } else if (++discards > maxDiscards) {
      const error: SampleError = { _tag: "SampleError", generated: values.length, discards }
      return yield* Effect.fail(error)
    } else if (maxOpsBeforeYield <= 1 || discards % maxOpsBeforeYield === 0) {
      yield* Effect.yieldNow
    }
  }
  return values
})

const passedProperty = { _tag: "Passed" } as const
const returnedFalse: ReturnedFalse = { _tag: "ReturnedFalse" }

const evaluateProperty = <A, E, R>(
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  value: A
): Effect.Effect<typeof passedProperty | PropertyFailure<E>, never, R> => {
  const output = property(value)
  if (!Effect.isEffect(output)) return Effect.succeed(output ? passedProperty : returnedFalse)
  return Effect.matchEager(output, {
    onFailure: (error): PropertyError<E> => ({ _tag: "PropertyError", error }),
    onSuccess: (success) => success ? passedProperty : returnedFalse
  })
}

const pullNext = <A>(pull: Pull.Pull<A>): Effect.Effect<Option.Option<A>> =>
  Pull.matchEffect(pull, {
    onSuccess: (value) => Effect.succeed(Option.some(value)),
    onDone: () => Effect.succeed(Option.none()),
    onFailure: Effect.failCause
  })

const shrink = Effect.fnUntraced(function*<A, E, R>(
  initial: Model.Sample<A>,
  initialFailure: PropertyFailure<E>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  maximum: number
) {
  // The first-failing-child traversal and its sibling-index path follow fast-check v4.9.0's counterexample-path model
  // (MIT).
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/check/runner/RunnerIterator.ts
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/check/runner/utils/PathWalker.ts
  let current = initial
  let failure = initialFailure
  let shrinks = 0
  let evaluations = 0
  const path: Array<number> = []
  while (evaluations < maximum) {
    let index = 0
    let found: Model.Sample<A> | undefined
    while (evaluations < maximum) {
      if (current.shrinks === undefined) break
      const candidate = yield* pullNext(current.shrinks)
      if (Option.isNone(candidate)) break
      evaluations++
      const outcome = yield* evaluateProperty(property, candidate.value.value)
      if (outcome._tag !== "Passed") {
        found = candidate.value
        failure = outcome
        path.push(index)
        break
      }
      index++
    }
    if (found === undefined) break
    current = found
    shrinks++
  }
  return { current, failure, shrinks, path }
})

const followReplay = Effect.fnUntraced(function*<A, E, R>(
  initial: Model.Sample<A>,
  initialFailure: PropertyFailure<E>,
  path: ReadonlyArray<number>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>
) {
  let current = initial
  let failure = initialFailure
  for (const targetIndex of path) {
    if (current.shrinks === undefined) return { _tag: "ReplayMismatch", reason: "ShrinkPathUnavailable" } as const
    let selected: Model.Sample<A> | undefined
    for (let index = 0; index <= targetIndex; index++) {
      const candidate = yield* pullNext(current.shrinks)
      if (Option.isNone(candidate)) return { _tag: "ReplayMismatch", reason: "ShrinkPathUnavailable" } as const
      if (index === targetIndex) selected = candidate.value
    }
    const outcome = yield* evaluateProperty(property, selected!.value)
    if (outcome._tag === "Passed") return { _tag: "ReplayMismatch", reason: "ShrinkPassed" } as const
    current = selected!
    failure = outcome
  }
  return { _tag: "Replayed", current, failure } as const
})

/** @internal */
export const check = Effect.fnUntraced(function*<A, E, R>(
  self: Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  options?: CheckOptions
): Effect.fn.Return<CheckResult<A, E>, never, R> {
  const replay = options?.replay
  if (replay !== undefined) {
    const data = replayData(replay)
    const attempt = yield* generateAttempt(self.gen, hashSeed(data.seed), data.attempt, data.size, true)
    if (attempt._tag === "Discarded") return { _tag: "ReplayMismatch", reason: "AttemptDiscarded" }
    const outcome = yield* evaluateProperty(property, attempt.sample.value)
    if (outcome._tag === "Passed") return { _tag: "ReplayMismatch", reason: "PropertyPassed" }
    const replayed = yield* followReplay(attempt.sample, outcome, data.path, property)
    if (replayed._tag === "ReplayMismatch") return replayed
    return {
      _tag: "Falsified",
      initialInput: attempt.sample.value,
      counterexample: replayed.current.value,
      failure: replayed.failure,
      runs: 1,
      discards: 0,
      shrinks: data.path.length,
      replay
    }
  }

  const runsTarget = positive(options?.runs, 100, "runs")
  const size = natural(options?.size, 10, "size")
  const maxDiscards = natural(options?.maxDiscards, Math.max(100, runsTarget * 10), "maxDiscards")
  const maxShrinks = natural(options?.maxShrinks, 100, "maxShrinks")
  const maxOpsBeforeYield = yield* Scheduler.MaxOpsBeforeYield
  const seed = yield* resolveMasterSeed(options?.seed)
  const seedState = hashSeed(seed)
  let runs = 0
  let discards = 0
  let attemptIndex = 0
  while (runs < runsTarget) {
    const currentAttempt = attemptIndex++
    const currentSize = runsTarget === 1 ? size : Math.round(runs * size / (runsTarget - 1))
    const attempt = yield* generateAttempt(self.gen, seedState, currentAttempt, currentSize, true)
    if (attempt._tag === "Discarded") {
      if (++discards > maxDiscards) return { _tag: "Exhausted", runs, discards }
      if (maxOpsBeforeYield <= 1 || discards % maxOpsBeforeYield === 0) yield* Effect.yieldNow
      continue
    }
    const outcome = yield* evaluateProperty(property, attempt.sample.value)
    if (outcome._tag === "Passed") {
      runs++
      continue
    }
    const minimized = yield* shrink(attempt.sample, outcome, property, maxShrinks)
    return {
      _tag: "Falsified",
      initialInput: attempt.sample.value,
      counterexample: minimized.current.value,
      failure: minimized.failure,
      runs: runs + 1,
      discards,
      shrinks: minimized.shrinks,
      replay: makeReplay({ seed, attempt: currentAttempt, size: currentSize, path: minimized.path })
    }
  }
  return { _tag: "Passed", runs, discards }
})
