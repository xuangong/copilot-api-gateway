import { expect, test } from "bun:test"
import type { ProtocolFrame } from "@vibe-core/result"
import { withUpstreamTelemetry } from "../../../../src/data-plane/chat-flow/shared/upstream-telemetry"
import { translateStream } from "../../../../src/data-plane/chat-flow/shared/translate-stream"

async function* frames(events: unknown[]): AsyncGenerator<ProtocolFrame<unknown>> {
  for (const event of events) yield { type: "event", event }
}
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const event of events) out.push(event)
  return out
}
for (const protocol of ["responses", "messages", "chat_completions"] as const) {
  test(`${protocol}: premature EOF throws and settles metadata`, async () => {
    const stream = withUpstreamTelemetry(frames([]), { protocol })
    await expect(collect(stream.events)).rejects.toThrow("without")
    expect((await stream.finalMetadata).failed).toBe(true)
  })
}
test("native successful terminal is withheld when a late explicit failure arrives", async () => {
  const failure = { type: "error", message: "late failure" }
  const stream = withUpstreamTelemetry(frames([{ type: "response.completed", response: {} }, failure]), { protocol: "responses" })
  expect(await collect(stream.events)).toEqual([{ type: "event", event: failure }])
  expect((await stream.finalMetadata).failed).toBe(true)
})
test("consumer cancellation closes source and settles metadata", async () => {
  let closed = false
  async function* source(): AsyncGenerator<ProtocolFrame<unknown>> {
    try { yield { type: "event", event: {} }; yield { type: "event", event: {} } } finally { closed = true }
  }
  const stream = withUpstreamTelemetry(source(), { protocol: "responses" })
  await stream.events.next()
  await stream.events.return(undefined)
  expect(closed).toBe(true)
  expect(await Promise.race([stream.finalMetadata, Promise.resolve("unsettled")])).toMatchObject({ failed: false, cancelled: true })
})
test("abort settles metadata without reporting an upstream failure", async () => {
  const abort = new AbortController()
  const stream = withUpstreamTelemetry(frames([]), { protocol: "messages", abortSignal: abort.signal })
  abort.abort()
  expect(await collect(stream.events)).toEqual([])
  expect(await stream.finalMetadata).toMatchObject({ failed: false, cancelled: true })
})
test("translation does not release a successful terminal after tail failure", async () => {
  async function* early(events: AsyncIterable<unknown>) {
    for await (const _ of events) { yield { type: "response.completed" }; return }
  }
  const out: unknown[] = []
  const stream = translateStream(frames([{}, { type: "error", message: "late failure" }]), early, undefined, undefined)
  await expect((async () => { for await (const event of stream) out.push(event) })()).rejects.toThrow("late failure")
  expect(out).toEqual([])
})
test("translation explicit error is delivered once without draining into a duplicate failure", async () => {
  async function* errors() { yield { type: "error", message: "original" } }
  async function* upstream(): AsyncGenerator<ProtocolFrame<unknown>> { yield* []; throw new Error("duplicate") }
  expect(await collect(translateStream(upstream(), errors, undefined, undefined))).toEqual([{ type: "error", message: "original" }])
})
test("native explicit error is not duplicated by a source cleanup failure", async () => {
  const cleanup = (): never => { throw new Error("cleanup failure") }
  async function* source(): AsyncGenerator<ProtocolFrame<unknown>> {
    try { yield { type: "event", event: { type: "error", message: "original" } } }
    finally { cleanup() }
  }
  const stream = withUpstreamTelemetry(source(), { protocol: "responses" })
  expect(await collect(stream.events)).toEqual([{ type: "event", event: { type: "error", message: "original" } }])
})
test("cancelling a never-started telemetry stream settles metadata", async () => {
  const stream = withUpstreamTelemetry(frames([]), { protocol: "responses" })
  await stream.events.return(undefined)
  expect(await stream.finalMetadata).toMatchObject({ failed: false, cancelled: true })
})
test("abort during pending input settles metadata before the source unwinds", async () => {
  const abort = new AbortController()
  let resume!: () => void
  const waiting = new Promise<void>((resolve) => { resume = resolve })
  let closed = false
  async function* source(): AsyncGenerator<ProtocolFrame<unknown>> {
    try { yield* []; await waiting; throw new Error("aborted read") } finally { closed = true }
  }
  const stream = withUpstreamTelemetry(source(), { protocol: "responses", abortSignal: abort.signal })
  const next = stream.events.next()
  abort.abort()
  expect(await stream.finalMetadata).toMatchObject({ failed: false, cancelled: true })
  resume()
  expect((await next).done).toBe(true)
  expect(closed).toBe(true)
})
test("translation holds Chat finish and trailing usage until a clean tail", async () => {
  async function* early(events: AsyncIterable<unknown>) {
    for await (const _ of events) {
      yield { choices: [{ finish_reason: "stop" }] }
      yield { choices: [], usage: { completion_tokens: 0 } }
      return
    }
  }
  const output: unknown[] = []
  await expect((async () => {
    for await (const event of translateStream(frames([{}, { type: "error", message: "late failure" }]), early, undefined, undefined)) output.push(event)
  })()).rejects.toThrow("late failure")
  expect(output).toEqual([])
  expect(await collect(translateStream(frames([{}]), early, undefined, undefined))).toEqual([
    { choices: [{ finish_reason: "stop" }] }, { choices: [], usage: { completion_tokens: 0 } },
  ])
})
