import * as BigDecimal from "../../BigDecimal.ts"
import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import * as Option from "../../Option.ts"
import * as Order from "../../Order.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import { errorWithPath } from "../errors.ts"
import * as InternalRecord from "../record.ts"
import * as Model from "./model.ts"
import * as Regexp from "./regexp.ts"

type Constraint = Schema.Annotations.ToCodecArbitrary.Constraint<any>
type GenerationConstraint = Schema.Annotations.ToCodecArbitrary.GenerationConstraint<any>
type Schemas = Schema.Annotations.ToCodecArbitrary.Schemas

interface Checks {
  readonly constraint: Constraint | undefined
  readonly filters: ReadonlyArray<SchemaAST.Filter<any>>
}

const infinity = Number.POSITIVE_INFINITY
const finiteNumberConstraint: Constraint = { number: "finite" }

function arbitraryError(what: string, path: ReadonlyArray<PropertyKey>) {
  return errorWithPath(`Unable to derive an arbitrary for ${what}`, path)
}

function sumCosts(costs: Iterable<number>): number {
  let out = 0
  for (const cost of costs) {
    if (cost === infinity) return infinity
    out += cost
  }
  return out
}

function mergeOrderedBound<T>(
  order: Order.Order<T>,
  self: T | undefined,
  selfExclusive: boolean | undefined,
  that: T | undefined,
  thatExclusive: boolean | undefined,
  takeComparison: -1 | 1
): readonly [T | undefined, boolean | undefined] {
  if (that === undefined || self === undefined) {
    return that === undefined ? [self, selfExclusive] : [that, thatExclusive]
  }
  const comparison = order(self, that)
  return comparison === takeComparison
    ? [that, thatExclusive]
    : comparison === 0
    ? [self, selfExclusive || thatExclusive]
    : [self, selfExclusive]
}

function mergeConstraint(self: Constraint | undefined, that: Constraint): Constraint {
  const order = that.order ?? self?.order
  if (self?.order !== undefined && that.order !== undefined && self.order !== that.order) {
    throw new Error("Cannot merge ordered arbitrary constraints with different Order instances")
  }
  const [minimum, exclusiveMinimum] = order === undefined
    ? [that.minimum ?? self?.minimum, that.exclusiveMinimum ?? self?.exclusiveMinimum]
    : mergeOrderedBound(
      order,
      self?.minimum,
      self?.exclusiveMinimum,
      that.minimum,
      that.exclusiveMinimum,
      -1
    )
  const [maximum, exclusiveMaximum] = order === undefined
    ? [that.maximum ?? self?.maximum, that.exclusiveMaximum ?? self?.exclusiveMaximum]
    : mergeOrderedBound(
      order,
      self?.maximum,
      self?.exclusiveMaximum,
      that.maximum,
      that.exclusiveMaximum,
      1
    )
  const mergeMinimum = (
    key: "minLength" | "minSize" | "minProperties"
  ): number | undefined =>
    self?.[key] === undefined
      ? that[key]
      : that[key] === undefined
      ? self[key]
      : Math.max(self[key], that[key])
  const mergeMaximum = (
    key: "maxLength" | "maxSize" | "maxProperties"
  ): number | undefined =>
    self?.[key] === undefined
      ? that[key]
      : that[key] === undefined
      ? self[key]
      : Math.min(self[key], that[key])
  const minLength = mergeMinimum("minLength")
  const maxLength = mergeMaximum("maxLength")
  const minSize = mergeMinimum("minSize")
  const maxSize = mergeMaximum("maxSize")
  const minProperties = mergeMinimum("minProperties")
  const maxProperties = mergeMaximum("maxProperties")
  const patterns = self?.patterns === undefined
    ? that.patterns
    : that.patterns === undefined
    ? self.patterns
    : [...self.patterns, ...that.patterns] as [
      Schema.Annotations.ToCodecArbitrary.Pattern,
      ...Array<Schema.Annotations.ToCodecArbitrary.Pattern>
    ]
  const number = self?.number === "integer" || that.number === "integer"
    ? "integer"
    : self?.number === "finite" || that.number === "finite"
    ? "finite"
    : undefined
  return {
    ...(order === undefined ? undefined : { order }),
    ...(minimum === undefined ? undefined : { minimum }),
    ...(exclusiveMinimum === true ? { exclusiveMinimum: true } : undefined),
    ...(maximum === undefined ? undefined : { maximum }),
    ...(exclusiveMaximum === true ? { exclusiveMaximum: true } : undefined),
    ...(minLength === undefined ? undefined : { minLength }),
    ...(maxLength === undefined ? undefined : { maxLength }),
    ...(minSize === undefined ? undefined : { minSize }),
    ...(maxSize === undefined ? undefined : { maxSize }),
    ...(minProperties === undefined ? undefined : { minProperties }),
    ...(maxProperties === undefined ? undefined : { maxProperties }),
    ...(patterns === undefined ? undefined : { patterns }),
    ...(number === undefined ? undefined : { number }),
    ...(self?.unique === true || that.unique === true ? { unique: true } : undefined)
  }
}

function collectChecks(checks: SchemaAST.Checks | undefined, inherited: Constraint | undefined): Checks {
  let constraint = inherited
  const filters: Array<SchemaAST.Filter<any>> = []
  const visit = (check: SchemaAST.Check<any>): void => {
    const next = check.annotations?.toCodecArbitrary?.constraint
    if (next !== undefined) constraint = mergeConstraint(constraint, next)
    if (check._tag === "Filter") {
      filters.push(check)
    } else {
      check.checks.forEach(visit)
    }
  }
  checks?.forEach(visit)
  return { constraint, filters }
}

function validateConstraint(constraint: Constraint | undefined, path: ReadonlyArray<PropertyKey>): void {
  if (constraint === undefined) return
  const cardinalities = [
    [constraint.minLength, constraint.maxLength],
    [constraint.minSize, constraint.maxSize],
    [constraint.minProperties, constraint.maxProperties]
  ] as const
  for (const [minimum, maximum] of cardinalities) {
    if (
      minimum !== undefined && (!Number.isSafeInteger(minimum) || minimum < 0) ||
      maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0) ||
      minimum !== undefined && maximum !== undefined && minimum > maximum
    ) {
      throw arbitraryError("constraints", path)
    }
  }
  if (constraint.order !== undefined && constraint.minimum !== undefined && constraint.maximum !== undefined) {
    const comparison = constraint.order(constraint.minimum, constraint.maximum)
    if (
      comparison > 0 ||
      comparison === 0 && (constraint.exclusiveMinimum === true || constraint.exclusiveMaximum === true)
    ) {
      throw arbitraryError("constraints", path)
    }
  }
}

function withoutOrder(constraint: Constraint | undefined): GenerationConstraint | undefined {
  if (constraint === undefined) return undefined
  const { order: _, ...out } = constraint
  return Object.keys(out).length === 0 ? undefined : out
}

const minimumDateTimestamp = -8_640_000_000_000_000
const maximumDateTimestamp = 8_640_000_000_000_000
const minimumZonedDateTimeTimestamp = minimumDateTimestamp + 14 * 60 * 60 * 1000
const maximumZonedDateTimeTimestamp = maximumDateTimestamp - 14 * 60 * 60 * 1000
const bigDecimalDefaultMaxScale = 20
const minimumTimeZoneOffset = -12 * 60 * 60 * 1000
const maximumTimeZoneOffset = 14 * 60 * 60 * 1000
const namedTimeZones = ["UTC", "Europe/London", "America/New_York", "Asia/Tokyo", "Australia/Sydney"] as const

function integerSchema(minimum: number, maximum: number): Schema.Codec<number> {
  return Schema.Int.check(Schema.isBetween({ minimum, maximum }))
}

function bigIntSchema(minimum: bigint | undefined, maximum: bigint | undefined): Schema.Codec<bigint> {
  if (minimum !== undefined && maximum !== undefined) {
    return Schema.BigInt.check(Schema.isBetweenBigInt({ minimum, maximum }))
  }
  if (minimum !== undefined) return Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(minimum))
  if (maximum !== undefined) return Schema.BigInt.check(Schema.isLessThanOrEqualToBigInt(maximum))
  return Schema.BigInt
}

function bigDecimalValueAtScale(value: BigDecimal.BigDecimal, scale: number): bigint {
  return BigDecimal.scale(value, scale).value
}

function bigDecimalMinimumAtScale(
  minimum: BigDecimal.BigDecimal,
  scale: number,
  exclusive: boolean
): bigint {
  return exclusive
    ? bigDecimalValueAtScale(BigDecimal.floor(minimum, scale), scale) + globalThis.BigInt(1)
    : bigDecimalValueAtScale(BigDecimal.ceil(minimum, scale), scale)
}

function bigDecimalMaximumAtScale(
  maximum: BigDecimal.BigDecimal,
  scale: number,
  exclusive: boolean
): bigint {
  return exclusive
    ? bigDecimalValueAtScale(BigDecimal.ceil(maximum, scale), scale) - globalThis.BigInt(1)
    : bigDecimalValueAtScale(BigDecimal.floor(maximum, scale), scale)
}

function bigDecimalSchema(
  constraint: Schema.Annotations.ToCodecArbitrary.GenerationConstraint<BigDecimal.BigDecimal> | undefined
): Schema.Codec<{ readonly value: bigint; readonly scale: number }> {
  if (constraint?.minimum === undefined && constraint?.maximum === undefined) {
    return Schema.Struct({
      value: Schema.BigInt,
      scale: integerSchema(0, bigDecimalDefaultMaxScale)
    })
  }
  const scale = Math.max(
    bigDecimalDefaultMaxScale,
    constraint.minimum?.scale ?? 0,
    constraint.maximum?.scale ?? 0,
    constraint.exclusiveMinimum === true && constraint.minimum !== undefined ? constraint.minimum.scale + 1 : 0,
    constraint.exclusiveMaximum === true && constraint.maximum !== undefined ? constraint.maximum.scale + 1 : 0
  )
  const minimum = constraint.minimum === undefined
    ? undefined
    : bigDecimalMinimumAtScale(constraint.minimum, scale, constraint.exclusiveMinimum === true)
  const maximum = constraint.maximum === undefined
    ? undefined
    : bigDecimalMaximumAtScale(constraint.maximum, scale, constraint.exclusiveMaximum === true)
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    return Schema.Struct({
      value: Schema.BigInt,
      scale: integerSchema(0, bigDecimalDefaultMaxScale)
    })
  }
  return Schema.Struct({ value: bigIntSchema(minimum, maximum), scale: Schema.Literal(scale) })
}

function dateTimeBounds<T extends { readonly epochMilliseconds: number }>(
  constraint: Schema.Annotations.ToCodecArbitrary.GenerationConstraint<T> | undefined,
  domainMinimum: number,
  domainMaximum: number
): readonly [minimum: number, maximum: number] {
  const minimum = Math.max(
    domainMinimum,
    constraint?.minimum === undefined
      ? domainMinimum
      : constraint.minimum.epochMilliseconds + (constraint.exclusiveMinimum === true ? 1 : 0)
  )
  const maximum = Math.min(
    domainMaximum,
    constraint?.maximum === undefined
      ? domainMaximum
      : constraint.maximum.epochMilliseconds - (constraint.exclusiveMaximum === true ? 1 : 0)
  )
  return minimum <= maximum ? [minimum, maximum] : [domainMinimum, domainMaximum]
}

function namedTimeZoneSchema(): Schema.Codec<string> {
  return Schema.Literals(namedTimeZones)
}

function timeZoneSchema(): Schema.Codec<number | string> {
  return Schema.Union([integerSchema(minimumTimeZoneOffset, maximumTimeZoneOffset), namedTimeZoneSchema()])
}

const schemas: Schemas = {
  Json: () => {
    let schema: Schema.Codec<Schema.Json>
    schema = Schema.Union([
      Schema.Null,
      Schema.Finite,
      Schema.Boolean,
      Schema.String,
      Schema.Array(Schema.suspend(() => schema)),
      Schema.Record(Schema.String, Schema.suspend(() => schema))
    ]) as Schema.Codec<Schema.Json>
    return schema
  },
  RegExp: () =>
    Schema.Struct({
      source: Schema.Literals([
        "",
        ".",
        ".*",
        "\\d+",
        "\\w+",
        "[a-z]+",
        "[A-Z]+",
        "[0-9]+",
        "^[a-zA-Z0-9]+$",
        "^\\d{4}-\\d{2}-\\d{2}$"
      ]),
      flags: Schema.Struct({
        g: Schema.Boolean,
        i: Schema.Boolean,
        m: Schema.Boolean,
        s: Schema.Boolean,
        u: Schema.Boolean,
        y: Schema.Boolean
      })
    }),
  URL: () =>
    Schema.Struct({
      protocol: Schema.Literals(["http", "https"]),
      label: Schema.String.check(Schema.isPattern(/^[a-z0-9]+$/), Schema.isMinLength(1), Schema.isMaxLength(63)),
      suffix: Schema.String.check(Schema.isPattern(/^[a-z]+$/), Schema.isMinLength(2), Schema.isMaxLength(10)),
      path: Schema.Array(
        Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~%-]*$/), Schema.isMaxLength(16))
      ).check(Schema.isMaxLength(4))
    }),
  Date: (constraint) => {
    const minimum = Math.max(
      minimumDateTimestamp,
      constraint?.minimum === undefined
        ? minimumDateTimestamp
        : constraint.minimum.getTime() + (constraint.exclusiveMinimum === true ? 1 : 0)
    )
    const maximum = Math.min(
      maximumDateTimestamp,
      constraint?.maximum === undefined
        ? maximumDateTimestamp
        : constraint.maximum.getTime() - (constraint.exclusiveMaximum === true ? 1 : 0)
    )
    return Schema.Int.check(Schema.isBetween({ minimum, maximum }))
  },
  BigDecimal: bigDecimalSchema,
  DateTimeUtc: (constraint) => {
    const [minimum, maximum] = dateTimeBounds(constraint, minimumDateTimestamp, maximumDateTimestamp)
    return integerSchema(minimum, maximum)
  },
  TimeZoneNamed: namedTimeZoneSchema,
  TimeZone: timeZoneSchema,
  DateTimeZoned: (constraint) => {
    const [minimum, maximum] = dateTimeBounds(
      constraint,
      minimumZonedDateTimeTimestamp,
      maximumZonedDateTimeTimestamp
    )
    return Schema.Struct({
      epochMilliseconds: integerSchema(minimum, maximum),
      timeZone: timeZoneSchema()
    })
  },
  Uint8Array: (constraint) => {
    let schema: Schema.Codec<ReadonlyArray<number>> = Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
    )
    if (constraint?.minLength !== undefined && constraint.maxLength !== undefined) {
      schema = schema.check(Schema.isLengthBetween(constraint.minLength, constraint.maxLength))
    } else if (constraint?.minLength !== undefined) {
      schema = schema.check(Schema.isMinLength(constraint.minLength))
    } else if (constraint?.maxLength !== undefined) {
      schema = schema.check(Schema.isMaxLength(constraint.maxLength))
    }
    if (constraint?.unique === true) schema = schema.check(Schema.isUnique())
    return schema
  }
}

function lengthBounds(
  constraint: Constraint | undefined,
  keys: readonly [
    minimum: "minLength" | "minSize" | "minProperties",
    maximum: "maxLength" | "maxSize" | "maxProperties"
  ],
  path: ReadonlyArray<PropertyKey>,
  label: string
): readonly [minimum: number, maximum: number | undefined] {
  const minimum = constraint?.[keys[0]] ?? 0
  const maximum = constraint?.[keys[1]]
  if (
    !Number.isSafeInteger(minimum) || minimum < 0 ||
    maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < minimum)
  ) {
    throw arbitraryError(`${label} constraints`, path)
  }
  return [minimum, maximum]
}

function constant<A>(value: A): Model.Compiled<A> {
  return Model.makeCompiled([], () => 0, () => Model.generated(Model.makeSample(value)))
}

function replaceAt<A>(values: ReadonlyArray<A>, index: number, value: A): Array<A> {
  const out = values.slice()
  out[index] = value
  return out
}

function arraySample(
  children: ReadonlyArray<Model.Sample<any>>,
  shape: {
    readonly fixedCount: number
    readonly optionalCount: number
    readonly repeatCount: number
    readonly tailCount: number
    readonly minimum: number
  },
  shrinks = true
): Model.Sample<ReadonlyArray<any>> {
  if (!shrinks) return Model.makeSample(children.map((child) => child.value))
  // Like fast-check v4.9.0's ArrayArbitrary (MIT), structural shrinks are tried before element shrinks.
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/ArrayArbitrary.ts
  const childPulls = children.flatMap((child, index) =>
    child.shrinks === undefined
      ? []
      : [Model.mapPull(child.shrinks, (sample) => arraySample(replaceAt(children, index, sample), shape))]
  )
  const structural: Array<() => Model.Sample<ReadonlyArray<any>>> = []
  if (shape.repeatCount > 0 && children.length - 1 >= shape.minimum) {
    const index = shape.fixedCount + shape.repeatCount - 1
    structural.push(() =>
      arraySample(children.slice(0, index).concat(children.slice(index + 1)), {
        ...shape,
        repeatCount: shape.repeatCount - 1
      })
    )
  } else if (
    shape.optionalCount > 0 && shape.repeatCount === 0 && shape.tailCount === 0 &&
    children.length - 1 >= shape.minimum
  ) {
    structural.push(() =>
      arraySample(children.slice(0, -1), {
        ...shape,
        fixedCount: shape.fixedCount - 1,
        optionalCount: shape.optionalCount - 1
      })
    )
  }
  const pulls = structural.length === 0
    ? childPulls
    : [Model.mapPull(Model.pullFromArray(structural), (make) => make()), ...childPulls]
  return Model.makeSample(
    children.map((child) => child.value),
    pulls.length === 0 ? undefined : Model.concatPulls(pulls)
  )
}

interface ObjectEntry {
  readonly key: PropertyKey
  readonly keySample?: Model.Sample<PropertyKey> | undefined
  readonly sample: Model.Sample<any>
  readonly removable: boolean
}

function normalizePropertyKeySample(sample: Model.Sample<any>): Option.Option<Model.Sample<PropertyKey>> {
  const filtered = Model.filterSample(
    sample,
    (value): value is string | number | symbol =>
      typeof value === "string" || typeof value === "number" || typeof value === "symbol"
  )
  return Option.isNone(filtered)
    ? Option.none()
    : Option.some(
      Model.mapSample(filtered.value, (value) => typeof value === "symbol" ? value : globalThis.String(value))
    )
}

function objectSample(
  entries: ReadonlyArray<ObjectEntry>,
  minimum: number,
  shrinks = true
): Model.Sample<Record<PropertyKey, any>> {
  const make = (entries: ReadonlyArray<ObjectEntry>) => {
    const out: Record<PropertyKey, any> = {}
    for (const entry of entries) InternalRecord.assignProperty(out, entry.key, entry.sample.value)
    return out
  }
  if (!shrinks) return Model.makeSample(make(entries))
  const childPulls = entries.flatMap((entry, index) =>
    entry.sample.shrinks === undefined
      ? []
      : [
        Model.mapPull(
          entry.sample.shrinks,
          (sample) => objectSample(replaceAt(entries, index, { ...entry, sample }), minimum)
        )
      ]
  )
  // Key shrinking uses the same uniqueness-preserving descendant filtering principle as fast-check v4.9.0's
  // ArrayArbitrary (MIT). Structural removals and value shrinks retain their established precedence.
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/ArrayArbitrary.ts
  const keyPulls = entries.flatMap((entry, index) => {
    if (entry.keySample === undefined || entry.keySample.shrinks === undefined) return []
    const filtered = Model.filterSample(
      entry.keySample,
      (key) => !entries.some((other, otherIndex) => otherIndex !== index && other.key === key)
    )
    if (Option.isNone(filtered) || filtered.value.shrinks === undefined) return []
    return [Model.mapPull(
      filtered.value.shrinks,
      (keySample) =>
        objectSample(
          replaceAt(entries, index, { ...entry, key: keySample.value, keySample }),
          minimum
        )
    )]
  })
  const structural: Array<() => Model.Sample<Record<PropertyKey, any>>> = entries.length <= minimum
    ? []
    : entries.flatMap((entry, index) =>
      entry.removable
        ? [() => objectSample(entries.slice(0, index).concat(entries.slice(index + 1)), minimum)]
        : []
    )
  const descendantPulls = [...childPulls, ...keyPulls]
  const pulls = structural.length === 0
    ? descendantPulls
    : [Model.mapPull(Model.pullFromArray(structural), (make) => make()), ...descendantPulls]
  return Model.makeSample(make(entries), pulls.length === 0 ? undefined : Model.concatPulls(pulls))
}

const generateWithReservedBudget = (
  child: Model.Compiled<any>,
  state: Model.GenerationState,
  reserved: number
): Model.Generation<any> => {
  if (child.minCost + reserved > state.budget.remaining) return Model.discarded
  if (reserved === 0) return child.generate(state)
  state.budget.remaining -= reserved
  return Model.mapGeneration(child.generate(state), (attempt) => {
    state.budget.remaining += reserved
    return attempt
  })
}

const generateSamples = (
  children: ReadonlyArray<Model.Compiled<any>>,
  state: Model.GenerationState,
  additionalReserved = 0
): Model.Computation<Option.Option<Array<Model.Sample<any>>>> => {
  let reserved = sumCosts(children.map((child) => child.minCost)) + additionalReserved
  if (reserved > state.budget.remaining) return Option.none()
  const order = children.map((_, index) => index)
  const recursive = order.filter((index) => children[index].mayRecurse)
  if (recursive.length > 1) {
    const shuffled = Model.shuffle(state, recursive)
    let next = 0
    for (let index = 0; index < order.length; index++) {
      if (children[index].mayRecurse) order[index] = shuffled[next++]
    }
  }
  const out = new Array<Model.Sample<any>>(children.length)
  let index = 0
  const loop = (): Model.Computation<Option.Option<Array<Model.Sample<any>>>> => {
    while (index < order.length) {
      const childIndex = order[index++]
      const child = children[childIndex]
      reserved -= child.minCost
      const generated = generateWithReservedBudget(child, state, reserved)
      if (Model.isAttempt(generated)) {
        const attempt = generated
        if (attempt._tag === "Discarded") return Option.none()
        out[childIndex] = attempt.sample
        continue
      }
      return Effect.flatMapEager(generated, (attempt) => {
        if (attempt._tag === "Discarded") return Effect.succeed(Option.none())
        out[childIndex] = attempt.sample
        return Model.toEffect(loop())
      })
    }
    return Option.some(out)
  }
  return loop()
}

function shrinkString(value: string, minimum: number): ReadonlyArray<string> {
  const values = value.length <= minimum
    ? []
    : [
      value.slice(0, minimum),
      value.slice(0, Math.max(minimum, Math.floor(value.length / 2))),
      value.slice(0, -1)
    ]
  // fast-check v4.9.0 builds strings from shrinkable units (MIT). Effect keeps UTF-16 code units as the native domain
  // and applies its integer-halving shrink toward the Effect-owned null-unit target.
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/string.ts
  for (let index = 0; index < value.length; index++) {
    for (const candidate of shrinkInteger(value.charCodeAt(index), 0, true)) {
      values.push(
        value.slice(0, index) + globalThis.String.fromCharCode(candidate.value) + value.slice(index + 1)
      )
    }
  }
  return [...new Set(values)].filter((candidate) => candidate !== value)
}

// Edge-case injection is inspired by fast-check v4.9.0's cached dangerous slices (MIT). The concrete corpus is
// Effect-owned and also covers control, numeric-property, and UTF-16 boundaries.
// https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/helpers/SlicesForStringBuilder.ts
const stringEdgeCases = [
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
] as const

function randomString(state: Model.GenerationState, minimum: number, maximum: number): string {
  if (Model.randomInt(state, 1, state.biasFactor) === 1) {
    let eligible = 0
    for (const value of stringEdgeCases) {
      if (value.length >= minimum && value.length <= maximum) eligible++
    }
    if (eligible > 0) {
      let target = Model.randomIndex(state, eligible)
      for (const value of stringEdgeCases) {
        if (value.length < minimum || value.length > maximum) continue
        if (target-- === 0) return value
      }
    }
  }
  const length = Model.randomLength(state, minimum, maximum)
  let value = ""
  for (let index = 0; index < length; index++) {
    value += globalThis.String.fromCharCode(Model.randomInt(state, 32, 126))
  }
  return value
}

function numberBounds(constraint: Constraint | undefined, integer: boolean, path: ReadonlyArray<PropertyKey>) {
  const ordered = constraint?.order === Order.Number ? constraint : undefined
  let minimum = ordered?.minimum as number | undefined
  let maximum = ordered?.maximum as number | undefined
  if (minimum !== undefined && Number.isNaN(minimum) || maximum !== undefined && Number.isNaN(maximum)) {
    throw arbitraryError(integer ? "integer constraints" : "number constraints", path)
  }
  if (integer) {
    if (minimum !== undefined) {
      minimum = ordered?.exclusiveMinimum === true
        ? Math.floor(minimum) + 1
        : Math.ceil(minimum)
    }
    if (maximum !== undefined) {
      maximum = ordered?.exclusiveMaximum === true
        ? Math.ceil(maximum) - 1
        : Math.floor(maximum)
    }
  } else {
    if (minimum !== undefined && ordered?.exclusiveMinimum === true && minimum === Infinity) {
      throw arbitraryError("number constraints", path)
    }
    if (maximum !== undefined && ordered?.exclusiveMaximum === true && maximum === -Infinity) {
      throw arbitraryError("number constraints", path)
    }
    if (minimum !== undefined) {
      minimum = ordered?.exclusiveMinimum === true ? Model.nextNumber(minimum) : minimum === 0 ? -0 : minimum
    }
    if (maximum !== undefined) {
      maximum = ordered?.exclusiveMaximum === true ? Model.previousNumber(maximum) : maximum === 0 ? 0 : maximum
    }
  }
  if (integer || constraint?.number === "finite") {
    if (minimum === Infinity || maximum === -Infinity) {
      throw arbitraryError(integer ? "integer constraints" : "number constraints", path)
    }
    if (minimum === -Infinity) minimum = integer ? Number.MIN_SAFE_INTEGER : -Number.MAX_VALUE
    if (maximum === Infinity) maximum = integer ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE
  }
  if (integer) {
    if (
      minimum !== undefined && minimum > Number.MAX_SAFE_INTEGER ||
      maximum !== undefined && maximum < Number.MIN_SAFE_INTEGER
    ) {
      throw arbitraryError("integer constraints", path)
    }
    if (minimum !== undefined) minimum = Math.max(minimum, Number.MIN_SAFE_INTEGER)
    if (maximum !== undefined) maximum = Math.min(maximum, Number.MAX_SAFE_INTEGER)
  }
  if (
    minimum !== undefined && maximum !== undefined &&
    (integer ? minimum > maximum : Model.numberToIndex(minimum) > Model.numberToIndex(maximum))
  ) {
    throw arbitraryError(integer ? "integer constraints" : "number constraints", path)
  }
  return { minimum, maximum }
}

interface NumberShrink {
  readonly value: number
  readonly context: number | undefined
}

function shrinkInteger(current: number, target: number, tryTargetAsap: boolean): ReadonlyArray<NumberShrink> {
  const out: Array<NumberShrink> = []
  const realGap = current - target
  let previous = tryTargetAsap ? undefined : target
  if (realGap > 0) {
    for (
      let toRemove = tryTargetAsap ? realGap : Math.floor(realGap / 2);
      toRemove > 0;
      toRemove = Math.floor(toRemove / 2)
    ) {
      const value = toRemove === realGap ? target : current - toRemove
      out.push({ value, context: previous })
      previous = value
    }
  } else {
    for (
      let toRemove = tryTargetAsap ? realGap : Math.ceil(realGap / 2);
      toRemove < 0;
      toRemove = Math.ceil(toRemove / 2)
    ) {
      const value = toRemove === realGap ? target : current - toRemove
      out.push({ value, context: previous })
      previous = value
    }
  }
  return out
}

function shrinkNumber(current: number, target: number, tryTargetAsap: boolean): ReadonlyArray<NumberShrink> {
  if (Number.isNaN(current)) return [{ value: target, context: undefined }]
  const currentIndex = Model.numberToIndex(current)
  const targetIndex = Model.numberToIndex(target)
  const realGap = currentIndex - targetIndex
  let previous = tryTargetAsap ? undefined : target
  const out: Array<NumberShrink> = []
  if (realGap > BigInt(0)) {
    for (
      let toRemove = tryTargetAsap ? realGap : realGap / BigInt(2);
      toRemove > BigInt(0);
      toRemove /= BigInt(2)
    ) {
      const value = toRemove === realGap ? target : Model.indexToNumber(currentIndex - toRemove)
      out.push({ value, context: previous })
      previous = value
    }
  } else {
    for (
      let toRemove = tryTargetAsap ? realGap : realGap / BigInt(2);
      toRemove < BigInt(0);
      toRemove /= BigInt(2)
    ) {
      const value = toRemove === realGap ? target : Model.indexToNumber(currentIndex - toRemove)
      out.push({ value, context: previous })
      previous = value
    }
  }
  return out
}

function numberTarget(minimum: number | undefined, maximum: number | undefined): number {
  if (minimum !== undefined && minimum > 0) return minimum
  if (maximum !== undefined && maximum < 0) return maximum
  return 0
}

function numberSample(
  value: number,
  minimum: number | undefined,
  maximum: number | undefined,
  integer: boolean,
  context?: number
): Model.Sample<number> {
  if (!integer) {
    // fast-check v4.9.0's double arbitrary shrinks the monotone IEEE-754 index through its BigInt arbitrary (MIT).
    // The native sample keeps the equivalent last-passing index context without exposing either representation.
    // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/double.ts
    let candidates: ReadonlyArray<NumberShrink>
    const target = numberTarget(minimum, maximum)
    if (context === undefined) {
      candidates = shrinkNumber(value, target, true)
    } else if (
      !Number.isNaN(value) &&
      (Model.numberToIndex(value) === Model.numberToIndex(context) + BigInt(1) ||
        Model.numberToIndex(value) === Model.numberToIndex(context) - BigInt(1))
    ) {
      candidates = [{ value: context, context: undefined }]
    } else {
      candidates = shrinkNumber(value, context, false)
    }
    return Model.makeSample(
      value,
      candidates.length === 0
        ? undefined
        : Model.mapPull(
          Model.pullFromArray(candidates),
          (candidate) => numberSample(candidate.value, minimum, maximum, false, candidate.context)
        )
    )
  }
  // The passing-value context and halving sequence are adapted from fast-check v4.9.0's IntegerArbitrary and
  // ShrinkInteger (MIT). Retaining the closest passing candidate lets the runner converge on a local failure boundary.
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/IntegerArbitrary.ts
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/helpers/ShrinkInteger.ts
  let candidates: ReadonlyArray<NumberShrink>
  if (context === undefined) {
    const target = Math.min(maximum ?? 0, Math.max(minimum ?? 0, 0))
    candidates = shrinkInteger(value, target, true)
  } else if (
    value > 0 && value === context + 1 && (minimum === undefined || value > minimum) ||
    value < 0 && value === context - 1 && (maximum === undefined || value < maximum)
  ) {
    candidates = [{ value: context, context: undefined }]
  } else {
    candidates = shrinkInteger(value, context, false)
  }
  return Model.makeSample(
    value,
    candidates.length === 0
      ? undefined
      : Model.mapPull(
        Model.pullFromArray(candidates),
        (candidate) => numberSample(candidate.value, minimum, maximum, true, candidate.context)
      )
  )
}

interface BigIntShrink {
  readonly value: bigint
  readonly context: bigint | undefined
}

function shrinkBigInt(current: bigint, target: bigint, tryTargetAsap: boolean): ReadonlyArray<BigIntShrink> {
  const out: Array<BigIntShrink> = []
  const realGap = current - target
  let previous = tryTargetAsap ? undefined : target
  if (realGap > BigInt(0)) {
    for (
      let toRemove = tryTargetAsap ? realGap : realGap / BigInt(2);
      toRemove > BigInt(0);
      toRemove /= BigInt(2)
    ) {
      const value = current - toRemove
      out.push({ value, context: previous })
      previous = value
    }
  } else {
    for (
      let toRemove = tryTargetAsap ? realGap : realGap / BigInt(2);
      toRemove < BigInt(0);
      toRemove /= BigInt(2)
    ) {
      const value = current - toRemove
      out.push({ value, context: previous })
      previous = value
    }
  }
  return out
}

function bigIntSample(
  value: bigint,
  minimum: bigint | undefined,
  maximum: bigint | undefined,
  context?: bigint
): Model.Sample<bigint> {
  // The passing-value context and gap-halving sequence are adapted from fast-check v4.9.0's BigIntArbitrary and
  // ShrinkBigInt (MIT). Retaining the closest passing candidate lets the runner converge on a local failure boundary.
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/BigIntArbitrary.ts
  // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/helpers/ShrinkBigInt.ts
  let candidates: ReadonlyArray<BigIntShrink>
  if (context === undefined) {
    const target = minimum !== undefined && minimum > BigInt(0)
      ? minimum
      : maximum !== undefined && maximum < BigInt(0)
      ? maximum
      : BigInt(0)
    candidates = shrinkBigInt(value, target, true)
  } else if (
    value > BigInt(0) && value === context + BigInt(1) && (minimum === undefined || value > minimum) ||
    value < BigInt(0) && value === context - BigInt(1) && (maximum === undefined || value < maximum)
  ) {
    candidates = [{ value: context, context: undefined }]
  } else {
    candidates = shrinkBigInt(value, context, false)
  }
  return Model.makeSample(
    value,
    candidates.length === 0
      ? undefined
      : Model.mapPull(
        Model.pullFromArray(candidates),
        (candidate) => bigIntSample(candidate.value, minimum, maximum, candidate.context)
      )
  )
}

/** @internal */
export function compile<S extends Schema.Constraint>(schema: S): Model.Compiled<S["Type"]> {
  const rootAst = SchemaAST.toType(schema.ast)
  const defaultConstraint = Symbol.for("~effect/arbitrary/defaultConstraint")
  const cache = new WeakMap<SchemaAST.AST, Map<Constraint | symbol, Model.Compiled<any>>>()
  const nodes: Array<Model.Compiled<any>> = []
  const suspendBodies = new Map<Model.Compiled<any>, Model.Compiled<any>>()
  const pending: Array<() => void> = []
  const recur = (
    ast: SchemaAST.AST,
    path: ReadonlyArray<PropertyKey>,
    inherited?: Constraint
  ): Model.Compiled<any> => {
    const cacheKey: Constraint | symbol = inherited ?? defaultConstraint
    let entries = cache.get(ast)
    const cached = entries?.get(cacheKey)
    if (cached !== undefined) return cached
    if (entries === undefined) {
      entries = new Map()
      cache.set(ast, entries)
    }
    const placeholder = Model.makePlaceholder<any>()
    entries.set(cacheKey, placeholder)
    nodes.push(placeholder)
    pending.push(() => {
      const checks = collectChecks(ast.checks, inherited)
      const baseAst = ast.checks === undefined ? ast : SchemaAST.replaceChecks(ast, undefined)
      const base = compileBase(baseAst, path, checks.constraint)
      if (baseAst._tag === "Suspend") {
        const body = base.dependencies[0]
        placeholder.dependencies = [body]
        placeholder.computeMinCost = () => {
          if (body.minCost === infinity) return infinity
          return body.minCost + (placeholder.recursive ? 1 : 0)
        }
        placeholder.generate = (state) =>
          Effect.suspend(() => {
            if (placeholder.recursive) {
              if (state.budget.remaining <= 0) return Effect.succeed(Model.discarded)
              state.budget.remaining--
            }
            return Model.toEffectGeneration(body.generate(state))
          })
        suspendBodies.set(placeholder, body)
      } else {
        placeholder.dependencies = base.dependencies
        placeholder.computeMinCost = base.computeMinCost
        placeholder.generate = base.generate
      }
      if (checks.filters.length > 0) {
        const generate = placeholder.generate
        placeholder.generate = (state) =>
          Model.mapGeneration(generate(state), (attempt) => {
            if (attempt._tag === "Discarded") return Model.discarded
            const sample = Model.filterSample(
              attempt.sample,
              (value) =>
                checks.filters.every((filter) => filter.run(value, ast, SchemaAST.defaultParseOptions) === undefined)
            )
            return Option.isSome(sample) ? Model.generated(sample.value) : Model.discarded
          })
      }
    })
    return placeholder
  }

  const compileBase = (
    ast: SchemaAST.AST,
    path: ReadonlyArray<PropertyKey>,
    constraint: Constraint | undefined
  ): Model.Compiled<any> => {
    switch (ast._tag) {
      case "Never":
        throw arbitraryError("Never", path)
      case "Null":
        return constant(null)
      case "Undefined":
      case "Void":
        return constant(undefined)
      case "Literal":
        return constant(ast.literal)
      case "UniqueSymbol":
        return constant(ast.symbol)
      case "Boolean":
        return Model.makeCompiled(
          [],
          () => 0,
          (state) => {
            const value = Model.randomBoolean(state)
            return Model.generated(Model.makeSample(
              value,
              state.shrinks && value ? Model.pullFromArray([Model.makeSample(false)]) : undefined
            ))
          }
        )
      case "String": {
        const patternConstraints = constraint?.patterns ?? []
        const patterns: Array<Regexp.Compiled> = []
        for (const constraint of patternConstraints) {
          const pattern = Regexp.compile(constraint)
          if (pattern !== undefined) patterns.push(pattern)
        }
        const [minimum, maximum] = lengthBounds(constraint, ["minLength", "maxLength"], path, "string")
        return Model.makeCompiled(
          [],
          () => 0,
          (state) => {
            const pattern = patterns.length === 0
              ? undefined
              : patterns.length === 1
              ? patterns[0]
              : patterns[Model.randomIndex(state, patterns.length)]
            const currentMaximum = Math.max(minimum, pattern?.minimumLength ?? 0, state.size)
            const upper = maximum === undefined ? currentMaximum : Math.min(maximum, currentMaximum)
            let value: string | undefined
            if (pattern === undefined) {
              value = randomString(state, minimum, upper)
            } else {
              value = pattern.generate(state, minimum, upper)
            }
            if (value === undefined) return Model.discarded
            return Model.generated(
              state.shrinks
                ? Model.sampleFromShrink(
                  value,
                  pattern === undefined
                    ? (value) => shrinkString(value, minimum)
                    : (value) => pattern.shrink(value, minimum)
                )
                : Model.makeSample(value)
            )
          }
        )
      }
      case "Number": {
        const integer = constraint?.number === "integer"
        const bounds = numberBounds(constraint, integer, path)
        const numberMinimum = bounds.minimum ?? (constraint?.number !== undefined
          ? -Number.MAX_VALUE
          : Number.NEGATIVE_INFINITY)
        const numberMaximum = bounds.maximum ?? (constraint?.number !== undefined
          ? Number.MAX_VALUE
          : Number.POSITIVE_INFINITY)
        const randomNumber = integer
          ? undefined
          : Model.makeRandomNumber(
            numberMinimum,
            numberMaximum,
            constraint?.number === undefined && bounds.minimum === undefined && bounds.maximum === undefined
          )
        let integerMinimum: number | undefined
        let integerMaximum: number | undefined
        let randomInteger: ((state: Model.GenerationState) => number) | undefined
        return Model.makeCompiled(
          [],
          () => 0,
          (state) => {
            let minimum = numberMinimum
            let maximum = numberMaximum
            if (integer) {
              const magnitude = Math.max(1, state.size * state.size)
              const center = bounds.minimum !== undefined && bounds.minimum > 0
                ? bounds.minimum
                : bounds.maximum !== undefined && bounds.maximum < 0
                ? bounds.maximum
                : 0
              minimum = bounds.minimum ?? center - magnitude
              maximum = bounds.maximum ?? center + magnitude
              if (randomInteger === undefined || minimum !== integerMinimum || maximum !== integerMaximum) {
                integerMinimum = minimum
                integerMaximum = maximum
                randomInteger = Model.makeRandomNumericInt(minimum, maximum)
              }
            }
            const value = integer
              ? randomInteger!(state)
              : randomNumber!(state)
            return Model.generated(
              state.shrinks
                ? numberSample(value, bounds.minimum, bounds.maximum, integer)
                : Model.makeSample(value)
            )
          }
        )
      }
      case "BigInt": {
        const ordered = constraint?.order === Order.BigInt ? constraint : undefined
        let minimum = ordered?.minimum as bigint | undefined
        let maximum = ordered?.maximum as bigint | undefined
        if (minimum !== undefined && ordered?.exclusiveMinimum === true) minimum++
        if (maximum !== undefined && ordered?.exclusiveMaximum === true) maximum--
        if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
          throw arbitraryError("bigint constraints", path)
        }
        let previousLow: bigint | undefined
        let previousHigh: bigint | undefined
        let randomBigInt: ((state: Model.GenerationState) => bigint) | undefined
        return Model.makeCompiled(
          [],
          () => 0,
          (state) => {
            const magnitude = BigInt(Math.max(1, state.size * state.size))
            const center = minimum !== undefined && minimum > BigInt(0)
              ? minimum
              : maximum !== undefined && maximum < BigInt(0)
              ? maximum
              : BigInt(0)
            const low = minimum ?? center - magnitude
            const high = maximum ?? center + magnitude
            if (randomBigInt === undefined || low !== previousLow || high !== previousHigh) {
              previousLow = low
              previousHigh = high
              randomBigInt = Model.makeRandomNumericBigInt(low, high)
            }
            const value = randomBigInt(state)
            return Model.generated(
              state.shrinks
                ? bigIntSample(value, minimum, maximum)
                : Model.makeSample(value)
            )
          }
        )
      }
      case "Symbol": {
        const strings = recur(SchemaAST.string, path, constraint)
        return Model.makeCompiled(
          [strings],
          () => strings.minCost,
          (state) =>
            Model.mapGeneration(strings.generate(state), (attempt) =>
              attempt._tag === "Discarded"
                ? attempt
                : Model.generated(Model.mapSample(attempt.sample, (value) => Symbol.for(value))))
        )
      }
      case "Unknown":
      case "Any": {
        const json = recur(Schema.Json.ast, path)
        return Model.makeCompiled([json], () => json.minCost, (state) => json.generate(state))
      }
      case "ObjectKeyword": {
        const json = recur(Schema.Json.ast, path)
        return Model.makeCompiled(
          [json],
          () => 0,
          (state) =>
            Model.mapGeneration(json.generate(state), (attempt) => {
              if (
                attempt._tag === "Generated" && typeof attempt.sample.value === "object" &&
                attempt.sample.value !== null
              ) {
                return attempt
              }
              return Model.generated(Model.makeSample({}))
            })
        )
      }
      case "Enum": {
        const values = [...new Set(ast.enums.map(([, value]) => value))]
        if (values.length === 0) throw arbitraryError("an enum with no members", path)
        return Model.makeCompiled(
          [],
          () => 0,
          (state) => Model.generated(Model.makeSample(values[Model.randomIndex(state, values.length)]))
        )
      }
      case "TemplateLiteral": {
        const parts = ast.parts.map((part, index) => recur(part, [...path, index], finiteNumberConstraint))
        return Model.makeCompiled(
          parts,
          () => sumCosts(parts.map((part) => part.minCost)),
          (state) =>
            Model.mapComputation(generateSamples(parts, state), (generated) => {
              if (Option.isNone(generated)) return Model.discarded
              const sample = arraySample(generated.value, {
                fixedCount: generated.value.length,
                optionalCount: 0,
                repeatCount: 0,
                tailCount: 0,
                minimum: generated.value.length
              }, state.shrinks)
              return Model.generated(Model.mapSample(sample, (parts) => parts.map(globalThis.String).join("")))
            })
        )
      }
      case "Union": {
        const members = ast.types.map((member) => recur(member, path, constraint))
        if (members.length === 0) throw arbitraryError("a union with no members", path)
        return Model.makeCompiled(
          members,
          () => Math.min(...members.map((member) => member.minCost)),
          (state) => {
            const eligible = members.filter((member) => member.minCost <= state.budget.remaining)
            if (eligible.length === 0) return Model.discarded
            const selected = eligible[Model.randomIndex(state, eligible.length)]
            return Model.mapGeneration(selected.generate(state), (attempt) => {
              if (!state.shrinks || attempt._tag === "Discarded") return attempt
              let fallback = members[0]
              for (let index = 1; index < members.length; index++) {
                if (members[index].minCost < fallback.minCost) fallback = members[index]
              }
              if (fallback.minCost >= selected.minCost) return attempt

              // This lazy cross-branch fallback follows fast-check v4.9.0's FrequencyArbitrary withCrossShrink idea
              // (MIT): a value selected from a recursive branch first shrinks toward the productive base branch.
              // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/FrequencyArbitrary.ts
              let pulled = false
              const fallbackPull = Effect.suspend(() => {
                if (pulled) return Cause.done()
                pulled = true
                return Effect.flatMapEager(
                  Model.toEffectGeneration(
                    fallback.generate({ ...state, budget: { remaining: fallback.minCost } })
                  ),
                  (attempt) => attempt._tag === "Generated" ? Effect.succeed(attempt.sample) : Cause.done()
                )
              })
              return Model.generated(Model.makeSample(
                attempt.sample.value,
                attempt.sample.shrinks === undefined
                  ? fallbackPull
                  : Model.concatPulls([fallbackPull, attempt.sample.shrinks])
              ))
            })
          }
        )
      }
      case "Arrays":
        return compileArrays(ast, path, constraint)
      case "Objects":
        return compileObjects(ast, path, constraint)
      case "Suspend": {
        const body = recur(ast.thunk(), path)
        return Model.makeCompiled([body], () => body.minCost, (state) => body.generate(state))
      }
      case "Declaration":
        return compileDeclaration(ast, path, constraint)
    }
  }

  const compileArrays = (
    ast: SchemaAST.Arrays,
    path: ReadonlyArray<PropertyKey>,
    constraint: Constraint | undefined
  ): Model.Compiled<ReadonlyArray<any>> => {
    const elements = ast.elements.map((element, index) => ({
      optional: SchemaAST.isOptional(element),
      compiled: recur(element, [...path, index])
    }))
    const requiredCount = elements.findIndex((element) => element.optional)
    const required = requiredCount === -1 ? elements.length : requiredCount
    const optional = elements.length - required
    const rest = ast.rest.map((element, index) => recur(element, [...path, elements.length + index]))
    const head = rest[0]
    const tail = rest.slice(1)
    const [minimum, maximum] = lengthBounds(constraint, ["minLength", "maxLength"], path, "array")
    if (
      maximum !== undefined && maximum < required + tail.length ||
      head === undefined && minimum > elements.length + tail.length
    ) {
      throw arbitraryError("array constraints", path)
    }
    const dependencies = [...elements.map((element) => element.compiled), ...rest]
    const combinations = (limit: number): Array<readonly [optional: number, repeat: number, cost: number]> => {
      const out: Array<readonly [number, number, number]> = []
      const requiredCost = sumCosts(elements.slice(0, required).map((element) => element.compiled.minCost))
      const tailCost = sumCosts(tail.map((element) => element.minCost))
      const currentMaximum = Math.max(minimum, required + tail.length, limit)
      const upper = maximum === undefined ? currentMaximum : Math.min(maximum, currentMaximum)
      for (let optionalCount = 0; optionalCount <= optional; optionalCount++) {
        const fixed = required + optionalCount + tail.length
        const minimumRepeat = Math.max(0, minimum - fixed)
        const maximumRepeat = head === undefined ? 0 : Math.max(minimumRepeat, upper - fixed)
        if (fixed + minimumRepeat > upper || head === undefined && minimumRepeat > 0) continue
        const optionalCost = sumCosts(
          elements.slice(required, required + optionalCount).map((element) => element.compiled.minCost)
        )
        for (let repeat = minimumRepeat; repeat <= maximumRepeat; repeat++) {
          if ((repeat > 0 || tail.length > 0) && optionalCount < optional) continue
          const repeatCost = repeat === 0 ? 0 : repeat * (head?.minCost ?? 0)
          const cost = requiredCost + optionalCost + tailCost + repeatCost
          out.push([optionalCount, repeat, cost])
        }
      }
      return out
    }
    return Model.makeCompiled(
      dependencies,
      () => {
        const possible = combinations(0)
        return possible.length === 0 ? infinity : Math.min(...possible.map(([, , cost]) => cost))
      },
      (state) => {
        const possible = combinations(state.size).filter(([, , cost]) => cost <= state.budget.remaining)
        if (possible.length === 0) return Model.discarded
        const [optionalCount, repeatCount] = possible[Model.randomLength(state, 0, possible.length - 1)]
        const selected = [
          ...elements.slice(0, required + optionalCount).map((element) => element.compiled),
          ...Array.from({ length: repeatCount }, () => head!),
          ...tail
        ]
        const makeAttempt = (generated: ReadonlyArray<Model.Sample<any>>) =>
          Model.generated(arraySample(generated, {
            fixedCount: required + optionalCount,
            optionalCount,
            repeatCount,
            tailCount: tail.length,
            minimum
          }, state.shrinks))
        // Explicit collection minima must stay productive while progressive checks are still at size zero.
        const itemState = state.size >= repeatCount ? state : { ...state, size: repeatCount }
        if (constraint?.unique !== true) {
          return Model.mapComputation(
            generateSamples(selected, itemState),
            (generated) => Option.isNone(generated) ? Model.discarded : makeAttempt(generated.value)
          )
        }
        // Constructive uniqueness and the requested-length consecutive duplicate circuit breaker follow fast-check
        // v4.9.0's ArrayArbitrary strategy (MIT). Hash buckets make Effect.Equal lookup expected-linear while retaining
        // collision checks with Effect's equality semantics.
        // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/ArrayArbitrary.ts
        const generated: Array<Model.Sample<any>> = []
        const primitives = new globalThis.Set<any>()
        const buckets = new globalThis.Map<number, Array<any>>()
        const addUnique = (value: any): boolean => {
          if (value === null || typeof value !== "object" && typeof value !== "function") {
            if (primitives.has(value)) return false
            primitives.add(value)
            return true
          }
          const hash = Hash.hash(value)
          const bucket = buckets.get(hash)
          if (bucket !== undefined) {
            for (let index = 0; index < bucket.length; index++) {
              if (Equal.equals(bucket[index], value)) return false
            }
            bucket.push(value)
          } else {
            buckets.set(hash, [value])
          }
          return true
        }
        let reserved = sumCosts(selected.map((child) => child.minCost))
        const maximumRetries = selected.length
        let index = 0
        let retries = 0
        let budget = state.budget.remaining
        const loop = (): Model.Generation<ReadonlyArray<any>> => {
          while (index < selected.length) {
            const child = selected[index]
            if (retries === 0) {
              reserved -= child.minCost
              budget = state.budget.remaining
            }
            const generatedChild = generateWithReservedBudget(child, itemState, reserved)
            if (Model.isAttempt(generatedChild)) {
              const attempt = generatedChild
              if (attempt._tag === "Discarded") return Model.discarded
              if (!addUnique(attempt.sample.value)) {
                if (++retries >= maximumRetries) return Model.discarded
                state.budget.remaining = budget
                continue
              }
              generated.push(attempt.sample)
              index++
              retries = 0
              continue
            }
            return Effect.flatMapEager(generatedChild, (attempt) => {
              if (attempt._tag === "Discarded") return Effect.succeed(Model.discarded)
              if (!addUnique(attempt.sample.value)) {
                if (++retries >= maximumRetries) return Effect.succeed(Model.discarded)
                state.budget.remaining = budget
              } else {
                generated.push(attempt.sample)
                index++
                retries = 0
              }
              return Model.toEffect(loop())
            })
          }
          return makeAttempt(generated)
        }
        return loop()
      }
    )
  }

  const compileObjects = (
    ast: SchemaAST.Objects,
    path: ReadonlyArray<PropertyKey>,
    constraint: Constraint | undefined
  ): Model.Compiled<Record<PropertyKey, any>> => {
    const properties = ast.propertySignatures.map((property) => ({
      property,
      optional: SchemaAST.isOptional(property.type),
      compiled: recur(property.type, [...path, property.name])
    }))
    const indexes = ast.indexSignatures.map((index, position) => ({
      parameter: recur(index.parameter, [...path, `index-${position}-key`]),
      value: recur(index.type, [...path, `index-${position}-value`])
    }))
    const required = properties.filter((property) => !property.optional)
    const optional = properties.filter((property) => property.optional)
    const [minimum, maximum] = lengthBounds(
      constraint,
      ["minProperties", "maxProperties"],
      path,
      "object property"
    )
    if (maximum !== undefined && maximum < required.length || indexes.length === 0 && minimum > properties.length) {
      throw arbitraryError("object property constraints", path)
    }
    const dependencies = [
      ...properties.map((property) => property.compiled),
      ...indexes.flatMap((index) => [index.parameter, index.value])
    ]
    return Model.makeCompiled(
      dependencies,
      () => {
        const requiredCost = sumCosts(required.map((property) => property.compiled.minCost))
        const need = Math.max(0, minimum - required.length)
        const optionalCosts = optional.map((property) => property.compiled.minCost).sort((a, b) => a - b)
        if (need <= optionalCosts.length) return requiredCost + sumCosts(optionalCosts.slice(0, need))
        if (indexes.length === 0) return infinity
        const indexCost = Math.min(...indexes.map((index) => index.parameter.minCost + index.value.minCost))
        return requiredCost + sumCosts(optionalCosts) + (need - optionalCosts.length) * indexCost
      },
      (state) => {
        const currentMaximum = Math.max(minimum, required.length, state.size)
        const upper = maximum === undefined ? currentMaximum : Math.min(maximum, currentMaximum)
        const maxOptional = Math.min(optional.length, upper - required.length)
        const minOptional = indexes.length === 0 ? Math.max(0, minimum - required.length) : 0
        const optionalCount = Model.randomInt(state, minOptional, maxOptional)
        const selectedOptional = optionalCount === 0 ? [] : Model.shuffle(state, optional).slice(0, optionalCount)
        const named = [...required, ...selectedOptional]
        const minimumIndexes = Math.max(0, minimum - named.length)
        const maximumIndexes = indexes.length === 0
          ? 0
          : upper - named.length
        const minimumIndexCost = indexes.length === 0
          ? infinity
          : Math.min(...indexes.map((index) => index.parameter.minCost + index.value.minCost))
        const namedCost = sumCosts(named.map((property) => property.compiled.minCost))
        const affordableIndexes = minimumIndexCost === 0
          ? maximumIndexes
          : minimumIndexCost === infinity
          ? 0
          : Math.min(maximumIndexes, Math.floor((state.budget.remaining - namedCost) / minimumIndexCost))
        if (affordableIndexes < minimumIndexes) return Model.discarded
        const indexCount = Model.randomLength(state, minimumIndexes, affordableIndexes)
        const indexReserved = indexCount === 0 ? 0 : indexCount * minimumIndexCost
        return Model.flatMapComputation(
          generateSamples(named.map((property) => property.compiled), state, indexReserved),
          (samples) => {
            if (Option.isNone(samples)) return Model.discarded
            const entries: Array<ObjectEntry> = samples.value.map((sample, index) => ({
              key: named[index].property.name,
              sample,
              removable: named[index].optional
            }))
            if (indexCount === 0) {
              return Model.generated(objectSample(entries, minimum, state.shrinks))
            }
            return Effect.gen(function*() {
              for (let position = 0; position < indexCount; position++) {
                const futureReserved = (indexCount - position - 1) * minimumIndexCost
                const eligible = indexes.filter((index) =>
                  index.parameter.minCost + index.value.minCost + futureReserved <= state.budget.remaining
                )
                if (eligible.length === 0) return Model.discarded
                const index = eligible[Model.randomIndex(state, eligible.length)]
                const budget = state.budget.remaining
                const reservedAfterKey = index.value.minCost + futureReserved
                // Multiple required index entries need enough key diversity before progressive size can advance.
                const keyState = state.size >= indexCount ? state : { ...state, size: indexCount }
                let keyAttempt = yield* Model.toEffectGeneration(
                  generateWithReservedBudget(index.parameter, keyState, reservedAfterKey)
                )
                let keySample: Model.Sample<PropertyKey>
                let retries = 0
                while (true) {
                  if (keyAttempt._tag === "Discarded") return Model.discarded
                  const normalized = normalizePropertyKeySample(keyAttempt.sample)
                  if (Option.isNone(normalized)) return Model.discarded
                  keySample = normalized.value
                  if (!entries.some((entry) => entry.key === keySample.value)) break
                  if (retries++ >= 10) return Model.discarded
                  state.budget.remaining = budget
                  keyAttempt = yield* Model.toEffectGeneration(
                    generateWithReservedBudget(index.parameter, keyState, reservedAfterKey)
                  )
                }
                const value = yield* Model.toEffectGeneration(
                  generateWithReservedBudget(index.value, state, futureReserved)
                )
                if (value._tag === "Discarded") return Model.discarded
                entries.push({ key: keySample.value, keySample, sample: value.sample, removable: true })
              }
              return Model.generated(objectSample(entries, minimum, state.shrinks))
            })
          }
        )
      }
    )
  }

  const compileDeclaration = (
    ast: SchemaAST.Declaration,
    path: ReadonlyArray<PropertyKey>,
    constraint: Constraint | undefined
  ): Model.Compiled<any> => {
    validateConstraint(constraint, path)
    const typeParameters = ast.typeParameters.map((parameter, index) => recur(parameter, [...path, index]))
    const parameters = ast.typeParameters.map((parameter) => Schema.make(SchemaAST.toType(parameter)))
    const getArbitrary = ast.annotations?.toCodecArbitrary
    let link: SchemaAST.Link
    if (typeof getArbitrary === "function") {
      link = getArbitrary({
        typeParameters: parameters,
        constraint: withoutOrder(constraint),
        schemas
      })
    } else {
      const getJson = ast.annotations?.toCodecJson
      if (typeof getJson === "function") {
        const jsonLink = getJson(parameters)
        if (jsonLink === undefined) throw arbitraryError("an opaque self-canonical Declaration", path)
        link = jsonLink
      } else {
        const get = ast.annotations?.toCodec
        if (typeof get !== "function") throw arbitraryError("an unsupported Declaration", path)
        link = get(parameters)
      }
    }
    const target = recur(SchemaAST.toType(link.to), path)
    const decodeDeclaration = Schema.decodeUnknownEffect(Schema.make(ast)) as (
      input: unknown
    ) => Effect.Effect<unknown, Schema.SchemaError>
    const decode = (value: unknown): Effect.Effect<Option.Option<unknown>> => {
      const transformed = link.transformation._tag === "Transformation"
        ? link.transformation.decode.run(Option.some(value), SchemaAST.defaultParseOptions)
        : link.transformation.decode(Effect.succeed(Option.some(value)), SchemaAST.defaultParseOptions)
      return Effect.flatMapEager(Effect.option(transformed), (outer) => {
        if (Option.isNone(outer) || Option.isNone(outer.value)) return Effect.succeedNone
        return Effect.option(decodeDeclaration(outer.value.value))
      }) as Effect.Effect<Option.Option<unknown>>
    }
    return Model.makeCompiled(
      [target, ...typeParameters],
      () => target.minCost,
      (state) =>
        Model.flatMapGeneration(target.generate(state), (attempt) => {
          if (attempt._tag === "Discarded") return Model.discarded
          return Effect.mapEager(
            Model.filterMapSample(attempt.sample, decode),
            (sample) => Option.isSome(sample) ? Model.generated(sample.value) : Model.discarded
          )
        })
    )
  }

  const root = recur(rootAst, [])
  for (let index = 0; index < pending.length; index++) pending[index]()
  markRecursiveSuspends(nodes, suspendBodies)
  const dependents = new Map<Model.Compiled<any>, Array<Model.Compiled<any>>>()
  for (const node of nodes) dependents.set(node, [])
  for (const node of nodes) {
    for (const dependency of node.dependencies) dependents.get(dependency)?.push(node)
  }
  const recursiveQueue = nodes.filter((node) => node.recursive)
  for (let index = 0; index < recursiveQueue.length; index++) {
    const node = recursiveQueue[index]
    if (node.mayRecurse) continue
    node.mayRecurse = true
    recursiveQueue.push(...dependents.get(node)!)
  }
  const queue = nodes.slice()
  const queued = new Set(nodes)
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]
    queued.delete(node)
    const next = node.computeMinCost()
    if (next >= node.minCost) continue
    node.minCost = next
    for (const dependent of dependents.get(node)!) {
      if (!queued.has(dependent)) {
        queued.add(dependent)
        queue.push(dependent)
      }
    }
  }
  if (root.minCost === infinity) {
    throw arbitraryError("a recursive schema without a finite generation path", [])
  }
  return root
}

function markRecursiveSuspends(
  nodes: ReadonlyArray<Model.Compiled<any>>,
  suspendBodies: ReadonlyMap<Model.Compiled<any>, Model.Compiled<any>>
): void {
  const visited = new Set<Model.Compiled<any>>()
  const finished: Array<Model.Compiled<any>> = []
  for (const root of nodes) {
    if (visited.has(root)) continue
    visited.add(root)
    const stack: Array<{ readonly node: Model.Compiled<any>; index: number }> = [{ node: root, index: 0 }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame.index < frame.node.dependencies.length) {
        const dependency = frame.node.dependencies[frame.index++]
        if (!visited.has(dependency)) {
          visited.add(dependency)
          stack.push({ node: dependency, index: 0 })
        }
      } else {
        finished.push(frame.node)
        stack.pop()
      }
    }
  }

  const reverse = new Map<Model.Compiled<any>, Array<Model.Compiled<any>>>()
  for (const node of visited) reverse.set(node, [])
  for (const node of visited) {
    for (const dependency of node.dependencies) reverse.get(dependency)?.push(node)
  }
  const component = new Map<Model.Compiled<any>, number>()
  let componentId = 0
  for (let index = finished.length - 1; index >= 0; index--) {
    const root = finished[index]
    if (component.has(root)) continue
    component.set(root, componentId)
    const stack = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      for (const dependency of reverse.get(node)!) {
        if (component.has(dependency)) continue
        component.set(dependency, componentId)
        stack.push(dependency)
      }
    }
    componentId++
  }
  for (const [suspend, body] of suspendBodies) {
    suspend.recursive = component.get(suspend) === component.get(body)
  }
}
