import { beforeEach, expect, test } from "bun:test"
import { doneFrame, eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { llmEventResult, type Invocation, type TranslatedLlmEventResult } from "@vibe-llm/protocols/common"
import { getTranslator } from "../../../../../src/data-plane/dispatch/translator-registry"
import { traverseTranslation } from "../../../../../src/data-plane/chat-flow/shared/traverse-translation"
import { withResponsesCompactShim } from "../../../../../src/data-plane/chat-flow/responses/interceptors/with-responses-compact-shim"
import { withResponsesServerToolShim } from "../../../../../src/data-plane/chat-flow/responses/interceptors/server-tool-shim"
import { createInMemoryPrivatePayloadStore } from "../../../../../src/data-plane/orchestrator/server-tools/private-payload-store"
import type { ServerToolRegistration, ServerToolResultSlot } from "../../../../../src/data-plane/orchestrator/server-tools/types"
import { respondResponses } from "../../../../../src/data-plane/chat-flow/responses/respond"
import { setupTestPlatform } from "../../../../_setup-platform"

beforeEach(() => setupTestPlatform())
const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "up", cost: null }
const ctx = { requestStartedAt: 0, targetEndpoint: "chat_completions" as const }
function invocation(stream: boolean): Invocation {
  return { endpoint: "responses", sourceApi: "responses", action: "generate", headers: {}, enabledFlags: new Set(),
    payload: { model: "m", stream, input: [{ type: "message", role: "user", content: "hello" }], metadata: { retained: "body-only" }, instructions: "retained instructions" } }
}
async function translated(inv: Invocation, toolCall: boolean, counts: { body: number; events: number }): Promise<TranslatedLlmEventResult> {
  const translator = getTranslator("responses", "chat_completions")
  if (!translator) throw new Error("Missing translator")
  const result = await traverseTranslation({ sourceProtocol: "responses", hubProtocol: "chat_completions", sourcePayload: inv.payload,
    translator, inheritedHeaders: {}, auth: {}, inheritedTelemetryCtx: {
      incomingModel: "m", apiKeyId: "key", requestId: "req", userAgent: null, isStreaming: inv.payload.stream === true, runtimeLocation: "bun", requestStartedAt: 0,
    }, innerAttempt: async args => {
      const tools = args.payload.tools as Array<{ function?: { name?: string } }> | undefined
      const name = tools?.[0]?.function?.name ?? "web_search"
      async function* frames(): AsyncGenerator<ProtocolFrame<unknown>> {
        yield eventFrame({ id: "chat", created: 1, model: "m", choices: [{ index: 0,
          delta: toolCall ? { role: "assistant", tool_calls: [{ index: 0, id: "call", type: "function", function: { name, arguments: "{}" } }] } : { role: "assistant", content: "summary text" },
          finish_reason: toolCall ? "tool_calls" : "stop" }] })
        yield doneFrame()
      }
      return llmEventResult(frames(), identity)
    } })
  if (result.type !== "events" || !result.producer) throw new Error("Expected translated result: " + JSON.stringify(result))
  return { ...result, modelIdentity: { ...identity, translatorPair: undefined },
    translateBody: (body, context) => { counts.body++; return result.translateBody(body, context) },
    translateEvents: (events, context) => { counts.events++; return result.translateEvents(events, context) },
  }
}
async function readResponse(response: Response, stream: boolean): Promise<Record<string, unknown>> {
  const text = await response.text()
  if (!stream) return JSON.parse(text) as Record<string, unknown>
  const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as { response?: Record<string, unknown> })
  const body = events.at(-1)?.response
  if (!body) throw new Error(text)
  return body
}
for (const stream of [false, true]) {
  test(`compact shim consumes translated ${stream ? "SSE" : "JSON"} source and replaces its producer`, async () => {
    const inv = invocation(stream)
    inv.action = "compact"
    const counts = { body: 0, events: 0 }
    const result = await withResponsesCompactShim(inv, ctx, () => translated(inv, false, counts))
    if (result.type !== "events") throw new Error("Expected events")
    expect(result.producer).toBeUndefined()
    expect(result.translateBody).toBeUndefined()
    const body = await readResponse(await respondResponses(result, { wantsStream: stream }), stream)
    expect(body.object).toBe("response.compaction")
    if (!stream) { expect(body.metadata).toEqual({ retained: "body-only" }); expect(body.instructions).toBe("retained instructions") }
    expect(counts).toEqual({ body: stream ? 0 : 1, events: stream ? 1 : 0 })
  })

  test(`server-tool shim translates both ${stream ? "SSE" : "JSON"} turns exactly once before dispatch`, async () => {
    const inv = invocation(stream)
    inv.payload.tools = [{ type: "web_search" }]
    let dispatched = 0
    const slot: ServerToolResultSlot = { id: "ws", startItem: { type: "web_search_call", status: "in_progress" }, startEvents: [],
      run: async function* () { yield* []; dispatched++; return { item: { type: "web_search_call", status: "completed" }, endEvents: [] } } }
    const registration: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({ type: "active", baseToolName: "web_search", hosted: {
      hostedTypes: ["web_search"], canonicalize: raw => raw.type === "web_search" ? { type: "web_search" } : undefined,
      buildFunctionTool: (_tool, name) => ({ type: "function", name }), dispatcher: () => [slot],
    } })
    const counts = { body: 0, events: 0 }
    let runs = 0
    const shim = withResponsesServerToolShim([registration], createInMemoryPrivatePayloadStore())
    const result = await shim(inv, ctx, () => translated(inv, ++runs === 1, counts))
    if (result.type !== "events") throw new Error("Expected events")
    expect(result.producer).toBeUndefined()
    expect(result.translateEvents).toBeUndefined()
    const body = await readResponse(await respondResponses(result, { wantsStream: stream }), stream)
    expect(body.status).toBe("completed")
    expect(JSON.stringify(body)).toContain("summary text")
    expect(dispatched).toBe(1)
    expect(runs).toBe(2)
    if (!stream) expect(body.metadata).toEqual({ retained: "body-only" })
    expect(counts).toEqual({ body: stream ? 0 : 2, events: stream ? 2 : 0 })
  })
}
