import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export interface Tree {
  readonly label: string
  readonly score: Option.Option<number>
  readonly children: ReadonlyArray<Tree>
}

export const makeTreeSchema = (): Schema.Codec<Tree> => {
  const Tree: Schema.Codec<Tree> = Schema.Struct({
    label: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(12)),
    score: Schema.Option(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
    children: Schema.Array(Schema.suspend(() => Tree)).check(Schema.isMaxLength(3))
  })
  return Tree
}

export const makeConstrainedStringSchema = () => Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(32))

export const makeRareFilterSchema = () =>
  Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 255 }),
    Schema.makeFilter((value: number) => value % 16 === 0)
  )

export const makeUniqueArraySchema = () =>
  Schema.UniqueArray(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_023 }))).check(
    Schema.isMinLength(32),
    Schema.isMaxLength(32)
  )
