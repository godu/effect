import * as Schema from "effect/Schema"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

const Name = Schema.NonEmptyString.annotate({
  arbitrary: () => Arbitrary.schema(Schema.Literals(["Ada", "Grace"]))
})

export const arbitrary = Arbitrary.schema(Schema.Struct({
  name: Name,
  age: Schema.Int
}))
