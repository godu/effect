import { type Effect, hole, Schema, type SchemaAST } from "effect"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"
import { describe, expect, it } from "tstyche"

describe("Arbitrary", () => {
  it("schema preserves the decoded type", () => {
    const schema = Schema.Struct({ value: Schema.String })
    type A = typeof schema.Type

    expect(Arbitrary.schema(schema)).type.toBe<Arbitrary.Arbitrary<A>>()
    expect(Arbitrary.sample(Arbitrary.schema(schema))).type.toBe<
      Effect.Effect<ReadonlyArray<A>, Arbitrary.SampleError>
    >()
  })

  it("check preserves property errors and requirements", () => {
    const arbitrary = Arbitrary.schema(Schema.String)
    const property = hole<(value: string) => Effect.Effect<boolean, "error", "service">>()

    expect(Arbitrary.check(arbitrary, property)).type.toBe<
      Effect.Effect<Arbitrary.CheckResult<string, "error">, never, "service">
    >()
  })

  it("types toCodecArbitrary inputs from the declaration target and decoded type parameters", () => {
    interface Box {
      readonly value: number
    }

    Schema.declareConstructor<Box>()(
      [Schema.NumberFromString],
      hole(),
      {
        toCodecArbitrary: (input) => {
          expect(input.typeParameters).type.toBe<readonly [Schema.Codec<number>]>()
          expect(input.constraint).type.toBe<
            Schema.Annotations.ToCodecArbitrary.GenerationConstraint<Box> | undefined
          >()
          return hole<SchemaAST.Link>()
        }
      }
    )
  })
})
