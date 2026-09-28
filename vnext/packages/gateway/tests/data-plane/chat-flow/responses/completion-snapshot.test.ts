import { test, expect, beforeEach } from "bun:test"
import { InMemoryResponsesSnapshotStore } from "@vibe-llm/responses-store"
import { eventFrame } from "@vibe-core/result"
import { llmEventResult } from "@vibe-llm/protocols/common"
import type { ResponsesResult, ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import type { ApiKeyId } from "../../../../src/repo/branded-ids.ts"
import { createResponseSnapshotWriter } from "../../../../src/data-plane/chat-flow/responses/completion-snapshot.ts"
import { respondResponses } from "../../../../src/data-plane/chat-flow/responses/respond.ts"
import { setupTestPlatform } from "../../../_setup-platform.ts"

beforeEach(() => setupTestPlatform())
const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "test", cost: null }
const key = "key" as ApiKeyId
const item = (id: string, text = id) => ({ type: "message" as const, id, role: "assistant" as const, content: [{ type: "output_text" as const, text }] })
function options(store: InMemoryResponsesSnapshotStore) {
  return {
    onCompleted: createResponseSnapshotWriter({ store, apiKeyId: key, retentionSeconds: 86400, fallbackModel: "fallback" }),
    mergedInputItems: [{ type: "message", role: "user", content: "q" }],
  }
}

for (const type of ["response.created", "response.incomplete", "response.failed"]) {
  test(`active renderer never saves ${type} as reusable completion`, async () => {
    const store = new InMemoryResponsesSnapshotStore()
    async function* source() {
      yield eventFrame({ type, response: { id: "unfinished", model: "m", output: [], status: type === "response.created" ? "in_progress" : type.slice(9) } } as ResponsesStreamEvent)
    }
    const response = await respondResponses(llmEventResult(source(), identity), { ...options(store), wantsStream: true })
    await response.text()
    expect(await store.load("unfinished", key)).toBeNull()
  })
}
for (const status of ["in_progress", "incomplete", "failed", "cancelled"]) {
  test(`bridged JSON ${status} never creates a snapshot`, async () => {
    const store = new InMemoryResponsesSnapshotStore()
    const response = await respondResponses({ kind: "bridged-response", response: Response.json({ id: "unfinished", status, output: [] }) }, { ...options(store), wantsStream: false })
    expect((await response.json()).status).toBe(status)
    expect(await store.load("unfinished", key)).toBeNull()
  })
}
for (const wantsStream of [false, true]) {
  test(`canonical ${wantsStream ? "SSE" : "JSON"} snapshot preserves closed outputs and terminal values`, async () => {
    const store = new InMemoryResponsesSnapshotStore()
    async function* source() {
      yield eventFrame({ type: "response.output_item.done", output_index: 1, item: item("b", "old") } as ResponsesStreamEvent)
      yield eventFrame({ type: "response.output_item.done", output_index: 0, item: item("a") } as ResponsesStreamEvent)
      yield eventFrame({ type: "response.completed", response: { id: "canonical", object: "response", model: "m", status: "completed", error: null, incomplete_details: null, output: [item("b", "final"), item("extra")] } } as ResponsesStreamEvent)
    }
    const response = await respondResponses(llmEventResult(source(), identity), { ...options(store), wantsStream })
    const text = await response.text()
    const terminal = wantsStream ? (JSON.parse(text.split('\n').filter((line) => line.startsWith('data: ')).at(-1)?.slice(6) ?? '{}') as { response: ResponsesResult }).response : JSON.parse(text) as ResponsesResult
    const snapshot = await store.load("canonical", key)
    expect(snapshot?.items).toEqual([{ type: "message", role: "user", content: "q" }, item("a"), item("b", "final"), item("extra")])
    expect(snapshot?.items.slice(1)).toEqual(terminal.output)
  })
}

test("legacy successful JSON without status remains reusable and uses fallback model", async () => {
  const store = new InMemoryResponsesSnapshotStore()
  const response = await respondResponses({ kind: "bridged-response", response: Response.json({ id: "legacy", output: [item("a")] }) }, { ...options(store), wantsStream: false })
  expect(response.status).toBe(200)
  expect((await store.load("legacy", key))?.model).toBe("fallback")
})

for (const wantsStream of [true, false]) {
  test(`completed event with incomplete status does not save (${wantsStream ? "SSE" : "JSON"})`, async () => {
    const store = new InMemoryResponsesSnapshotStore()
    async function* source() {
      yield eventFrame({ type: "response.completed", response: { id: "partial", object: "response", status: "incomplete", model: "m", output: [], error: null, incomplete_details: { reason: "max_output_tokens" } } } as ResponsesStreamEvent)
    }
    await (await respondResponses(llmEventResult(source(), identity), { ...options(store), wantsStream })).text()
    expect(await store.load("partial", key)).toBeNull()
  })
}

test('cancellation before source completion never starts a snapshot write', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  const abort = new AbortController()
  const started = Promise.withResolvers<void>()
  const continueSource = Promise.withResolvers<void>()
  async function* source() {
    yield eventFrame({ type: 'response.created', response: { id: 'cancelled', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } } as ResponsesStreamEvent)
    started.resolve()
    await continueSource.promise
    yield eventFrame({ type: 'response.completed', response: { id: 'cancelled', object: 'response', model: 'm', status: 'completed', output: [], error: null, incomplete_details: null } } as ResponsesStreamEvent)
  }
  let writes = 0
  const writer = options(store).onCompleted
  const response = await respondResponses(llmEventResult(source(), identity), {
    wantsStream: true, downstreamAbortController: abort,
    onCompleted: async (...args) => { writes++; await writer(...args) },
  })
  const text = response.text()
  await started.promise
  abort.abort()
  continueSource.resolve()
  expect(await text).not.toContain('response.completed')
  expect(writes).toBe(0)
  expect(await store.load('cancelled', key)).toBeNull()
})
