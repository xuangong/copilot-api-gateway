import { Buffer } from "node:buffer"
import { expect, spyOn, test } from "bun:test"
import { UpstreamExchangeCollector, UPSTREAM_ATTEMPT_LIMITS } from "../src/shared/dump/upstream-attempts.ts"
import { createUpstreamDialObservationContext } from "../src/shared/dump/upstream-dial-adapter.ts"

const begin = (collector: UpstreamExchangeCollector) => collector.begin({
  parentCallId: "call-1", upstreamId: "upstream-1", method: "POST", operation: "responses.create",
})!

function retainedBufferBytes(root: unknown): number {
  const seen = new Set<unknown>()
  const buffers = new Set<ArrayBufferLike>()
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    if (ArrayBuffer.isView(value)) { buffers.add(value.buffer); return }
    for (const child of Object.values(value)) visit(child)
  }
  visit(root)
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0)
}

function observeDialText(collector: UpstreamExchangeCollector, text: string): void {
  createUpstreamDialObservationContext(collector).forOperation({ upstreamId: "upstream-1", operation: "responses.create" })
    .beginCall({ upstreamId: "upstream-1", url: "https://example.test", startedAt: 1 })?.beginAttempt?.({
      transport: "direct_fetch", transportId: "direct_fetch", method: "POST", url: "https://example.test",
      startedAt: 2, requestHeaders: undefined, body: { kind: "text", text },
    })
}

test("prepared text owns an exact prefix without a second capture copy", () => {
  for (const length of [0, 1, 4095, 4096, 5000, 65536, 65537]) {
    const collector = new UpstreamExchangeCollector()
    let copiedBytes = 0
    const set = Uint8Array.prototype.set
    const observer = spyOn(Uint8Array.prototype, "set").mockImplementation(function (this: Uint8Array, source, offset) {
      copiedBytes += source.length
      return set.call(this, source, offset)
    })
    try { observeDialText(collector, "a".repeat(length)) } finally { observer.mockRestore() }
    const captured = Math.min(length, UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
    expect(copiedBytes).toBe(0)
    expect(retainedBufferBytes(collector)).toBe(captured)
    const snapshot = collector.finish()
    expect(atob(snapshot.attempts[0]!.request.prefixBase64)).toBe("a".repeat(captured))
    expect(snapshot.attempts[0]!.request).toMatchObject({ capturedBytes: captured, totalBytes: length, truncated: length > captured })
    expect(retainedBufferBytes(collector)).toBe(0)
  }
})

test("one owned chunk serializes directly without a concat allocation", () => {
  for (const length of [0, 1, 4095, 4096, 5000, 65536]) {
    const collector = new UpstreamExchangeCollector()
    observeDialText(collector, "x".repeat(length))
    const concat = spyOn(Buffer, "concat")
    try {
      expect(atob(collector.finish().attempts[0]!.request.prefixBase64)).toBe("x".repeat(length))
      expect(concat).not.toHaveBeenCalled()
    } finally { concat.mockRestore() }
  }
})

test("single copied page serializes only captured bytes, while multiple pages still concatenate", () => {
  for (const length of [1, 4095, 4096, 4097, 5000]) {
    const collector = new UpstreamExchangeCollector()
    const input = new Uint8Array(length).fill(255)
    begin(collector).observePreparedRequest({ prefix: input, totalBytes: length })
    input.fill(0)
    const concat = spyOn(Buffer, "concat")
    try {
      const body = collector.finish().attempts[0]!.request
      expect(Buffer.from(body.prefixBase64, "base64")).toEqual(Buffer.alloc(length, 255))
      expect(concat).toHaveBeenCalledTimes(length > 4096 ? 1 : 0)
    } finally { concat.mockRestore() }
  }
})

test("text capture allocates only the remaining aggregate budget", async () => {
  for (const remaining of [0, 1, 4095, 4096, 5000]) {
    const collector = new UpstreamExchangeCollector()
    for (let index = 0; index < 4; index++) {
      const size = UPSTREAM_ATTEMPT_LIMITS.responsePrefix - (index === 3 ? remaining : 0)
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(size)); controller.close() } })
      await new Response(begin(collector).observeResponse(200, [], body)).arrayBuffer()
    }
    const before = retainedBufferBytes(collector)
    const allocations: number[] = []
    const nativeUint8Array = globalThis.Uint8Array
    globalThis.Uint8Array = new Proxy(nativeUint8Array, {
      construct(target, args) {
        const value = Reflect.construct(target, args) as Uint8Array
        allocations.push(value.byteLength)
        return value
      },
    })
    try { observeDialText(collector, "中".repeat(30000)) } finally { globalThis.Uint8Array = nativeUint8Array }
    expect(allocations.reduce((sum, size) => sum + size, 0)).toBe(remaining)
    expect(retainedBufferBytes(collector) - before).toBe(remaining)
    const snapshot = collector.finish()
    const request = snapshot.attempts[4]!.request
    expect(request).toMatchObject({ capturedBytes: remaining, totalBytes: 90000, truncated: true })
    expect(Buffer.from(request.prefixBase64, "base64")).toEqual(Buffer.from("中".repeat(30000)).subarray(0, remaining))
    expect(snapshot.capturedBodyBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.totalBodyBytes)
  }
})

test("arbitrary owned lengths support later byte and text appends without aliasing", () => {
  for (const length of [0, 1, 4095, 4096, 5000, 65536]) {
    const collector = new UpstreamExchangeCollector()
    const attempt = begin(collector)
    attempt.observePreparedText("a".repeat(length))
    const external = new Uint8Array(6000).fill(98)
    attempt.observePreparedRequest({ prefix: external, totalBytes: length + external.byteLength })
    external.fill(0)
    attempt.observePreparedText("c".repeat(70000))
    const snapshot = collector.finish()
    const expected = ("a".repeat(length) + "b".repeat(6000) + "c".repeat(70000)).slice(0, 65536)
    expect(atob(snapshot.attempts[0]!.request.prefixBase64)).toBe(expected)
    expect(snapshot.capturedBodyBytes).toBe(65536)
    attempt.observePreparedText("after finish")
    expect(collector.finish()).toBe(snapshot)
    expect(retainedBufferBytes([collector, attempt])).toBe(0)
  }
})

test("partial external copy after a sealed chunk preserves bytes and global accounting", () => {
  class PartialCopyFault extends Uint8Array {
    private copies = 0
    override subarray(start?: number, end?: number): Uint8Array {
      if (this.copies++ > 0) throw new Error("later diagnostic copy failed")
      return super.subarray(start, end)
    }
  }
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  attempt.observePreparedText("a".repeat(5000))
  attempt.observePreparedRequest({ prefix: new PartialCopyFault(new Uint8Array(9000).fill(98)), totalBytes: 14000 })
  attempt.observePreparedRequest({ prefix: Uint8Array.of(99, 100, 101), totalBytes: 14003 })
  const snapshot = collector.finish()
  expect(atob(snapshot.attempts[0]!.request.prefixBase64)).toBe("a".repeat(5000) + "b".repeat(4096) + "cde")
  expect(snapshot.capturedBodyBytes).toBe(9099)
  expect(snapshot.attempts[0]!.request).toMatchObject({ capturedBytes: 9099, totalBytes: 14003, truncated: true })
})

test("a failed initial external copy does not leave a page ahead of newly owned bytes", () => {
  class CopyFault extends Uint8Array {
    override subarray(): Uint8Array { throw new Error("diagnostic copy failed") }
  }
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  attempt.observePreparedRequest({ prefix: new CopyFault(1), totalBytes: 1 })
  attempt.observePreparedText("hello")
  expect(retainedBufferBytes(collector)).toBe(5)
  expect(atob(collector.finish().attempts[0]!.request.prefixBase64)).toBe("hello")
})
