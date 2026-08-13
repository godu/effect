import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary"

interface Tree {
  readonly label: string
  readonly score: Option.Option<number>
  readonly children: ReadonlyArray<Tree>
}

const Tree: Schema.Codec<Tree> = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(12)),
  score: Schema.Option(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  children: Schema.Array(Schema.suspend(() => Tree)).check(Schema.isMaxLength(3))
})

export const arbitrary = Arbitrary.schema(Tree)
