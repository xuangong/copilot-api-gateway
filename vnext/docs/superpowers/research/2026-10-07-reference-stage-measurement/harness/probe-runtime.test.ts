import { expect, test } from "bun:test"
import { createProbe } from "./probe-runtime"

test("probe attributes overlapping continuations and retains only bounded numeric observations", async () => {
  let time = 0
  const probe = createProbe(() => ++time, 3)
  await Promise.all(["one", "two"].map(id => probe.run(id, async () => {
    probe.emit("mark", "entry")
    await Promise.resolve()
    probe.emit("count", "copies", id === "one" ? 2 : 4)
    probe.emit("mark", "ready")
    probe.emit("mark", "end")
    probe.emit("mark", "overflow")
  })))
  const traces = probe.snapshot()
  expect(traces).toHaveLength(2)
  expect(traces.find(trace => trace.id === "one")?.counts.copies).toBe(2)
  expect(traces.find(trace => trace.id === "two")?.counts.copies).toBe(4)
  expect(traces.every(trace => trace.marks.length === 3 && trace.overflow)).toBe(true)
})

test("probe rejects duplicate ownership and counts unowned hooks separately", () => {
  const probe = createProbe(() => 1, 10)
  probe.emit("mark", "startup")
  probe.run("one", () => probe.emit("count", "counter", 1))
  expect(() => probe.run("one", () => {})).toThrow("duplicate")
  expect(probe.unowned()).toBe(1)
  expect(probe.snapshot()[0]?.counts.counter).toBe(1)
})

test("counter overflow is flagged without replacing the last precise observation", () => {
  const probe = createProbe(() => 1)
  probe.run("one", () => {
    probe.emit("count", "bytes", Number.MAX_SAFE_INTEGER)
    probe.emit("count", "bytes", 1)
  })
  expect(probe.snapshot()[0]?.overflow).toBe(true)
  expect(probe.snapshot()[0]?.counts.bytes).toBe(Number.MAX_SAFE_INTEGER)
})

test.each([Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.NaN, -1, 0.5])(
  "rejects invalid counter increments before they enter a trace: %s",
  value => {
    const probe = createProbe(() => 1)
    probe.run("one", () => probe.emit("count", "bytes", value))
    expect(probe.snapshot()[0]?.overflow).toBe(true)
    expect(probe.snapshot()[0]?.counts.bytes).toBeUndefined()
  },
)
