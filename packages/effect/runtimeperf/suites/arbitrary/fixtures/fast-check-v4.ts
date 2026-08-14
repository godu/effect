import * as Schema from "effect/Schema"
import * as FastCheck from "effect/testing/FastCheck"
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

export const coldRecursiveFirstSample = () => ({
  run: () => FastCheck.sample(Schema.toArbitrary(makeTreeSchema())(FastCheck), { numRuns: 1, seed }),
  validate: validateTrees(1, 2, 2)
})

export const recursiveSample32 = () => {
  const arbitrary = Schema.toArbitrary(makeTreeSchema())(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 32, seed }),
    validate: validateTrees(32, 90, 110)
  }
}

export const constrainedStringSample128 = () => {
  const arbitrary = Schema.toArbitrary(makeConstrainedStringSchema())(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 128, seed }),
    validate: validateStrings(128)
  }
}

export const boundedNumberSample128 = () => {
  const arbitrary = Schema.toArbitrary(
    Schema.Number.check(Schema.isBetween({ minimum: 2, maximum: 4 }))
  )(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 128, seed }),
    validate: validateNumbers(128)
  }
}

export const uint8ArraySample128 = () => {
  const arbitrary = Schema.toArbitrary(Schema.Uint8Array)(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 128, seed }),
    validate: validateUint8Arrays(128)
  }
}

export const bigDecimalSample128 = () => {
  const schema = makeBigDecimalSchema()
  const arbitrary = Schema.toArbitrary(schema)(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 128, seed }),
    validate: validateSchemaValues(schema, 128)
  }
}

export const dateTimeUtcSample128 = () => {
  const schema = makeDateTimeUtcSchema()
  const arbitrary = Schema.toArbitrary(schema)(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 128, seed }),
    validate: validateSchemaValues(schema, 128)
  }
}

export const timeZoneNamedSample128 = () => {
  const arbitrary = Schema.toArbitrary(Schema.TimeZoneNamed)(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 128, seed }),
    validate: validateSchemaValues(Schema.TimeZoneNamed, 128)
  }
}

export const timeZoneSample128 = () => {
  const arbitrary = Schema.toArbitrary(Schema.TimeZone)(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 128, seed }),
    validate: validateSchemaValues(Schema.TimeZone, 128)
  }
}

export const dateTimeZonedSample128 = () => {
  const schema = makeDateTimeZonedSchema()
  const arbitrary = Schema.toArbitrary(schema)(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 128, seed }),
    validate: validateSchemaValues(schema, 128)
  }
}

export const rareFilterSample32 = () => {
  const arbitrary = Schema.toArbitrary(makeRareFilterSchema())(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 32, seed }),
    validate: (values: ReadonlyArray<number>) => {
      assert.equal(values.length, 32)
      assert.equal(values.every((value) => value % 16 === 0), true)
    }
  }
}

export const uniqueArraySample32 = () => {
  const arbitrary = Schema.toArbitrary(makeUniqueArraySchema())(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 32, seed }),
    validate: (values: ReadonlyArray<ReadonlyArray<number>>) => {
      assert.equal(values.length, 32)
      assert.equal(values.every((value) => value.length === 32 && new Set(value).size === 32), true)
    }
  }
}

export const literalSample128 = () => {
  const arbitrary = Schema.toArbitrary(Schema.Literal("value"))(FastCheck)
  return {
    run: () => FastCheck.sample(arbitrary, { numRuns: 128, seed }),
    validate: (values: ReadonlyArray<unknown>) => {
      assert.equal(values.length, 128)
      assert.equal(values.every((value) => value === "value"), true)
    }
  }
}

export const checkPass100 = () => {
  const arbitrary = Schema.toArbitrary(Schema.Int)(FastCheck)
  const property = FastCheck.property(arbitrary, () => true)
  return {
    run: () => FastCheck.check(property, { numRuns: 100, seed }),
    validate: (result: FastCheck.RunDetails<[number]>) => {
      assert.equal(result.failed, false)
      assert.equal(result.numRuns, 100)
      assert.equal(result.numSkips, 0)
    }
  }
}

export const testSchemaVerifyGeneration100 = () => ({
  run: () => {
    const schema = Schema.Int
    const arbitrary = Schema.toArbitrary(schema)(FastCheck)
    FastCheck.assert(FastCheck.property(arbitrary, Schema.is(schema)), { numRuns: 100, seed })
  },
  validate: (result: void) => assert.equal(result, undefined)
})

export const checkFalsifyAndShrink = () => {
  const arbitrary = Schema.toArbitrary(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))
  )(FastCheck)
  const property = FastCheck.property(arbitrary, (value) => value < 0)
  return {
    run: () => FastCheck.check(property, { examples: [[1_000]], numRuns: 1, seed }),
    validate: (result: FastCheck.RunDetails<[number]>) => {
      assert.equal(result.failed, true)
      assert.deepEqual(result.counterexample, [1])
      assert.equal(result.numShrinks, 1)
    }
  }
}

export const checkReplay = () => {
  const arbitrary = Schema.toArbitrary(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))
  )(FastCheck)
  const property = FastCheck.property(arbitrary, (value) => value < 0)
  const initial = FastCheck.check(property, { examples: [[1_000]], numRuns: 1, seed })
  assert.equal(initial.failed, true)
  return {
    run: () => FastCheck.check(property, { numRuns: 1, seed: initial.seed, path: initial.counterexamplePath }),
    validate: (result: FastCheck.RunDetails<[number]>) => {
      assert.equal(result.failed, true)
      assert.deepEqual(result.counterexample, [1])
      assert.equal(result.numShrinks, 0)
    }
  }
}
