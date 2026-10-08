import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { llmEventResult } from "@vibe-llm/protocols/common"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import { setupTestPlatform } from "../../../_setup-platform"
import { analyzeAffinityRequest } from "../../../../src/shared/affinity/analysis"
import { AffinityCodec } from "../../../../src/shared/affinity/carrier"
import type { RequestAffinity } from "../../../../src/shared/affinity/context"
import { responsesAttempt } from "../../../../src/data-plane/chat-flow/responses/attempt"
import { renderResponsesTurn } from "../../../../src/data-plane/chat-flow/responses/respond"
import { createResponsesTurn } from "../../../../src/data-plane/chat-flow/responses/turn"
import type { ResponsesInterceptor } from "../../../../src/data-plane/chat-flow/responses/interceptors"
import type { GatewayRequestContext } from "../../../../src/data-plane/chat-flow/shared/gateway-ctx"

afterEach(() => __resetPlatformForTests())

test("deferred server-tool turns share actual identity and plaintext compactions with egress", async () => {
  const { db } = setupTestPlatform()
  try {
    const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })
    const target: AffinityExecutionTarget = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "m" }
    const input = { model: "m", input: "question", stream: false }
    const affinity: RequestAffinity = { analysis: await analyzeAffinityRequest("responses", input), execution: { protocol: "responses", codec, plaintextCompactions: new Set() } }
    const plain = { id: "plain", type: "compaction", encrypted_content: "summary" }
    const native = { id: "native", type: "reasoning", summary: [], encrypted_content: "opaque" }
    const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "up", cost: null }
    let calls = 0
    const deferred: ResponsesInterceptor = async (_invocation, context, run) => llmEventResult((async function* () {
      const first = await run()
      if (first.type !== "events") throw new Error("Expected first server-tool turn")
      for await (const _frame of first.events) { /* The server tool consumes its intermediate turn. */ }
      const gatewayContext = context as GatewayRequestContext
      gatewayContext.registerPlaintextCompaction?.(plain)
      const final = await run()
      if (final.type !== "events") throw new Error("Expected final server-tool turn")
      yield* final.events
    })(), identity)
    const result = await responsesAttempt.generate({
      payload: input, affinity, auth: {}, ctx: { requestStartedAt: Date.now() },
      telemetryCtx: { incomingModel: "m", apiKeyId: "key", requestId: "request", isStreaming: false, runtimeLocation: "bun", requestStartedAt: Date.now() },
      interceptors: [deferred],
      selectBinding: async () => ({
        kind: "ok", bareModel: "m", targetEndpoint: "responses", translator: { translateRequest: (payload: unknown) => payload } as never,
        binding: { upstream: "up", model: { id: "m" }, provider: {
          getPricingForModelKey: () => null,
          fetch: async () => {
            calls++
            const response = Response.json({ id: "response", object: "response", status: "completed", model: "m", output: [native, plain] })
            return { status: 200, headers: response.headers, body: response.body, affinityExecution: target }
          },
        } } as never,
      }),
    })
    expect(calls).toBe(0)
    const turn = createResponsesTurn(result, { wantsStream: false, affinity: affinity.execution })
    const body = await (await renderResponsesTurn(turn)).json() as { output: Array<{ encrypted_content: string }> }
    expect(calls).toBe(2)
    expect(body.output).toHaveLength(3)
    expect(body.output[0]?.encrypted_content).toStartWith("vnext-affinity:2:")
    expect(body.output[1]?.encrypted_content).toStartWith("vnext-affinity:1:")
    expect(body.output[2]?.encrypted_content).toBe("summary")
    expect((await turn.completion).outcome).toBe("completed")
  } finally { db.close() }
})
