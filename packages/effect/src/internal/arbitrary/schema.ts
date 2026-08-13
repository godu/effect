import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Equal from "../../Equal.ts"
import * as Exit from "../../Exit.ts"
import * as Option from "../../Option.ts"
import * as Order from "../../Order.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import { errorWithPath } from "../errors.ts"
import * as InternalRecord from "../record.ts"
import * as Annotation from "./annotation.ts"
import * as Model from "./model.ts"

type Constraint = Schema.Annotations.ToArbitrary.GenerationConstraint
type OrderedConstraint = Schema.Annotations.ToArbitrary.OrderedConstraint<any>

interface Checks {
  readonly constraint: Constraint | undefined
  readonly filters: ReadonlyArray<SchemaAST.Filter<any>>
}

const infinity = Number.POSITIVE_INFINITY
const finiteNumberConstraint: Constraint = { noInfinity: true, noNaN: true }

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

function mergeOrdered(self: OrderedConstraint | undefined, that: OrderedConstraint): OrderedConstraint {
  if (self === undefined) return that
  if (self.order !== that.order) {
    throw new Error("Cannot merge ordered arbitrary constraints with different Order instances")
  }
  const [minimum, exclusiveMinimum] = mergeOrderedBound(
    self.order,
    self.minimum,
    self.exclusiveMinimum,
    that.minimum,
    that.exclusiveMinimum,
    -1
  )
  const [maximum, exclusiveMaximum] = mergeOrderedBound(
    self.order,
    self.maximum,
    self.exclusiveMaximum,
    that.maximum,
    that.exclusiveMaximum,
    1
  )
  return {
    order: self.order,
    ...(minimum === undefined ? undefined : { minimum }),
    ...(exclusiveMinimum === undefined ? undefined : { exclusiveMinimum }),
    ...(maximum === undefined ? undefined : { maximum }),
    ...(exclusiveMaximum === undefined ? undefined : { exclusiveMaximum })
  }
}

function mergeConstraint(self: Constraint | undefined, that: Constraint): Constraint {
  const minLength = self?.minLength === undefined
    ? that.minLength
    : that.minLength === undefined
    ? self.minLength
    : Math.max(self.minLength, that.minLength)
  const maxLength = self?.maxLength === undefined
    ? that.maxLength
    : that.maxLength === undefined
    ? self.maxLength
    : Math.min(self.maxLength, that.maxLength)
  const patterns = self?.patterns === undefined
    ? that.patterns
    : that.patterns === undefined
    ? self.patterns
    : [...self.patterns, ...that.patterns] as [string, ...Array<string>]
  const ordered = that.ordered === undefined ? self?.ordered : mergeOrdered(self?.ordered, that.ordered)
  return {
    ...(minLength === undefined ? undefined : { minLength }),
    ...(maxLength === undefined ? undefined : { maxLength }),
    ...(patterns === undefined ? undefined : { patterns }),
    ...(self?.integer === true || that.integer === true ? { integer: true } : undefined),
    ...(self?.noInfinity === true || that.noInfinity === true ? { noInfinity: true } : undefined),
    ...(self?.noNaN === true || that.noNaN === true ? { noNaN: true } : undefined),
    ...(self?.unique === true || that.unique === true ? { unique: true } : undefined),
    ...(ordered === undefined ? undefined : { ordered })
  }
}

function collectChecks(checks: SchemaAST.Checks | undefined, inherited: Constraint | undefined): Checks {
  let constraint = inherited
  const filters: Array<SchemaAST.Filter<any>> = []
  const visit = (check: SchemaAST.Check<any>): void => {
    const next = check.annotations?.arbitrary?.constraint
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

function lengthBounds(
  constraint: Constraint | undefined,
  fallbackMaximum: number,
  path: ReadonlyArray<PropertyKey>,
  label: string
): readonly [number, number] {
  const minimum = constraint?.minLength ?? 0
  const maximum = constraint?.maxLength ?? Math.max(minimum, fallbackMaximum)
  if (!Number.isSafeInteger(minimum) || minimum < 0 || !Number.isSafeInteger(maximum) || maximum < minimum) {
    throw arbitraryError(`${label} constraints`, path)
  }
  return [minimum, maximum]
}

function constant<A>(value: A): Model.Compiled<A> {
  return Model.makeCompiled([], () => 0, () => Effect.succeed(Model.generated(Model.makeSample(value))))
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
  readonly sample: Model.Sample<any>
  readonly removable: boolean
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
  const structural: Array<() => Model.Sample<Record<PropertyKey, any>>> = entries.length <= minimum
    ? []
    : entries.flatMap((entry, index) =>
      entry.removable
        ? [() => objectSample(entries.slice(0, index).concat(entries.slice(index + 1)), minimum)]
        : []
    )
  const pulls = structural.length === 0
    ? childPulls
    : [Model.mapPull(Model.pullFromArray(structural), (make) => make()), ...childPulls]
  return Model.makeSample(make(entries), pulls.length === 0 ? undefined : Model.concatPulls(pulls))
}

const generateWithReservedBudget = (
  child: Model.Compiled<any>,
  state: Model.GenerationState,
  reserved: number
): Effect.Effect<Model.Attempt<any>> => {
  if (child.minCost + reserved > state.budget.remaining) return Effect.succeed(Model.discarded)
  state.budget.remaining -= reserved
  return Effect.mapEager(child.generate(state), (attempt) => {
    state.budget.remaining += reserved
    return attempt
  })
}

const generateSamples = (
  children: ReadonlyArray<Model.Compiled<any>>,
  state: Model.GenerationState,
  additionalReserved = 0
): Effect.Effect<Option.Option<Array<Model.Sample<any>>>> => {
  let reserved = sumCosts(children.map((child) => child.minCost)) + additionalReserved
  if (reserved > state.budget.remaining) return Effect.succeed(Option.none())
  const out: Array<Model.Sample<any>> = []
  let index = 0
  const loop = (): Effect.Effect<Option.Option<Array<Model.Sample<any>>>> => {
    while (index < children.length) {
      const child = children[index++]
      reserved -= child.minCost
      const generated = generateWithReservedBudget(child, state, reserved)
      if (Exit.isExit(generated) && generated._tag === "Success") {
        const attempt = generated.value as Model.Attempt<any>
        if (attempt._tag === "Discarded") return Effect.succeed(Option.none())
        out.push(attempt.sample)
        continue
      }
      return Effect.flatMap(generated, (attempt) => {
        if (attempt._tag === "Discarded") return Effect.succeed(Option.none())
        out.push(attempt.sample)
        return loop()
      })
    }
    return Effect.succeed(Option.some(out))
  }
  return loop()
}

function shrinkString(value: string, minimum: number): ReadonlyArray<string> {
  if (value.length <= minimum) return []
  const values = [
    value.slice(0, minimum),
    value.slice(0, Math.max(minimum, Math.floor(value.length / 2))),
    value.slice(0, -1)
  ]
  return [...new Set(values)].filter((candidate) => candidate !== value)
}

function numberBounds(constraint: Constraint | undefined, integer: boolean, path: ReadonlyArray<PropertyKey>) {
  const ordered = constraint?.ordered?.order === Order.Number ? constraint.ordered : undefined
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
  if (integer || constraint?.noInfinity === true) {
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

function makeJson(): Model.Compiled<unknown> {
  let self: Model.Compiled<unknown>
  const leaf = (state: Model.GenerationState): Model.Sample<unknown> => {
    const choice = Model.randomIndex(state, 4)
    switch (choice) {
      case 0:
        return Model.makeSample(null)
      case 1:
        const number = Model.randomBetween(state, -100, 100)
        return state.shrinks
          ? numberSample(number, undefined, undefined, false)
          : Model.makeSample(number)
      case 2:
        return Model.makeSample(Model.randomBoolean(state))
      default: {
        const length = Model.randomInt(state, 0, 8)
        let value = ""
        for (let index = 0; index < length; index++) {
          value += globalThis.String.fromCharCode(Model.randomInt(state, 32, 126))
        }
        return state.shrinks
          ? Model.sampleFromShrink(value, (value) => shrinkString(value, 0))
          : Model.makeSample(value)
      }
    }
  }
  self = Model.makeCompiled<unknown>(
    [],
    () => 0,
    Effect.fnUntraced(function*(state) {
      const canRecur = state.budget.remaining > 0
      const choice = Model.randomIndex(state, canRecur ? 6 : 4)
      if (choice < 4) return Model.generated(leaf(state))
      state.budget.remaining--
      const length = Model.randomInt(state, 0, Math.max(0, Math.min(3, state.size)))
      const children = yield* generateSamples(Array.from({ length }, () => self), state)
      if (Option.isNone(children)) return Model.discarded
      if (choice === 4) {
        return Model.generated(arraySample(children.value, {
          fixedCount: 0,
          optionalCount: 0,
          repeatCount: children.value.length,
          tailCount: 0,
          minimum: 0
        }, state.shrinks))
      }
      const entries = children.value.map((sample, index) => ({ key: `key${index}`, sample, removable: true }))
      return Model.generated(objectSample(entries, 0, state.shrinks))
    })
  )
  self.minCost = 0
  return self
}

/** @internal */
export function compile<S extends Schema.Constraint>(schema: S): Model.Compiled<S["Type"]> {
  const rootAst = SchemaAST.toType(schema.ast)
  const defaultConstraint = Symbol.for("~effect/arbitrary/defaultConstraint")
  const cache = new WeakMap<SchemaAST.AST, Map<Constraint | symbol, Model.Compiled<any>>>()
  const nodes: Array<Model.Compiled<any>> = []
  const suspendBodies = new Map<Model.Compiled<any>, Model.Compiled<any>>()
  const json = makeJson()
  const constructors: Annotation.Constructors = {
    Json: () => json as unknown as Annotation.Arbitrary<any>
  }

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
      placeholder.generate = (state) => {
        if (placeholder.recursive) {
          if (state.budget.remaining <= 0) return Effect.succeed(Model.discarded)
          state.budget.remaining--
        }
        return body.generate(state)
      }
      suspendBodies.set(placeholder, body)
    } else {
      placeholder.dependencies = base.dependencies
      placeholder.computeMinCost = base.computeMinCost
      placeholder.generate = base.generate
    }
    if (checks.filters.length > 0) {
      const generate = placeholder.generate
      placeholder.generate = (state) =>
        Effect.mapEager(generate(state), (attempt) => {
          if (attempt._tag === "Discarded") return Model.discarded
          const sample = Model.filterSample(
            attempt.sample,
            (value) =>
              checks.filters.every((filter) => filter.run(value, ast, SchemaAST.defaultParseOptions) === undefined)
          )
          return Option.isSome(sample) ? Model.generated(sample.value) : Model.discarded
        })
    }
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
            return Effect.succeed(Model.generated(Model.makeSample(
              value,
              state.shrinks && value ? Model.pullFromArray([Model.makeSample(false)]) : undefined
            )))
          }
        )
      case "String": {
        const [minimum, maximum] = lengthBounds(constraint, 16, path, "string")
        return Model.makeCompiled(
          [],
          () => 0,
          (state) => {
            const upper = Math.min(maximum, Math.max(minimum, state.size * 2))
            const length = Model.randomInt(state, minimum, upper)
            let value = ""
            for (let index = 0; index < length; index++) {
              value += globalThis.String.fromCharCode(Model.randomInt(state, 32, 126))
            }
            return Effect.succeed(Model.generated(
              state.shrinks
                ? Model.sampleFromShrink(value, (value) => shrinkString(value, minimum))
                : Model.makeSample(value)
            ))
          }
        )
      }
      case "Number": {
        const integer = constraint?.integer === true
        const bounds = numberBounds(constraint, integer, path)
        return Model.makeCompiled(
          [],
          () => 0,
          (state) => {
            const magnitude = Math.max(1, state.size * state.size)
            const center = bounds.minimum !== undefined && bounds.minimum > 0
              ? bounds.minimum
              : bounds.maximum !== undefined && bounds.maximum < 0
              ? bounds.maximum
              : 0
            const minimum = bounds.minimum ?? center - magnitude
            const maximum = bounds.maximum ?? center + magnitude
            let value: number
            if (
              !integer && bounds.minimum === undefined && bounds.maximum === undefined && constraint?.noNaN !== true
            ) {
              const special = Model.randomIndex(state, constraint?.noInfinity === true ? 20 : 24)
              value = special === 20 ? Number.NaN : special === 21 ? Number.POSITIVE_INFINITY : special === 22
                ? Number.NEGATIVE_INFINITY
                : Model.randomBetween(state, minimum, maximum)
            } else {
              value = integer
                ? Model.randomInt(state, minimum, maximum)
                : Model.randomNumber(state, minimum, maximum)
            }
            return Effect.succeed(Model.generated(
              state.shrinks
                ? numberSample(value, bounds.minimum, bounds.maximum, integer)
                : Model.makeSample(value)
            ))
          }
        )
      }
      case "BigInt": {
        const ordered = constraint?.ordered?.order === Order.BigInt ? constraint.ordered : undefined
        let minimum = ordered?.minimum as bigint | undefined
        let maximum = ordered?.maximum as bigint | undefined
        if (minimum !== undefined && ordered?.exclusiveMinimum === true) minimum++
        if (maximum !== undefined && ordered?.exclusiveMaximum === true) maximum--
        if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
          throw arbitraryError("bigint constraints", path)
        }
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
            const value = Model.randomBigInt(state, low, high)
            return Effect.succeed(Model.generated(
              state.shrinks
                ? Model.sampleFromShrink(value, (value) => value === BigInt(0) ? [] : [BigInt(0)])
                : Model.makeSample(value)
            ))
          }
        )
      }
      case "Symbol": {
        const strings = recur(SchemaAST.string, path, constraint)
        return Model.makeCompiled(
          [strings],
          () => strings.minCost,
          (state) =>
            Effect.mapEager(strings.generate(state), (attempt) =>
              attempt._tag === "Discarded"
                ? attempt
                : Model.generated(Model.mapSample(attempt.sample, (value) => Symbol.for(value))))
        )
      }
      case "Unknown":
      case "Any":
        return json
      case "ObjectKeyword":
        return Model.makeCompiled(
          [json],
          () => 0,
          Effect.fnUntraced(function*(state) {
            const attempt = yield* json.generate(state)
            if (
              attempt._tag === "Generated" && typeof attempt.sample.value === "object" && attempt.sample.value !== null
            ) {
              return attempt
            }
            return Model.generated(Model.makeSample({}))
          })
        )
      case "Enum": {
        const values = [...new Set(ast.enums.map(([, value]) => value))]
        if (values.length === 0) throw arbitraryError("an enum with no members", path)
        return Model.makeCompiled(
          [],
          () => 0,
          (state) => Effect.succeed(Model.generated(Model.makeSample(values[Model.randomIndex(state, values.length)])))
        )
      }
      case "TemplateLiteral": {
        const parts = ast.parts.map((part, index) => recur(part, [...path, index], finiteNumberConstraint))
        return Model.makeCompiled(
          parts,
          () => sumCosts(parts.map((part) => part.minCost)),
          Effect.fnUntraced(function*(state) {
            const generated = yield* generateSamples(parts, state)
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
          Effect.fnUntraced(
            function*(state) {
              const eligible = members.filter((member) => member.minCost <= state.budget.remaining)
              if (eligible.length === 0) return Model.discarded
              const selected = eligible[Model.randomIndex(state, eligible.length)]
              const attempt = yield* selected.generate(state)
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
                  fallback.generate({ ...state, budget: { remaining: fallback.minCost } }),
                  (attempt) => attempt._tag === "Generated" ? Effect.succeed(attempt.sample) : Cause.done()
                )
              })
              return Model.generated(Model.makeSample(
                attempt.sample.value,
                attempt.sample.shrinks === undefined
                  ? fallbackPull
                  : Model.concatPulls([fallbackPull, attempt.sample.shrinks])
              ))
            }
          )
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
    const [minimum, maximum] = lengthBounds(constraint, Math.max(elements.length + tail.length, 8), path, "array")
    if (head === undefined && (minimum > elements.length || maximum < required)) {
      throw arbitraryError("array constraints", path)
    }
    const dependencies = [...elements.map((element) => element.compiled), ...rest]
    const combinations = (limit: number): Array<readonly [optional: number, repeat: number, cost: number]> => {
      const out: Array<readonly [number, number, number]> = []
      const requiredCost = sumCosts(elements.slice(0, required).map((element) => element.compiled.minCost))
      const tailCost = sumCosts(tail.map((element) => element.minCost))
      for (let optionalCount = 0; optionalCount <= optional; optionalCount++) {
        const fixed = required + optionalCount + tail.length
        const minimumRepeat = Math.max(0, minimum - fixed)
        const maximumRepeat = head === undefined ? 0 : Math.max(minimumRepeat, Math.min(maximum - fixed, limit))
        if (fixed + minimumRepeat > maximum || head === undefined && minimumRepeat > 0) continue
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
        const possible = combinations(Math.max(minimum, state.size)).filter(([, , cost]) =>
          cost <= state.budget.remaining
        )
        if (possible.length === 0) return Effect.succeed(Model.discarded)
        const [optionalCount, repeatCount] = possible[Model.randomIndex(state, possible.length)]
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
        if (constraint?.unique !== true) {
          return Effect.mapEager(
            generateSamples(selected, state),
            (generated) => Option.isNone(generated) ? Model.discarded : makeAttempt(generated.value)
          )
        }
        // Constructive uniqueness with bounded duplicate retries follows fast-check v4.9.0's ArrayArbitrary strategy
        // (MIT).
        // Effect.Equal defines the equality semantics here.
        // https://github.com/dubzzz/fast-check/blob/v4.9.0/packages/fast-check/src/arbitrary/_internals/ArrayArbitrary.ts
        const generated: Array<Model.Sample<any>> = []
        let reserved = sumCosts(selected.map((child) => child.minCost))
        let index = 0
        let retries = 0
        let budget = state.budget.remaining
        const loop = (): Effect.Effect<Model.Attempt<ReadonlyArray<any>>> => {
          while (index < selected.length) {
            const child = selected[index]
            if (retries === 0) {
              reserved -= child.minCost
              budget = state.budget.remaining
            }
            const effect = generateWithReservedBudget(child, state, reserved)
            if (Exit.isExit(effect) && effect._tag === "Success") {
              const attempt = effect.value as Model.Attempt<any>
              if (attempt._tag === "Discarded") return Effect.succeed(Model.discarded)
              if (generated.some((other) => Equal.equals(other.value, attempt.sample.value))) {
                if (retries++ >= 10) return Effect.succeed(Model.discarded)
                state.budget.remaining = budget
                continue
              }
              generated.push(attempt.sample)
              index++
              retries = 0
              continue
            }
            return Effect.flatMap(effect, (attempt) => {
              if (attempt._tag === "Discarded") return Effect.succeed(Model.discarded)
              if (generated.some((other) => Equal.equals(other.value, attempt.sample.value))) {
                if (retries++ >= 10) return Effect.succeed(Model.discarded)
                state.budget.remaining = budget
              } else {
                generated.push(attempt.sample)
                index++
                retries = 0
              }
              return loop()
            })
          }
          return Effect.succeed(makeAttempt(generated))
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
    const [minimum, maximum] = lengthBounds(constraint, Math.max(properties.length, 8), path, "object property")
    if (maximum < required.length || indexes.length === 0 && minimum > properties.length) {
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
        const maxOptional = Math.min(optional.length, maximum - required.length)
        const minOptional = indexes.length === 0 ? Math.max(0, minimum - required.length) : 0
        const optionalCount = Model.randomInt(state, minOptional, maxOptional)
        const selectedOptional = optionalCount === 0 ? [] : Model.shuffle(state, optional).slice(0, optionalCount)
        const named = [...required, ...selectedOptional]
        const minimumIndexes = Math.max(0, minimum - named.length)
        const maximumIndexes = indexes.length === 0
          ? 0
          : Math.min(maximum - named.length, Math.max(minimumIndexes, state.size))
        const minimumIndexCost = indexes.length === 0
          ? infinity
          : Math.min(...indexes.map((index) => index.parameter.minCost + index.value.minCost))
        const namedCost = sumCosts(named.map((property) => property.compiled.minCost))
        const affordableIndexes = minimumIndexCost === 0
          ? maximumIndexes
          : minimumIndexCost === infinity
          ? 0
          : Math.min(maximumIndexes, Math.floor((state.budget.remaining - namedCost) / minimumIndexCost))
        if (affordableIndexes < minimumIndexes) return Effect.succeed(Model.discarded)
        const indexCount = Model.randomInt(state, minimumIndexes, affordableIndexes)
        const indexReserved = indexCount === 0 ? 0 : indexCount * minimumIndexCost
        return Effect.flatMapEager(
          generateSamples(named.map((property) => property.compiled), state, indexReserved),
          (samples) => {
            if (Option.isNone(samples)) return Effect.succeed(Model.discarded)
            const entries: Array<ObjectEntry> = samples.value.map((sample, index) => ({
              key: named[index].property.name,
              sample,
              removable: named[index].optional
            }))
            if (indexCount === 0) {
              return Effect.succeed(Model.generated(objectSample(entries, minimum, state.shrinks)))
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
                let keyAttempt = yield* generateWithReservedBudget(index.parameter, state, reservedAfterKey)
                let retries = 0
                while (true) {
                  if (keyAttempt._tag === "Discarded") return Model.discarded
                  const key = keyAttempt.sample.value
                  if (!entries.some((entry) => entry.key === key)) break
                  if (retries++ >= 10) return Model.discarded
                  state.budget.remaining = budget
                  keyAttempt = yield* generateWithReservedBudget(index.parameter, state, reservedAfterKey)
                }
                const key = keyAttempt.sample.value
                if (
                  (typeof key !== "string" && typeof key !== "number" && typeof key !== "symbol") ||
                  entries.some((entry) => entry.key === key)
                ) return Model.discarded
                const value = yield* generateWithReservedBudget(index.value, state, futureReserved)
                if (value._tag === "Discarded") return Model.discarded
                entries.push({ key, sample: value.sample, removable: true })
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
    const typeParameters = ast.typeParameters.map((parameter, index) => recur(parameter, [...path, index]))
    const annotation = ast.annotations?.[Annotation.ToArbitraryKey]
    if (typeof annotation === "function") {
      const compiled = (annotation as Annotation.ToArbitrary<any>)(
        typeParameters as unknown as ReadonlyArray<Annotation.Arbitrary<unknown>>
      )(constructors) as unknown as Model.Compiled<any>
      return Model.makeCompiled(
        [compiled, ...typeParameters],
        () => compiled.minCost,
        (state) => compiled.generate(state)
      )
    }
    const parameters = ast.typeParameters.map((parameter) => Schema.make(SchemaAST.toType(parameter)))
    const getJson = ast.annotations?.toCodecJson
    const link: SchemaAST.Link = typeof getJson === "function"
      ? (() => {
        const link = getJson(parameters)
        if (link === undefined) throw arbitraryError("an opaque self-canonical Declaration", path)
        return link
      })()
      : (() => {
        const get = ast.annotations?.toCodec
        if (typeof get !== "function") throw arbitraryError("an unsupported Declaration", path)
        return get(parameters)
      })()
    const target = recur(SchemaAST.toType(link.to), path, constraint)
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
        Effect.flatMapEager(target.generate(state), (attempt) => {
          if (attempt._tag === "Discarded") return Effect.succeed(Model.discarded)
          return Effect.mapEager(
            Model.filterMapSample(attempt.sample, decode),
            (sample) => Option.isSome(sample) ? Model.generated(sample.value) : Model.discarded
          )
        })
    )
  }

  const root = recur(rootAst, [])
  markRecursiveSuspends(nodes, suspendBodies)
  for (let pass = 0; pass <= nodes.length; pass++) {
    let changed = false
    for (const node of nodes) {
      const next = node.computeMinCost()
      if (next < node.minCost) {
        node.minCost = next
        changed = true
      }
    }
    if (!changed) break
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
  let nextIndex = 0
  const indexes = new Map<Model.Compiled<any>, number>()
  const lowLinks = new Map<Model.Compiled<any>, number>()
  const stack: Array<Model.Compiled<any>> = []
  const onStack = new Set<Model.Compiled<any>>()
  const component = new Map<Model.Compiled<any>, number>()
  let componentId = 0

  const visit = (node: Model.Compiled<any>): void => {
    const index = nextIndex++
    indexes.set(node, index)
    lowLinks.set(node, index)
    stack.push(node)
    onStack.add(node)
    for (const dependency of node.dependencies) {
      if (!indexes.has(dependency)) {
        visit(dependency)
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!))
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indexes.get(dependency)!))
      }
    }
    if (lowLinks.get(node) !== index) return
    while (stack.length > 0) {
      const member = stack.pop()!
      onStack.delete(member)
      component.set(member, componentId)
      if (member === node) break
    }
    componentId++
  }

  nodes.forEach((node) => {
    if (!indexes.has(node)) visit(node)
  })
  for (const [suspend, body] of suspendBodies) {
    suspend.recursive = component.get(suspend) === component.get(body)
  }
}
