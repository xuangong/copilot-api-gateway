import type { ApiKeyId } from "../../../../src/repo/branded-ids"
import { expect, test } from "bun:test"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import type { ProviderResponse } from "@vibe-llm/provider-llm"
import type { ResponsesResult, ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { adaptResponsesFrames, providerResponseToExecuteResult } from "../../../../src/data-plane/chat-flow/shared/attempt-helpers"
import { SourceStreamState, finalModelIdentity } from "../../../../src/data-plane/chat-flow/shared/respond-telemetry"
import { PerformanceRecorder } from "../../../../src/data-plane/observability/performance-recorder"
import { fetchWithPerformance } from "../../../../src/data-plane/chat-flow/shared/performance-upstream"
import { messagesAttempt } from "../../../../src/data-plane/chat-flow/messages/attempt"
import { responsesAttempt } from "../../../../src/data-plane/chat-flow/responses/attempt"
import { getTranslator } from "../../../../src/data-plane/dispatch/translator-registry"

const result: ResponsesResult = {
  id: "resp_test", object: "response", status: "completed", model: "gpt-base",
  output: [], incomplete_details: null, error: null, usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
}
const telemetryCtx = {
  incomingModel: "team-alias", apiKeyId: "test" as ApiKeyId, userAgent: null, requestId: "test",
  isStreaming: true, runtimeLocation: "bun" as const, requestStartedAt: 0,
}
const binding = {
  upstream: "test", model: { id: "gpt-base" },
  provider: { getPricingForModelKey: (key: string) => key === "gpt-base-fast" ? { input: 9, output: 18 } : null },
}
function response(label: string, stream: boolean): ProviderResponse {
  const body = stream
    ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`
    : JSON.stringify(result)
  return {
    status: 200, headers: new Headers({ "content-type": stream ? "text/event-stream" : "application/json" }),
    body: new Response(body).body,
    execution: Object.freeze({ modelKey: "gpt-base-fast", serviceTier: "priority" }),
    responsesAdapter: Object.freeze({
      frame: (frame: ProtocolFrame<ResponsesStreamEvent>) => frame.type === "event" && frame.event.type === "response.completed"
        ? eventFrame({ ...frame.event, response: { ...frame.event.response, id: label } }) : frame,
      result: (value: ResponsesResult) => ({ ...value, id: label }),
    }),
  }
}
function helper(providerResp: ProviderResponse) {
  return providerResponseToExecuteResult({
    providerResp, binding, telemetryCtx, bareModel: "gpt-base", incomingModel: "team-alias", protocol: "responses",
    toEvents: async function* () { yield eventFrame<ResponsesStreamEvent>({ type: "response.completed", response: result }) },
  })
}
test("parsed helper adapts each call independently and retains executed pricing identity", async () => {
  const calls = [helper(response("call_a", true)), helper(response("call_b", true))]
  const actual = await Promise.all(calls.map(async (call) => {
    const frames = []
    for await (const frame of call.events) frames.push(frame)
    return frames
  }))
  expect(JSON.stringify(actual[0])).toContain("call_a")
  expect(JSON.stringify(actual[1])).toContain("call_b")
  for (const call of calls) {
    expect(call.modelIdentity).toMatchObject({ modelKey: "gpt-base-fast", executedModelKey: "gpt-base-fast", cost: { input: 9, output: 18 } })
    expect(finalModelIdentity(call.modelIdentity, "unrelated", call.resolveModelIdentity)).toEqual(call.modelIdentity)
  }
})
test("source state locks executed pricing but fallback still adopts reported revisions", () => {
  const state = new SourceStreamState("gpt-base-fast", "gpt-base", "gpt-base-fast")
  state.rememberModelKey("gpt-base-20260929")
  expect(state.modelKey).toBe("gpt-base-fast")
  const fallback = new SourceStreamState("gpt-base", "gpt-base")
  fallback.rememberModelKey("gpt-base-20260929")
  expect(fallback.modelKey).toBe("gpt-base-20260929")
})
for (const stream of [false, true]) {
  test(`Responses ${stream ? "SSE" : "JSON"} applies the per-call adapter`, async () => {
    const translator = getTranslator("responses", "responses")
    if (!translator) throw new Error("missing Responses translator")
    const attempt = await responsesAttempt.generate({
      payload: { model: "gpt-base", input: [], stream }, auth: {},
      ctx: { requestStartedAt: 0 }, telemetryCtx, interceptors: [],
      selectBinding: async () => ({
        kind: "ok", binding: { ...binding, provider: { ...binding.provider, fetch: async () => response("restored", stream) } },
        targetEndpoint: "responses", translator, bareModel: "gpt-base",
      }),
    })
    if (!("type" in attempt) || attempt.type !== "events") throw new Error("expected events")
    const frames = []
    for await (const frame of attempt.events) frames.push(frame)
    expect(JSON.stringify(frames)).toContain("restored")
    expect(attempt.modelIdentity).toMatchObject({ modelKey: "gpt-base-fast", executedModelKey: "gpt-base-fast" })
    expect(attempt.performance?.modelKey).toBe("gpt-base-fast")
  })
}

test("execution snapshot cannot drift while a lazy response is consumed", async () => {
  const execution = { modelKey: "gpt-base-fast" }
  const call = helper({ ...response("snapshot", true), execution })
  execution.modelKey = "other-call"
  expect(call.resolveModelIdentity?.("gpt-base").modelKey).toBe("gpt-base-fast")
  expect(call.modelIdentity.executedModelKey).toBe("gpt-base-fast")
  for await (const _frame of call.events) { /* drain */ }
})

test("adapter failure propagates and iterator cleanup is retained", async () => {
  let closed = false
  const call = providerResponseToExecuteResult({
    providerResp: { ...response("failure", true), responsesAdapter: { frame: () => { throw new Error("invalid prepared response") } } },
    binding, telemetryCtx, bareModel: "gpt-base", incomingModel: "team-alias", protocol: "responses",
    toEvents: async function* () {
      try { yield eventFrame<ResponsesStreamEvent>({ type: "response.completed", response: result }) }
      finally { closed = true }
    },
  })
  await expect(Array.fromAsync(call.events)).rejects.toThrow("invalid prepared response")
  expect(closed).toBe(true)
})

test("adapter passthrough retains done frames and consumer cancellation closes the parser", async () => {
  let closed = false
  const frames = adaptResponsesFrames((async function* () {
    try { yield { type: "done" } as const; yield eventFrame<ResponsesStreamEvent>({ type: "response.completed", response: result }) }
    finally { closed = true }
  })(), response("cancel", true).responsesAdapter)
  for await (const frame of frames) { expect(frame.type).toBe("done"); break }
  expect(closed).toBe(true)
})

test("performance transport wrapping preserves adapters and execution identity", async () => {
  const original = response("wrapped", true)
  const wrapped = await fetchWithPerformance(new PerformanceRecorder(true), "responses", {
    endpoint: "responses", payload: {}, headers: new Headers(), sourceApi: "openai",
  }, async () => original)
  expect(wrapped.execution).toBe(original.execution)
  expect(wrapped.responsesAdapter).toBe(original.responsesAdapter)
  const frames = await Array.fromAsync(helper(wrapped).events)
  expect(JSON.stringify(frames)).toContain("wrapped")
  await wrapped.body?.cancel()
})

for (const stream of [false, true]) {
  test(`translated Messages via Responses ${stream ? "SSE" : "JSON"} restores before translation`, async () => {
    const translator = getTranslator("messages", "responses")
    if (!translator) throw new Error("missing Messages translator")
    const attempt = await messagesAttempt.generate({
      payload: { model: "gpt-base", messages: [], max_tokens: 32, stream }, auth: {},
      ctx: { requestStartedAt: 0 }, telemetryCtx, interceptors: [],
      selectBinding: async () => ({
        kind: "ok", binding: { ...binding, provider: { ...binding.provider, fetch: async () => response("restored-hub", stream) } },
        targetEndpoint: "responses", translator, bareModel: "gpt-base",
      }),
    })
    if (!("type" in attempt) || attempt.type !== "events") throw new Error("expected events")
    const frames = await Array.fromAsync(attempt.events)
    expect(JSON.stringify(frames)).toContain("restored-hub")
    expect(attempt.modelIdentity).toMatchObject({
      modelKey: "gpt-base-fast", executedModelKey: "gpt-base-fast", incomingModel: "team-alias",
      translatorPair: { source: "messages", hub: "responses" },
    })
    expect(attempt.resolveModelIdentity?.("gpt-base").modelKey).toBe("gpt-base-fast")
    expect(attempt.resolveModelIdentity?.("gpt-base").translatorPair).toEqual({ source: "messages", hub: "responses" })
  })
}

for (const scenario of ["json", "malformed", "upstream-error", "adapter-error"] as const) {
  test(`unary adapter boundary: ${scenario}`, async () => {
    const translator = getTranslator("responses", "responses")
    if (!translator) throw new Error("missing Responses translator")
    let resultCalls = 0
    let frameCalls = 0
    const providerResp = response("unary", false)
    const attempt = await responsesAttempt.generate({
      payload: { model: "gpt-base", input: [], stream: false }, auth: {},
      ctx: { requestStartedAt: 0 }, telemetryCtx, interceptors: [],
      selectBinding: async () => ({
        kind: "ok", binding: { ...binding, provider: { ...binding.provider, fetch: async () => ({
          ...providerResp,
          status: scenario === "upstream-error" ? 401 : 200,
          body: scenario === "malformed" ? new Response("not-json").body : providerResp.body,
          responsesAdapter: {
            result: (value: ResponsesResult) => {
              resultCalls++
              if (scenario === "adapter-error") throw new Error("invalid unary response")
              return { ...value, id: "unary-restored" }
            },
            frame: (frame: ProtocolFrame<ResponsesStreamEvent>) => { frameCalls++; return frame },
          },
        }) } }, targetEndpoint: "responses", translator, bareModel: "gpt-base",
      }),
    })
    if (!("type" in attempt)) throw new Error("unexpected bridge")
    expect(attempt.type).toBe(scenario === "json" ? "events" : scenario === "upstream-error" ? "upstream-error" : "internal-error")
    if (attempt.type === "events") {
      const frames = await Array.fromAsync(attempt.events)
      expect(JSON.stringify(frames)).toContain("unary-restored")
    }
    expect(resultCalls).toBe(scenario === "json" || scenario === "adapter-error" ? 1 : 0)
    expect(frameCalls).toBe(0)
  })
}

test("Responses dispatch retains original Messages provenance for strict Fast selection", async () => {
  const translator = getTranslator("responses", "responses")
  if (!translator) throw new Error("missing identity translator")
  let source: string | undefined
  const attempt = await responsesAttempt.generate({
    payload: { model: "gpt-base", input: [], service_tier: "priority" }, auth: {},
    ctx: { downstreamAbortSignal: undefined }, telemetryCtx: { ...telemetryCtx, sourceApi: "messages" }, interceptors: [],
    selectBinding: async () => ({ kind: "ok", binding: { ...binding, provider: {
      ...binding.provider, fetch: async (request) => { source = request.sourceProtocol; return response("provenance", false) },
    } }, targetEndpoint: "responses", translator, bareModel: "gpt-base" }),
  })
  expect(source).toBe("messages")
  if (attempt.type === "events") await Array.fromAsync(attempt.events)
})
