import { beforeEach, expect, test } from "bun:test"
import { doneFrame, eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { llmEventResult, type LlmExecuteResult, type TranslatedProducerProtocol } from "@vibe-llm/protocols/common"
import type { ChatCompletionsStreamEvent } from "@vibe-llm/protocols/chat"
import type { MessagesStreamEvent } from "@vibe-llm/protocols/messages"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { getTranslator } from "../../../../src/data-plane/dispatch/translator-registry"
import { traverseTranslation } from "../../../../src/data-plane/chat-flow/shared/traverse-translation"
import { respondChatCompletions } from "../../../../src/data-plane/chat-flow/chat-completions/respond"
import { respondMessages } from "../../../../src/data-plane/chat-flow/messages/respond"
import { respondResponses } from "../../../../src/data-plane/chat-flow/responses/respond"
import { respondGemini } from "../../../../src/data-plane/chat-flow/gemini/respond"
import { setupTestPlatform } from "../../../_setup-platform"

beforeEach(() => setupTestPlatform())
type Protocol = "chat_completions" | "messages" | "responses" | "gemini"
const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "up", cost: null }
const payload = { model: "m", messages: [{ role: "user", content: "hello" }], input: [{ role: "user", content: "hello" }],
  contents: [{ role: "user", parts: [{ text: "hello" }] }], max_tokens: 100 }
async function* hubFrames(hub: TranslatedProducerProtocol): AsyncGenerator<ProtocolFrame<unknown>> {
  if (hub === "chat_completions") {
    yield eventFrame({ id: "chat", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "domain-safe" }, finish_reason: "stop" }] })
  } else {
    const response = { id: "response", object: "response", model: "m", status: "completed", output: [
      { id: "message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "domain-safe", annotations: [] }] },
    ] }
    yield eventFrame({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })
    yield eventFrame({ type: "response.output_text.delta", item_id: "message", output_index: 0, content_index: 0, delta: "domain-safe" })
    yield eventFrame({ type: "response.completed", response })
  }
  yield doneFrame()
}

function register<T>(source: Protocol, hub: TranslatedProducerProtocol,
  respond: (result: LlmExecuteResult<ProtocolFrame<T>>, options: { wantsStream: boolean }) => Promise<Response>) {
  for (const wantsStream of [false, true]) for (const telemetry of ["missing", "stale"] as const) {
    test(`${source} ${wantsStream ? "SSE" : "JSON"} consumes the real producer with ${telemetry} translator telemetry`, async () => {
      const translator = getTranslator(source, hub)
      if (!translator) throw new Error("Missing translator fixture")
      const result = await traverseTranslation<unknown, T>({
        sourcePayload: payload, sourceProtocol: source, hubProtocol: hub, translator,
        innerAttempt: async () => llmEventResult(hubFrames(hub), identity), inheritedHeaders: {}, auth: {},
        inheritedTelemetryCtx: { incomingModel: "m", apiKeyId: "key", userAgent: null, requestId: "request",
          isStreaming: wantsStream, runtimeLocation: "bun", requestStartedAt: Date.now() },
      })
      if (result.type !== "events") throw new Error("Expected a translated event result")
      const corrected = { ...result, modelIdentity: { ...result.modelIdentity,
        translatorPair: telemetry === "missing" ? undefined : { source, hub: source } } }
      const response = await respond(corrected, { wantsStream })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("domain-safe")
    })
  }
  for (const fault of ["missing", "unsupported", "wrong-source"] as const) for (const wantsStream of [false, true]) {
    test(`${source} rejects ${fault} translated producer for ${wantsStream ? "SSE" : "JSON"}`, async () => {
      const translator = getTranslator(source, hub)
      if (!translator) throw new Error("Missing translator fixture")
      const result = await traverseTranslation<unknown, T>({
        sourcePayload: payload, sourceProtocol: source, hubProtocol: hub, translator,
        innerAttempt: async () => llmEventResult(hubFrames(hub), identity), inheritedHeaders: {}, auth: {},
        inheritedTelemetryCtx: { incomingModel: "m", apiKeyId: "key", userAgent: null, requestId: "request",
          isStreaming: wantsStream, runtimeLocation: "bun", requestStartedAt: 0 },
      })
      if (result.type !== "events" || !result.producer) throw new Error("Expected translated result")
      const invalid = { ...result, producer: fault === "missing" ? undefined : { ...result.producer,
        ...(fault === "unsupported" ? { protocol: "unknown" } : { source: "invalid-source" }),
      } } as unknown as LlmExecuteResult<ProtocolFrame<T>>
      const wire = await respond(invalid, { wantsStream }).then(response => response.text(), error => String(error))
      expect(wire).toMatch(/producer domain/)
      expect(wire).not.toContain("domain-safe")
    })
  }

}

register<ChatCompletionsStreamEvent>("chat_completions", "responses", respondChatCompletions)
register<MessagesStreamEvent>("messages", "chat_completions", respondMessages)
register<ResponsesStreamEvent>("responses", "chat_completions", respondResponses)
register<unknown>("gemini", "chat_completions", respondGemini)
