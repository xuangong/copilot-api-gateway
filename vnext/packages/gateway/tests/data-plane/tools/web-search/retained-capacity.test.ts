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
