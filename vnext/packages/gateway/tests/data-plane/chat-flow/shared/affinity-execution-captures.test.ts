import { expect, test } from "bun:test"
import type { ProtocolFrame } from "@vibe-core/result"
import { llmEventResult, type RequestContext } from "@vibe-llm/protocols/common"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import { chatCompletionsAttempt } from "../../../../src/data-plane/chat-flow/chat-completions/attempt"
import { messagesAttempt } from "../../../../src/data-plane/chat-flow/messages/attempt"
import { geminiAttempt } from "../../../../src/data-plane/chat-flow/gemini/attempt"
import type { HubAttemptProtocol } from "../../../../src/data-plane/chat-flow/shared/hub-attempt-dispatch"
import type { SelectBindingResult } from "../../../../src/data-plane/chat-flow/shared/select-binding"
import type { TelemetryRequestContext } from "../../../../src/data-plane/chat-flow/shared/telemetry-ctx"
import { analyzeAffinityRequest, type AffinityProtocol } from "../../../../src/shared/affinity/analysis"
import type { AffinityExecutionState, AttemptAffinity, RequestAffinity } from "../../../../src/shared/affinity/context"

interface HubArgs {
  payload: Record<string, unknown>
  affinity: AttemptAffinity | undefined
  affinityMaterialized: boolean
  ctx: RequestContext
  telemetryCtx: TelemetryRequestContext
  inheritedHeaders: Record<string, string>
  selectBinding: () => Promise<SelectBindingResult>
}

const routes: ReadonlyArray<readonly [AffinityProtocol, HubAttemptProtocol]> = [
  ["chat_completions", "messages"], ["chat_completions", "responses"],
  ["messages", "chat_completions"], ["messages", "responses"],
  ["gemini", "chat_completions"], ["gemini", "messages"], ["gemini", "responses"],
]

for (const [source, hub] of routes) {
  test(`${source} → ${hub} preserves shared execution, fixed selection and materialized input`, async () => {
    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    const context: RequestContext = {
      requestStartedAt: Date.now(), downstreamAbortSignal: controller.signal,
      abortUpstream, apiKeyId: "key", bindingScope: { ownerId: "owner", pin: "up" },
    }
    const telemetry: TelemetryRequestContext = {
      incomingModel: "alias", apiKeyId: "key", requestId: "request", isStreaming: true,
      runtimeLocation: "bun", requestStartedAt: Date.now(),
    }
    const payload = { model: "alias", messages: [{ role: "user", content: "original" }], contents: [{ role: "user", parts: [{ text: "original" }] }] }
    const execution: AffinityExecutionState = { protocol: source, plaintextCompactions: new Set() }
    const preparation: RequestAffinity = { analysis: await analyzeAffinityRequest(source, payload), execution }
    const target: AffinityExecutionTarget = {
      provider: "custom", upstreamId: "up", upstreamIncarnation: "inc",
      credentialSubject: "subject", credentialRevision: "rev", model: "model",
    }
    const binding = { upstream: "up", model: { id: "model" }, provider: { getPricingForModelKey: () => null } }
    let selections = 0
    let hubLookups = 0
    let hubCalls = 0
    const selectBinding = async () => {
      selections++
      return {
        kind: "ok" as const, bareModel: "model", targetEndpoint: hub, binding: binding as never,
        translator: {
          translateRequest: async (input: Record<string, unknown>) => input,
          translateBody: async (body: unknown) => body,
          translateEvents: (events: AsyncIterable<unknown>) => events,
        } as never,
      }
    }
    const hubAttemptOverride = (protocol: HubAttemptProtocol) => {
      hubLookups++
      expect(protocol).toBe(hub)
      return { generate: async (raw: never): Promise<never> => {
        hubCalls++
        const args = raw as HubArgs
        expect(args.affinity).toBe(execution)
        expect(args.affinity).not.toBe(preparation)
        expect(args.affinityMaterialized).toBe(true)
        expect(args.ctx.downstreamAbortSignal).toBe(controller.signal)
        if (source !== "gemini") expect(args.ctx.abortUpstream).toBe(abortUpstream)
        if (source === "messages") {
          expect(args.ctx.apiKeyId).toBe(context.apiKeyId)
          expect(args.ctx.bindingScope).toBe(context.bindingScope)
        }
        expect(args.telemetryCtx).toBe(telemetry)
        expect(args.inheritedHeaders).toEqual({ "x-fixture": "value" })
        const selection = await args.selectBinding()
        expect(selection.kind).toBe("ok")
        if (selection.kind !== "ok") throw new Error("Expected fixed hub selection")
        expect(selection.binding).toBe(binding)
        expect(selection.targetEndpoint).toBe(hub)
        expect(args.payload).not.toBe(payload)
        expect(args.payload.messages).not.toBe(payload.messages)
        args.payload.messages = []
        const frames = (async function* (): AsyncGenerator<ProtocolFrame<unknown>> {
          execution.actual = target
          execution.plaintextCompactions?.add("plain")
          yield { type: "event", event: { sentinel: "hub" } }
        })()
        return llmEventResult(frames, { incomingModel: "alias", model: "model", modelKey: "model", upstream: "up", cost: null }) as never
      } }
    }
    const common = {
      payload, affinity: preparation, auth: { ownerId: "owner" }, ctx: context,
      telemetryCtx: telemetry, selectBinding, hubAttemptOverride,
      inheritedHeaders: { "x-fixture": "value" }, interceptors: [],
    }
    const result = source === "chat_completions"
      ? await chatCompletionsAttempt.generate(common)
      : source === "messages"
        ? await messagesAttempt.generate(common)
        : await geminiAttempt.generate({ ...common, model: "alias", forceStream: true })
    expect(result.type).toBe("events")
    if (result.type !== "events") throw new Error("Expected cross-protocol events")
    expect(result.modelIdentity.translatorPair).toEqual({ source, hub })
    expect(selections).toBe(1)
    expect(hubLookups).toBe(1)
    expect(hubCalls).toBe(1)
    expect(payload.messages).toHaveLength(1)
    expect(preparation.analysis.cloneSource().messages).toEqual(payload.messages)
    expect(execution.actual).toBeUndefined()
    for await (const _frame of result.events) { /* Consume deferred hub work. */ }
    expect(preparation.execution.actual).toBe(target)
    expect(preparation.execution.plaintextCompactions?.has("plain")).toBe(true)
  })
}
