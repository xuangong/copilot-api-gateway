import { beforeEach, expect, test } from "bun:test"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { llmEventResult } from "@vibe-llm/protocols/common"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { respondResponses } from "../../../../src/data-plane/chat-flow/responses/respond"
import { withUpstreamTelemetry } from "../../../../src/data-plane/chat-flow/shared/upstream-telemetry"
import { setupTestPlatform } from "../../../_setup-platform"

beforeEach(() => setupTestPlatform())
const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "test", cost: null }
const terminal = { type: "response.completed", response: { id: "r", object: "response", status: "completed", model: "m", output: [] } }
const late = { type: "response.output_text.delta", delta: "must not escape", output_index: 0, content_index: 0, item_id: "i" }
async function* frames(events: unknown[]): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for (const event of events) yield eventFrame(event as ResponsesStreamEvent)
}
const readEvents = (wire: string): Array<{ type: string }> => wire.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
for (const wrapped of [false, true]) {
  test(`terminal is the final event and suppresses provider tail (${wrapped ? "telemetry" : "direct"})`, async () => {
    const source = frames([terminal, late])
    const events = wrapped ? withUpstreamTelemetry(source, { protocol: "responses" }).events : source
    const wire = await (await respondResponses(llmEventResult(events, identity), { wantsStream: true })).text()
    expect(readEvents(wire).map(event => event.type)).toEqual(["response.completed"])
    expect(wire).not.toContain("must not escape")
  })
}
for (const wantsStream of [true, false]) {
  test(`late failure withholds snapshot and success (${wantsStream ? "SSE" : "JSON"})`, async () => {
    let saves = 0
    const response = await respondResponses(llmEventResult(frames([terminal, { type: "error", message: "late failure" }]), identity), {
      wantsStream, onCompleted: async () => { saves++ },
    })
    const wire = await response.text()
    expect(wire).not.toContain("response.completed")
    expect(wire).toContain("late failure")
    expect(saves).toBe(0)
  })
}
for (const type of ["response.failed", "response.incomplete", "error"]) {
  test(`${type} is terminal-last even without a snapshot writer`, async () => {
    const event = type === "error" ? { type, message: "failure" } : { ...terminal, type, response: { ...terminal.response, status: type.slice(9) } }
    const wire = await (await respondResponses(llmEventResult(frames([event, late, terminal]), identity), { wantsStream: true })).text()
    expect(readEvents(wire).map(value => value.type)).toEqual([type])
  })
}
test("legacy bridged SSE enforces the barrier without persistence enabled", async () => {
  const wire = [terminal, late].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
  const response = await respondResponses({ kind: "bridged-response", response: new Response(wire, { headers: { "content-type": "text/event-stream" } }) }, { wantsStream: true })
  expect(readEvents(await response.text()).map(event => event.type)).toEqual(["response.completed"])
})

test("an unconsumed turn closes its owned upstream iterator on cancellation", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  let returned = 0
  const source: AsyncIterableIterator<ProtocolFrame<ResponsesStreamEvent>> = {
    [Symbol.asyncIterator]() { return this },
    next: () => new Promise(() => {}),
    return: async () => { returned++; return { done: true, value: undefined } },
  }
  const turn = createResponsesTurn(llmEventResult(source, identity), { wantsStream: true })
  await turn.ready
  turn.abortController.abort()
  const completion = await turn.completion
  expect(returned).toBe(1)
  expect(completion).toEqual({ outcome: "cancelled", cleanupComplete: true })
})

test("translated Chat placeholder trailing usage retains sparse measured counts", async () => {
  const { translateChatToResponsesEvents } = await import("@vibe-llm/translate/responses-via-chat-completions")
  const source = frames([
    { id: "chat", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
    { id: "chat", choices: [{ index: 0 }], usage: { completion_tokens: 3 } },
  ])
  const result = llmEventResult(source, identity, undefined, undefined, undefined, translateChatToResponsesEvents)
  const wire = await (await respondResponses(result, { wantsStream: true })).text()
  const final = readEvents(wire).at(-1) as { type: string; response?: { usage?: unknown } }
  expect(final.type).toBe("response.completed")
  expect(final.response?.usage).toEqual({ output_tokens: 3 })
})

test("a translator stalled after its terminal fails within the bounded tail lifetime", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  const result = llmEventResult(frames([]), identity, undefined, undefined, undefined, async function* () {
    yield terminal
    await new Promise<void>(() => {})
  })
  const upstream = new AbortController()
  const turn = createResponsesTurn(result, { wantsStream: true, upstreamAbortController: upstream })
  const output = await Promise.race([Array.fromAsync(turn.events), Bun.sleep(3_300).then(() => null)])
  expect(output).not.toBeNull()
  expect(output?.map(event => event.type)).toEqual(["error"])
  expect(upstream.signal.aborted).toBe(true)
  expect(turn.abortController.signal.aborted).toBe(false)
}, 4_000)

test("cancellation before preparation prevents an inference factory from starting", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  const abort = new AbortController()
  abort.abort()
  let prepared = 0
  const turn = createResponsesTurn(async () => {
    prepared++
    return { result: llmEventResult(frames([terminal]), identity), options: { wantsStream: true } }
  }, { wantsStream: true, downstreamAbortController: abort })
  const completion = await turn.completion
  expect(prepared).toBe(0)
  expect(completion.outcome).toBe("cancelled")
})

test("failed upstream metadata cannot keep cleanup pending or invent usage", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  let observedUsage: unknown
  const dump = { frame() {}, failed() {}, success(_identity: unknown, usage: unknown) { observedUsage = usage } }
  const result = { ...llmEventResult(frames([{ type: "error", message: "failed" }]), identity), __interceptorReplaced: true as const, finalMetadata: new Promise<never>(() => {}) }
  const turn = createResponsesTurn(result, { wantsStream: true, dump: dump as never })
  const completion = await Promise.race([(async () => { await Array.fromAsync(turn.events); return turn.completion })(), Bun.sleep(2_500).then(() => null)])
  expect(completion).toEqual({ outcome: "failed", cleanupComplete: false })
  expect(observedUsage).toEqual({})
  expect(turn.abortController.signal.aborted).toBe(false)
}, 3_000)

test("disconnect while the consumer pauses on an event still settles turn cleanup", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  let closed = false
  async function* source() {
    try { yield* frames([{ type: "response.created", response: terminal.response }, terminal]) }
    finally { closed = true }
  }
  const turn = createResponsesTurn(llmEventResult(source(), identity), { wantsStream: true })
  await turn.events.next()
  turn.abortController.abort()
  const completed = await Promise.race([turn.completion, Bun.sleep(100).then(() => null)])
  expect(completed?.outcome).toBe("cancelled")
  expect(closed).toBe(true)
})

test("throw before consumption closes the source and settles completion", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  let closed = false
  const source: AsyncIterableIterator<ProtocolFrame<ResponsesStreamEvent>> = {
    [Symbol.asyncIterator]() { return this },
    next: async () => ({ done: false, value: eventFrame(terminal as ResponsesStreamEvent) }),
    return: async () => { closed = true; return { done: true, value: undefined } },
  }
  const turn = createResponsesTurn(llmEventResult(source, identity), { wantsStream: true })
  await expect(turn.events.throw(new Error("consumer failed"))).rejects.toThrow("consumer failed")
  const completed = await Promise.race([turn.completion, Bun.sleep(100).then(() => null)])
  expect(completed?.outcome).toBe("cancelled")
  expect(closed).toBe(true)
})

test("JSON preserves terminal authority before the single canonical affinity signature and save", async () => {
  const { AffinityCodec } = await import("../../../../src/shared/affinity/carrier")
  const { analyzeAffinityRequest } = await import("../../../../src/shared/affinity/analysis")
  const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
  const target = { provider: "custom" as const, upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "m" }
  const affinity = { protocol: "responses" as const, codec, source: {}, analysis: await analyzeAffinityRequest("responses", {}, codec), actual: target }
  const first = { id: "reasoning", type: "reasoning", summary: [{ type: "summary_text", text: "first" }], encrypted_content: "first" }
  const final = { ...first, summary: [{ type: "summary_text", text: "final" }], encrypted_content: "final" }
  let saved: unknown
  const response = await respondResponses(llmEventResult(frames([
    { type: "response.output_item.done", item: first, output_index: 0 },
    { ...terminal, response: { ...terminal.response, output: [final] } },
  ]), identity), { wantsStream: false, affinity, onCompleted: async body => { saved = body.output } })
  const body = await response.json() as { output: unknown[] }
  const replay = await analyzeAffinityRequest("responses", { input: body.output }, codec)
  expect(replay.materialize(target).input).toEqual([final])
  expect(saved).toEqual(body.output)
})

for (const tail of [Array.from({ length: 300 }, () => late), [{ ...late, delta: "x".repeat(1_100_000) }]]) {
  test(`tail ${tail.length > 1 ? "frame" : "byte"} overflow aborts the producer without creating a reusable success`, async () => {
    const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
    const upstream = new AbortController()
    let saves = 0
    const turn = createResponsesTurn(llmEventResult(frames([terminal, ...tail]), identity), {
      wantsStream: true, upstreamAbortController: upstream, onCompleted: async () => { saves++ },
    })
    const events = await Array.fromAsync(turn.events)
    expect(events.map(event => event.type)).toEqual(["error"])
    expect((await turn.completion).outcome).toBe("failed")
    expect(upstream.signal.aborted).toBe(true)
    expect(turn.abortController.signal.aborted).toBe(false)
    expect(saves).toBe(0)
  })
}

test("completion owns a pending snapshot after cancellation while no terminal escapes", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  const entered = Promise.withResolvers<void>()
  const save = Promise.withResolvers<void>()
  let settled = false
  const turn = createResponsesTurn(llmEventResult(frames([terminal]), identity), {
    wantsStream: true, onCompleted: async () => { entered.resolve(); await save.promise },
  })
  void turn.completion.then(() => { settled = true })
  const output = Array.fromAsync(turn.events)
  await entered.promise
  turn.abortController.abort()
  await Bun.sleep(10)
  expect(settled).toBe(false)
  save.resolve()
  expect(await output).toEqual([])
  expect(await turn.completion).toEqual({ outcome: "cancelled", cleanupComplete: true })
})

test("Chat n=2 does not start the tail deadline when only one choice is finished", async () => {
  const events: AsyncIterable<ProtocolFrame<unknown>> = (async function* () {
    yield eventFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    await Bun.sleep(1_100)
    yield eventFrame({ choices: [{ index: 1, delta: { content: "second" }, finish_reason: "stop" }] })
    yield eventFrame({ choices: [{ index: 0 }], usage: { completion_tokens: 0 } })
    yield { type: "done" as const }
  })()
  const source = withUpstreamTelemetry(events, { protocol: "chat_completions", expectedChoices: 2 })
  const observed = await Array.fromAsync(source.events)
  expect(observed).toHaveLength(4)
  expect((await source.finalMetadata).usage).toEqual({ completion_tokens: 0 })
  expect((await source.finalMetadata).failed).toBe(false)
})

for (const contentType of ["text/event-stream", "application/json"]) {
  test(`unconsumed legacy ${contentType} cancellation closes its body`, async () => {
    const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const turn = createResponsesTurn({ kind: "bridged-response", response: new Response(body, { headers: { "content-type": contentType } }) }, { wantsStream: true })
    // Let preparation acquire any body reader, without consuming turn events.
    await Bun.sleep(5)
    turn.abortController.abort()
    const complete = await Promise.race([turn.completion, Bun.sleep(100).then(() => null)])
    expect(complete?.outcome).toBe("cancelled")
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  })
}

test("HTTP metadata reaches the awaited turn dump finalizer", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  const { renderResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/respond")
  let headers: ReadonlyArray<readonly [string, string]> = []
  const dump = { frame() {}, failed() {}, success() {}, recordSentPayloadBytes() {}, async finalizeTurn(_status: number, value: ReadonlyArray<readonly [string, string]>) { headers = value } }
  const turn = createResponsesTurn(llmEventResult(frames([terminal]), identity), { wantsStream: false, dump: dump as never, finalizeDump: true })
  await (await renderResponsesTurn(turn)).text()
  await turn.completion
  expect(headers).toContainEqual(["content-type", "application/json"])
})

test("telemetry cleanup failure still awaits the dump finalizer", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  let finalized = false
  const dump = { frame() {}, failed() {}, success() { throw new Error("telemetry sink unavailable") }, async finalizeTurn() { finalized = true } }
  const turn = createResponsesTurn(llmEventResult(frames([terminal]), identity), { wantsStream: true, dump: dump as never, finalizeDump: true })
  await Array.fromAsync(turn.events)
  expect((await turn.completion).cleanupComplete).toBe(false)
  expect(finalized).toBe(true)
})
