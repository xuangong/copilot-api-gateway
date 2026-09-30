import { Buffer } from "node:buffer"
import { expect, spyOn, test } from "bun:test"
import { UpstreamExchangeCollector } from "../src/shared/dump/upstream-attempts.ts"
import type { UpstreamExchanges } from "../src/shared/dump/upstream-attempts.ts"

const attemptInput = {
  parentCallId: "call-1", upstreamId: "upstream-1", method: "POST", operation: "responses.create",
  startedAt: 1005, requestHeaders: [["content-type", "application/json"]],
} as const
function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a non-null test fixture value")
  return value
}
const begin = (collector: UpstreamExchangeCollector) => requireValue(collector.begin(attemptInput))

function controlledSource(cancel?: (reason: unknown) => void) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const source = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    ...(cancel ? { cancel } : {}),
  })
  return { source, controller: requireValue<ReadableStreamDefaultController<Uint8Array>>(controller) }
}

// This is the same object-field ownership boundary as prefix-lifecycle tests.
// It does not inspect closure roots, force collection, or establish heap savings.
function reachableObjects(root: unknown): Set<object> {
  const seen = new Set<object>()
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    if (ArrayBuffer.isView(value)) return
    for (const child of Object.values(value)) visit(child)
  }
  visit(root)
  return seen
}

function retainedBufferBytes(root: unknown): number {
  const buffers = new Set<ArrayBufferLike>()
  for (const value of reachableObjects(root)) {
    if (ArrayBuffer.isView(value)) buffers.add(value.buffer)
  }
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0)
}

function expectConsumed(collector: UpstreamExchangeCollector): void {
  // Neither API may rebuild an empty snapshot or make consumption GC-dependent.
  expect(() => collector.finish()).toThrow()
  expect(() => collector.finish()).toThrow()
  expect(() => collector.takeSnapshot()).toThrow()
  expect(() => collector.takeSnapshot()).toThrow()
  expect(collector.begin(attemptInput)).toBeNull()
}

type SealMode = "transfer" | "abandon"
function seal(collector: UpstreamExchangeCollector, mode: SealMode): UpstreamExchanges | undefined {
  if (mode === "transfer") return collector.takeSnapshot(1040)
  collector.abandon()
}

test("takeSnapshot transfers the exact immutable envelope previously published by ordinary finish", () => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  const input = Uint8Array.of(1, 2, 3)
  attempt.observePreparedRequest({ prefix: input, totalBytes: 3 })
  const snapshot = collector.finish(1040)
  const item = requireValue(snapshot.attempts[0])
  expect(collector.finish(1100)).toBe(snapshot)
  expect(reachableObjects([collector, attempt]).has(snapshot)).toBe(true)

  const transferred = collector.takeSnapshot(1200)
  expect(transferred).toBe(snapshot)
  expect(transferred.attempts).toBe(snapshot.attempts)
  expect(transferred.attempts[0]?.request).toBe(item.request)
  expect(item.request).toMatchObject({ prefixBase64: "AQID", observedBytes: 3, capturedBytes: 3 })
  for (const value of [snapshot, snapshot.attempts, item, item.request, item.response, item.requestHeaders, requireValue(item.requestHeaders[0])]) {
    expect(Object.isFrozen(value)).toBe(true)
    expect(reachableObjects([collector, attempt]).has(value)).toBe(false)
  }
  expect(() => Object.assign(item.request, { prefixBase64: "changed" })).toThrow()
  expect(input).toEqual(Uint8Array.of(1, 2, 3))
  expect(retainedBufferBytes([collector, attempt])).toBe(0)
  expectConsumed(collector)
})

test("takeSnapshot finalizes directly at the supplied time before transferring ownership", () => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  attempt.observePreparedRequest({ prefix: Uint8Array.of(4, 5), totalBytes: 2 })
  const snapshot = collector.takeSnapshot(1040)
  expect(snapshot.attempts).toHaveLength(1)
  expect(snapshot.attempts[0]).toMatchObject({
    startedOffsetMs: 5, completedOffsetMs: 40,
    request: { prefixBase64: "BAU=", observedBytes: 2, capturedBytes: 2 },
    response: { terminal: "not_consumed", observedBytes: 0, totalBytes: null, capturedBytes: 0, prefixBase64: "" },
  })
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(reachableObjects([collector, attempt]).has(snapshot)).toBe(false)
  expect(retainedBufferBytes([collector, attempt])).toBe(0)
  expectConsumed(collector)
})

test.each(["finish", "takeSnapshot"] as const)("failed transfer preserves every prefix for an exact %s retry", retry => {
  const collector = new UpstreamExchangeCollector(1000)
  const first = begin(collector), second = begin(collector)
  first.observePreparedRequest({ prefix: Uint8Array.of(1), totalBytes: 1 })
  second.observePreparedRequest({ prefix: Uint8Array.of(2), totalBytes: 1 })
  const roots = [collector, first, second]
  const before = retainedBufferBytes(roots)
  expect(before).toBeGreaterThan(0)
  const toString = Buffer.prototype.toString
  let conversions = 0
  const fault = spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, ...args) {
    if (args[0] === "base64" && this.byteLength > 0 && ++conversions === 2) throw new Error("snapshot conversion failed")
    return toString.apply(this, args)
  })
  try {
    expect(() => collector.takeSnapshot(1040)).toThrow("snapshot conversion failed")
    expect(retainedBufferBytes(roots)).toBe(before)
  } finally { fault.mockRestore() }

  const snapshot = retry === "finish" ? collector.finish(1100) : collector.takeSnapshot(1100)
  expect(snapshot.attempts.map(item => item.request.prefixBase64)).toEqual(["AQ==", "Ag=="])
  expect(snapshot.attempts.map(item => item.completedOffsetMs)).toEqual([40, 40])
  expect(snapshot.capturedBodyBytes).toBe(2)
  expect(retainedBufferBytes(roots)).toBe(0)
  if (retry === "finish") {
    expect(collector.finish(1200)).toBe(snapshot)
    expect(reachableObjects(roots).has(snapshot)).toBe(true)
    expect(collector.takeSnapshot(1300)).toBe(snapshot)
  }
  expect(reachableObjects(roots).has(snapshot)).toBe(false)
  expectConsumed(collector)
})

test("a failed ordinary finish remains retryable by takeSnapshot without losing earlier prefixes", () => {
  const collector = new UpstreamExchangeCollector(1000)
  const first = begin(collector), second = begin(collector)
  first.observePreparedRequest({ prefix: Uint8Array.of(3), totalBytes: 1 })
  second.observePreparedRequest({ prefix: Uint8Array.of(4), totalBytes: 1 })
  const roots = [collector, first, second]
  const before = retainedBufferBytes(roots)
  expect(before).toBeGreaterThan(0)
  const toString = Buffer.prototype.toString
  let conversions = 0
  const fault = spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, ...args) {
    if (args[0] === "base64" && this.byteLength > 0 && ++conversions === 2) throw new Error("snapshot conversion failed")
    return toString.apply(this, args)
  })
  try {
    expect(() => collector.finish(1040)).toThrow("snapshot conversion failed")
    expect(retainedBufferBytes(roots)).toBe(before)
  } finally { fault.mockRestore() }
  const snapshot = collector.takeSnapshot(1100)
  expect(snapshot.attempts.map(item => item.request.prefixBase64)).toEqual(["Aw==", "BA=="])
  expect(snapshot.attempts.map(item => item.completedOffsetMs)).toEqual([40, 40])
  expect(retainedBufferBytes(roots)).toBe(0)
  expectConsumed(collector)
})

test("explicit abandonment releases request and response prefixes without changing caller bytes", async () => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  const request = Uint8Array.of(7, 8), response = Uint8Array.of(9, 10)
  attempt.observePreparedRequest({ prefix: request, totalBytes: request.byteLength })
  const body = attempt.observeResponse(200, [], new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(response); controller.close() },
  }))
  expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(Uint8Array.of(9, 10))
  expect(retainedBufferBytes([collector, attempt])).toBeGreaterThan(0)

  collector.abandon()
  expect(retainedBufferBytes([collector, attempt])).toBe(0)
  expect(request).toEqual(Uint8Array.of(7, 8))
  expect(response).toEqual(Uint8Array.of(9, 10))
  expectConsumed(collector)
})

test("explicit abandonment can discard a failed transfer without retrying snapshot conversion", () => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  attempt.observePreparedRequest({ prefix: Uint8Array.of(1, 2), totalBytes: 2 })
  const roots = [collector, attempt]
  const before = retainedBufferBytes(roots)
  expect(before).toBeGreaterThan(0)
  const toString = Buffer.prototype.toString
  let conversions = 0
  const fault = spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, ...args) {
    if (args[0] === "base64" && this.byteLength > 0) {
      conversions++
      throw new Error("snapshot conversion failed")
    }
    return toString.apply(this, args)
  })
  try {
    expect(() => collector.takeSnapshot(1040)).toThrow("snapshot conversion failed")
    expect(retainedBufferBytes(roots)).toBe(before)
    const afterFailure = conversions
    collector.abandon()
    expect(conversions).toBe(afterFailure)
    expect(retainedBufferBytes(roots)).toBe(0)
  } finally { fault.mockRestore() }
  expectConsumed(collector)
})

test("abandonment releases the collector's published envelope without mutating its external owner", () => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  attempt.observePreparedRequest({ prefix: Uint8Array.of(1, 2, 3), totalBytes: 3 })
  const snapshot = collector.finish(1040)
  const original = JSON.stringify(snapshot)
  expect(reachableObjects([collector, attempt]).has(snapshot)).toBe(true)
  collector.abandon()
  expect(reachableObjects([collector, attempt]).has(snapshot)).toBe(false)
  expect(JSON.stringify(snapshot)).toBe(original)
  expect(snapshot.attempts[0]?.request.prefixBase64).toBe("AQID")
  expectConsumed(collector)
})

test.each(["transfer", "abandon"] as const)("%s prevents old attempts from reopening capture", async mode => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  attempt.observePreparedRequest({ prefix: Uint8Array.of(1), totalBytes: 1 })
  const snapshot = seal(collector, mode)
  const original = snapshot && JSON.stringify(snapshot)
  attempt.observePreparedText("must not reopen capture")
  attempt.observePreparedRequest({ prefix: Uint8Array.of(2, 3), totalBytes: 2 })
  attempt.fetchError("network")
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.of(4)); controller.close() },
  })
  const forwarded = attempt.observeResponse(503, [["content-type", "text/plain"]], source)
  expect(forwarded).toBe(source)
  expect(source.locked).toBe(false)
  expect(new Uint8Array(await new Response(forwarded).arrayBuffer())).toEqual(Uint8Array.of(4))
  expect(retainedBufferBytes([collector, attempt])).toBe(0)
  if (snapshot) expect(JSON.stringify(snapshot)).toBe(original)
  expectConsumed(collector)
})

test.each(["transfer", "abandon"] as const)("%s preserves a pending read, later bytes and source EOF", async mode => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  const { source, controller } = controlledSource()
  const reader = requireValue(attempt.observeResponse(200, [], source)).getReader()
  const first = Uint8Array.of(1), second = Uint8Array.of(2, 3)
  try {
    controller.enqueue(first)
    expect((await reader.read()).value).toBe(first)
    const pending = reader.read()
    const snapshot = seal(collector, mode)
    controller.enqueue(second)
    expect((await pending).value).toBe(second)
    controller.close()
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(source.locked).toBe(false)
    expect(first).toEqual(Uint8Array.of(1))
    expect(second).toEqual(Uint8Array.of(2, 3))
    if (snapshot) expect(snapshot.attempts[0]?.response).toMatchObject({
      terminal: "not_consumed", observedBytes: 1, totalBytes: null, capturedBytes: 1, prefixBase64: "AQ==",
    })
    expect(retainedBufferBytes([collector, attempt])).toBe(0)
    expectConsumed(collector)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
})

test.each(["transfer", "abandon"] as const)("%s forwards the original cancellation reason during a pending read", async mode => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  const cancellations: unknown[] = []
  const { source, controller } = controlledSource(reason => { cancellations.push(reason) })
  const reader = requireValue(attempt.observeResponse(200, [], source)).getReader()
  const reason = new Error("consumer cancelled the original stream")
  try {
    controller.enqueue(Uint8Array.of(1))
    await reader.read()
    const pending = reader.read()
    const snapshot = seal(collector, mode)
    await reader.cancel(reason)
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(cancellations).toHaveLength(1)
    expect(cancellations[0]).toBe(reason)
    expect(source.locked).toBe(false)
    if (snapshot) expect(snapshot.attempts[0]?.response).toMatchObject({
      terminal: "not_consumed", observedBytes: 1, totalBytes: null, capturedBytes: 1, prefixBase64: "AQ==",
    })
    expect(retainedBufferBytes([collector, attempt])).toBe(0)
    expectConsumed(collector)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
})

test.each(["transfer", "abandon"] as const)("%s forwards a later source read error by identity and releases its lock", async mode => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  const { source, controller } = controlledSource()
  const reader = requireValue(attempt.observeResponse(200, [], source)).getReader()
  const reason = new Error("original source read failed")
  try {
    controller.enqueue(Uint8Array.of(1))
    await reader.read()
    const pending = reader.read()
    const snapshot = seal(collector, mode)
    // Bun's promise matcher may wait during its call. Register a native
    // reaction first so the producer can reject before the assertion runs.
    const outcome = pending.then(
      value => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    )
    controller.error(reason)
    const result = await outcome
    expect(result.status).toBe("rejected")
    if (result.status !== "rejected") throw new Error("expected source rejection")
    expect(result.error).toBe(reason)
    expect(source.locked).toBe(false)
    if (snapshot) expect(snapshot.attempts[0]).toMatchObject({
      errorCategory: null,
      response: { terminal: "not_consumed", observedBytes: 1, totalBytes: null, capturedBytes: 1, prefixBase64: "AQ==" },
    })
    expect(retainedBufferBytes([collector, attempt])).toBe(0)
    expectConsumed(collector)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
})
