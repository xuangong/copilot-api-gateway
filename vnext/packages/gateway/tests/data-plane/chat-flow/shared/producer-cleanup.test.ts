import { afterEach, beforeEach, expect, test } from "bun:test"
import { llmEventResult, type LlmExecuteResult, type Invocation } from "@vibe-llm/protocols/common"
import type { ProtocolFrame } from "@vibe-core/result"
import type { ChatCompletionsStreamEvent } from "@vibe-llm/protocols/chat"
import type { MessagesStreamEvent } from "@vibe-llm/protocols/messages"
import { respondChatCompletions } from "../../../../src/data-plane/chat-flow/chat-completions/respond"
import { respondMessages } from "../../../../src/data-plane/chat-flow/messages/respond"
import { respondGemini } from "../../../../src/data-plane/chat-flow/gemini/respond"
import { traverseTranslation } from "../../../../src/data-plane/chat-flow/shared/traverse-translation"
import { getTranslator } from "../../../../src/data-plane/dispatch/translator-registry"
import { withToolArgumentWhitespaceAborted } from "../../../../src/data-plane/chat-flow/chat-completions/interceptors/with-tool-argument-whitespace-aborted"
import { withThinkingDisplayPromoted } from "../../../../src/data-plane/chat-flow/messages/interceptors/with-thinking-display-promoted"
import { materializeResponsesSource, mapResponsesSourceFrames } from "../../../../src/data-plane/chat-flow/responses/interceptor-source"
import { setupTestPlatform } from "../../../_setup-platform"

let platform: ReturnType<typeof setupTestPlatform>
beforeEach(() => { platform = setupTestPlatform() })
afterEach(() => platform.db.close())
const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "up", cost: null }
function fixture(source: string, close: "success" | "reject" | "hang" = "success") {
  const observed = { reads: 0, returned: 0, aborted: false }
  const events: AsyncIterable<ProtocolFrame<unknown>> = { [Symbol.asyncIterator]: () => ({
    next: async () => { observed.reads++; return { done: true, value: undefined } },
    return: async () => {
      observed.returned++
      if (close === "reject") throw new Error("cleanup failed")
      if (close === "hang") await new Promise<void>(() => {})
      return { done: true, value: undefined }
    },
  }) }
  const result = { ...llmEventResult(events, identity), producer: { kind: "translated", source, protocol: "unsupported" },
    translateBody: (body: unknown) => body, translateEvents: (values: AsyncIterable<unknown>) => values }
  return { observed, result, abort: () => { observed.aborted = true } }
}
for (const source of ["chat_completions", "messages", "gemini"] as const) for (const wantsStream of [false, true]) {
  test(`${source} ${wantsStream ? "SSE" : "JSON"} rejects before reading and closes its producer`, async () => {
    const { observed, result } = fixture(source)
    const controller = new AbortController()
    controller.signal.addEventListener("abort", () => { observed.aborted = true })
    const options = { wantsStream, includeUsageChunk: false, downstreamAbortController: controller }
    const response = source === "chat_completions"
      ? respondChatCompletions(result as unknown as LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>, options)
      : source === "messages"
        ? respondMessages(result as unknown as LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>, options)
        : respondGemini(result as unknown as LlmExecuteResult<unknown>, options)
    await expect(response).rejects.toThrow("producer domain")
    expect(observed).toEqual({ reads: 0, returned: 1, aborted: true })
  })
}
for (const close of ["reject", "hang"] as const) test(`invalid producer ${close} cleanup preserves the error within its bound`, async () => {
  const { observed, result } = fixture("gemini", close)
  const started = Date.now()
  await expect(respondGemini(result as unknown as LlmExecuteResult<unknown>, { wantsStream: false })).rejects.toThrow("producer domain")
  expect(Date.now() - started).toBeLessThan(1800)
  expect(observed.returned).toBe(1)
  expect(observed.reads).toBe(0)
})
test("nested traversal closes the rejected inner producer without consuming it", async () => {
  const { result, observed, abort } = fixture("chat_completions")
  const translator = getTranslator("responses", "chat_completions")
  if (!translator) throw new Error("Missing translator")
  const outcome = await traverseTranslation({ abortUpstream: abort, sourceProtocol: "responses", hubProtocol: "chat_completions", translator,
    sourcePayload: { model: "m", input: "hello" }, inheritedHeaders: {}, auth: {},
    inheritedTelemetryCtx: { incomingModel: "m", apiKeyId: "k", requestId: "r", userAgent: null, isStreaming: false, runtimeLocation: "bun", requestStartedAt: 0 },
    innerAttempt: async () => result as unknown as LlmExecuteResult<ProtocolFrame<unknown>>,
  })
  expect(outcome.type).toBe("internal-error")
  expect(observed.aborted).toBe(true)
  expect(observed.reads).toBe(0)
  expect(observed.returned).toBe(1)
})
for (const source of ["chat_completions", "messages"] as const) test(`${source} native interceptor owns rejected translated results`, async () => {
  const { result, observed, abort } = fixture(source)
  const inv: Invocation = { endpoint: source, enabledFlags: new Set(), headers: {}, payload: { thinking: { type: "enabled", display: "omitted" } } }
  const context = { requestStartedAt: 0, abortUpstream: abort }
  const task = source === "chat_completions"
    ? withToolArgumentWhitespaceAborted(inv, context, async () => result as unknown as LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>)
    : withThinkingDisplayPromoted(inv, context, async () => result as unknown as LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>)
  await expect(task).rejects.toThrow("Native interceptor")
  expect(observed).toEqual({ reads: 0, returned: 1, aborted: true })
})
for (const path of ["materialize", "map"] as const) test(`Responses ${path} closes a rejected producer`, async () => {
  const { result, observed } = fixture("responses")
  const invalid = result as unknown as Parameters<typeof materializeResponsesSource>[0]
  const action = async () => path === "materialize" ? await materializeResponsesSource(invalid, true) : await mapResponsesSourceFrames(invalid, frames => frames)
  await expect(action()).rejects.toThrow("producer domain")
  expect(observed.reads).toBe(0)
  expect(observed.returned).toBe(1)
})

test("a real attempt releases its unopened body when its producer domain is rejected", async () => {
  const { chatCompletionsAttempt } = await import("../../../../src/data-plane/chat-flow/chat-completions/attempt")
  let reads = 0
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({ pull() { reads++ }, cancel() { cancelled++ } }, { highWaterMark: 0 })
  const translator = getTranslator("chat_completions", "chat_completions")
  if (!translator) throw new Error("Missing translator")
  type Binding = Extract<Awaited<ReturnType<NonNullable<Parameters<typeof chatCompletionsAttempt.generate>[0]["selectBinding"]>>>, { kind: "ok" }>["binding"]
  const binding = { upstream: "u", model: { id: "m" }, provider: {
    getPricingForModelKey: () => null,
    fetch: async () => ({ status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body }),
  } } as unknown as Binding
  const native = await chatCompletionsAttempt.generate({
    payload: { model: "m", messages: [], stream: true }, auth: {}, ctx: { requestStartedAt: 0 },
    telemetryCtx: { incomingModel: "m", apiKeyId: "k", requestId: "r", userAgent: null, isStreaming: true, runtimeLocation: "bun", requestStartedAt: 0 },
    selectBinding: async () => ({ kind: "ok", binding, targetEndpoint: "chat_completions", translator, bareModel: "m" }),
  })
  if (native.type !== "events") throw new Error("Expected native events")
  const invalid = { ...native, translateBody: (value: unknown) => value } as unknown as typeof native
  const controller = new AbortController()
  await expect(respondChatCompletions(invalid, { wantsStream: false, includeUsageChunk: false, downstreamAbortController: controller })).rejects.toThrow("producer domain")
  expect(controller.signal.aborted).toBe(false)
  expect(reads).toBe(0)
  expect(cancelled).toBe(1)
  expect(body.locked).toBe(false)
})

for (const kind of ["throw", "reject", "hang"] as const) test(`producer disposal ${kind} preserves the validation error and bounded close`, async () => {
  const { result, observed } = fixture("gemini")
  const invalid = { ...result, discardProducer: () => {
    if (kind === "throw") throw new Error("disposal threw")
    if (kind === "reject") return Promise.reject(new Error("disposal rejected"))
    return new Promise<void>(() => {})
  } } as unknown as LlmExecuteResult<unknown>
  const started = Date.now()
  await expect(respondGemini(invalid, { wantsStream: true })).rejects.toThrow("producer domain")
  expect(Date.now() - started).toBeLessThan(1800)
  expect(observed.returned).toBe(1)
  expect(observed.reads).toBe(0)
})

test("nested translation releases the body owner preserved by the first translation", async () => {
  let cancelled = 0
  let reads = 0
  const body = new ReadableStream<Uint8Array>({ pull() { reads++ }, cancel() { cancelled++ } }, { highWaterMark: 0 })
  const events = (async function* () { const reader = body.getReader(); try { await reader.read(); yield { type: "done" as const } } finally { reader.releaseLock() } })()
  const native = { ...llmEventResult(events, identity), discardProducer: () => body.cancel() }
  const translator = getTranslator("responses", "chat_completions")
  if (!translator) throw new Error("Missing translator")
  const args = { sourceProtocol: "responses" as const, hubProtocol: "chat_completions" as const, translator,
    sourcePayload: { model: "m", input: "hello" }, inheritedHeaders: {}, auth: {},
    inheritedTelemetryCtx: { incomingModel: "m", apiKeyId: "k", requestId: "r", userAgent: null, isStreaming: false, runtimeLocation: "bun" as const, requestStartedAt: 0 } }
  const translated = await traverseTranslation({ ...args, innerAttempt: async () => native })
  const outcome = await traverseTranslation({ ...args, innerAttempt: async () => translated })
  expect(outcome.type).toBe("internal-error")
  expect(cancelled).toBe(1)
  expect(reads).toBe(0)
})

test("Responses turn releases an unopened producer body while retaining failed execution facts", async () => {
  const { createResponsesTurn } = await import("../../../../src/data-plane/chat-flow/responses/turn")
  let cancelled = 0
  let reads = 0
  const body = new ReadableStream<Uint8Array>({ pull() { reads++ }, cancel() { cancelled++ } }, { highWaterMark: 0 })
  const events = (async function* () { const reader = body.getReader(); try { await reader.read(); yield { type: "done" as const } } finally { reader.releaseLock() } })()
  const invalid = { ...fixture("responses").result, events, discardProducer: () => body.cancel() }
  const turn = createResponsesTurn(invalid as unknown as Parameters<typeof createResponsesTurn>[0], { wantsStream: true })
  for await (const event of turn.events) expect(event.type).toBe("error")
  expect(await turn.facts).toMatchObject({ outcome: "failed", rawCleanupComplete: true })
  expect(await turn.completion).toMatchObject({ outcome: "failed", cleanupComplete: true })
  expect(turn.abortController.signal.aborted).toBe(false)
  expect(cancelled).toBe(1)
  expect(reads).toBe(0)
})
