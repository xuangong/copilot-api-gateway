import { expect, test } from "bun:test"
import type { ResponsesInterceptor } from "../../../../../src/data-plane/chat-flow/responses/interceptors/types"
import { responsesInterceptors } from "../../../../../src/data-plane/chat-flow/responses/interceptors"
import { defaultsForUpstream } from "@vibe-llm/protocols/flags"
import { llmEventResult, type Invocation } from "@vibe-llm/protocols/common"

const identity = { incomingModel: "test", model: "test", upstream: "test", modelKey: "test", cost: null }

test("Copilot registry projects collaboration before dispatch by default", async () => {
  const inv: Invocation = {
    endpoint: "responses", sourceApi: "responses", action: "generate", headers: {},
    enabledFlags: defaultsForUpstream("copilot"),
    payload: { model: "test", input: [], tools: [{ type: "namespace", name: "collaboration", tools: [
      { type: "function", name: "spawn_agent", parameters: { type: "object", properties: { message: { type: "string", encrypted: true } } } },
    ] }] },
  }
  const terminal = async () => {
    expect(inv.payload.tools).toEqual([{ type: "namespace", name: "collaboration-optimize", tools: [
      { type: "function", name: "spawn_agent", parameters: { type: "object", properties: { message: { type: "string" } } } },
    ] }])
    return llmEventResult((async function* () {})(), identity)
  }
  const ctx = { requestStartedAt: Date.now(), targetEndpoint: "responses" as const }
  const run = responsesInterceptors.reduceRight<Parameters<ResponsesInterceptor>[2]>(
    (next, interceptor) => () => interceptor(inv, ctx, next), terminal,
  )
  await run()
})
