import { expect, test } from "bun:test"
import { jsonSnapshotByteChunks } from "../json-ext-traversal"
import { snapshotKnownData } from "../json-snapshot"

const bytes = (value: unknown) => Buffer.concat([...jsonSnapshotByteChunks(snapshotKnownData(value))])

test("source-copy normalizes undefined, holes, nonfinite numbers, and own proto keys", () => {
  const array: (number | undefined)[] = [undefined, undefined, Infinity]
  delete array[1]
  const input: Record<string, unknown> = { omitted: undefined, array, negative: -0 }
  Object.defineProperty(input, "__proto__", { value: "safe", enumerable: true })
  Object.defineProperty(input, Symbol.toStringTag, { value: "ignored", enumerable: true })
  const snapshot = snapshotKnownData(input)
  input.array = []
  input.negative = 9
  expect(Buffer.concat([...jsonSnapshotByteChunks(snapshot)]).toString()).toBe('{"array":[null,null,null],"negative":0,"__proto__":"safe"}')
})

test("shared acyclic sources copy separately and cycles fail", () => {
  const child = { n: 1 }
  expect(bytes([child, child]).toString()).toBe('[{"n":1},{"n":1}]')
  const cycle: unknown[] = []
  cycle.push(cycle)
  expect(() => snapshotKnownData(cycle)).toThrow(TypeError)
})

test("internal copier rejects exotics instead of silently rewriting them", () => {
  for (const value of [new Date(0), new Number(2), Object.create({ inherited: 1 }), { toJSON() { return 1 } }, { get field() { return 2 } }]) {
    expect(() => snapshotKnownData(value)).toThrow(TypeError)
  }
  const hidden = {}
  Object.defineProperty(hidden, "field", { get() { return 1 }, enumerable: false })
  expect(() => snapshotKnownData(hidden)).toThrow(TypeError)
})

test("source mutation cannot alter copied nested arrays or key order", () => {
  const inner = { "10": "ten", "2": "two", last: ["original"] }
  const source = { inner, tail: true }
  const snapshot = snapshotKnownData(source)
  inner.last[0] = "changed"
  inner.last.push("added")
  delete (inner as Partial<typeof inner>).last
  Object.defineProperty(inner, "new", { value: 5, enumerable: true })
  expect(Buffer.concat([...jsonSnapshotByteChunks(snapshot)]).toString()).toBe('{"inner":{"2":"two","10":"ten","last":["original"]},"tail":true}')
})

test("surrogate pairs and lone surrogates at every slice seam match native", () => {
  const encoder = new TextEncoder()
  for (const offset of [8190, 8191, 8192, 8193]) {
    for (const suffix of ["😀", "\ud800", "\udc00", "\ud800\udc00"]) {
      const value = "x".repeat(offset) + suffix + "\n"
      expect(bytes(value).equals(Buffer.from(encoder.encode(JSON.stringify(value))))).toBe(true)
      expect(bytes({ [value]: 1 }).equals(Buffer.from(encoder.encode(JSON.stringify({ [value]: 1 }))))).toBe(true)
    }
  }
})

test("deep known data copies and serializes without recursion", () => {
  let source: unknown = "end"
  for (let i = 0; i < 5000; i++) source = [source]
  const result = bytes(source).toString()
  expect(result.startsWith("[".repeat(5000))).toBe(true)
  expect(result.endsWith("]".repeat(5000))).toBe(true)
})

test("bounded traversal equals native bytes for seeded trees", () => {
  let state = 0x12345678
  const next = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const scalar = () => [null, true, false, -0, 1e21, "\u2028\u2029\ud800😀\udc00\n\\\"", Math.floor(next() * 100000)][Math.floor(next() * 7)]
  const tree = (depth: number): unknown => {
    if (depth === 0 || next() < 0.35) return scalar()
    if (next() < 0.5) return Array.from({ length: Math.floor(next() * 5) }, () => tree(depth - 1))
    const out: Record<string, unknown> = {}
    for (let i = 0, count = Math.floor(next() * 5); i < count; i++) {
      const key = ["0", "12", "a", "__proto__", "z"][i] ?? "x"
      Object.defineProperty(out, key, { value: tree(depth - 1), enumerable: true, configurable: true, writable: true })
    }
    return out
  }
  const encoder = new TextEncoder()
  for (let i = 0; i < 1200; i++) {
    const value = tree(4)
    expect(bytes(value).equals(Buffer.from(encoder.encode(JSON.stringify(value))))).toBe(true)
  }
})

test("fixed byte fixtures include control and surrogate escaping", () => {
  expect(bytes({ "2": "\u0000\n\"\\", "1": "\ud800", x: "😀\u2028" }).toString("hex"))
    .toBe("7b2231223a225c7564383030222c2232223a225c75303030305c6e5c225c5c222c2278223a22f09f9880e280a8227d")
})
