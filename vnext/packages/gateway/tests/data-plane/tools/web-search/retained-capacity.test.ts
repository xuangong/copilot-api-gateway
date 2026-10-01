import { expect, test } from "bun:test"
import { createOwnedRetainedMap, estimateRetainedCharge, createGeneratedStateAdmission, WebSearchCapacityError } from "../../../../src/data-plane/tools/web-search/capacity"

test("estimator includes own extensions and duplicate graphs without invoking accessors", () => {
  expect(estimateRetainedCharge("ab", "privateBytes", 100)).toBe(36)
  expect(estimateRetainedCharge({ a: 1 }, "privateBytes", 200)).toBe(122)
  const value = { a: "x" }; Object.defineProperty(value, "hidden", { value: "z".repeat(100) })
  expect(() => estimateRetainedCharge(value, "privateBytes", 200)).toThrow(WebSearchCapacityError)
  const shared = { a: 1 }
  expect(estimateRetainedCharge([shared, shared], "privateBytes", 1000)).toBe(492)
  let reads = 0
  const getter = Object.defineProperty({}, "secret", { get() { reads++; return "x" } })
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  for (const invalid of [getter, cycle, new Date(), () => {}, { [Symbol()]: 1 }]) expect(() => estimateRetainedCharge(invalid, "privateBytes", 10000)).toThrow(WebSearchCapacityError)
  expect(reads).toBe(0)
  let deep: unknown = null
  for (let i = 0; i < 66; i++) deep = { deep }
  expect(() => estimateRetainedCharge(deep, "privateBytes", 100000)).toThrow(WebSearchCapacityError)
  expect(() => estimateRetainedCharge(new Array(65537).fill(null), "privateBytes", 4000000)).toThrow(WebSearchCapacityError)
})

test("owned map charges exact key/value boundaries with atomic replacement and close", () => {
  const map = createOwnedRetainedMap<string>({ entries: 1, bytes: 68, entriesCategory: "pageEntries", bytesCategory: "pageBytes" })
  map.set("a", "b")
  expect(() => map.set("a", "bb")).toThrow(WebSearchCapacityError)
  expect(map.get("a")).toBe("b")
  map.set("a", "c")
  expect(() => map.set("b", "c")).toThrow(WebSearchCapacityError)
  map.clear()
  expect(map.get("a")).toBeUndefined()
  expect(() => map.set("a", "b")).toThrow("closed")
})

test("generated admission charges additions monotonically", () => {
  const admit = createGeneratedStateAdmission(68)
  admit("a"); admit("b")
  expect(() => admit("c")).toThrow(WebSearchCapacityError)
})

test("replacement refunds only its prior charge and rejected insertion keeps unrelated data", () => {
  const map = createOwnedRetainedMap<string>({ entries: 2, bytes: 140, entriesCategory: "privateEntries", bytesCategory: "privateBytes" })
  map.set("a", "bbb")
  map.set("b", "b")
  expect(() => map.set("a", "bbbb")).toThrow(WebSearchCapacityError)
  expect(map.get("a")).toBe("bbb")
  expect(map.get("b")).toBe("b")
  map.set("a", "a")
  map.set("b", "bbb")
  expect(map.get("b")).toBe("bbb")
})

test("retirement during reflection cannot publish a late retained entry", () => {
  const map = createOwnedRetainedMap<unknown>({ entries: 2, bytes: 1000, entriesCategory: "pageEntries", bytesCategory: "pageBytes" })
  const value = new Proxy({}, { ownKeys() { map.clear(); return [] } })
  expect(() => map.set("key", value)).toThrow("closed")
  expect(map.get("key")).toBeUndefined()
})

test("estimator accepts depth 64 and rejects depth 65", () => {
  let depth64: unknown = null
  for (let i = 0; i < 64; i++) depth64 = { deep: depth64 }
  expect(estimateRetainedCharge(depth64, "privateBytes", 100000)).toBe(7688)
  expect(() => estimateRetainedCharge({ deep: depth64 }, "privateBytes", 100000)).toThrow(WebSearchCapacityError)
})

test("estimator accepts 65536 visited values and rejects the next including an optional key", () => {
  // The array itself and its own length value each consume one visit.
  expect(estimateRetainedCharge(new Array(65534).fill(null), "privateBytes", 16000000)).toBeGreaterThan(0)
  expect(() => estimateRetainedCharge(new Array(65535).fill(null), "privateBytes", 16000000)).toThrow(WebSearchCapacityError)
  expect(estimateRetainedCharge(new Array(65533).fill(null), "privateBytes", 16000000, "a")).toBeGreaterThan(0)
  expect(() => estimateRetainedCharge(new Array(65534).fill(null), "privateBytes", 16000000, "a")).toThrow(WebSearchCapacityError)
})

test("nested insertion during reflection consumes the last entry before outer admission", () => {
  const map = createOwnedRetainedMap<unknown>({ entries: 1, bytes: 1000, entriesCategory: "pageEntries", bytesCategory: "pageBytes" })
  const value = new Proxy({}, { ownKeys() { map.set("nested", "kept"); return [] } })
  expect(() => map.set("outer", value)).toThrow(new WebSearchCapacityError("pageEntries", 1))
  expect(map.get("outer")).toBeUndefined()
  expect(map.get("nested")).toBe("kept")
  expect(() => map.set("later", "rejected")).toThrow(WebSearchCapacityError)
})

test("nested same-key replacement is refunded at its current charge after reflection", () => {
  const map = createOwnedRetainedMap<unknown>({ entries: 4, bytes: 334, entriesCategory: "privateEntries", bytesCategory: "privateBytes" })
  map.set("a", "a")
  map.set("b", "b")
  const value = new Proxy({}, { ownKeys() { map.set("a", "x".repeat(100)); return [] } })
  map.set("a", value)
  expect(map.get("a")).toBe(value)
  expect(map.get("b")).toBe("b")
  // a=98, b=68, c=168 exactly fill the domain after the nested replacement.
  map.set("c", "x".repeat(51))
  expect(map.get("c")).toBe("x".repeat(51))
  expect(() => map.set("d", "d")).toThrow(new WebSearchCapacityError("privateBytes", 334))
  expect(map.get("d")).toBeUndefined()
  expect(map.get("a")).toBe(value)
})
