import { expect, test } from "bun:test"
import { DumpCaptureBudget } from "../src/shared/dump/capture-budget.ts"

test("capture reservations share a bounded environment and release exactly once", () => {
  const budget = new DumpCaptureBudget({ captureBytes: 1000, environmentBytes: 1500, frames: 2 })
  const a = budget.open(), b = budget.open()
  expect(a.bytes(900)).toBe(true)
  expect(b.bytes(700)).toBe(false)
  expect(b.reason).toBe("environment_limit")
  expect(b.bytes(1)).toBe(false)
  expect(budget.retainedBytes).toBe(900)
  a.release()
  a.release()
  expect(budget.retainedBytes).toBe(0)
  const c = budget.open()
  expect(c.bytes(1001)).toBe(false)
  expect(c.reason).toBe("capture_limit")
})

test("bounded graph admission never invokes getters or serializes oversized strings", () => {
  const budget = new DumpCaptureBudget({ captureBytes: 1000 })
  let invoked = false
  const accessor = budget.open()
  expect(accessor.graph({ get data() { invoked = true; return "secret" } })).toBe(false)
  expect(accessor.reason).toBe("unsupported_payload")
  expect(invoked).toBe(false)
  const big = budget.open()
  expect(big.graph({ text: "x".repeat(1_000_000) })).toBe(false)
  expect(big.reason).toBe("capture_limit")
  expect(budget.retainedBytes).toBe(0)
  const sparse = budget.open()
  expect(sparse.graph(new Array(1_000_000))).toBe(false)
  expect(sparse.reason).toBe("capture_limit")
})

test("frame count and cyclic/deep graphs fail with an explicit capture outcome", () => {
  const budget = new DumpCaptureBudget({ frames: 1 })
  const capture = budget.open()
  expect(capture.frame({ type: "event", event: { text: "ok" } })).toEqual({ value: { type: "event", event: { text: "ok" } } })
  expect(capture.frame({ type: "event", event: { text: "extra" } })).toBeUndefined()
  expect(capture.reason).toBe("frame_limit")
  capture.release()
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  const cyclic = budget.open()
  expect(cyclic.graph(cycle)).toBe(false)
  expect(cyclic.reason).toBe("unsupported_payload")
  expect(budget.retainedBytes).toBe(0)
})

test("private projections omit hidden state, preserve JSON order and reject custom serialization", () => {
  const budget = new DumpCaptureBudget()
  const source = { text: "original", nested: { value: 1 } }
  Object.defineProperty(source, "private", { value: { retained: "x".repeat(1_000_000) } })
  Object.defineProperty(source, Symbol("private"), { value: () => source })
  const capture = budget.open()
  const captured = capture.project(source)
  expect(captured).toBeDefined()
  expect(JSON.stringify(captured?.value)).toBe(JSON.stringify(source))
  expect(Reflect.ownKeys(captured?.value ?? {})).toEqual(["text", "nested"])
  source.nested.value = 2
  expect(captured?.value.nested.value).toBe(1)
  capture.release()
  let invoked = false
  const custom = Object.defineProperty({}, "toJSON", { value: () => { invoked = true; return "different" } })
  const rejected = budget.open()
  expect(rejected.graph(custom)).toBe(false)
  expect(rejected.reason).toBe("unsupported_payload")
  expect(invoked).toBe(false)
})

test("array projection keeps non-enumerable indices and ordinary toJSON data fields exact", () => {
  const budget = new DumpCaptureBudget({ captureBytes: 1000 })
  const array = ["keep"]
  Object.defineProperty(array, "0", { enumerable: false })
  Object.defineProperty(array, "extra", { enumerable: true, value: "x".repeat(1_000_000) })
  const capture = budget.open()
  const projected = capture.project({ array, toJSON: "user-data" })
  expect(projected).toBeDefined()
  expect(JSON.stringify(projected?.value)).toBe(JSON.stringify({ array, toJSON: "user-data" }))
  expect(Reflect.ownKeys(projected?.value.array ?? [])).toEqual(["0", "length"])
  capture.release()
  expect(budget.retainedBytes).toBe(0)
})
