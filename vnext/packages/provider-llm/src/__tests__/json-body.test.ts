import { describe, expect, test } from "bun:test"
import { createJsonBody, createJsonBodyFromText } from "../json-body"

const encoder = new TextEncoder()
const read = async (body: ReturnType<typeof createJsonBody>, signal?: AbortSignal) => {
  const reader = body.open(signal).getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const result = await reader.read()
    if (result.done) break
    expect(result.value.byteLength).toBeGreaterThan(0)
    expect(result.value.byteLength).toBeLessThanOrEqual(65536)
    chunks.push(result.value)
  }
  return Buffer.concat(chunks)
}

describe("replayable JSON body", () => {
  test("native fallback invokes stateful JSON hooks exactly once before opening", async () => {
    const trace: string[] = []
    const value = { nested: { toJSON(key: string) { trace.push(`toJSON:${key}`); return key } }, get item() { trace.push("getter"); return 2 } }
    const body = createJsonBody(value)
    expect(trace).toEqual(["toJSON:nested", "getter"])
    expect(body.mode).toBe("native-buffered")
    expect(body.contentLength).toBe(28)
    expect((await read(body)).toString()).toBe('{"nested":"nested","item":2}')
    expect((await read(body)).toString()).toBe('{"nested":"nested","item":2}')
    expect(trace).toEqual(["toJSON:nested", "getter"])
  })

  test("native input failures are synchronous and preserve native errors", () => {
    expect(() => createJsonBody(undefined)).toThrow(TypeError)
    expect(() => createJsonBody(() => 1)).toThrow(TypeError)
    expect(() => createJsonBody(1n)).toThrow(TypeError)
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(() => createJsonBody(cycle)).toThrow(TypeError)
    const error = new Error("hook")
    expect(() => createJsonBody({ toJSON() { throw error } })).toThrow(error)
    expect(() => createJsonBodyFromText("{" )).toThrow(SyntaxError)
    expect(() => createJsonBodyFromText(3 as unknown as string)).toThrow(TypeError)
  })

  test("native fallback adds no proxy eligibility traps", async () => {
    const build = (trace: string[]) => new Proxy({ x: 1 }, {
      get(target, key, receiver) { trace.push(`get:${String(key)}`); return Reflect.get(target, key, receiver) },
      ownKeys(target) { trace.push("keys"); return Reflect.ownKeys(target) },
      getOwnPropertyDescriptor(target, key) { trace.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key) }
    })
    const nativeTrace: string[] = []
    const expected = JSON.stringify(build(nativeTrace))
    const actualTrace: string[] = []
    const body = createJsonBody(build(actualTrace))
    expect(actualTrace).toEqual(nativeTrace)
    expect((await read(body)).toString()).toBe(expected)
    expect(actualTrace).toEqual(nativeTrace)
  })

  test("native fallback handles exotics with native output", async () => {
    const build = () => ({ date: new Date("2020-01-02T03:04:05.000Z"), boxed: new Number(3), array: [undefined, Symbol("s"), () => 1], omitted: undefined })
    const body = createJsonBody(build())
    expect((await read(body)).toString()).toBe(JSON.stringify(build()))
  })

  test("text canonicalization and immutable replay", async () => {
    const body = createJsonBodyFromText(' { "x": 1e400, "a": -0, "b": "😀" } ')
    const expected = '{"x":null,"a":0,"b":"😀"}'
    expect(body.mode).toBe("trusted-json-snapshot")
    expect(body.contentLength).toBe(encoder.encode(expected).byteLength)
    const first = await read(body)
    expect(first.toString()).toBe(expected)
    first.fill(0)
    expect((await read(body)).toString()).toBe(expected)
    expect(Object.isFrozen(body)).toBe(true)
  })

  test("parsed JSON may contain an ordinary toJSON data key", async () => {
    const body = createJsonBodyFromText('{"toJSON":"literal","x":1}')
    expect((await read(body)).toString()).toBe('{"toJSON":"literal","x":1}')
  })

  test("large scalar and key stay within the hard byte bound", async () => {
    const key = "\n😀".repeat(30000)
    const value = "\ud800\u2028\n".repeat(30000)
    const text = JSON.stringify({ [key]: value })
    const body = createJsonBodyFromText(text)
    const output = await read(body)
    expect(output.equals(Buffer.from(encoder.encode(text)))).toBe(true)
    expect(body.contentLength).toBe(output.byteLength)
  })

  test("abort and cancel are per-open", async () => {
    const body = createJsonBodyFromText(JSON.stringify({ x: "a".repeat(200000) }))
    const already = new AbortController()
    already.abort()
    await expect(body.open(already.signal).getReader().read()).rejects.toBeDefined()
    const active = new AbortController()
    const reader = body.open(active.signal).getReader()
    expect((await reader.read()).done).toBe(false)
    active.abort()
    await expect(reader.read()).rejects.toBeDefined()
    const cancelled = body.open().getReader()
    await cancelled.cancel()
    expect((await read(body)).byteLength).toBe(body.contentLength)
  })

  test("one open's mutable chunks cannot change concurrent or later opens", async () => {
    for (const body of [createJsonBody({ x: "a".repeat(140000) }), createJsonBodyFromText(JSON.stringify({ x: "a".repeat(140000) }))]) {
      const first = body.open().getReader()
      const second = body.open().getReader()
      const a = await first.read()
      expect(a.done).toBe(false)
      if (!a.done) a.value.fill(0)
      await first.cancel()
      const secondParts: Uint8Array[] = []
      while (true) {
        const part = await second.read()
        if (part.done) break
        secondParts.push(part.value)
      }
      const expected = JSON.stringify({ x: "a".repeat(140000) })
      expect(Buffer.concat(secondParts).toString()).toBe(expected)
      expect((await read(body)).toString()).toBe(expected)
    }
  })
})
