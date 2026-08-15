/**
 * @since 4.0.0
 */

import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { flow, pipe } from "effect/Function"
import * as Inspectable from "effect/Inspectable"
import * as Layer from "effect/Layer"
import { isObject } from "effect/Predicate"
import * as Rec from "effect/Record"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as fc from "effect/testing/FastCheck"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import * as NativeArbitrary from "effect/unstable/arbitrary/Arbitrary"
import * as V from "vitest"
import type * as Vitest from "../index.ts"

const getCurrentSuite = V.TestRunner.getCurrentSuite

const runPromise: <E, A>(
  _: Effect.Effect<A, E, never>,
  ctx?: V.TestContext | undefined
) => Promise<A> = Effect.fnUntraced(function*<E, A>(effect: Effect.Effect<A, E>, _ctx?: Vitest.TestContext) {
  const exit = yield* Effect.exit(effect)
  if (Exit.isFailure(exit)) {
    const errors = Cause.prettyErrors(exit.cause)
    for (let i = 0; i < errors.length; i++) {
      yield* Effect.logError(errors[i])
    }
  }
  return yield* exit
}, (effect, _, ctx) => Effect.runPromise(effect, { signal: ctx?.signal }))

/** @internal */
const runTest = (ctx?: Vitest.TestContext) => <E, A>(effect: Effect.Effect<A, E>) => runPromise(effect, ctx)

/** @internal */
export type TestContext = TestConsole.TestConsole | TestClock.TestClock

const TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

/** @internal */
export const addEqualityTesters = () => {
  V.expect.addEqualityTesters([])
}

/** @internal */
const testOptions = (timeout?: number | V.TestOptions) => typeof timeout === "number" ? { timeout } : timeout ?? {}

const hookTimeout = (timeout?: Duration.Input) =>
  timeout === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(timeout))

type PropertyTimeout =
  | number
  | V.TestOptions & {
    readonly arbitrary?: NativeArbitrary.CheckOptions | undefined
    readonly fastCheck?: fc.Parameters<any> | undefined
  }

type SchemaArbitraries =
  | Array<Schema.Schema<any>>
  | { [K in string]: Schema.Schema<any> }

const isSchemaArbitraries = (
  arbitraries: Vitest.Vitest.Arbitraries
): arbitraries is SchemaArbitraries =>
  (Array.isArray(arbitraries) ? arbitraries : Object.values(arbitraries)).every(Schema.isSchema)

const propertyTestOptions = (
  timeout: PropertyTimeout | undefined
): Exclude<PropertyTimeout, number> | undefined => typeof timeout === "number" ? undefined : timeout

const hasFastCheckOptions = (timeout: PropertyTimeout | undefined): boolean =>
  propertyTestOptions(timeout)?.fastCheck !== undefined

const nativeCheckOptions = (timeout: PropertyTimeout | undefined): NativeArbitrary.CheckOptions | undefined =>
  propertyTestOptions(timeout)?.arbitrary

const makeNativeArbitrary = (arbitraries: SchemaArbitraries): NativeArbitrary.Arbitrary<any> =>
  NativeArbitrary.schema(
    Array.isArray(arbitraries)
      ? Schema.Tuple(arbitraries)
      : Schema.Struct(arbitraries)
  )

function formatNativeCheckFailure<A, E>(result: NativeArbitrary.CheckResult<A, E>): string | undefined {
  switch (result._tag) {
    case "Passed":
      return undefined
    case "Falsified":
      return `Property falsified after ${result.runs} run(s) and ${result.shrinks} shrink(s)\n` +
        `Counterexample: ${Inspectable.toStringUnknown(result.counterexample)}\n` +
        `${
          result.failure._tag === "ReturnedFalse"
            ? "Failure: returned false"
            : `Failure: ${Inspectable.toStringUnknown(result.failure.error)}`
        }\n` +
        `Replay: ${result.replay}`
    case "Exhausted":
      return `Property exhausted after ${result.runs} run(s) and ${result.discards} discard(s)`
    case "ReplayMismatch":
      return `Property replay failed: ${result.reason}`
  }
}

const runNativeCheck = <A, E>(
  ctx: V.TestContext,
  arbitrary: NativeArbitrary.Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E>,
  options: NativeArbitrary.CheckOptions | undefined
): Promise<void> =>
  runTest(ctx)(
    Effect.flatMapEager(NativeArbitrary.check(arbitrary, property, options), (result) => {
      const failure = formatNativeCheckFailure(result)
      return failure === undefined ? Effect.void : Effect.die(new Error(failure))
    })
  )

const makeItProxy = <Methods extends object>(
  it: V.TestAPI,
  overrides: Methods
): Methods & V.TestAPI =>
  new Proxy(it as Methods & V.TestAPI, {
    apply(target, thisArg, argArray) {
      return Reflect.apply(target, thisArg, argArray)
    },
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) {
        return Reflect.get(overrides, property)
      }
      // do not bind: binding would strip vitest's static helpers (e.g. `describe.each`)
      return Reflect.get(target, property, receiver)
    }
  })

type CollectedTask = {
  readonly type: string
  readonly mode?: string
  readonly tasks?: ReadonlyArray<CollectedTask>
}

const collectTasks = (tasks: ReadonlyArray<CollectedTask>, acc: Array<V.TestContext["task"]> = []) => {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    if (task.type === "test" && task.mode !== "skip" && task.mode !== "todo") {
      acc.push(task as V.TestContext["task"])
    } else if (task.tasks !== undefined) {
      collectTasks(task.tasks, acc)
    }
  }
  return acc
}

/** @internal */
const makeTester = <R>(
  mapEffect: <A, E>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, never>,
  it: V.TestAPI = V.it
): Vitest.Vitest.Tester<R> => {
  const run = <A, E, TestArgs extends Array<unknown>>(
    ctx: V.TestContext & object,
    args: TestArgs,
    self: Vitest.Vitest.TestFunction<A, E, R, TestArgs>
  ) => pipe(Effect.suspend(() => self(...args)), mapEffect, runTest(ctx))

  const f: Vitest.Vitest.Test<R> = (name, self, timeout) =>
    it(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self))

  const skip: Vitest.Vitest.Tester<R>["only"] = (name, self, timeout) =>
    it.skip(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self))

  const skipIf: Vitest.Vitest.Tester<R>["skipIf"] = (condition) => (name, self, timeout) =>
    it.skipIf(condition)(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self))

  const runIf: Vitest.Vitest.Tester<R>["runIf"] = (condition) => (name, self, timeout) =>
    it.runIf(condition)(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self))

  const only: Vitest.Vitest.Tester<R>["only"] = (name, self, timeout) =>
    it.only(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self))

  const each: Vitest.Vitest.Tester<R>["each"] = (cases) => (name, self, timeout) =>
    it.for(cases)(
      name,
      testOptions(timeout),
      (args, ctx) => run(ctx, [args], self) as any
    )

  const fails: Vitest.Vitest.Tester<R>["fails"] = (name, self, timeout) =>
    V.it.fails(name, testOptions(timeout), (ctx) => run(ctx, [ctx], self))

  const prop: Vitest.Vitest.Tester<R>["prop"] = (name, arbitraries, self, timeout) => {
    if (isSchemaArbitraries(arbitraries) && !hasFastCheckOptions(timeout)) {
      const arbitrary = makeNativeArbitrary(arbitraries)
      return it(
        name,
        testOptions(timeout),
        (ctx) =>
          runNativeCheck(
            ctx,
            arbitrary,
            (values) =>
              Effect.mapEager(
                mapEffect(Effect.suspend(() => self(values as any, ctx))),
                (value) => (value as unknown) !== false
              ),
            nativeCheckOptions(timeout)
          )
      )
    }

    if (Array.isArray(arbitraries)) {
      const arbs = arbitraries.map((arbitrary) => {
        if (Schema.isSchema(arbitrary)) {
          return Schema.toArbitrary(arbitrary)(fc)
        }
        return arbitrary as fc.Arbitrary<any>
      })
      return it(
        name,
        testOptions(timeout),
        (ctx) =>
          // @ts-ignore
          fc.assert(
            // @ts-ignore
            fc.asyncProperty(...arbs, (...as) => run(ctx, [as as any, ctx], self)),
            // @ts-ignore
            isObject(timeout) ? timeout?.fastCheck : {}
          )
      )
    }

    const arbs = fc.record(
      Object.keys(arbitraries).reduce(function(result, key) {
        const arb: any = arbitraries[key]
        Rec.assignProperty(result, key, Schema.isSchema(arb) ? Schema.toArbitrary(arb)(fc) : arb)
        return result
      }, {} as Record<string, fc.Arbitrary<any>>)
    )

    return it(
      name,
      testOptions(timeout),
      (ctx) =>
        // @ts-ignore
        fc.assert(
          fc.asyncProperty(arbs, (...as) =>
            // @ts-ignore
            run(ctx, [as[0] as any, ctx], self)),
          // @ts-ignore
          isObject(timeout) ? timeout?.fastCheck : {}
        )
    )
  }

  return Object.assign(f, { skip, skipIf, runIf, only, each, fails, prop })
}

/** @internal */
export const prop: Vitest.Vitest.Methods["prop"] = (name, arbitraries, self, timeout) => {
  if (isSchemaArbitraries(arbitraries) && !hasFastCheckOptions(timeout)) {
    const arbitrary = makeNativeArbitrary(arbitraries)
    return V.it(
      name,
      testOptions(timeout),
      (ctx) =>
        runNativeCheck(
          ctx,
          arbitrary,
          (values) => (self(values as any, ctx) as unknown) !== false,
          nativeCheckOptions(timeout)
        )
    )
  }

  if (Array.isArray(arbitraries)) {
    const arbs = arbitraries.map((arbitrary) => {
      if (Schema.isSchema(arbitrary)) {
        return Schema.toArbitrary(arbitrary)(fc)
      }
      return arbitrary
    })
    return V.it(
      name,
      testOptions(timeout),
      // @ts-ignore
      (ctx) => fc.assert(fc.property(...arbs, (...as) => self(as, ctx)), isObject(timeout) ? timeout?.fastCheck : {})
    )
  }

  const arbs = fc.record(
    Object.keys(arbitraries).reduce(function(result, key) {
      const arb: any = arbitraries[key]
      if (Schema.isSchema(arb)) {
        Rec.assignProperty(result, key, Schema.toArbitrary(arb)(fc))
        return result
      }
      Rec.assignProperty(result, key, arb)
      return result
    }, {} as Record<string, fc.Arbitrary<any>>)
  )

  return V.it(
    name,
    testOptions(timeout),
    // @ts-ignore
    (ctx) => fc.assert(fc.property(arbs, (as) => self(as, ctx)), isObject(timeout) ? timeout?.fastCheck : {})
  )
}

/** @internal */
export const layer = <R, E>(
  layer_: Layer.Layer<R, E>,
  options?: {
    readonly memoMap?: Layer.MemoMap
    readonly timeout?: Duration.Input
    readonly excludeTestServices?: boolean
  }
): {
  (f: (it: Vitest.Vitest.MethodsNonLive<R>) => void): void
  (
    name: string,
    f: (it: Vitest.Vitest.MethodsNonLive<R>) => void
  ): void
} =>
(
  ...args: [
    name: string,
    f: (
      it: Vitest.Vitest.MethodsNonLive<R>
    ) => void
  ] | [
    f: (it: Vitest.Vitest.MethodsNonLive<R>) => void
  ]
) => {
  const excludeTestServices = options?.excludeTestServices ?? false
  const withTestEnv = excludeTestServices
    ? layer_ as Layer.Layer<R, E>
    : Layer.provideMerge(layer_, TestEnv)
  const memoMap = options?.memoMap ?? Effect.runSync(Layer.makeMemoMap)
  const scope = Effect.runSync(Scope.make())
  const contextEffect = Layer.buildWithMemoMap(withTestEnv, memoMap, scope).pipe(
    Effect.orDie,
    Effect.cached,
    Effect.runSync
  )
  let closed = false
  const closeScope = (ctx?: Vitest.TestContext) => {
    if (closed) {
      return Promise.resolve()
    }
    closed = true
    return runPromise(Scope.close(scope, Exit.void), ctx)
  }

  const makeIt = (it: V.TestAPI): Vitest.Vitest.MethodsNonLive<R> =>
    makeItProxy(it, {
      effect: makeTester<R | Scope.Scope>(
        (effect) =>
          Effect.flatMap(contextEffect, (context) =>
            effect.pipe(
              Effect.scoped,
              Effect.provide(context)
            )),
        it
      ),
      prop,
      flakyTest,
      layer<R2, E2>(nestedLayer: Layer.Layer<R2, E2, R>, options?: {
        readonly timeout?: Duration.Input
      }) {
        return layer(Layer.provideMerge(nestedLayer, withTestEnv), {
          ...options,
          memoMap: Layer.forkMemoMapUnsafe(memoMap),
          excludeTestServices
        })
      }
    })

  if (args.length === 1) {
    const currentSuite = getCurrentSuite()
    const previousTasks = new Set(currentSuite.tasks)

    args[0](makeIt(V.it))

    const blockTasks = collectTasks(
      currentSuite.tasks.filter((task) => !previousTasks.has(task)) as ReadonlyArray<CollectedTask>
    )
    if (blockTasks.length === 0) {
      V.afterAll(() => closeScope(), hookTimeout(options?.timeout))
      return
    }

    const blockTaskSet = new Set(blockTasks)
    let remaining = blockTasks.length

    V.beforeEach(
      (ctx) => {
        if (!blockTaskSet.has(ctx.task)) {
          return
        }
        ctx.onTestFinished(() => {
          remaining--
          if (remaining === 0) {
            return closeScope(ctx)
          }
        })
        return runPromise(Effect.asVoid(contextEffect), ctx)
      },
      hookTimeout(options?.timeout)
    )
    V.afterAll(() => closeScope(), hookTimeout(options?.timeout))
    return
  }

  return V.describe(args[0], () => {
    V.beforeAll(
      () => runPromise(Effect.asVoid(contextEffect)),
      hookTimeout(options?.timeout)
    )
    V.afterAll(
      () => closeScope(),
      hookTimeout(options?.timeout)
    )
    return args[1](makeIt(V.it))
  })
}

/** @internal */
export const flakyTest = <A, E, R>(
  self: Effect.Effect<A, E, R | Scope.Scope>,
  timeout: Duration.Input = Duration.seconds(30)
) =>
  pipe(
    self,
    Effect.scoped,
    Effect.sandbox,
    Effect.retry(
      pipe(
        Schedule.recurs(10),
        Schedule.while((_) =>
          Effect.succeed(Duration.isLessThanOrEqualTo(
            Duration.fromInputUnsafe(_.elapsed),
            Duration.fromInputUnsafe(timeout)
          ))
        )
      )
    ),
    Effect.orDie
  )

/** @internal */
export const makeMethods = (it: V.TestAPI): Vitest.Vitest.Methods =>
  makeItProxy(it, {
    effect: makeTester<Scope.Scope>(flow(Effect.scoped, Effect.provide(TestEnv)), it),
    live: makeTester<Scope.Scope>(Effect.scoped, it),
    flakyTest,
    layer,
    prop
  })

/** @internal */
export const {
  /** @internal */
  effect,
  /** @internal */
  live
} = makeMethods(V.it)

/** @internal */
export const describeWrapped = (name: string, f: (it: Vitest.Vitest.Methods) => void): V.SuiteCollector =>
  V.describe(name, (it) => f(makeMethods(it)))
