import { assert, describe, it } from "@effect/vitest"
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Order,
  Random,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation
} from "effect"
import * as BigDecimal from "effect/BigDecimal"
import * as Chunk from "effect/Chunk"
import * as DateTime from "effect/DateTime"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Scheduler from "effect/Scheduler"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const makeSuspendChain = (count: number): Schema.Codec<unknown> => {
  let schema: Schema.Codec<unknown> = Schema.Null
  for (let index = 0; index < count; index++) {
    const next = schema
    schema = Schema.suspend(() => next)
  }
  return schema
}

interface SchemaCatalogEntry {
  readonly name: string
  readonly schema: Schema.Top
}

const verifySchemaCatalog = Effect.fnUntraced(function*(entries: ReadonlyArray<SchemaCatalogEntry>) {
  for (const entry of entries) {
    const result = yield* Arbitrary.check(Arbitrary.schema(entry.schema), Schema.is(entry.schema), {
      runs: 100,
      maxDiscards: 200,
      seed: `schema-catalog:${entry.name}`
    })
    assert.strictEqual(result._tag, "Passed", entry.name)
    if (result._tag === "Passed") {
      assert.strictEqual(result.runs, 100, entry.name)
      assert.isAtMost(result.discards, 200, entry.name)
    }
  }
})

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

    it.effect("constructs strings for the regular pattern subset", () =>
      Effect.gen(function*() {
        const schemas = [
          Schema.String.check(Schema.isPattern(/^[A-Z]{3}[0-9]{3}$/)),
          Schema.String.check(Schema.isPattern(/^(?:foo|bar)-[^0-9]\s?\w+$/)),
          Schema.String.check(Schema.isPattern(/^a+?$/)),
          Schema.String.check(Schema.isPattern(/^\x41\u0042\cC$/)),
          Schema.String.check(Schema.isPattern(/^\u{1f600}{2}$/u)),
          Schema.String.check(Schema.isPattern(/^effect$/y))
        ]
        for (let index = 0; index < schemas.length; index++) {
          const values = yield* Arbitrary.sample(Arbitrary.schema(schemas[index]), {
            count: 20,
            maxDiscards: 20,
            seed: `regular-pattern-${index}`
          })
          assert.isTrue(values.every(Schema.is(schemas[index])))
        }
      }))

    it.effect("honors dot-all and sticky regular-expression flags", () =>
      Effect.gen(function*() {
        const dotAll = Schema.String.check(Schema.isPattern(/^.$/s))
        const dotAllValues = yield* Arbitrary.sample(Arbitrary.schema(dotAll), {
          count: 200,
          maxDiscards: 0,
          seed: 0
        })
        assert.isTrue(dotAllValues.every(Schema.is(dotAll)))
        assert.isTrue(dotAllValues.some((value) => /[\n\r\u2028\u2029]/.test(value)))

        const sticky = Schema.String.check(Schema.isPattern(/a/y))
        const stickyValues = yield* Arbitrary.sample(Arbitrary.schema(sticky), {
          count: 100,
          maxDiscards: 0,
          seed: "sticky-pattern"
        })
        assert.isTrue(stickyValues.every(Schema.is(sticky)))
        assert.isTrue(stickyValues.some((value) => value.length > 1))
      }))

    it.effect("biases broad character classes toward common characters while exploring their full domain", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.isPattern(/^.$/u))
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 200,
          maxDiscards: 0,
          seed: "broad-character-class"
        })

        assert.isTrue(values.some((value) => /^[\x20-\x7e]$/u.test(value)))
        assert.isTrue(values.some((value) => value.codePointAt(0)! > 0x1f600))
      }))

    it.effect("constructs strings for built-in pattern checks", () =>
      Effect.gen(function*() {
        const schemas = [
          Schema.String.check(Schema.isTrimmed()),
          Schema.String.check(Schema.isUppercased()),
          Schema.String.check(Schema.isLowercased()),
          Schema.String.check(Schema.isCapitalized()),
          Schema.String.check(Schema.isUncapitalized()),
          Schema.String.check(Schema.isStartsWith("a.b")),
          Schema.String.check(Schema.isEndsWith("a.b")),
          Schema.String.check(Schema.isIncludes("a.b"))
        ]
        for (let index = 0; index < schemas.length; index++) {
          const values = yield* Arbitrary.sample(Arbitrary.schema(schemas[index]), {
            count: 20,
            maxDiscards: 100,
            seed: `built-in-pattern-${index}`
          })
          assert.isTrue(values.every(Schema.is(schemas[index])))
        }
      }))

    it.effect("generates RegExp declarations without codec filtering", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.RegExp), {
          count: 100,
          maxDiscards: 0,
          seed: "regexp-declaration"
        })

        assert.isTrue(values.every((value) => value instanceof globalThis.RegExp))
        assert.isTrue(new Set(values.map((value) => value.source)).size > 1)
        assert.isTrue(new Set(values.map((value) => value.flags)).size > 1)
      }))

    it.effect("generates and shrinks web URL declarations without codec filtering", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(Schema.URL)
        const values = yield* Arbitrary.sample(arbitrary, {
          count: 200,
          maxDiscards: 0,
          seed: "url-declaration",
          size: 10
        })

        assert.isTrue(values.every((value) => value instanceof globalThis.URL))
        assert.deepStrictEqual(new Set(values.map((value) => value.protocol)), new Set(["http:", "https:"]))
        assert.isTrue(values.some((value) => value.pathname !== "/"))

        const result = yield* Arbitrary.check(arbitrary, () => false, {
          runs: 1,
          maxDiscards: 0,
          seed: "url-shrink",
          size: 10
        })
        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.isAbove(result.shrinks, 0)
          assert.match(result.counterexample.protocol, /^https?:$/)
        }
      }))

    it.effect("generates and shrinks Date declarations constructively across their full domain", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.Date), {
          count: 25_000,
          maxDiscards: 0,
          seed: "date-declaration"
        })
        const timestamps = values.map((value) => value.getTime())

        assert.include(timestamps, -8_640_000_000_000_000)
        assert.include(timestamps, 0)
        assert.include(timestamps, 8_640_000_000_000_000)
        assert.isTrue(values.every(Schema.is(Schema.Date)))

        const constrained = Schema.Date.check(Schema.isBetweenDate({
          minimum: new globalThis.Date(0),
          maximum: new globalThis.Date(10),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        }))
        const constrainedValues = yield* Arbitrary.sample(Arbitrary.schema(constrained), {
          count: 500,
          maxDiscards: 0,
          seed: "date-constraints"
        })
        const constrainedTimestamps = constrainedValues.map((value) => value.getTime())
        assert.include(constrainedTimestamps, 1)
        assert.include(constrainedTimestamps, 9)
        assert.isTrue(constrainedValues.every(Schema.is(constrained)))

        const result = yield* Arbitrary.check(Arbitrary.schema(Schema.Date), () => false, {
          runs: 1,
          maxDiscards: 0,
          seed: "date-shrink"
        })
        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") assert.strictEqual(result.counterexample.getTime(), 0)
      }))

    it.effect("generates and shrinks BigDecimal declarations constructively", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(Schema.BigDecimal)
        const values = yield* Arbitrary.sample(arbitrary, {
          count: 500,
          maxDiscards: 0,
          seed: "big-decimal-declaration",
          size: 10
        })

        assert.isTrue(values.every(Schema.is(Schema.BigDecimal)))
        assert.isAbove(new Set(values.map((value) => value.scale)).size, 1)

        const constrained = Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
          minimum: BigDecimal.make(1_234n, 3),
          maximum: BigDecimal.make(1_236n, 3),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        }))
        const constrainedValues = yield* Arbitrary.sample(Arbitrary.schema(constrained), {
          count: 500,
          maxDiscards: 0,
          seed: "big-decimal-constraints",
          size: 10
        })

        assert.isTrue(constrainedValues.every(Schema.is(constrained)))

        const highScale = Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
          minimum: BigDecimal.make(-12_345n, 22),
          maximum: BigDecimal.make(678_901n, 24)
        }))
        const highScaleValues = yield* Arbitrary.sample(Arbitrary.schema(highScale), {
          count: 500,
          maxDiscards: 0,
          seed: "big-decimal-high-scale-constraints",
          size: 10
        })

        assert.isTrue(highScaleValues.every(Schema.is(highScale)))

        const result = yield* Arbitrary.check(arbitrary, () => false, {
          runs: 1,
          maxDiscards: 0,
          seed: "big-decimal-shrink",
          size: 10
        })
        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.isTrue(BigDecimal.Equivalence(result.counterexample, BigDecimal.make(0n, 0)))
        }
      }))

    it.effect("generates and shrinks DateTime.Utc declarations constructively", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(Schema.DateTimeUtc)
        const values = yield* Arbitrary.sample(arbitrary, {
          count: 1_000,
          maxDiscards: 0,
          seed: "date-time-utc-declaration",
          size: 10
        })

        assert.isTrue(values.every(Schema.is(Schema.DateTimeUtc)))

        const isBetweenDateTime = Schema.makeIsBetween({ order: DateTime.Order })
        const constrained = Schema.DateTimeUtc.check(isBetweenDateTime({
          minimum: DateTime.makeUnsafe(0),
          maximum: DateTime.makeUnsafe(10),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        }))
        const constrainedValues = yield* Arbitrary.sample(Arbitrary.schema(constrained), {
          count: 500,
          maxDiscards: 0,
          seed: "date-time-utc-constraints",
          size: 10
        })

        assert.isTrue(constrainedValues.every(Schema.is(constrained)))
        assert.isTrue(constrainedValues.every((value) => value.epochMilliseconds > 0 && value.epochMilliseconds < 10))

        const result = yield* Arbitrary.check(arbitrary, () => false, {
          runs: 1,
          maxDiscards: 0,
          seed: "date-time-utc-shrink",
          size: 10
        })
        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") assert.strictEqual(result.counterexample.epochMilliseconds, 0)
      }))

    it.effect("generates named and offset TimeZone declarations constructively", () =>
      Effect.gen(function*() {
        const named = yield* Arbitrary.sample(Arbitrary.schema(Schema.TimeZoneNamed), {
          count: 200,
          maxDiscards: 0,
          seed: "time-zone-named-declaration",
          size: 10
        })
        const zones = yield* Arbitrary.sample(Arbitrary.schema(Schema.TimeZone), {
          count: 1_000,
          maxDiscards: 0,
          seed: "time-zone-declaration",
          size: 10
        })

        assert.isTrue(named.every(Schema.is(Schema.TimeZoneNamed)))
        assert.isAbove(new Set(named.map((value) => value.id)).size, 1)
        assert.isTrue(zones.every(Schema.is(Schema.TimeZone)))
        assert.isTrue(zones.some(DateTime.isTimeZoneNamed))
        assert.isTrue(zones.some(DateTime.isTimeZoneOffset))
      }))

    it.effect("generates and shrinks DateTime.Zoned declarations constructively", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(Schema.DateTimeZoned)
        const values = yield* Arbitrary.sample(arbitrary, {
          count: 1_000,
          maxDiscards: 0,
          seed: "date-time-zoned-declaration",
          size: 10
        })

        assert.isTrue(values.every(Schema.is(Schema.DateTimeZoned)))
        assert.isTrue(values.some((value) => DateTime.isTimeZoneNamed(value.zone)))
        assert.isTrue(values.some((value) => DateTime.isTimeZoneOffset(value.zone)))

        const isBetweenDateTime = Schema.makeIsBetween({ order: DateTime.Order })
        const constrained = Schema.DateTimeZoned.check(isBetweenDateTime({
          minimum: DateTime.makeZonedUnsafe(0, { timeZone: "UTC" }),
          maximum: DateTime.makeZonedUnsafe(10, { timeZone: "UTC" }),
          exclusiveMinimum: true,
          exclusiveMaximum: true
        }))
        const constrainedValues = yield* Arbitrary.sample(Arbitrary.schema(constrained), {
          count: 500,
          maxDiscards: 0,
          seed: "date-time-zoned-constraints",
          size: 10
        })

        assert.isTrue(constrainedValues.every(Schema.is(constrained)))
        assert.isTrue(constrainedValues.every((value) => value.epochMilliseconds > 0 && value.epochMilliseconds < 10))

        const result = yield* Arbitrary.check(arbitrary, () => false, {
          runs: 1,
          maxDiscards: 0,
          seed: "date-time-zoned-shrink",
          size: 10
        })
        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") assert.strictEqual(result.counterexample.epochMilliseconds, 0)
      }))

    it.effect("generates and shrinks Uint8Array declarations through native Array semantics", () =>
      Effect.gen(function*() {
        const schema = Schema.Uint8Array.check(Schema.isMinLength(2), Schema.isMaxLength(10))
        const arbitrary = Arbitrary.schema(schema)
        const values = yield* Arbitrary.sample(arbitrary, {
          count: 8_192,
          maxDiscards: 0,
          seed: "uint8-array-declaration",
          size: 10
        })
        const lengths = values.map((value) => value.length)
        const bytes = values.flatMap((value) => [...value])

        assert.isTrue(values.every((value) => value instanceof globalThis.Uint8Array))
        assert.isTrue(values.every(Schema.is(schema)))
        assert.include(lengths, 2)
        assert.include(lengths, 10)
        assert.include(bytes, 0)
        assert.include(bytes, 255)

        const result = yield* Arbitrary.check(arbitrary, () => false, {
          runs: 1,
          maxDiscards: 0,
          seed: "uint8-array-shrink",
          size: 10
        })
        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.instanceOf(result.counterexample, globalThis.Uint8Array)
          assert.deepStrictEqual([...result.counterexample], [0, 0])
        }
      }))

    it.effect("explores strings around an unanchored match", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.isIncludes("needle"))
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 100,
          maxDiscards: 0,
          seed: "unanchored-pattern"
        })

        assert.isTrue(values.every(Schema.is(schema)))
        assert.isTrue(values.some((value) => value !== "needle"))
        assert.isTrue(values.some((value) => value.startsWith("needle")))
        assert.isTrue(values.some((value) => value.endsWith("needle")))
      }))

    it.effect("combines constructive pattern generation with string length constraints", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(
          Schema.isPattern(/^(ab){3,10}$/),
          Schema.isMinLength(8),
          Schema.isMaxLength(12)
        )
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 100,
          maxDiscards: 0,
          seed: "pattern-length"
        })

        assert.isTrue(values.every(Schema.is(schema)))
        assert.isTrue(values.every((value) => value.length === 8 || value.length === 10 || value.length === 12))
      }))

    it.effect("uses every supported pattern as a candidate and validates against every pattern", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(
          Schema.isPattern(/^[^A-Z]*$/),
          Schema.isPattern(/^0x[0-9a-f]{40}$/)
        )
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 20,
          maxDiscards: 200,
          seed: "multiple-patterns"
        })

        assert.isTrue(values.every(Schema.is(schema)))
      }))

    it.effect("keeps unsupported patterns as residual filters", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(
          Schema.isPattern(/^(?=a)a$/),
          Schema.isPattern(/^a$/)
        )
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 20,
          maxDiscards: 0,
          seed: "unsupported-pattern-candidate"
        })

        assert.deepStrictEqual(values, globalThis.Array.from({ length: 20 }, () => "a"))
      }))

    it.effect("bounds fallback filtering for unsupported regular expression constructs", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.isPattern(/^(?=a)b$/))
        const result = yield* Effect.result(Arbitrary.sample(Arbitrary.schema(schema), {
          count: 1,
          maxDiscards: 2,
          seed: "unsupported-pattern"
        }))

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.deepStrictEqual(result.failure, { _tag: "SampleError", generated: 0, discards: 3 })
        }
      }))

    it.effect("uses generic generation for permissive unsupported regular expressions", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.isPattern(/^(?=)[ -~]*$/))
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 20,
          maxDiscards: 20,
          seed: "unsupported-permissive-pattern"
        })

        assert.isTrue(values.every(Schema.is(schema)))
      }))

    it.effect("bounds incompatible pattern and length constraints", () =>
      Effect.gen(function*() {
        const schemas = [
          Schema.String.check(
            Schema.isPattern(/^(aa)+$/),
            Schema.isMinLength(3),
            Schema.isMaxLength(3)
          ),
          Schema.String.check(
            Schema.isPattern(/^$/),
            Schema.isMinLength(1)
          )
        ]

        for (const schema of schemas) {
          const result = yield* Effect.result(Arbitrary.sample(Arbitrary.schema(schema), {
            count: 1,
            maxDiscards: 2,
            seed: "incompatible-pattern-length"
          }))

          assert.isTrue(Result.isFailure(result))
          if (Result.isFailure(result)) {
            assert.deepStrictEqual(result.failure, { _tag: "SampleError", generated: 0, discards: 3 })
          }
        }
      }))

    it.effect("keeps pattern constraints while shrinking strings", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.isPattern(/^a+$/), Schema.isMaxLength(8))
        const evaluated: Array<string> = []
        const result = yield* Arbitrary.check(
          Arbitrary.schema(schema),
          (value) => {
            evaluated.push(value)
            return value.length < 4
          },
          { runs: 100, seed: "pattern-shrink" }
        )

        assert.strictEqual(result._tag, "Falsified")
        assert.isTrue(evaluated.every(Schema.is(schema)))
        if (result._tag === "Falsified") assert.strictEqual(result.counterexample.length, 4)
      }))

    it.effect("shrinks fixed-length String code units toward null", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(3))
        const result = yield* Arbitrary.check(Arbitrary.schema(schema), () => false, {
          runs: 1,
          seed: "string-code-unit-shrink",
          size: 3
        })

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.notStrictEqual(result.initialInput, "\0\0\0")
          assert.strictEqual(result.counterexample, "\0\0\0")
        }
      }))

    it.effect("structurally shrinks regular-expression repetitions", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.isPattern(/^a*b$/), Schema.isMinLength(1), Schema.isMaxLength(8))
        const result = yield* Arbitrary.check(
          Arbitrary.schema(schema),
          () => false,
          { runs: 1, seed: "structural-pattern-shrink", size: 8 }
        )

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.notStrictEqual(result.initialInput, "b")
          assert.strictEqual(result.counterexample, "b")
        }
      }))

    it.effect("structurally shrinks regular-expression alternatives to the first one", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.isPattern(/^(foo|bar|baz)$/))
        const result = yield* Arbitrary.check(
          Arbitrary.schema(schema),
          () => false,
          { runs: 1, seed: "structural-alternative-shrink" }
        )

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.notStrictEqual(result.initialInput, "foo")
          assert.strictEqual(result.counterexample, "foo")
        }
      }))

    it.effect("derives independent random streams for adjacent attempts", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(
          Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
          { count: 1_000, maxDiscards: 0, seed: "attempt-streams" }
        )

        // Numeric bias deliberately repeats small values, but attempt-local streams must still explore broadly.
        assert.isAtLeast(new Set(values).size, 750)
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

    it.effect("spreads bounded integer samples across the complete domain", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(
          Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 }))),
          { count: 8_192, maxDiscards: 0, seed: "bounded-integer-buckets" }
        )
        const buckets = Array.from({ length: 8 }, () => 0)
        for (const value of values) buckets[value]!++

        // Like fast-check v4.9.0's broad numeric smoke assertions, these bounds detect collapsed PRNG buckets without
        // specifying a public distribution.
        // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/test/e2e/arbitraries/DoubleArbitrary.spec.ts
        for (const bucket of buckets) {
          assert.isAtLeast(bucket, values.length * 0.05)
          assert.isAtMost(bucket, values.length * 0.3)
        }
      }))

    it.effect("spreads bounded Number samples across one IEEE-754 binade", () =>
      Effect.gen(function*() {
        const schema = Schema.Number.check(Schema.isBetween({
          minimum: 1,
          maximum: 2,
          exclusiveMaximum: true
        }))
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
          count: 8_192,
          maxDiscards: 0,
          seed: "bounded-number-buckets"
        })
        const buckets = Array.from({ length: 4 }, () => 0)
        for (const value of values) buckets[Math.floor((value - 1) * 4)]!++

        // Edge weighting may change privately, but it must preserve broad coverage of the binade.
        for (const bucket of buckets) {
          assert.isAtLeast(bucket, values.length * 0.1)
          assert.isAtMost(bucket, values.length * 0.4)
        }
      }))

    it.effect("targets bounded integer and BigInt edges while preserving broad coverage", () =>
      Effect.gen(function*() {
        const minimumInt = -1_000_000
        const maximumInt = 1_000_000
        const ints = yield* Arbitrary.sample(
          Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: minimumInt, maximum: maximumInt }))),
          { count: 25_000, maxDiscards: 0, seed: "numeric-edge-bias-int" }
        )
        assert.include(ints, minimumInt)
        assert.include(ints, 0)
        assert.include(ints, maximumInt)
        assert.isAtLeast(new Set(ints).size, 15_000)

        const minimumBigInt = -(BigInt(1) << BigInt(255))
        const maximumBigInt = (BigInt(1) << BigInt(255)) - BigInt(1)
        const bigints = yield* Arbitrary.sample(
          Arbitrary.schema(Schema.BigInt.check(Schema.isBetweenBigInt({
            minimum: minimumBigInt,
            maximum: maximumBigInt
          }))),
          { count: 25_000, maxDiscards: 0, seed: "numeric-edge-bias-bigint" }
        )
        assert.include(bigints, minimumBigInt)
        assert.include(bigints, BigInt(0))
        assert.include(bigints, maximumBigInt)
        assert.isAtLeast(new Set(bigints).size, 15_000)
      }))

    it.effect("targets String, Array, and Record cardinality boundaries while preserving intermediate sizes", () =>
      Effect.gen(function*() {
        const count = 8_192
        const assertBoundaryBias = Effect.fnUntraced(function*<A>(
          schema: Schema.Schema<A>,
          cardinality: (value: A) => number
        ) {
          const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
            count,
            maxDiscards: count,
            seed: "length-edge-bias",
            size: 10
          })
          const buckets = Array.from({ length: 11 }, () => 0)
          for (const value of values) buckets[cardinality(value)]!++

          assert.isAtLeast(buckets[0], count * 0.12)
          assert.isAtLeast(buckets[10], count * 0.12)
          for (const bucket of buckets.slice(1, -1)) assert.isAtLeast(bucket, count * 0.04)
        })

        yield* assertBoundaryBias(Schema.String.check(Schema.isMaxLength(10)), (value) => value.length)
        yield* assertBoundaryBias(Schema.Array(Schema.Null).check(Schema.isMaxLength(10)), (value) => value.length)
        yield* assertBoundaryBias(
          Schema.Record(Schema.String, Schema.Null).check(Schema.isMaxProperties(10)),
          (value) => Object.keys(value).length
        )
      }))

    it.effect("starts progressive checks for Records with an explicit minimum property count", () =>
      Effect.gen(function*() {
        const schema = Schema.Record(Schema.String, Schema.Number).check(Schema.isMinProperties(2))
        const result = yield* Arbitrary.check(Arbitrary.schema(schema), Schema.is(schema), {
          runs: 20,
          maxDiscards: 200,
          seed: "record-min-properties-progressive"
        })

        assert.strictEqual(result._tag, "Passed")
      }))

    it.effect("injects the approved JavaScript String edge corpus", () =>
      Effect.gen(function*() {
        const corpus = [
          "",
          " ",
          "\t",
          "\n",
          "\0",
          "0",
          "-1",
          "4294967295",
          "__proto__",
          "constructor",
          "prototype",
          "toString",
          "\uD800",
          "\uDC00",
          "😀"
        ]
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.String), {
          count: 8_192,
          maxDiscards: 0,
          seed: "string-edge-corpus",
          size: 16
        })

        for (const value of corpus) assert.include(values, value)
      }))

    it.effect("scales unconstrained String, Array, and Record sizes without hidden ceilings", () =>
      Effect.gen(function*() {
        const size = 32
        const strings = yield* Arbitrary.sample(Arbitrary.schema(Schema.String), {
          count: 200,
          maxDiscards: 0,
          seed: "unconstrained-size",
          size
        })
        const arrays = yield* Arbitrary.sample(Arbitrary.schema(Schema.Array(Schema.Null)), {
          count: 200,
          maxDiscards: 0,
          seed: "unconstrained-size",
          size
        })
        const records = yield* Arbitrary.sample(Arbitrary.schema(Schema.Record(Schema.String, Schema.Null)), {
          count: 200,
          maxDiscards: 200,
          seed: "unconstrained-size",
          size
        })

        assert.isTrue(strings.some((value) => value.length > 16))
        assert.isTrue(arrays.some((value) => value.length > 8))
        assert.isTrue(records.some((value) => Object.keys(value).length > 8))
      }))

    it.effect("scales the specialized Json generator with size", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.Json), {
          count: 200,
          maxDiscards: 0,
          seed: "json-size",
          size: 32
        })

        assert.isTrue(values.some((value) => typeof value === "string" && value.length > 8))
        assert.isTrue(values.some((value) => Array.isArray(value) && value.length > 3))
        const objects = values.filter((value): value is Record<string, Schema.Json> => {
          return typeof value === "object" && value !== null && !Array.isArray(value)
        })
        assert.isTrue(objects.some((value) => Object.keys(value).length > 3))
        assert.isTrue(objects.flatMap((value) => Object.keys(value)).some((key) => !/^key\d+$/.test(key)))
        assert.isTrue(objects.every((value) => Object.getPrototypeOf(value) === Object.prototype))
      }))

    it.effect("targets IEEE-754 edge cases while preserving intermediate values", () =>
      Effect.gen(function*() {
        // This follows fast-check v4.9.0's broad edge-coverage contract without fixing exact frequencies.
        // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/test/e2e/arbitraries/DoubleArbitrary.spec.ts
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.Number), {
          count: 25_000,
          maxDiscards: 0,
          seed: "numeric-edge-bias-number"
        })
        const expected = [
          Number.NEGATIVE_INFINITY,
          -Number.MAX_VALUE,
          -Number.MIN_VALUE,
          -0,
          0,
          Number.MIN_VALUE,
          Number.MAX_VALUE,
          Number.POSITIVE_INFINITY,
          Number.NaN
        ]
        for (const value of expected) {
          assert.isTrue(values.some((candidate) => Object.is(candidate, value)))
        }
        const intermediate = values.filter((value) => {
          const absolute = Math.abs(value)
          return absolute >= 2 ** -1021 && absolute < 2 ** 1023
        })
        assert.isAtLeast(intermediate.length, values.length * 0.5)
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

    it.effect("uses the same generated value for sampling and a single-run check", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(Schema.Struct({
          values: Schema.Array(Schema.Int).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
          unique: Schema.UniqueArray(Schema.Int).check(Schema.isMinLength(2), Schema.isMaxLength(4))
        }))
        const sampled = yield* Arbitrary.sample(arbitrary, { count: 1, seed: "sample-check", size: 10 })
        let checked: (typeof sampled)[number] | undefined
        yield* Arbitrary.check(arbitrary, (value) => {
          checked = value
          return true
        }, { runs: 1, seed: "sample-check", size: 10 })

        assert.deepStrictEqual(checked, sampled[0])
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

    it.effect("uses Effect equality for constructive uniqueness", () =>
      Effect.gen(function*() {
        const schema = Schema.UniqueArray(Schema.Struct({ value: Schema.Literal(1) })).check(
          Schema.isMinLength(2),
          Schema.isMaxLength(2)
        )
        const result = yield* Effect.result(Arbitrary.sample(Arbitrary.schema(schema), {
          count: 1,
          maxDiscards: 2,
          seed: "structural-unique"
        }))

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.deepStrictEqual(result.failure, { _tag: "SampleError", generated: 0, discards: 3 })
        }
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

    it.effect("shrinks Record values before keys while preserving key uniqueness", () =>
      Effect.gen(function*() {
        const schema = Schema.Record(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1)),
          Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))
        ).check(Schema.isMinProperties(1), Schema.isMaxProperties(1))
        const result = yield* Arbitrary.check(Arbitrary.schema(schema), () => false, {
          runs: 1,
          seed: "record-key-shrink",
          size: 1
        })

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.deepStrictEqual(result.counterexample, { "\0": 0 })
        }

        const uniqueSchema = Schema.Record(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1)),
          Schema.Null
        ).check(Schema.isMinProperties(2), Schema.isMaxProperties(2))
        const uniqueResult = yield* Arbitrary.check(Arbitrary.schema(uniqueSchema), () => false, {
          runs: 1,
          seed: "record-key-unique-shrink",
          size: 2
        })

        assert.strictEqual(uniqueResult._tag, "Falsified")
        if (uniqueResult._tag === "Falsified") {
          const keys = Object.keys(uniqueResult.counterexample).map((key) => key.charCodeAt(0)).sort((a, b) => a - b)
          assert.deepStrictEqual(keys, [0, 1])
        }
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

    it.effect("generates Unknown and Any through Json", () =>
      Effect.gen(function*() {
        for (const schema of [Schema.Unknown, Schema.Any]) {
          const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
            count: 30,
            maxDiscards: 0,
            seed: "unknown-any",
            size: 5
          })

          assert.isTrue(values.every(Schema.is(Schema.Json)))
        }
      }))

    it.effect("uses the private native annotation for Json", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.Json), { count: 30, seed: "json", size: 5 })

        assert.isTrue(values.every(Schema.is(Schema.Json)))
      }))

    it.effect("derives canonical declarations through their codec", () =>
      Effect.gen(function*() {
        const schema = Schema.Option(Schema.Int)
        const values = yield* Arbitrary.sample(Arbitrary.schema(schema), { count: 30, seed: "option", size: 5 })

        assert.isTrue(values.every(Option.isOption))
        assert.isTrue(values.every(Schema.is(schema)))
      }))

    it.effect("prefers toCodecArbitrary and passes normalized constraints without Order", () =>
      Effect.gen(function*() {
        let received: Schema.Annotations.ToCodecArbitrary.GenerationConstraint<number> | undefined
        const declaration = Schema.declare<number>((input): input is number => typeof input === "number", {
          toCodec: () =>
            Schema.link<number>()(
              Schema.Literal(99),
              SchemaTransformation.transform<number, 99>({ decode: (value) => value, encode: () => 99 })
            ),
          toCodecArbitrary: ({ constraint }) => {
            received = constraint
            return Schema.link<number>()(
              Schema.Int.check(Schema.isBetween({
                minimum: constraint?.minimum ?? Number.MIN_SAFE_INTEGER,
                maximum: constraint?.maximum ?? Number.MAX_SAFE_INTEGER,
                exclusiveMinimum: constraint?.exclusiveMinimum,
                exclusiveMaximum: constraint?.exclusiveMaximum
              })),
              SchemaTransformation.passthrough()
            )
          }
        }).check(Schema.isBetween({ minimum: 1, maximum: 4, exclusiveMinimum: true }))

        const values = yield* Arbitrary.sample(Arbitrary.schema(declaration), {
          count: 100,
          maxDiscards: 0,
          seed: "to-codec-arbitrary-constraint"
        })

        assert.deepStrictEqual(received, { minimum: 1, maximum: 4, exclusiveMinimum: true })
        assert.isTrue(values.every((value) => value > 1 && value <= 4))
      }))

    it("rejects contradictory native constraints before invoking toCodecArbitrary", () => {
      let invoked = false
      const declaration = Schema.declare<number>((input): input is number => typeof input === "number", {
        toCodecArbitrary: () => {
          invoked = true
          return Schema.link<number>()(Schema.Number, SchemaTransformation.passthrough())
        }
      }).check(
        Schema.makeFilter(() => true, { toCodecArbitrary: { constraint: { minLength: 2 } } }),
        Schema.makeFilter(() => true, { toCodecArbitrary: { constraint: { maxLength: 1 } } })
      )

      assert.throws(() => Arbitrary.schema(declaration), /Unable to derive an arbitrary for constraints/)
      assert.isFalse(invoked)
    })

    it.effect("derives mutually recursive declarations through toCodecArbitrary", () =>
      Effect.gen(function*() {
        interface A {
          readonly _tag: "A"
          readonly next: B | null
        }
        interface B {
          readonly _tag: "B"
          readonly next: A | null
        }
        let A: Schema.declare<A>
        let B: Schema.declare<B>
        A = Schema.declare<A>(
          (input): input is A => typeof input === "object" && input !== null && (input as A)._tag === "A",
          {
            toCodecArbitrary: () =>
              Schema.link<A>()(
                Schema.Struct({
                  _tag: Schema.Literal("A"),
                  next: Schema.NullOr(Schema.suspend(() => B))
                }),
                SchemaTransformation.passthrough()
              )
          }
        )
        B = Schema.declare<B>(
          (input): input is B => typeof input === "object" && input !== null && (input as B)._tag === "B",
          {
            toCodecArbitrary: () =>
              Schema.link<B>()(
                Schema.Struct({
                  _tag: Schema.Literal("B"),
                  next: Schema.NullOr(Schema.suspend(() => A))
                }),
                SchemaTransformation.passthrough()
              )
          }
        )

        const values = yield* Arbitrary.sample(Arbitrary.schema(A), {
          count: 100,
          maxDiscards: 0,
          seed: "mutual-to-codec-arbitrary",
          size: 10
        })

        assert.isTrue(values.every(Schema.is(A)))
        assert.isTrue(values.some((value) => value.next?._tag === "B"))
      }))

    it.effect("promotes valid shrink descendants through a rejecting canonical codec", () =>
      Effect.gen(function*() {
        const encoded = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
        const schema = Schema.declare<number>(
          (input): input is number => input === 25 || input === 100,
          {
            toCodec: () =>
              Schema.link<number>()(
                encoded,
                SchemaTransformation.transformOrFail({
                  decode: (value) =>
                    value === 25 || value === 100
                      ? Effect.succeed(value)
                      : Effect.fail(new SchemaIssue.Forbidden({ message: "unsupported value" })),
                  encode: Effect.succeed
                })
              )
          }
        )

        const result = yield* Arbitrary.check(Arbitrary.schema(schema), () => false, {
          runs: 1,
          maxDiscards: 0,
          seed: 47
        })

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.strictEqual(result.initialInput, 100)
          assert.strictEqual(result.counterexample, 25)
          assert.strictEqual(result.shrinks, 1)
        }
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

    it.effect("translates collection cardinality constraints through toCodecArbitrary", () =>
      Effect.gen(function*() {
        const hashSet = Schema.HashSet(Schema.Int).check(Schema.makeFilter(
          (value: HashSet.HashSet<number>) => HashSet.size(value) === 3,
          { toCodecArbitrary: { constraint: { minSize: 3, maxSize: 3 } } }
        ))
        const hashMap = Schema.HashMap(Schema.String, Schema.Int).check(Schema.makeFilter(
          (value: HashMap.HashMap<string, number>) => HashMap.size(value) === 3,
          { toCodecArbitrary: { constraint: { minSize: 3, maxSize: 3 } } }
        ))
        const schemas: ReadonlyArray<readonly [Schema.Top, (value: any) => number]> = [
          [Schema.Chunk(Schema.Int).check(Schema.isLengthBetween(3, 3)), Chunk.size],
          [Schema.ReadonlySet(Schema.Int).check(Schema.isSizeBetween(3, 3)), (value) => value.size],
          [hashSet, HashSet.size],
          [Schema.ReadonlyMap(Schema.String, Schema.Int).check(Schema.isSizeBetween(3, 3)), (value) => value.size],
          [hashMap, HashMap.size]
        ]

        for (const [schema, size] of schemas) {
          const values = yield* Arbitrary.sample(Arbitrary.schema(schema), {
            count: 30,
            maxDiscards: 100,
            seed: "collection-to-codec-arbitrary",
            size: 10
          })
          assert.isTrue(values.every((value) => size(value) === 3))
        }
      }))

    describe("native Schema catalog", () => {
      it.effect("derives primitive and structural schemas", () => {
        const enumValues = {
          Apple: "apple",
          Banana: "banana",
          Cantaloupe: 3
        } as const
        class CatalogClass extends Schema.Class<CatalogClass>("ArbitraryCatalogClass")({
          value: Schema.String
        }) {}
        return verifySchemaCatalog([
          { name: "Any", schema: Schema.Any },
          { name: "Unknown", schema: Schema.Unknown },
          { name: "Void", schema: Schema.Void },
          { name: "Undefined", schema: Schema.Undefined },
          { name: "Null", schema: Schema.Null },
          { name: "String", schema: Schema.String },
          { name: "Number", schema: Schema.Number },
          { name: "Boolean", schema: Schema.Boolean },
          { name: "BigInt", schema: Schema.BigInt },
          { name: "Symbol", schema: Schema.Symbol },
          { name: "UniqueSymbol", schema: Schema.UniqueSymbol(Symbol.for("arbitrary-parity")) },
          { name: "ObjectKeyword", schema: Schema.ObjectKeyword },
          { name: "Literals", schema: Schema.Literals(["a", 1, true, 1n]) },
          { name: "Enum", schema: Schema.Enum(enumValues) },
          {
            name: "TemplateLiteral",
            schema: Schema.TemplateLiteral(["user_", Schema.String.check(Schema.isUUID())])
          },
          { name: "Union", schema: Schema.Union([Schema.String, Schema.Number]) },
          {
            name: "Tuple",
            schema: Schema.Tuple([Schema.String, Schema.optionalKey(Schema.Number)])
          },
          {
            name: "TupleWithRest",
            schema: Schema.TupleWithRest(Schema.Tuple([Schema.Boolean]), [Schema.Number, Schema.String])
          },
          { name: "Array", schema: Schema.Array(Schema.String) },
          {
            name: "Struct",
            schema: Schema.Struct({
              required: Schema.String,
              optional: Schema.optionalKey(Schema.Number)
            })
          },
          { name: "Record(String)", schema: Schema.Record(Schema.String, Schema.Number) },
          { name: "Record(Symbol)", schema: Schema.Record(Schema.Symbol, Schema.Number) },
          { name: "Class", schema: CatalogClass },
          {
            name: "StructWithRest",
            schema: Schema.StructWithRest(
              Schema.Struct({ required: Schema.Number }),
              [Schema.Record(Schema.String, Schema.Number)]
            )
          }
        ])
      })

      it.effect("derives schemas with canonical constraints", () =>
        verifySchemaCatalog([
          {
            name: "String length",
            schema: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(4))
          },
          { name: "String starts with", schema: Schema.String.check(Schema.isStartsWith("a.b")) },
          { name: "String ends with", schema: Schema.String.check(Schema.isEndsWith("a+b")) },
          { name: "String includes", schema: Schema.String.check(Schema.isIncludes("[")) },
          { name: "Finite", schema: Schema.Finite },
          { name: "Int32", schema: Schema.Number.check(Schema.isInt32()) },
          {
            name: "Int fractional bounds",
            schema: Schema.Int.check(Schema.isBetween({
              minimum: 1.2,
              maximum: 10.8,
              exclusiveMinimum: true,
              exclusiveMaximum: true
            }))
          },
          {
            name: "BigInt bounds",
            schema: Schema.BigInt.check(Schema.isBetweenBigInt({
              minimum: 0n,
              maximum: 10n,
              exclusiveMinimum: true,
              exclusiveMaximum: true
            }))
          },
          {
            name: "Date bounds",
            schema: Schema.Date.check(Schema.isBetweenDate({
              minimum: new globalThis.Date(0),
              maximum: new globalThis.Date(10),
              exclusiveMinimum: true,
              exclusiveMaximum: true
            }))
          },
          {
            name: "BigDecimal bounds",
            schema: Schema.BigDecimal.check(Schema.isBetweenBigDecimal({
              minimum: BigDecimal.fromStringUnsafe("1.01"),
              maximum: BigDecimal.fromStringUnsafe("1.02"),
              exclusiveMinimum: true,
              exclusiveMaximum: true
            }))
          },
          {
            name: "Array length",
            schema: Schema.Array(Schema.String).check(Schema.isLengthBetween(2, 4))
          },
          {
            name: "UniqueArray",
            schema: Schema.UniqueArray(Schema.String).check(Schema.isMaxLength(2))
          },
          {
            name: "Record properties",
            schema: Schema.Record(Schema.String, Schema.Number).check(Schema.isPropertiesLengthBetween(2, 4))
          },
          {
            name: "Struct properties",
            schema: Schema.Struct({
              a: Schema.optionalKey(Schema.String),
              b: Schema.optionalKey(Schema.String),
              c: Schema.optionalKey(Schema.String)
            }).check(Schema.isPropertiesLengthBetween(2, 2))
          },
          {
            name: "ReadonlyMap size",
            schema: Schema.ReadonlyMap(Schema.String, Schema.Number).check(Schema.isSizeBetween(2, 4))
          }
        ]))

      it.effect("derives built-in and canonical declarations", () =>
        verifySchemaCatalog([
          { name: "Json", schema: Schema.Json },
          { name: "MutableJson", schema: Schema.MutableJson },
          { name: "Date", schema: Schema.Date },
          { name: "URL", schema: Schema.URL },
          { name: "URLSearchParams", schema: Schema.URLSearchParams },
          { name: "RegExp", schema: Schema.RegExp },
          { name: "Duration", schema: Schema.Duration },
          { name: "BigDecimal", schema: Schema.BigDecimal },
          { name: "DateTimeUtc", schema: Schema.DateTimeUtc },
          { name: "TimeZoneOffset", schema: Schema.TimeZoneOffset },
          { name: "TimeZoneNamed", schema: Schema.TimeZoneNamed },
          { name: "TimeZone", schema: Schema.TimeZone },
          { name: "DateTimeZoned", schema: Schema.DateTimeZoned },
          { name: "Uint8Array", schema: Schema.Uint8Array },
          { name: "UnknownFromJsonString", schema: Schema.UnknownFromJsonString },
          { name: "Option", schema: Schema.Option(Schema.String) },
          { name: "Result", schema: Schema.Result(Schema.Number, Schema.String) },
          { name: "ReadonlySet", schema: Schema.ReadonlySet(Schema.Number) },
          { name: "ReadonlyMap", schema: Schema.ReadonlyMap(Schema.String, Schema.Number) },
          { name: "HashSet", schema: Schema.HashSet(Schema.Number) },
          { name: "HashMap", schema: Schema.HashMap(Schema.String, Schema.Number) },
          { name: "Chunk", schema: Schema.Chunk(Schema.Number) },
          { name: "Redacted", schema: Schema.Redacted(Schema.String, { label: "password" }) },
          { name: "CauseReason", schema: Schema.CauseReason(Schema.String, Schema.String) },
          { name: "Cause", schema: Schema.Cause(Schema.String, Schema.String) },
          { name: "ErrorInstance", schema: Schema.ErrorInstance() },
          { name: "Exit", schema: Schema.Exit(Schema.Number, Schema.String, Schema.String) },
          { name: "File", schema: Schema.File },
          { name: "FormData", schema: Schema.FormData }
        ]))

      it("rejects uninhabited structural schemas", () => {
        assert.throws(() => Arbitrary.schema(Schema.Never), /Unable to derive an arbitrary for Never/)
        assert.throws(
          () => Arbitrary.schema(Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(1))),
          /Unable to derive an arbitrary for array constraints/
        )
        assert.throws(
          () =>
            Arbitrary.schema(
              Schema.Struct({ required: Schema.String }).check(Schema.isMaxProperties(0))
            ),
          /Unable to derive an arbitrary for object property constraints/
        )
      })
    })

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

    it.effect("uses the same recursive value for sampling and a single-run check", () =>
      Effect.gen(function*() {
        interface Node {
          readonly left: ReadonlyArray<Node | null>
          readonly right: ReadonlyArray<Node | null>
        }
        let Node!: Schema.Codec<Node>
        const child = Schema.Union([Schema.Null, Schema.suspend(() => Node)])
        const children = Schema.Array(child).check(Schema.isMinLength(1), Schema.isMaxLength(2))
        Node = Schema.Struct({ left: children, right: children })
        const arbitrary = Arbitrary.schema(Node)
        const sampled = yield* Arbitrary.sample(arbitrary, {
          count: 1,
          seed: "recursive-parity",
          size: 8
        })
        const checked: Array<Node> = []
        yield* Arbitrary.check(arbitrary, (value) => {
          checked.push(value)
          return true
        }, { runs: 1, seed: "recursive-parity", size: 8 })

        assert.deepStrictEqual(checked, sampled)
        const assertPropertyOrder = (node: Node | null): void => {
          if (node === null) return
          assert.deepStrictEqual(Object.keys(node), ["left", "right"])
          for (const child of node.left) assertPropertyOrder(child)
          for (const child of node.right) assertPropertyOrder(child)
        }
        assertPropertyOrder(sampled[0])
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

    it.effect("does not assign recursive depth according to sibling order", () =>
      Effect.gen(function*() {
        interface Node {
          readonly left: Node | null
          readonly right: Node | null
        }
        const Node: Schema.Codec<Node> = Schema.Struct({
          left: Schema.Union([Schema.Null, Schema.suspend(() => Node)]),
          right: Schema.Union([Schema.Null, Schema.suspend(() => Node)])
        })
        const values = yield* Arbitrary.sample(Arbitrary.schema(Node), {
          count: 2_000,
          maxDiscards: 0,
          seed: "recursive-sibling-order",
          size: 8
        })
        const countNodes = (root: Node | null): number => {
          if (root === null) return 0
          assert.deepStrictEqual(Object.keys(root), ["left", "right"])
          return 1 + countNodes(root.left) + countNodes(root.right)
        }
        let left = 0
        let right = 0
        for (const value of values) {
          left += countNodes(value.left)
          right += countNodes(value.right)
        }

        assert.isAbove(left, 0)
        assert.isAbove(right, 0)
        assert.isAtMost(Math.abs(left - right), (left + right) * 0.1)
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

    it.effect("starts progressive checks from a finite recursive base", () =>
      Effect.gen(function*() {
        interface Node {
          readonly next: Node | null
        }
        const Node: Schema.Codec<Node> = Schema.suspend(() =>
          Schema.Struct({
            next: Schema.Union([Schema.Null, Node])
          })
        )
        const result = yield* Arbitrary.check(Arbitrary.schema(Node), () => true, {
          runs: 2,
          maxDiscards: 0,
          seed: "recursive-base",
          size: 5
        })

        assert.deepStrictEqual(result, { _tag: "Passed", runs: 2, discards: 0 })
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

    it.effect("derives a five-thousand-node mutually recursive component without overflowing", () =>
      Effect.gen(function*() {
        const count = 5_000
        const schemas: Array<Schema.Codec<unknown>> = []
        const suspends = Array.from(
          { length: count },
          (_, index) => Schema.suspend((): Schema.Codec<unknown> => schemas[(index + 1) % count])
        )
        for (let index = 0; index < count; index++) {
          schemas.push(Schema.Union([Schema.Null, Schema.Struct({ next: suspends[index] })]))
        }

        const values = yield* Arbitrary.sample(Arbitrary.schema(schemas[0]), {
          count: 1,
          maxDiscards: 0,
          seed: "deep-mutual-recursion",
          size: 10
        })

        assert.strictEqual(values.length, 1)
      }))

    it.effect("derives and samples a ten-thousand-node suspend chain without overflowing", () =>
      Effect.gen(function*() {
        const values = yield* Arbitrary.sample(Arbitrary.schema(makeSuspendChain(10_000)), {
          count: 1,
          maxDiscards: 0,
          seed: "deep-suspend-chain"
        })

        assert.deepStrictEqual(values, [null])
      }))

    it("fails immediately for recursion without a finite path", () => {
      const Recursive = Schema.suspend((): Schema.Codec<unknown> => schema)
      const schema: Schema.Codec<unknown> = Schema.Struct({ value: Recursive })

      assert.throws(
        () => Arbitrary.schema(schema),
        /Unable to derive an arbitrary for a recursive schema without a finite generation path/
      )
    })

    it.effect("treats unproductive recursive union branches as empty", () =>
      Effect.gen(function*() {
        const Empty: Schema.Codec<unknown> = Schema.suspend(() => Schema.Struct({ value: Empty }))
        const values = yield* Arbitrary.sample(Arbitrary.schema(Schema.Union([Schema.Null, Empty])), {
          count: 10,
          maxDiscards: 0,
          seed: "empty-recursive-branch"
        })

        assert.deepStrictEqual(values, Array.from({ length: 10 }, () => null))
      }))

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

    it.effect("evaluates a residual filter once per generated value", () =>
      Effect.gen(function*() {
        let evaluations = 0
        const schema = Schema.Null.check(Schema.makeFilter(() => {
          evaluations++
          return true
        }))
        const result = yield* Arbitrary.check(Arbitrary.schema(schema), () => true, {
          runs: 1,
          seed: "single-filter-evaluation"
        })

        assert.deepStrictEqual(result, { _tag: "Passed", runs: 1, discards: 0 })
        assert.strictEqual(evaluations, 1)
      }))

    it.effect("interrupts a synchronous residual-filter generation loop", () =>
      Effect.gen(function*() {
        const schema = Schema.String.check(Schema.makeFilter(() => false, { expected: "impossible" }))
        const fiber = yield* Effect.forkChild(Arbitrary.sample(Arbitrary.schema(schema), {
          count: 1,
          maxDiscards: 100_000,
          seed: "interrupt-generation"
        }))

        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)

        assert.isTrue(Exit.hasInterrupts(exit))
      }))

    it.effect("interrupts a synchronous successful generation loop", () =>
      Effect.gen(function*() {
        const count = 100_001
        let generated = 0
        const started = yield* Deferred.make<void>()
        const schema = Schema.String.check(Schema.makeFilter(() => {
          generated++
          if (generated === 1) Deferred.doneUnsafe(started, Effect.void)
          return true
        }))
        const arbitrary = Arbitrary.schema(schema)
        generated = 0
        const fiber = yield* Effect.forkChild(
          Arbitrary.sample(arbitrary, {
            count,
            seed: "interrupt-successful-generation"
          }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16))
        )

        yield* Deferred.await(started)
        assert.isBelow(generated, count)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)

        assert.isTrue(Exit.hasInterrupts(exit))
      }))

    it.effect("interrupts deep suspended generation", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(makeSuspendChain(10_000))
        const fiber = yield* Effect.forkChild(Arbitrary.sample(arbitrary, {
          count: 1,
          maxDiscards: 0,
          seed: "interrupt-suspended-generation"
        }))

        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)

        assert.isTrue(Exit.hasInterrupts(exit))
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

    it.effect("grows size across successful runs without advancing on discards", () =>
      Effect.gen(function*() {
        type Node = null | { readonly next: Node }
        const Node: Schema.Codec<Node> = Schema.Union([
          Schema.Null.check(Schema.makeFilter(() => false, { expected: "discard" })),
          Schema.Null,
          Schema.Struct({ next: Schema.suspend(() => Node) })
        ])
        const inputs: Array<Node> = []
        const result = yield* Arbitrary.check(Arbitrary.schema(Node), (input) => {
          inputs.push(input)
          return true
        }, {
          runs: 100,
          size: 1,
          seed: "progressive-size"
        })

        assert.strictEqual(result._tag, "Passed")
        if (result._tag === "Passed") assert.isAbove(result.discards, 0)
        assert.isTrue(inputs.slice(0, 50).every((input) => input === null))
        assert.isTrue(inputs.slice(50).some((input) => input !== null))
      }))

    it.effect("shrinks integers to the local failure boundary", () =>
      Effect.gen(function*() {
        const result = yield* Arbitrary.check(
          Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
          (value) => value < 10,
          { runs: 100, seed: 0, size: 10 }
        )

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.strictEqual(result.counterexample, 10)
        }
      }))

    it.effect("shrinks bounded positive BigInts toward the minimum", () =>
      Effect.gen(function*() {
        const result = yield* Arbitrary.check(
          Arbitrary.schema(Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 100n, maximum: 1_000n }))),
          () => false,
          { runs: 1, seed: 21 }
        )

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.isTrue(result.initialInput > 100n)
          assert.strictEqual(result.counterexample, 100n)
        }
      }))

    it.effect("shrinks bounded BigInts to the local failure boundary", () =>
      Effect.gen(function*() {
        const result = yield* Arbitrary.check(
          Arbitrary.schema(Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 100n, maximum: 1_000n }))),
          (value) => value < 700n,
          { runs: 1, seed: 839 }
        )

        assert.strictEqual(result._tag, "Falsified")
        if (result._tag === "Falsified") {
          assert.strictEqual(result.initialInput, 775n)
          assert.strictEqual(result.counterexample, 700n)
        }
      }))

    it.effect("selects the closest-to-zero BigInt shrink target", () =>
      Effect.gen(function*() {
        const cases = [
          { minimum: -1_000n, maximum: -100n, target: -100n },
          { minimum: -1_000n, maximum: 1_000n, target: 0n }
        ] as const
        for (const { maximum, minimum, target } of cases) {
          const result = yield* Arbitrary.check(
            Arbitrary.schema(Schema.BigInt.check(Schema.isBetweenBigInt({ minimum, maximum }))),
            () => false,
            { runs: 1, seed: 21 }
          )

          assert.strictEqual(result._tag, "Falsified")
          if (result._tag === "Falsified") {
            assert.notStrictEqual(result.initialInput, target)
            assert.strictEqual(result.counterexample, target)
          }
        }
      }))

    it.effect("shrinks Numbers to the local representable failure boundary", () =>
      Effect.gen(function*() {
        const result = yield* Arbitrary.check(
          Arbitrary.schema(Schema.Number.check(Schema.isBetween({ minimum: 2, maximum: 4 }))),
          (value) => value < 3,
          { runs: 100, seed: 1, size: 10 }
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
          seed: 231,
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
        assert.strictEqual(first.runs, 1)
        assert.strictEqual(typeof first.replay, "string")

        const replay = `${first.replay}`
        const replayed = yield* Arbitrary.check(arbitrary, (value) => value < 0, { replay })
        assert.strictEqual(replayed._tag, "Falsified")
        if (replayed._tag !== "Falsified") return
        assert.strictEqual(replayed.runs, 1)
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
        const first = yield* Arbitrary.check(arbitrary, () => false, { runs: 1, seed: 1, size: 3 })
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

    it.effect("traverses a thousand lazy child shrinks without overflowing", () =>
      Effect.gen(function*() {
        const count = 1_000
        const schema = Schema.Array(Schema.Int).check(Schema.isMinLength(count), Schema.isMaxLength(count))
        let evaluations = 0
        const result = yield* Arbitrary.check(Arbitrary.schema(schema), () => {
          evaluations++
          return evaluations !== 1
        }, { runs: 1, seed: "wide-shrink", size: count, maxShrinks: count })

        assert.strictEqual(result._tag, "Falsified")
        assert.strictEqual(evaluations, count + 1)
      }))

    it.effect("propagates interruption while shrinking", () =>
      Effect.gen(function*() {
        const shrinking = yield* Deferred.make<void>()
        let evaluations = 0
        const fiber = yield* Effect.forkChild(Arbitrary.check(
          Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))),
          () => {
            evaluations++
            return evaluations === 1
              ? false
              : Deferred.succeed(shrinking, undefined).pipe(Effect.andThen(Effect.never))
          },
          { runs: 1, seed: 139, size: 10 }
        ))

        yield* Deferred.await(shrinking)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)

        assert.strictEqual(evaluations, 2)
        assert.isTrue(Exit.hasInterrupts(exit))
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

    it.effect("requires an explicit true result from pure and Effectful properties", () =>
      Effect.gen(function*() {
        const arbitrary = Arbitrary.schema(Schema.Literal("value"))
        const pureProperty = (() => 1) as unknown as () => boolean
        const effectfulProperty = (() => Effect.succeed("yes")) as unknown as () => Effect.Effect<boolean>

        const pure = yield* Arbitrary.check(arbitrary, pureProperty, { runs: 1, seed: "pure-truthy" })
        const effectful = yield* Arbitrary.check(arbitrary, effectfulProperty, { runs: 1, seed: "effectful-truthy" })

        assert.strictEqual(pure._tag, "Falsified")
        assert.strictEqual(effectful._tag, "Falsified")
        if (pure._tag === "Falsified") assert.deepStrictEqual(pure.failure, { _tag: "ReturnedFalse" })
        if (effectful._tag === "Falsified") assert.deepStrictEqual(effectful.failure, { _tag: "ReturnedFalse" })
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
