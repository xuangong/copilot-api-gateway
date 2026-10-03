import { expect, spyOn, test } from "bun:test"
import { analyzeAffinityRequest } from "../../src/shared/affinity/analysis"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object")
  return value as Record<string, unknown>
}

test("deep JSON inputs keep isolated canonical and attempt containers without recursive copying", async () => {
  const depth = 12_000
  const source = { input: "hello", extra: JSON.parse('{"nested":'.repeat(depth) + '"leaf"' + '}'.repeat(depth)) as unknown }
  const plan = await analyzeAffinityRequest("responses", source)
  const first = plan.materialize(undefined)
  const second = plan.materialize(undefined)
  let original = object(source.extra), left = object(first.extra), right = object(second.extra)
  for (let index = 1; index < depth; index++) {
    expect(left === original || left === right).toBe(false)
    original = object(original.nested); left = object(left.nested); right = object(right.nested)
  }
  left.nested = "mutated"
  expect(original.nested).toBe("leaf")
  expect(right.nested).toBe("leaf")
})

test("JSON copy preserves dangerous property names, array holes and repeated references without prototype changes", async () => {
  const parsed = object(JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"toString":"literal"}'))
  const sparse = new Array<unknown>(3)
  sparse[2] = parsed
  const plan = await analyzeAffinityRequest("responses", { input: "hello", a: parsed, b: parsed, sparse })
  const copy = plan.materialize(undefined)
  expect(Object.getPrototypeOf(copy.a)).toBe(Object.prototype)
  expect(Object.hasOwn(object(copy.a), "__proto__")).toBe(true)
  expect(object(copy.a).__proto__).toEqual({ polluted: true })
  expect(object(copy.a).polluted).toBeUndefined()
  expect(copy.a).toBe(copy.b)
  expect((copy.sparse as unknown[])[2]).toBe(copy.a)
  expect(0 in (copy.sparse as unknown[])).toBe(false)
  object(copy.a).toString = "changed"
  expect(parsed.toString).toBe("literal")
})

test("runtime-only values preserve structured clone behavior instead of JSON serialization semantics", async () => {
  const cyclic: Record<string, unknown> = { missing: undefined, number: NaN, integer: 5n }
  cyclic.self = cyclic
  const source = { input: "hello", cyclic, date: new Date(123), bytes: new Uint8Array([1, 2]), map: new Map([["item", cyclic]]) }
  const plan = await analyzeAffinityRequest("responses", source)
  const copy = plan.materialize(undefined)
  expect(copy).toEqual(structuredClone(source))
  expect(object(copy.cyclic).self).toBe(copy.cyclic)
  expect(Object.hasOwn(object(copy.cyclic), "missing")).toBe(true)
  expect((copy.map as Map<string, unknown>).get("item")).toBe(copy.cyclic)
  const bytes = copy.bytes as Uint8Array
  bytes[0] = 9
  expect(source.bytes[0]).toBe(1)
})

test("accessor fallback reads once and unsupported values still fail closed", async () => {
  let reads = 0
  const plan = await analyzeAffinityRequest("responses", { input: "hello", nested: { get value() { reads++; return { text: "original" } } } })
  expect(reads).toBe(1)
  const first = plan.cloneSource()
  object(object(first.nested).value).text = "mutated"
  expect(plan.cloneSource().nested).toEqual({ value: { text: "original" } })
  for (const unsupported of [() => {}, Symbol("private")]) {
    await expect(analyzeAffinityRequest("responses", { input: "hello", unsupported })).rejects.toThrow()
  }
})

test("analysis keeps root spread getter evaluation and self-reference topology", async () => {
  let reads = 0
  const getterSource = { input: "hello", get extra() { reads++; return { text: "original" } } }
  const getterPlan = await analyzeAffinityRequest("responses", getterSource)
  expect(reads).toBe(1)
  object(getterPlan.cloneSource().extra).text = "mutated"
  expect(getterPlan.materialize(undefined).extra).toEqual({ text: "original" })
  expect(reads).toBe(1)

  const source: Record<string, unknown> = { input: "hello" }
  source.self = source
  source.alias = source
  const plan = await analyzeAffinityRequest("responses", source)
  const first = plan.cloneSource()
  const second = plan.materialize(undefined)
  expect(first.self).not.toBe(first)
  expect(first.self).toBe(first.alias)
  expect(object(first.self).self).toBe(first.self)
  expect(object(first.self).alias).toBe(first.self)
  expect(second.self).not.toBe(second)
  expect(second.self).toBe(second.alias)
  expect(second.self).not.toBe(first.self)
  object(first.self).input = "mutated"
  expect(object(second.self).input).toBe("hello")
  expect(source.input).toBe("hello")
})

test("plain cyclic aliases retain sparse lengths, extra fields and null-prototype normalization", async () => {
  const shared: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  shared.text = "original"
  shared.self = shared
  const sparse = new Array<unknown>(4)
  sparse[2] = shared
  Object.defineProperty(sparse, "extra", { value: shared, enumerable: true })
  const plan = await analyzeAffinityRequest("responses", { input: "hello", shared, alias: shared, sparse })
  const first = plan.cloneSource()
  const second = plan.materialize(undefined)
  expect(first.shared).toBe(first.alias)
  expect(object(first.shared).self).toBe(first.shared)
  expect(Object.getPrototypeOf(first.shared)).toBe(Object.prototype)
  expect((first.sparse as unknown[]).length).toBe(4)
  expect(0 in (first.sparse as unknown[])).toBe(false)
  expect(3 in (first.sparse as unknown[])).toBe(false)
  expect((first.sparse as unknown[])[2]).toBe(first.shared)
  expect(Object.getOwnPropertyDescriptor(first.sparse, "extra")?.value).toBe(first.shared)
  expect(first.shared).not.toBe(second.shared)
  object(first.shared).text = "mutated"
  expect(object(second.shared).text).toBe("original")
  expect(shared.text).toBe("original")
})

test("capture and subsequent copies define own data fields without invoking inherited setters", async () => {
  const source = { input: "hello", nested: { affinityCopySetter: "original" } }
  let writes = 0
  Object.defineProperty(Object.prototype, "affinityCopySetter", { configurable: true, set() { writes++ } })
  try {
    const plan = await analyzeAffinityRequest("responses", source)
    const first = plan.cloneSource()
    const second = plan.materialize(undefined)
    expect(writes).toBe(0)
    expect(Object.getOwnPropertyDescriptor(first.nested, "affinityCopySetter")).toEqual({
      value: "original", enumerable: true, configurable: true, writable: true,
    })
    object(first.nested).affinityCopySetter = "mutated"
    expect(writes).toBe(0)
    expect(object(second.nested).affinityCopySetter).toBe("original")
    expect(source.nested.affinityCopySetter).toBe("original")
  } finally { Reflect.deleteProperty(Object.prototype, "affinityCopySetter") }
})

test("late accessor fallback discards partial capture and keeps subsequent plain copies checked", async () => {
  let reads = 0
  const shared = { text: "original" }
  const late = { get value() { reads++; return shared } }
  const source = { input: "hello", late, earlier: { shared }, alias: shared }
  const native = spyOn(globalThis, "structuredClone")
  try {
    const plan = await analyzeAffinityRequest("responses", source)
    expect(reads).toBe(1)
    const descriptors = spyOn(Object, "getOwnPropertyDescriptor")
    let first: Record<string, unknown>, second: Record<string, unknown>, inspections: number
    try {
      first = plan.cloneSource()
      second = plan.materialize(undefined)
      inspections = descriptors.mock.calls.length
    } finally { descriptors.mockRestore() }
    expect(inspections).toBeGreaterThan(0)
    expect(native).toHaveBeenCalledTimes(1)
    expect(object(first.late).value).toBe(first.alias)
    expect(object(first.earlier).shared).toBe(first.alias)
    expect(object(second.late).value).toBe(second.alias)
    expect(first.alias).not.toBe(second.alias)
    object(first.alias).text = "mutated"
    shared.text = "source mutation"
    expect(object(second.alias).text).toBe("original")
    expect(object(plan.cloneSource().alias).text).toBe("original")
    expect(reads).toBe(1)
    expect(native).toHaveBeenCalledTimes(1)
  } finally { native.mockRestore() }
})

test("late runtime fallback retains runtime identities within independent subsequent copies", async () => {
  const shared = { text: "original" }
  const source = { input: "hello", late: { map: new Map([["shared", shared]]) }, earlier: { shared }, alias: shared }
  const native = spyOn(globalThis, "structuredClone")
  try {
    const plan = await analyzeAffinityRequest("responses", source)
    const first = plan.cloneSource()
    const second = plan.materialize(undefined)
    expect(native).toHaveBeenCalledTimes(3)
    expect((object(first.late).map as Map<string, unknown>).get("shared")).toBe(first.alias)
    expect(object(first.earlier).shared).toBe(first.alias)
    expect((object(second.late).map as Map<string, unknown>).get("shared")).toBe(second.alias)
    expect(first.alias).not.toBe(second.alias)
    object(first.alias).text = "mutated"
    const firstMap = object(first.late).map as Map<string, unknown>
    firstMap.clear()
    expect(object(second.alias).text).toBe("original")
    expect(source.late.map.get("shared")).toBe(shared)
  } finally { native.mockRestore() }
})

// Delegating primitive spies check repeated discovery only, without asserting
// runtime, allocation size or heap usage. The observation stays synchronous.
test("private plain snapshot copies skip repeated prototype and descriptor discovery", async () => {
  const plan = await analyzeAffinityRequest("responses", { input: "hello", nested: { text: "original" }, list: [1, { value: 2 }] })
  const prototypes = spyOn(Object, "getPrototypeOf")
  const descriptors = spyOn(Object, "getOwnPropertyDescriptor")
  let first: Record<string, unknown>, second: Record<string, unknown>, prototypeCalls: number, descriptorCalls: number
  try {
    first = plan.cloneSource()
    second = plan.materialize(undefined)
    prototypeCalls = prototypes.mock.calls.length
    descriptorCalls = descriptors.mock.calls.length
  } finally { descriptors.mockRestore(); prototypes.mockRestore() }
  expect(first).toEqual(second)
  expect(first.nested).not.toBe(second.nested)
  expect(prototypeCalls).toBe(0)
  expect(descriptorCalls).toBe(0)
})

// Native structuredClone serializes string values on the target runtimes. This
// allocation budget guards the large ordinary-input regression without a flaky
// timing/heap threshold; the spy delegates to the real clone implementation.
test("ordinary JSON snapshot and attempts avoid native whole-value serialization", async () => {
  const source = { input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(1024 * 1024) }] }] }
  const native = spyOn(globalThis, "structuredClone")
  try {
    const plan = await analyzeAffinityRequest("responses", source)
    const attempt = plan.materialize(undefined)
    expect(attempt).toEqual(source)
    expect(native).toHaveBeenCalledTimes(0)
  } finally { native.mockRestore() }
})
