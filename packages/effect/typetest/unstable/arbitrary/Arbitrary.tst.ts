import { type Effect, hole, Result, Schema, type SchemaAST } from "effect"
import type * as BigDecimal from "effect/BigDecimal"
import type * as DateTime from "effect/DateTime"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"
import { describe, expect, it } from "tstyche"

describe("Arbitrary", () => {
  it("identifies Arbitrary values", () => {
    expect(Arbitrary.isArbitrary).type.toBe<(u: unknown) => u is Arbitrary.Arbitrary<unknown>>()
  })

  it("schema preserves the decoded type", () => {
    const schema = Schema.Struct({ value: Schema.String })
    type A = typeof schema.Type

    expect(Arbitrary.schema(schema)).type.toBe<Arbitrary.Arbitrary<A>>()
    expect(Arbitrary.sampleEffect(Arbitrary.schema(schema))).type.toBe<
      Effect.Effect<ReadonlyArray<A>, Arbitrary.SampleError>
    >()
  })

  it("checkEffect preserves property errors and requirements", () => {
    const arbitrary = Arbitrary.schema(Schema.String)
    const property = hole<(value: string) => Effect.Effect<boolean, "error", "service">>()

    expect(Arbitrary.checkEffect(arbitrary, property)).type.toBe<
      Effect.Effect<Arbitrary.CheckResult<string, "error">, never, "service">
    >()
  })

  it("composes Arbitraries", () => {
    const strings = Arbitrary.schema(Schema.String)
    const stringOrNumber = Arbitrary.schema(Schema.Union([Schema.String, Schema.Number]))

    expect(Arbitrary.map(strings, (value) => value.length)).type.toBe<Arbitrary.Arbitrary<number>>()
    expect(Arbitrary.map((value: string) => value.length)(strings)).type.toBe<Arbitrary.Arbitrary<number>>()
    expect(strings.pipe(Arbitrary.map((value) => value.length))).type.toBe<Arbitrary.Arbitrary<number>>()
    expect(Arbitrary.filter(stringOrNumber, (value): value is string => typeof value === "string")).type.toBe<
      Arbitrary.Arbitrary<string>
    >()
    expect(
      Arbitrary.filter((value: string | number) => typeof value === "string")(stringOrNumber)
    ).type.toBe<Arbitrary.Arbitrary<string>>()
    expect(
      Arbitrary.filterMap(
        strings,
        (value) => value.length === 0 ? Result.fail("empty" as const) : Result.succeed(value.length)
      )
    ).type.toBe<Arbitrary.Arbitrary<number>>()
    expect(
      Arbitrary.Union([
        strings,
        Arbitrary.schema(Schema.Number)
      ])
    ).type.toBe<Arbitrary.Arbitrary<string | number>>()
  })

  it("types the Schema-local arbitrary annotation from the decoded type", () => {
    const strings = Arbitrary.schema(Schema.String)
    const annotated = Schema.NonEmptyString.annotate({ arbitrary: () => strings })

    expect(Schema.resolveAnnotations(annotated)?.arbitrary).type.toBe<
      (() => Arbitrary.Arbitrary<string>) | undefined
    >()

    // @ts-expect-error Type 'Arbitrary<number>'
    Schema.String.annotate({ arbitrary: () => Arbitrary.schema(Schema.Number) })
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
          expect(input.schemas).type.toBe<Schema.Annotations.ToCodecArbitrary.Schemas>()
          expect(input.schemas.Array).type.toBe<
            <S extends Schema.Constraint>(
              item: S,
              options?: Schema.Annotations.ToCodecArbitrary.ArrayOptions<S["Type"]>
            ) => Schema.$Array<S>
          >()
          expect(input.schemas.Date).type.toBe<
            (
              constraint: Schema.Annotations.ToCodecArbitrary.GenerationConstraint<Date> | undefined
            ) => Schema.Codec<number>
          >()
          expect(input.schemas.BigDecimal).type.toBe<
            (
              constraint:
                | Schema.Annotations.ToCodecArbitrary.GenerationConstraint<BigDecimal.BigDecimal>
                | undefined
            ) => Schema.Codec<{ readonly value: bigint; readonly scale: number }>
          >()
          expect(input.schemas.DateTimeUtc).type.toBe<
            (
              constraint: Schema.Annotations.ToCodecArbitrary.GenerationConstraint<DateTime.Utc> | undefined
            ) => Schema.Codec<number>
          >()
          expect(input.schemas.TimeZoneNamed).type.toBe<
            (
              constraint:
                | Schema.Annotations.ToCodecArbitrary.GenerationConstraint<DateTime.TimeZone.Named>
                | undefined
            ) => Schema.Codec<string>
          >()
          expect(input.schemas.TimeZone).type.toBe<
            (
              constraint: Schema.Annotations.ToCodecArbitrary.GenerationConstraint<DateTime.TimeZone> | undefined
            ) => Schema.Codec<number | string>
          >()
          expect(input.schemas.DateTimeZoned).type.toBe<
            (
              constraint: Schema.Annotations.ToCodecArbitrary.GenerationConstraint<DateTime.Zoned> | undefined
            ) => Schema.Codec<{ readonly epochMilliseconds: number; readonly timeZone: number | string }>
          >()
          return hole<SchemaAST.Link>()
        }
      }
    )
  })
})
