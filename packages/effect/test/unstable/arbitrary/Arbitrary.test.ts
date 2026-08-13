import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Option, Order, Random, Result, Schema } from "effect"
import { FastCheck } from "effect/testing"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

describe("Arbitrary", () => {
  describe("schema", () => {
    it.effect("generates deterministic samples and pushes constraints into primitive constructors", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(8))
        const arbitrary = Arbitrary.schema(schema)
        const first = yield* Arbitrary.sample(arbitrary, { count: 20, maxDiscards: 0, seed: "constraint" })
        const second = yield* Arbitrary.sample(arbitrary, { count: 20, maxDiscards: 0, seed: "constraint" })

        assert.deepStrictEqual(first, second)
        assert.isTrue(first.every((value) => value.length === 8))
      }))

    it.effect("derives independent random streams for adjacent attempts", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(
          Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
          { count: 1_000, maxDiscards: 0, seed: "attempt-streams" }
        )

        assert.isAtLeast(new Set(values).size, 990)
      }))

    it.effect("reaches both integer parities across the complete safe range", () =>
      Effect.gen(function*() {
        const schema = Schema.Int.check(Schema.isBetween({
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER
        }))
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 200,
          maxDiscards: 0,
          seed: "complete-safe-integer-range"
        })

        assert.isTrue(values.every(Number.isSafeInteger))
        assert.isTrue(values.some((value) => Math.abs(value % 2) === 0))
        assert.isTrue(values.some((value) => Math.abs(value % 2) === 1))
      }))

    it("rejects integer bounds outside the safe range", () => {
      assert.throws(
        () => Arbitrary.schema(Schema.Int.check(Schema.isGreaterThan(Number.MAX_SAFE_INTEGER))),
        /Unable to derive an arbitrary for integer constraints/
      )
      assert.throws(
        () => Arbitrary.schema(Schema.Int.check(Schema.isLessThan(Number.MIN_SAFE_INTEGER))),
        /Unable to derive an arbitrary for integer constraints/
      )
    })

    it("rejects NaN numeric bounds", () => {
      const isBetweenNumber = Schema.makeIsBetween({ order: Order.Number })
      assert.throws(
        () => Arbitrary.schema(Schema.Number.check(isBetweenNumber({ minimum: Number.NaN, maximum: 1 }))),
        /Unable to derive an arbitrary for number constraints/
      )
      assert.throws(
        () => Arbitrary.schema(Schema.Int.check(isBetweenNumber({ minimum: 0, maximum: Number.NaN }))),
        /Unable to derive an arbitrary for integer constraints/
      )
    })

    it.effect("generates BigInts across arbitrary-width bounded ranges", () =>
      Effect.gen(function*() {
        const maximum = BigInt(1) << BigInt(1024)
        const schema = Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: BigInt(0), maximum }))
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 20,
          maxDiscards: 0,
          seed: "arbitrary-width-bigint"
        })

        assert.isTrue(values.every((value) => value >= BigInt(0) && value <= maximum))
        assert.isTrue(values.some((value) => value > BigInt(Number.MAX_SAFE_INTEGER)))
      }))

    it.effect("generates the sole Number between adjacent exclusive IEEE-754 bounds", () =>
      Effect.gen(function*() {
        const minimum = 2 ** 100
        const unit = 2 ** 48
        const expected = minimum + unit
        const schema = Schema.Number.check(Schema.isBetween({
          minimum,
          maximum: minimum + unit * 2,
          exclusiveMinimum: true,
          exclusiveMaximum: true
        }))
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 20,
          maxDiscards: 0,
          seed: "adjacent-ieee-bounds"
        })

        assert.deepStrictEqual(values, Array.from({ length: 20 }, () => expected))
      }))

    it.effect("preserves both signed zeros in an inclusive zero interval", () =>
      Effect.gen(function*() {
        const schema = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 0 }))
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 50,
          maxDiscards: 0,
          seed: "signed-zero"
        })

        assert.isTrue(values.every((value) => value === 0))
        assert.isTrue(values.some((value) => Object.is(value, -0)))
        assert.isTrue(values.some((value) => Object.is(value, 0)))
      }))

    it.effect("generates exact subnormal and infinite singleton intervals", () =>
      Effect.gen(function*() {
        const expected = [
          Number.NEGATIVE_INFINITY,
          -Number.MAX_VALUE,
          -Number.MIN_VALUE,
          Number.MIN_VALUE,
          Number.MAX_VALUE,
          Number.POSITIVE_INFINITY
        ]
        const values: Array<number> = []
        const isBetweenNumber = Schema.makeIsBetween({ order: Order.Number })
        for (const value of expected) {
          const schema = Schema.Number.check(isBetweenNumber({ minimum: value, maximum: value }))
          const [sample] = yield* Arbitrary.sample(Arbitrary.schema(schema), {
            count: 1,
            maxDiscards: 0,
            seed: "ieee-singleton"
          })
          values.push(sample)
        }

        assert.deepStrictEqual(values, expected)
      }))

    it.effect("generates infinity from one-sided inclusive bounds", () =>
      Effect.gen(function*() {
        const greaterThanOrEqualTo = Schema.makeIsGreaterThanOrEqualTo({ order: Order.Number })
        const lessThanOrEqualTo = Schema.makeIsLessThanOrEqualTo({ order: Order.Number })
        const [positive] = yield* Arbitrary.sample(
          Arbitrary.schema(Schema.Number.check(greaterThanOrEqualTo(Number.POSITIVE_INFINITY))),
          { count: 1, maxDiscards: 0, seed: "positive-infinity" }
        )
        const [negative] = yield* Arbitrary.sample(
          Arbitrary.schema(Schema.Number.check(lessThanOrEqualTo(Number.NEGATIVE_INFINITY))),
          { count: 1, maxDiscards: 0, seed: "negative-infinity" }
        )

        assert.strictEqual(positive, Number.POSITIVE_INFINITY)
        assert.strictEqual(negative, Number.NEGATIVE_INFINITY)
      }))

    it("rejects infinite intervals excluded by a finite constraint", () => {
      const greaterThanOrEqualTo = Schema.makeIsGreaterThanOrEqualTo({ order: Order.Number })
      const schema = Schema.Number.check(
        Schema.isFinite(),
        greaterThanOrEqualTo(Number.POSITIVE_INFINITY)
      )

      assert.throws(() => Arbitrary.schema(schema), /Unable to derive an arbitrary for number constraints/)
    })

    it.effect("uses the same generated values for sampling and checking", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(
          Schema.Array(Schema.Int).check(Schema.isMinLength(2), Schema.isMaxLength(4))
        )
        const sampled = yield* Arbitrary.sample(arbitrary, { count: 20, seed: "sample-check", size: 10 })
        const checked: Array<ReadonlyArray<number>> = []
        yield* Arbitrary.check(arbitrary, (value) => {
          checked.push(value)
          return true
        }, { runs: 20, seed: "sample-check", size: 10 })

        assert.deepStrictEqual(checked, sampled)
      }))

    it.effect("supports unique collections", () =>
      Effect.gen(function*() {
        const schema = Schema.UniqueArray(Schema.Int).check(Schema.isMinLength(4), Schema.isMaxLength(4))
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 20,
          maxDiscards: 20,
          seed: "unique"
        })

        assert.isTrue(values.every((value) => value.length === 4 && new Set(value).size === 4))
      }))

    it.effect("preserves unique collections while shrinking", () =>
      Effect.gen(function*() {
        const schema = Schema.UniqueArray(Schema.Int).check(Schema.isMinLength(2), Schema.isMaxLength(4))
        const result = yield* Arbitrary.check(Arbitrary.schema(schema), () => false, {
          runs: 1,
          seed: "unique-shrink",
          size: 10
        })

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.isTrue(Schema.is(schema)(result.counterexample))
        }
      }))

    it.effect("generates optional, rest, record, and union structure", () =>
      Effect.gen(function*() {
        const schema = Schema.Struct({
          tuple: Schema.TupleWithRest(
            Schema.Tuple([Schema.String, Schema.optionalKey(Schema.Int)]),
            [Schema.Boolean]
          ),
          optional: Schema.optionalKey(Schema.String),
          record: Schema.Record(Schema.String, Schema.Int).check(Schema.isMaxProperties(3)),
          union: Schema.Union([Schema.String, Schema.Int])
        })
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 50,
          seed: "structural",
          size: 5
        })

        assert.isTrue(values.every(Schema.is(schema)))
      }))

    it.effect("generates finite numeric template literal segments", () =>
      Effect.gen(function*() {
        const schema = Schema.TemplateLiteral([Schema.Number])
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 200,
          maxDiscards: 0,
          seed: "template-number"
        })

        assert.isTrue(values.every(Schema.is(schema)))
      }))

    it.effect("generates finite numeric template literal union segments", () =>
      Effect.gen(function*() {
        const schema = Schema.TemplateLiteral([Schema.Union([Schema.Number, Schema.Literal("a")])])
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 200,
          maxDiscards: 0,
          seed: "template-number-union"
        })

        assert.isTrue(values.every(Schema.is(schema)))
      }))

    it.effect("generates symbols", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.Symbol), {
          count: 20,
          maxDiscards: 0,
          seed: "symbol"
        })

        assert.isTrue(values.every((value) => typeof value === "symbol"))
      }))

    it.effect("uses the private native annotation for Json", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.Json), { count: 30, seed: "json", size: 5 })

        assert.isTrue(values.every(Schema.is(Schema.Json)))
      }))

    it.effect("coexists with the legacy fast-check annotation", () =>
      Effect.gen(function*() {
        const legacy = FastCheck.sample(Schema.toArbitrary(Schema.Json)(FastCheck), { numRuns: 10, seed: 1 })
        const native = yield* Arbitrary.sample(Arbitrary.schema(Schema.Json), { count: 10, seed: 1 })

        assert.isTrue(legacy.every(Schema.is(Schema.Json)))
        assert.isTrue(native.every(Schema.is(Schema.Json)))
      }))

    it.effect("derives canonical declarations through their codec", () =>
      Effect.gen(function*() {
        const schema = Schema.Option(Schema.Int)
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), { count: 30, seed: "option", size: 5 })

        assert.isTrue(values.every(Option.isOption))
        assert.isTrue(values.every(Schema.is(schema)))
      }))

    it.effect("derives JSON-canonical declarations through their codec", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.URLSearchParams), {
          count: 30,
          seed: "url-search-params"
        })

        assert.isTrue(values.every((value) => value instanceof URLSearchParams))
      }))

    it.effect("derives productive structural declarations through canonical codecs", () =>
      Effect.gen(function*() {
        const schemas: ReadonlyArray<Schema.Top> = [
          Schema.Result(Schema.Number, Schema.String),
          Schema.Redacted(Schema.String),
          Schema.ReadonlySet(Schema.Int),
          Schema.HashSet(Schema.Int),
          Schema.ReadonlyMap(Schema.String, Schema.Int),
          Schema.HashMap(Schema.String, Schema.Int),
          Schema.Chunk(Schema.Int),
          Schema.Duration,
          Schema.Cause(Schema.String, Schema.String),
          Schema.Exit(Schema.Int, Schema.String, Schema.String),
          Schema.TimeZoneOffset
        ]

        for (const schema of schemas) {
          const result = yield* Arbitrary.check(Arbitrary.schema(schema), Schema.is(schema), {
            runs: 20,
            maxDiscards: 0,
            seed: "structural-declarations"
          })
          assert.deepStrictEqual(result, { _tag: "Passed", runs: 20, discards: 0 })
        }
      }))

    it.effect("generates recursive schemas with a finite path", () =>
      Effect.gen(function*() {
        interface Node {
          readonly value: string
          readonly children: ReadonlyArray<Node>
        }
        const Node: Schema.Codec<Node> = Schema.Struct({
          value: Schema.String,
          children: Schema.Array(Schema.suspend(() => Node)).check(Schema.isMaxLength(3))
        })
        const values = yield* Arbitrary.sample(Arbitrary.schema(Node), { count: 30, seed: "recursive", size: 5 })

        assert.isTrue(values.every(Schema.is(Node)))
      }))

    it.effect("reserves the shared recursion budget for later siblings", () =>
      Effect.gen(function*() {
        interface Node {
          readonly children: ReadonlyArray<Node>
        }
        const Node: Schema.Codec<Node> = Schema.Struct({
          children: Schema.Array(Schema.suspend(() => Node)).check(Schema.isMaxLength(3))
        })
        const result = yield* Arbitrary.check(Arbitrary.schema(Node), () => true, {
          runs: 100,
          seed: "recursive-budget",
          size: 10
        })

        assert.deepStrictEqual(result, { _tag: "Passed", runs: 100, discards: 0 })
      }))

    it.effect("reserves the shared recursion budget for record entries", () =>
      Effect.gen(function*() {
        type Node = null | { readonly [key: string]: Node }
        const Node: Schema.Codec<Node> = Schema.Union([
          Schema.Null,
          Schema.Record(Schema.String, Schema.suspend(() => Node)).check(
            Schema.isMinProperties(2),
            Schema.isMaxProperties(2)
          )
        ])
        const result = yield* Arbitrary.check(Arbitrary.schema(Node), () => true, {
          runs: 100,
          seed: "recursive-record-budget",
          size: 10
        })

        assert.deepStrictEqual(result, { _tag: "Passed", runs: 100, discards: 0 })
      }))

    it.effect("discovers a recursive finite path through a canonical declaration", () =>
      Effect.gen(function*() {
        interface Node {
          readonly next: Option.Option<Node>
        }
        const Node: Schema.Codec<Node> = Schema.Struct({
          next: Schema.Option(Schema.suspend(() => Node))
        })
        const values = yield* Arbitrary.sample(Arbitrary.schema(Node), {
          count: 30,
          seed: "recursive-option",
          size: 5
        })

        assert.isTrue(values.every(Schema.is(Node)))
      }))

    it.effect("generates mutually recursive schemas", () =>
      Effect.gen(function*() {
        interface Expression {
          readonly type: "expression"
          readonly value: number | Operation
        }
        interface Operation {
          readonly type: "operation"
          readonly left: Expression
          readonly right: Expression
        }
        const Expression: Schema.Codec<Expression> = Schema.Struct({
          type: Schema.Literal("expression"),
          value: Schema.Union([Schema.Int, Schema.suspend((): Schema.Codec<Operation> => Operation)])
        })
        const Operation: Schema.Codec<Operation> = Schema.Struct({
          type: Schema.Literal("operation"),
          left: Expression,
          right: Expression
        })
        const values = yield* Arbitrary.sample(Arbitrary.schema(Operation), {
          count: 30,
          seed: "mutually-recursive",
          size: 5
        })

        assert.isTrue(values.every(Schema.is(Operation)))
      }))

    it("fails immediately for recursion without a finite path", () => {
      const Recursive = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: Schema.Codec<unknown> = Schema.Struct({ value: Recursive })

      assert.throws(
        () => Arbitrary.schema(schema),
        /Unable to derive an arbitrary for a recursive schema without a finite generation path/
      )
    })

    it("fails immediately for unsupported declarations", () => {
      const declaration = Schema.declare((input): input is URL => input instanceof URL, { expected: "URL" })

      assert.throws(() => Arbitrary.schema(declaration), /Unable to derive an arbitrary for an unsupported Declaration/)
    })

    it.effect("bounds residual-filter exhaustion", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.makeFilter(() => false, { expected: "impossible" }))
        const result = yield* Effect.result(Arbitrary.sample(Arbitrary.schema(schema), {
          count: 1,
          maxDiscards: 2,
          seed: "exhaustion"
        }))

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.deepStrictEqual(result.failure, { _tag: "SampleError", generated: 0, discards: 3 })
        }
      }))
  })

  describe("check", () => {
    it.effect("isolates generation Random from property Random", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(Schema.Int)
        const pureInputs: Array<number> = []
        const effectfulInputs: Array<number> = []

        yield* Arbitrary.check(arbitrary, (value) => {
          pureInputs.push(value)
          return true
        }, { runs: 20, seed: "random-isolation" })
        yield* Arbitrary.check(arbitrary, (value) =>
          Effect.gen(function*() {
            effectfulInputs.push(value)
            yield* Random.next
            yield* Random.next
            return true
          }), { runs: 20, seed: "random-isolation" })

        assert.deepStrictEqual(effectfulInputs, pureInputs)
      }))

    it.effect("shrinks integers to the local failure boundary", () =>
      Effect.gen(function*() {
        const result = yield* Arbitrary.check(
          Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
          (value) => value < 10,
          { runs: 1, seed: 0, size: 10 }
        )

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.strictEqual(result.counterexample, 10)
        }
      }))

    it.effect("shrinks Numbers to the local representable failure boundary", () =>
      Effect.gen(function*() {
        const result = yield* Arbitrary.check(
          Arbitrary.schema(Schema.Number.check(Schema.isBetween({ minimum: 2, maximum: 4 }))),
          (value) => value < 3,
          { runs: 1, seed: 1, size: 10 }
        )

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.isAtLeast(result.initialInput, 3)
          assert.strictEqual(result.counterexample, 3)
        }
      }))

    it.effect("shrinks NaN through the ordinary Number target", () =>
      Effect.gen(function*() {
        const result = yield* Arbitrary.check(Arbitrary.schema(Schema.Number), () => false, {
          runs: 1,
          seed: 18,
          size: 10
        })

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.isTrue(Number.isNaN(result.initialInput))
          assert.strictEqual(result.counterexample, 0)
        }
      }))

    it.effect("shrinks recursive unions toward a finite base branch", () =>
      Effect.gen(function*() {
        type Node = null | { readonly next: Node }
        const Node: Schema.Codec<Node> = Schema.Union([
          Schema.Null,
          Schema.Struct({ next: Schema.suspend(() => Node) })
        ])
        const result = yield* Arbitrary.check(Arbitrary.schema(Node), () => false, {
          runs: 1,
          seed: 1,
          size: 5
        })

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.notStrictEqual(result.initialInput, null)
          assert.strictEqual(result.counterexample, null)

          const replayed = yield* Arbitrary.check(Arbitrary.schema(Node), () => false, { replay: result.replay })
          assert.strictEqual(replayed._tag, "Falsified")
          if (replayed._tag === "Falsified") {
            assert.deepStrictEqual(replayed.initialInput, result.initialInput)
            assert.strictEqual(replayed.counterexample, null)
          }
        }
      }))

    it.effect("shrinks and replays the complete falsification", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
        )
        const first = yield* Arbitrary.check(arbitrary, (value) => value < 0, {
          runs: 1,
          seed: "replay",
          size: 10
        })
        assert.strictEqual(first._tag, "Falsified")
        if (first._tag !== "Falsified") return
        assert.strictEqual(typeof first.replay, "string")

        const replay = `${first.replay}`
        const replayed = yield* Arbitrary.check(arbitrary, (value) => value < 0, { replay })
        assert.strictEqual(replayed._tag, "Falsified")
        if (replayed._tag !== "Falsified") return
        assert.strictEqual(first.counterexample, 1)
        assert.strictEqual(replayed.initialInput, first.initialInput)
        assert.strictEqual(replayed.counterexample, first.counterexample)
        assert.deepStrictEqual(replayed.failure, first.failure)
        assert.strictEqual(replayed.shrinks, first.shrinks)
      }))

    it.effect("counts every tested shrink candidate against maxShrinks", () =>
      Effect.gen(function*() {
        let evaluations = 0
        const result = yield* Arbitrary.check(
          Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
          () => {
            evaluations++
            return evaluations !== 1
          },
          { runs: 1, seed: 0, size: 10, maxShrinks: 1 }
        )

        assert.strictEqual(result._tag, "Falsified")
        assert.strictEqual(evaluations, 2)
        if (result._tag === "Falsified") {
          assert.strictEqual(result.shrinks, 0)
        }
      }))

    it.effect("lazily materializes structural shrinks and replays them", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(
          Schema.Array(Schema.Literal("value")).check(Schema.isMaxLength(3))
        )
        const first = yield* Arbitrary.check(arbitrary, () => false, { runs: 1, seed: 42, size: 3 })
        assert.strictEqual(first._tag, "Falsified")
        if (first._tag !== "Falsified") return

        const replayed = yield* Arbitrary.check(arbitrary, () => false, { replay: first.replay })
        assert.strictEqual(replayed._tag, "Falsified")
        if (replayed._tag !== "Falsified") return
        assert.deepStrictEqual(first.initialInput, ["value"])
        assert.deepStrictEqual(first.counterexample, [])
        assert.strictEqual(first.shrinks, 1)
        assert.deepStrictEqual(replayed.initialInput, first.initialInput)
        assert.deepStrictEqual(replayed.counterexample, first.counterexample)
        assert.strictEqual(replayed.shrinks, first.shrinks)
      }))

    it.effect("preserves typed property failures", () =>
      Effect.gen(function*() {
        const result = yield* Arbitrary.check(
          Arbitrary.schema(Schema.Literal("value")),
          () => Effect.fail("property failure"),
          { runs: 1, seed: "typed-failure" }
        )

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.deepStrictEqual(result.failure, { _tag: "PropertyError", error: "property failure" })
        }
      }))

    it.effect("does not turn synchronous property defects into a property result", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Arbitrary.check(Arbitrary.schema(Schema.Literal("value")), () => {
            throw new Error("property defect")
          }, { runs: 1, seed: "property-defect" })
        )

        assert.isTrue(Exit.hasDies(exit))
      }))

    it.effect("does not turn interruption into a property result", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Arbitrary.check(Arbitrary.schema(Schema.Literal("value")), () => Effect.interrupt, {
            runs: 1,
            seed: "interruption"
          })
        )

        assert.isTrue(Exit.hasInterrupts(exit))
      }))
  })
})
