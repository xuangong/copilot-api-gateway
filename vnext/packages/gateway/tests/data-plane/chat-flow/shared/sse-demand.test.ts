import { chatCompletionsAttempt } from "../../../../src/data-plane/chat-flow/chat-completions/attempt"
import { STREAM_TAIL_TIMEOUT_MS } from "../../../../src/data-plane/chat-flow/shared/stream-tail"
import { demandSse } from "../../../../src/data-plane/chat-flow/shared/demand-sse"
import { startSseKeepalive } from "../../../../src/data-plane/chat-flow/shared/sse-keepalive"
import { expect, test } from "bun:test"
import { eventFrame, doneFrame } from "@vibe-core/result"
import { llmEventResult, type TelemetryModelIdentity } from "@vibe-llm/protocols/common"
import { respondChatCompletions } from "../../../../src/data-plane/chat-flow/chat-completions/respond"
import { respondMessages } from "../../../../src/data-plane/chat-flow/messages/respond"
import { respondGemini } from "../../../../src/data-plane/chat-flow/gemini/respond"
import { renderResponsesTurn } from "../../../../src/data-plane/chat-flow/responses/respond"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"

const identity: TelemetryModelIdentity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "u", cost: null }
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

for (const protocol of ["chat", "messages", "gemini", "responses"] as const) {
  test(`${protocol} SSE bounds encoded output and stops reading a stalled client`, async () => {
    let reads = 0
    let cleaned = false
    const text = "é中😀\ud800".repeat(20_000)
    async function* source() {
      try {
        for (let i = 0; i < 20; i++) {
          reads++
          const event = protocol === "chat"
            ? { id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: text } }] }
            : protocol === "messages" ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }
              : protocol === "gemini" ? { candidates: [{ content: { parts: [{ text }] } }] }
                : { type: "response.output_text.delta", delta: text }
          yield eventFrame(event)
        }
        yield doneFrame()
      } finally { cleaned = true }
    }
    const abortController = new AbortController()
    const options = { wantsStream: true, downstreamAbortController: abortController }
    const response = protocol === "chat"
      ? await respondChatCompletions(llmEventResult(source() as never, identity), { ...options, includeUsageChunk: false })
      : protocol === "messages" ? await respondMessages(llmEventResult(source() as never, identity), options)
        : protocol === "gemini" ? await respondGemini(llmEventResult(source(), identity), options)
          : await renderResponsesTurn({
            ready: Promise.resolve({ status: 200 }), wantsStream: true, abortController,
            completion: Promise.resolve({ outcome: "completed", cleanupComplete: true }),
            mergedInputItems: [], recordSentPayloadBytes() {},
            events: (async function* () { for await (const frame of source()) if (frame.type === "event") yield frame.event as ResponsesStreamEvent })(),
          })
    await tick()
    const stalledReads = reads
    const reader = response.body?.getReader()
    if (!reader) throw new Error("missing body")
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value?.byteLength).toBeLessThanOrEqual(16 * 1024)
    expect(stalledReads).toBeLessThanOrEqual(1)
    await reader.cancel()
    await tick()
    expect(cleaned).toBe(true)
    expect(abortController.signal.aborted).toBe(true)
  })
}


test("bounded encoding preserves Unicode across chunk and surrogate boundaries", async () => {
  const wire = "a".repeat(16_383) + "😀é中\ud800".repeat(20_000) + "\n\n"
  let counted = 0
  const response = new Response(demandSse({
    events: (async function* () { yield wire })(),
    serialize: value => value,
    keepalive: ": ping\n\n",
    onBytes: bytes => { counted += bytes },
  }))
  const actual = new Uint8Array(await response.arrayBuffer())
  expect(actual).toEqual(new TextEncoder().encode(wire))
  expect(counted).toBe(actual.byteLength)
})

test("terminal HTTP close resumes canonical cleanup without waiting for persistence", async () => {
  const persisted = Promise.withResolvers<void>()
  let finishing = false
  let finished = false
  const response = new Response(demandSse({
    events: (async function* () {
      try { yield "terminal" } finally { finishing = true; await persisted.promise; finished = true }
    })(),
    serialize: value => value,
    terminal: () => true,
    keepalive: ": ping\n\n",
  }))
  try {
    const outcome = await Promise.race([response.text(), new Promise(resolve => setTimeout(() => resolve("timed out"), 100))])
    expect(outcome).toBe("terminal")
    expect(finishing).toBe(true)
    expect(finished).toBe(false)
  } finally { persisted.resolve(); await tick() }
  expect(finished).toBe(true)
})

test("serialization exceptions remain transport errors without an error-frame adapter", async () => {
  let cleaned = false
  const response = new Response(demandSse({
    events: (async function* () { try { yield 1 } finally { cleaned = true } })(),
    serialize() { throw new Error("encode failed") },
    keepalive: ": ping\n\n",
  }))
  await expect(response.text()).rejects.toThrow("encode failed")
  await tick()
  expect(cleaned).toBe(true)
})

test("keepalive skips full capacity and incomplete serialized frames", async () => {
  let capacity = 0
  let boundary = true
  const writes: Uint8Array[] = []
  const alive = startSseKeepalive({
    get desiredSize() { return capacity },
    enqueue(bytes) { writes.push(bytes); capacity = 0 },
  }, ": ping\n\n", 5, () => boundary)
  try {
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(writes).toHaveLength(0)
    boundary = false
    capacity = 16_384
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(writes).toHaveLength(0)
    boundary = true
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(writes).toHaveLength(1)
  } finally { alive.stop() }
})


for (const offset of [5_459, 5_460, 5_461, 16_380, 16_381, 16_382, 16_383, 16_384]) {
  test(`Unicode SSE remains exact around byte and compatibility boundaries at ${offset}`, async () => {
    const wire = "a".repeat(offset) + "😀" + "中".repeat(20_000) + "\ud800" + "b".repeat(16_384)
    const body = demandSse({
      events: (async function* () { yield wire })(), serialize: value => value, keepalive: ": ping\n\n",
    })
    const encoded = new Uint8Array(await new Response(body).arrayBuffer())
    expect(encoded).toEqual(new TextEncoder().encode(wire))
  })
}


const nativeChatFrame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`
const nativeChatFinish = { id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
const nativeChatUsage = { id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }

async function nativeChatResponse(body: ReadableStream<Uint8Array>, abort?: AbortController): Promise<Response> {
  const result = await chatCompletionsAttempt.generate({
    payload: { model: "m", messages: [], stream: true, stream_options: { include_usage: true } },
    auth: { ownerId: "owner", copilot: false }, ctx: { requestStartedAt: Date.now(), downstreamAbortSignal: abort?.signal },
    telemetryCtx: { incomingModel: "m", apiKeyId: "k", userAgent: null, requestId: "r", isStreaming: true, runtimeLocation: "bun", requestStartedAt: Date.now() },
    interceptors: [],
    selectBinding: async () => ({ kind: "ok", bareModel: "m", targetEndpoint: "chat_completions", translator: { translateRequest: (payload: unknown) => payload } as never,
      binding: { upstream: "u", model: { id: "m" }, provider: { getPricingForModelKey: () => null, fetch: async () => ({ status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body }) } } as never,
    }),
  })
  return respondChatCompletions(result, { wantsStream: true, includeUsageChunk: true, downstreamAbortController: abort })
}

test("native Chat usage tail validates upstream before a slow client's demand pause", async () => {
  const response = await nativeChatResponse(new Response(nativeChatFrame(nativeChatFinish) + nativeChatFrame(nativeChatUsage) + "data: [DONE]\n\n").body as ReadableStream<Uint8Array>)
  const reader = response.body?.getReader()
  if (!reader) throw new Error("missing body")
  const finish = await reader.read()
  expect(new TextDecoder().decode(finish.value)).toContain('"finish_reason":"stop"')
  await new Promise(resolve => setTimeout(resolve, STREAM_TAIL_TIMEOUT_MS + 50))
  let wire = ""
  while (true) {
    const next = await reader.read()
    if (next.done) break
    wire += new TextDecoder().decode(next.value)
  }
  expect(wire).toContain('"completion_tokens":4')
  expect(wire).toContain("data: [DONE]")
  expect(wire).not.toContain("event: error")
})

test("native Chat preserves observed usage before a late upstream error", async () => {
  const response = await nativeChatResponse(new Response(nativeChatFrame(nativeChatFinish) + nativeChatFrame(nativeChatUsage) + nativeChatFrame({ error: { message: "late failure" } })).body as ReadableStream<Uint8Array>)
  const wire = await response.text()
  expect(wire).toContain('"completion_tokens":4')
  expect(wire.indexOf('"completion_tokens":4')).toBeLessThan(wire.indexOf("late failure"))
  expect(wire).not.toContain("data: [DONE]")
})

test("native Chat preserves observed usage before an actual upstream tail stall", async () => {
  const abort = new AbortController()
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller
      controller.enqueue(new TextEncoder().encode(nativeChatFrame(nativeChatFinish) + nativeChatFrame(nativeChatUsage)))
    },
  })
  const response = await nativeChatResponse(body, abort)
  const wire = await response.text()
  expect(wire).toContain('"completion_tokens":4')
  expect(wire).toContain("terminal observation limit")
  expect(wire.indexOf('"completion_tokens":4')).toBeLessThan(wire.indexOf("terminal observation limit"))
  expect(wire).not.toContain("data: [DONE]")
  upstreamController?.close()
})
