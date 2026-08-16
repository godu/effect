import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const integers = Arbitrary.schema(Schema.Int)

export const arbitrary = Arbitrary.Union([
  integers.pipe(Arbitrary.map((value) => value + 1)),
  integers.pipe(Arbitrary.filter((value) => value >= 0)),
  integers.pipe(Arbitrary.filterMap((value) => value === 0 ? Result.fail(value) : Result.succeed(value)))
])
