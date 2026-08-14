import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"
import assert from "node:assert/strict"
import {
  makeBigDecimalSchema,
  makeConstrainedStringSchema,
  makeDateTimeUtcSchema,
  makeDateTimeZonedSchema,
  makeRareFilterSchema,
  makeTreeSchema,
  makeUniqueArraySchema,
  validateNumbers,
  validateSchemaValues,
  validateStrings,
  validateTrees,
  validateUint8Arrays
} from "./schema.ts"

const seed = 42
const size = 10

export const coldRecursiveFirstSample = () => ({
  run: () =>
    Effect.runSync(
      Arbitrary.sample(Arbitrary.schema(makeTreeSchema()), { count: 1, seed, size: 1 })
    ),
  validate: validateTrees(1, 2, 2)
})

export const recursiveSample32 = () => {
  const arbitrary = Arbitrary.schema(makeTreeSchema())
  const program = Arbitrary.sample(arbitrary, { count: 32, seed, size: 3 })
  return {
    run: () => Effect.runSync(program),
    validate: validateTrees(32, 90, 110)
  }
}

export const constrainedStringSample128 = () => {
  const arbitrary = Arbitrary.schema(makeConstrainedStringSchema())
  const program = Arbitrary.sample(arbitrary, { count: 128, maxDiscards: 0, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: validateStrings(128)
  }
}

export const boundedNumberSample128 = () => {
  const arbitrary = Arbitrary.schema(Schema.Number.check(Schema.isBetween({ minimum: 2, maximum: 4 })))
  const program = Arbitrary.sample(arbitrary, { count: 128, maxDiscards: 0, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: validateNumbers(128)
  }
}

export const uint8ArraySample128 = () => {
  const arbitrary = Arbitrary.schema(Schema.Uint8Array)
  const program = Arbitrary.sample(arbitrary, { count: 128, maxDiscards: 0, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: validateUint8Arrays(128)
  }
}

export const bigDecimalSample128 = () => {
  const schema = makeBigDecimalSchema()
  const arbitrary = Arbitrary.schema(schema)
  const program = Arbitrary.sample(arbitrary, { count: 128, maxDiscards: 0, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: validateSchemaValues(schema, 128)
  }
}

export const dateTimeUtcSample128 = () => {
  const schema = makeDateTimeUtcSchema()
  const arbitrary = Arbitrary.schema(schema)
  const program = Arbitrary.sample(arbitrary, { count: 128, maxDiscards: 0, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: validateSchemaValues(schema, 128)
  }
}

export const timeZoneNamedSample128 = () => {
  const arbitrary = Arbitrary.schema(Schema.TimeZoneNamed)
  const program = Arbitrary.sample(arbitrary, { count: 128, maxDiscards: 0, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: validateSchemaValues(Schema.TimeZoneNamed, 128)
  }
}

export const timeZoneSample128 = () => {
  const arbitrary = Arbitrary.schema(Schema.TimeZone)
  const program = Arbitrary.sample(arbitrary, { count: 128, maxDiscards: 0, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: validateSchemaValues(Schema.TimeZone, 128)
  }
}

export const dateTimeZonedSample128 = () => {
  const schema = makeDateTimeZonedSchema()
  const arbitrary = Arbitrary.schema(schema)
  const program = Arbitrary.sample(arbitrary, { count: 128, maxDiscards: 0, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: validateSchemaValues(schema, 128)
  }
}

export const rareFilterSample32 = () => {
  const arbitrary = Arbitrary.schema(makeRareFilterSchema())
  const program = Arbitrary.sample(arbitrary, { count: 32, maxDiscards: 2_048, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: (values: ReadonlyArray<number>) => {
      assert.equal(values.length, 32)
      assert.equal(values.every((value) => value % 16 === 0), true)
    }
  }
}

export const uniqueArraySample32 = () => {
  const arbitrary = Arbitrary.schema(makeUniqueArraySchema())
  const program = Arbitrary.sample(arbitrary, { count: 32, maxDiscards: 2_048, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: (values: ReadonlyArray<ReadonlyArray<number>>) => {
      assert.equal(values.length, 32)
      assert.equal(values.every((value) => value.length === 32 && new Set(value).size === 32), true)
    }
  }
}

export const literalSample128 = () => {
  const arbitrary = Arbitrary.schema(Schema.Literal("value"))
  const program = Arbitrary.sample(arbitrary, { count: 128, maxDiscards: 0, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: (values: ReadonlyArray<unknown>) => {
      assert.equal(values.length, 128)
      assert.equal(values.every((value) => value === "value"), true)
    }
  }
}

export const checkPass100 = () => {
  const arbitrary = Arbitrary.schema(Schema.Int)
  const program = Arbitrary.check(arbitrary, () => true, { runs: 100, seed, size })
  return {
    run: () => Effect.runSync(program),
    validate: (result: Arbitrary.CheckResult<number, never>) => {
      assert.deepEqual(result, { _tag: "Passed", runs: 100, discards: 0 })
    }
  }
}

export const checkFalsifyAndShrink = () => {
  const arbitrary = Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))
  )
  const program = Arbitrary.check(arbitrary, (value) => value < 0, { runs: 1, seed: 139, size })
  return {
    run: () => Effect.runSync(program),
    validate: (result: Arbitrary.CheckResult<number, never>) => {
      assert.equal(result._tag, "Falsified")
      if (result._tag !== "Falsified") return
      assert.equal(result.initialInput, 1_000)
      assert.equal(result.counterexample, 1)
      assert.equal(result.shrinks, 1)
    }
  }
}

export const checkReplay = () => {
  const arbitrary = Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))
  )
  const property = (value: number) => value < 0
  const initial = Effect.runSync(Arbitrary.check(arbitrary, property, { runs: 1, seed: 139, size }))
  assert.equal(initial._tag, "Falsified")
  if (initial._tag !== "Falsified") throw new Error("Expected the replay setup to falsify")
  const program = Arbitrary.check(arbitrary, property, { replay: initial.replay })
  return {
    run: () => Effect.runSync(program),
    validate: (result: Arbitrary.CheckResult<number, never>) => {
      assert.equal(result._tag, "Falsified")
      if (result._tag !== "Falsified") return
      assert.equal(result.initialInput, 1_000)
      assert.equal(result.counterexample, 1)
      assert.equal(result.shrinks, 1)
    }
  }
}
