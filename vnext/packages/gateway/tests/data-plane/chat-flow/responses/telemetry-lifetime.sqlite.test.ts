import { expect, test } from "bun:test"
import { initBackground } from "@vibe-core/platform"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { llmEventResult } from "@vibe-llm/protocols/common"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { setupTestPlatform } from "../../../_setup-platform"
import { createResponsesTurn } from "../../../../src/data-plane/chat-flow/responses/turn"
import { renderResponsesTurn } from "../../../../src/data-plane/chat-flow/responses/respond"
import { PerformanceRecorder } from "../../../../src/data-plane/observability/performance-recorder"

const identity = { incomingModel: "model", model: "model", modelKey: "model", upstream: "test", cost: null }
async function* frames(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  yield eventFrame({ type: "response.completed", response: {
    id: "response", object: "response", model: "model", status: "completed", output: [],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  } } as ResponsesStreamEvent)
}

for (const wantsStream of [false, true]) for (const sink of ["usage", "performanceMetrics"] as const) {
  test(`${wantsStream ? "SSE" : "JSON"} delivery releases before ${sink} storage while completion owns the write`, async () => {
    const { db, repo } = setupTestPlatform()
    const owned: Promise<unknown>[] = []
    initBackground({ waitUntil: promise => { owned.push(promise) } })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    // Delay the real repository boundary; the eventual write still uses SQLite.
    if (sink === "usage") {
      const record = repo.usage.record.bind(repo.usage)
      repo.usage.record = async row => { entered.resolve(); await release.promise; await record(row) }
    } else {
      const record = repo.performanceMetrics.record.bind(repo.performanceMetrics)
      repo.performanceMetrics.record = async row => { entered.resolve(); await release.promise; await record(row) }
    }
    const turn = createResponsesTurn(llmEventResult(frames(), identity, {
      keyId: "key", model: "model", modelKey: "model", upstream: "test", stream: wantsStream, runtimeLocation: "bun",
    }), { wantsStream, telemetryCtx: {
      incomingModel: "model", apiKeyId: "key", userAgent: null, requestId: "request", isStreaming: wantsStream,
      runtimeLocation: "bun", requestStartedAt: Date.now(), sourceApi: "responses", metrics: new PerformanceRecorder(wantsStream),
    } })
    let delivered = false
    let settled = false
    let backgroundSettled = false
    void turn.completion.then(() => { settled = true })
    void Promise.all(owned).then(() => { backgroundSettled = true })
    const response = renderResponsesTurn(turn).then(async value => { const wire = await value.text(); delivered = true; return wire })
    try {
      await entered.promise
      await Bun.sleep(0)
      expect(delivered).toBe(true)
      expect(settled).toBe(false)
      expect(backgroundSettled).toBe(false)
      release.resolve()
      expect(await response).toContain('"status":"completed"')
      expect(await turn.completion).toMatchObject({ outcome: "completed", cleanupComplete: true })
      await Promise.all(owned)
      expect(await repo.usage.query({ keyId: "key", start: "2000-01-01T00", end: "2100-01-01T00" })).toMatchObject([{ requests: 1, tokens: { input: 2, output: 1 } }])
      expect(db.query("SELECT SUM(count) AS count FROM performance_metrics WHERE metric = '__requests'").get()).toEqual({ count: 1 })
    } finally {
      release.resolve()
      await response
      await turn.completion
      db.close()
    }
  })
}

for (const wantsStream of [false, true]) test(`${wantsStream ? "SSE" : "JSON"} detached storage failure settles completion and still finalizes the dump`, async () => {
  const { db, repo } = setupTestPlatform()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const record = repo.performanceMetrics.record.bind(repo.performanceMetrics)
  repo.performanceMetrics.record = async row => { entered.resolve(); await release.promise; await record(row) }
  let finalized = false
  const turn = createResponsesTurn(llmEventResult(frames(), identity), { wantsStream, finalizeDump: true,
    dump: { frame() {}, success() {}, recordSentPayloadBytes() {}, async finalizeTurn() { finalized = true } } as never,
    telemetryCtx: { incomingModel: "model", apiKeyId: "key", userAgent: null, requestId: "request", isStreaming: wantsStream,
      runtimeLocation: "bun", requestStartedAt: Date.now(), sourceApi: "responses", metrics: new PerformanceRecorder(wantsStream) },
  })
  const response = renderResponsesTurn(turn).then(value => value.text())
  try {
    await entered.promise
    db.run("DROP TABLE performance_metrics")
    release.resolve()
    expect(await response).toContain('"status":"completed"')
    expect(await turn.completion).toMatchObject({ outcome: "completed", cleanupComplete: false })
    expect(finalized).toBe(true)
  } finally { release.resolve(); await response; await turn.completion; db.close() }
})
