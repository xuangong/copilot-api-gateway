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
