import { Buffer } from "node:buffer"
import { expect, spyOn, test } from "bun:test"
import { UpstreamExchangeCollector, safeUpstreamExchangesForPersistence } from "../src/shared/dump/upstream-attempts"

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

test("successful snapshot releases capture buffers even while the attempt remains reachable", () => {
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  attempt.observePreparedRequest({ prefix: Uint8Array.of(1, 2, 3), totalBytes: 3 })
  expect(retainedBufferBytes([collector, attempt])).toBeGreaterThan(0)
  const snapshot = collector.finish()
  expect(snapshot.attempts[0]?.request.prefixBase64).toBe("AQID")
  expect(retainedBufferBytes([collector, attempt])).toBe(0)
  expect(collector.finish()).toBe(snapshot)
})

test("failed snapshot conversion retains all prefixes for an exact retry", () => {
  const collector = new UpstreamExchangeCollector()
  const first = begin(collector)
  const second = begin(collector)
  first.observePreparedRequest({ prefix: Uint8Array.of(1), totalBytes: 1 })
  second.observePreparedRequest({ prefix: Uint8Array.of(2), totalBytes: 1 })
  const before = retainedBufferBytes([collector, first, second])
  const concat = Buffer.concat
  let calls = 0
  const fault = spyOn(Buffer, "concat").mockImplementation((list, length) => {
    if (++calls === 3) throw new Error("snapshot conversion failed")
    return concat(list, length)
  })
  try {
    expect(() => collector.finish()).toThrow("snapshot conversion failed")
    expect(retainedBufferBytes([collector, first, second])).toBe(before)
  } finally { fault.mockRestore() }
  const snapshot = collector.finish()
  expect(snapshot.attempts.map(item => item.request.prefixBase64)).toEqual(["AQ==", "Ag=="])
  expect(retainedBufferBytes([collector, first, second])).toBe(0)
})

test("late reads and cancellation still forward after immutable capture finalization", async () => {
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined
  let reason: unknown
  const source = new ReadableStream<Uint8Array>({
    start(controller) { sourceController = controller },
    cancel(value) { reason = value },
  })
  const reader = attempt.observeResponse(200, [], source)!.getReader()
  sourceController!.enqueue(Uint8Array.of(1))
  expect((await reader.read()).value).toEqual(Uint8Array.of(1))
  const pending = reader.read()
  const snapshot = collector.finish()
  sourceController!.enqueue(Uint8Array.of(2))
  expect((await pending).value).toEqual(Uint8Array.of(2))
  await reader.cancel("late cancel")
  expect(reason).toBe("late cancel")
  expect(source.locked).toBe(false)
  expect(snapshot.attempts[0]?.response).toMatchObject({ observedBytes: 1, totalBytes: null, prefixBase64: "AQ==", terminal: "not_consumed" })
  expect(collector.finish()).toBe(snapshot)
  expect(retainedBufferBytes([collector, attempt])).toBe(0)
})

test("safe persistence validates large base64 prefixes without decoding another body", () => {
  const collector = new UpstreamExchangeCollector()
  begin(collector).observePreparedRequest({ prefix: new Uint8Array(65536).fill(255), totalBytes: 65536 })
  const snapshot = collector.finish()
  let decodes = 0
  const atob = globalThis.atob
  const observer = spyOn(globalThis, "atob").mockImplementation(value => { decodes++; return atob(value) })
  try {
    expect(safeUpstreamExchangesForPersistence(snapshot)).toEqual(snapshot)
    expect(decodes).toBe(0)
  } finally { observer.mockRestore() }
})

test("base64 validation preserves exact alphabet, padding and decoded-length rules", () => {
  const collector = new UpstreamExchangeCollector()
  begin(collector).observePreparedRequest({ prefix: new Uint8Array(0), totalBytes: 0 })
  const template = collector.finish()
  const check = (prefixBase64: string, capturedBytes: number) => safeUpstreamExchangesForPersistence({
    ...template, capturedBodyBytes: capturedBytes,
    attempts: [{
      ...template.attempts[0],
      request: { source: "prepared", observedBytes: capturedBytes, totalBytes: capturedBytes, capturedBytes, prefixBase64, truncated: false },
    }],
  })
  // Nonzero unused pad bits were accepted by the original regex + atob rule.
  for (const [prefix, length] of [["", 0], ["AA==", 1], ["AB==", 1], ["AAA=", 2], ["AAB=", 2], ["+/AA", 3]] as const) {
    expect(check(prefix, length).attempts[0]?.request.prefixBase64).toBe(prefix)
  }
  for (const [prefix, length] of [["AA==", 2], ["AAA=", 1], ["AAAA", 2], ["A===", 1], ["=AAA", 3], ["AA=A", 3], ["AA-A", 3], ["AA_A", 3], ["AAA\n", 3], ["AAA\r", 3], ["AAA ", 3], ["AAA中", 3]] as const) {
    expect(() => check(prefix, length)).toThrow("invalid upstream body prefix")
  }
})
