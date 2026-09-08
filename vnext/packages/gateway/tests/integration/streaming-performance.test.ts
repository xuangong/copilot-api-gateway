import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { FileDumpStore } from "../../src/repo/dump-store"
import { initDumpStore, initDumpBroker, resetDumpRegistryForTests } from "../../src/shared/dump/registry"
import { EventTargetChannelBroker } from "../../src/shared/runtime/event-target-channel-broker"
import { dumpCodec } from "../../src/shared/dump/codec"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { initBackground, __resetPlatformForTests } from "@vibe-core/platform"
import { app } from "../../src/app"
import { setupTestPlatform } from "../_setup-platform"
import type { PerformanceMetricsResponse } from "@vibe-llm/protocols/common"

const originalFetch = globalThis.fetch
let platform: ReturnType<typeof setupTestPlatform>
let pending: Promise<unknown>[]
let jsonFallback = false
let missingUsage = false
let upstreamError = false
let truncateStream = false
let hostedSearch = false
let upstreamCalls = 0
let searchCalls = 0
const KEY = "performance-test-key"
const MODEL = "performance-target"
const encoder = new TextEncoder()
const frames = [
  { type: "response.created", response: { id: "resp_perf", model: MODEL, output: [], status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_perf", type: "message", role: "assistant", content: [] } },
  { type: "response.content_part.added", output_index: 0, item_id: "msg_perf", content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", output_index: 0, item_id: "msg_perf", content_index: 0, delta: "Hello " },
  { type: "response.output_text.delta", output_index: 0, item_id: "msg_perf", content_index: 0, delta: "world" },
  { type: "response.output_text.done", output_index: 0, item_id: "msg_perf", content_index: 0, text: "Hello world" },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_perf", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello world" }] } },
]
const snapshot = () => ({ id: "resp_perf", object: "response", model: MODEL, status: "completed", output: [{ id: "msg_perf", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello world" }] }], ...(!missingUsage && { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 } } }) })
beforeEach(async () => {
  platform = setupTestPlatform()
  resetDumpRegistryForTests()
  const files = new Map<string, Uint8Array>()
  initDumpStore(new FileDumpStore(new BunSqliteDatabase(platform.db), {
    async put(key, body) { files.set(key, body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())) },
    async get(key) {
      const bytes = files.get(key)
      return bytes ? { body: new Blob([bytes as BlobPart]).stream(), size: bytes.length } : null
    },
    async delete(key) { files.delete(key) },
  }))
  initDumpBroker(new EventTargetChannelBroker(dumpCodec))
  pending = []
  jsonFallback = false
  missingUsage = false
  upstreamError = false
  truncateStream = false
  hostedSearch = false
  upstreamCalls = 0
  searchCalls = 0
  initBackground({ waitUntil: p => { pending.push(p) } })
  await platform.repo.apiKeys.save({ id: "perf-key", name: "perf", key: KEY, createdAt: "2026-09-08", modelMappingsEnabled: true, modelMappings: [{ source: "perf-alias", destination: MODEL }] })
  await platform.repo.upstreams.save({ id: "perf-up", provider: "custom", name: "perf", enabled: true, sortOrder: 0, config: { name: "perf", baseUrl: "https://performance.test/v1", apiKey: "fixture", endpoints: ["responses"] }, flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [{ id: "direct_fetch" }], createdAt: "2026-09-08", updatedAt: "2026-09-08" })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    if (new URL(req.url).hostname === "api.tavily.com") {
      searchCalls++
      await new Promise(resolve => setTimeout(resolve, 30))
      return Response.json({ results: [{ title: "fixture", url: "https://example.test/result", content: "fixture result" }] })
    }
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model" }] })
    const payload = await req.json() as Record<string, unknown>
    if (upstreamError) return Response.json({ error: { message: "fixture failure" } }, { status: 500 })
    const path = new URL(req.url).pathname
    if (path.endsWith("/messages")) {
      const usage = { input_tokens: 90, cache_read_input_tokens: 10, output_tokens: 20 }
      const body = { id: "msg_perf", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "Hello world" }], stop_reason: "end_turn", stop_sequence: null, ...(!missingUsage && { usage }) }
      if (jsonFallback || !payload.stream) return Response.json(body)
      return eventStream([
        { type: "message_start", message: { ...body, content: [], stop_reason: null, ...(!missingUsage && { usage: { ...usage, output_tokens: 0 } }) } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, ...(!missingUsage && { usage: { output_tokens: 20 } }) },
        { type: "message_stop" },
      ])
    }
    if (path.endsWith("/chat/completions")) {
      upstreamCalls++
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 5 } }
      const base = { id: "chat_perf", model: MODEL, object: "chat.completion.chunk", created: 0 }
      if (hostedSearch && upstreamCalls === 1) return eventStream([
        { ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_text: "Checking sources" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "search_perf", type: "function", function: { name: "web_search", arguments: '{"search_query":[{"q":"fixture"}]}' } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { ...base, choices: [], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 1 } } },
        "[DONE]",
      ])
      if (jsonFallback || !payload.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }], ...(!missingUsage && { usage }) })
      return eventStream([
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ...(!missingUsage ? [{ ...base, choices: [], usage }] : []),
        "[DONE]",
      ])
    }
    if (jsonFallback || !payload.stream) return Response.json(snapshot())
    const events = truncateStream ? frames.slice(0, 4) : [...frames, { type: "response.completed", response: snapshot() }]
    let index = 0
    return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
      if (index >= events.length) { controller.close(); return }
      await new Promise(resolve => setTimeout(resolve, 2))
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`))
    } }), { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
})
afterEach(async () => { await Promise.allSettled(pending); globalThis.fetch = originalFetch; platform.db.close(); resetDumpRegistryForTests(); __resetPlatformForTests() })
async function result() {
  await Promise.all(pending)
  const hour = new Date().toISOString().slice(0, 13)
  return platform.repo.performanceMetrics.query({ start: hour, end: hour })
}
for (const source of ["responses", "messages", "chat-completions", "gemini"] as const) {
  for (const stream of [true, false]) test(`collects ${source} via Responses, stream=${stream}`, async () => {
    const payload = source === "responses" ? { model: "perf-alias", input: "hi", stream } : source === "gemini" ? { contents: [{ role: "user", parts: [{ text: "hi" }] }] } : { model: "perf-alias", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream }
    const path = source === "gemini" ? `/v1beta/models/perf-alias:${stream ? "streamGenerateContent" : "generateContent"}` : `/v1/${source === "chat-completions" ? "chat/completions" : source}`
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${KEY}`, "x-api-key": KEY }, body: JSON.stringify(payload) })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Hello")
    const metrics = await result()
    expect(metrics.groups).toHaveLength(1)
    const group = metrics.groups[0]
    expect(group).toMatchObject({ incomingModel: "perf-alias", model: MODEL, sourceApi: source, targetApi: "responses", outcome: "success", stream })
    expect(group?.metrics.outputTokens?.sum).toBe(20)
    expect(group?.metrics.reasoningTokens?.sum).toBe(5)
    expect(group?.metrics.upstreamMs?.sum).toBeGreaterThan(0)
    expect(group?.metrics.upstreamTps?.sum).toBeCloseTo(20 * 1000 / (group?.metrics.upstreamMs?.sum ?? Infinity))
    expect(group?.metrics).not.toHaveProperty("outputTps")
    expect(group?.metrics.totalMs?.sum).toBeGreaterThanOrEqual(group?.metrics.upstreamMs?.sum ?? Infinity)
    if (stream) { expect(group?.metrics.ttftMs?.sum).toBeGreaterThan(0); expect(group?.metrics.gapMs?.count).toBeGreaterThanOrEqual(1) }
    else expect(group?.metrics.ttftMs).toBeUndefined()
    expect(metrics.legacyRequests).toBe(0)
  })
}
for (const mode of ["json", "missing", "error", "cancel"] as const) test(`preserves ${mode} observability semantics`, async () => {
  jsonFallback = mode === "json"
  missingUsage = mode === "missing"
  upstreamError = mode === "error"
  const response = await app.request("/v1/responses", { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${KEY}` }, body: JSON.stringify({ model: "perf-alias", input: "hi", stream: true }) })
  if (mode === "json") expect(response.headers.get("x-gateway-stream-timing")).toBe("unavailable")
  if (mode === "cancel") {
    const reader = response.body?.getReader()
    await reader?.read()
    await reader?.cancel()
  } else await response.text()
  const group = (await result()).groups[0]
  expect(group).toBeDefined()
  if (mode === "json") expect(group?.metrics.ttftMs).toBeUndefined()
  if (mode === "missing") expect(group?.metrics.outputTokens).toBeUndefined()
  if (mode === "error") expect(group?.outcome).toBe("error")
  if (mode === "cancel") expect(group?.outcome).toBe("cancelled")
})


function eventStream(input: unknown[]): Response {
  const events = truncateStream ? input.slice(0, 3) : input
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
    if (index >= events.length) { controller.close(); return }
    await new Promise(resolve => setTimeout(resolve, 2))
    const event = events[index++]
    controller.enqueue(encoder.encode(`data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`))
  } }), { headers: { "content-type": "text/event-stream" } })
}
async function selectNative(target: "messages" | "chat_completions") {
  const upstream = await platform.repo.upstreams.getById("perf-up")
  if (!upstream) throw new Error("missing fixture upstream")
  await platform.repo.upstreams.save({ ...upstream, config: { ...upstream.config as Record<string, unknown>, endpoints: [target] } })
}
for (const target of ["responses", "messages", "chat_completions"] as const) {
  for (const source of ["responses", "messages", "chat-completions", "gemini"] as const) {
    for (const fallback of [false, true]) test(`missing output usage remains absent on ${source} wire via ${target}, JSON=${fallback}`, async () => {
      if (target !== "responses") await selectNative(target)
      missingUsage = true
      jsonFallback = fallback
      const payload = source === "responses" ? { model: "perf-alias", input: "hi", stream: true } : source === "gemini" ? { contents: [{ role: "user", parts: [{ text: "hi" }] }] } : { model: "perf-alias", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }
      const path = source === "gemini" ? "/v1beta/models/perf-alias:streamGenerateContent" : `/v1/${source === "chat-completions" ? "chat/completions" : source}`
      const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(payload) })
      const wire = await response.text()
      expect(response.status).toBe(200)
      // The existing generic Responses JSON synthesizer emits item envelopes
      // without text deltas; this case verifies usage, not that separate path.
      if (!fallback || target !== "responses" || source === "responses") expect(wire).toContain("Hello")
      const events = wire.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6)) as { type?: string; usage?: { output_tokens?: number; completion_tokens?: number }; response?: { usage?: { output_tokens?: number } }; usageMetadata?: { candidatesTokenCount?: number } })
      for (const event of events) {
        expect(event.type).not.toBe("error")
        expect(event.usage?.output_tokens).toBeUndefined()
        expect(event.usage?.completion_tokens).toBeUndefined()
        expect(event.response?.usage?.output_tokens).toBeUndefined()
        expect(event.usageMetadata?.candidatesTokenCount).toBeUndefined()
      }
      expect((await result()).groups[0]?.metrics.outputTokens).toBeUndefined()
    })
  }
}
for (const target of ["messages", "chat_completions"] as const) {
  for (const source of ["responses", "messages", "chat-completions", "gemini"] as const) {
    for (const stream of [true, false]) test(`collects ${source} via native ${target}, stream=${stream}`, async () => {
      await selectNative(target)
      const payload = source === "responses" ? { model: "perf-alias", input: "hi", stream } : source === "gemini" ? { contents: [{ role: "user", parts: [{ text: "hi" }] }] } : { model: "perf-alias", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream }
      const path = source === "gemini" ? `/v1beta/models/perf-alias:${stream ? "streamGenerateContent" : "generateContent"}` : `/v1/${source === "chat-completions" ? "chat/completions" : source}`
      const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${KEY}`, "x-api-key": KEY }, body: JSON.stringify(payload) })
      expect(response.status).toBe(200)
      const wire = await response.text()
      expect(wire).toContain("Hello")
      if (stream) {
        const events = wire.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
        if (source === "messages") {
          const delta = events.find(event => event.type === "message_delta")
          expect(delta?.usage).toMatchObject({ output_tokens: 20 })
        } else if (source === "responses") {
          const terminal = events.find(event => event.type === "response.completed")
          expect(terminal?.response).toMatchObject({ usage: { output_tokens: 20 } })
        } else if (source === "gemini") {
          expect(events.find(event => event.usageMetadata)?.usageMetadata).toMatchObject({ candidatesTokenCount: 20 })
        }
      }
      const group = (await result()).groups[0]
      expect(group).toMatchObject({ sourceApi: source, targetApi: target === "chat_completions" ? "chat-completions" : target, outcome: "success", stream })
      expect(group?.metrics.inputTokens?.sum).toBe(100)
      expect(group?.metrics.outputTokens?.sum).toBe(20)
      expect(group?.metrics.cachedInputTokens?.sum).toBe(10)
      expect(group?.metrics.upstreamTps?.sum).toBeCloseTo(20 * 1000 / (group?.metrics.upstreamMs?.sum ?? Infinity))
      expect(group?.metrics).not.toHaveProperty("outputTps")
      if (stream) expect(group?.metrics.ttftMs?.count).toBe(1)
      else expect(group?.metrics.ttftMs).toBeUndefined()
    })
  }
  test(`native ${target} JSON fallback cannot fabricate stream metrics or missing usage`, async () => {
    await selectNative(target)
    jsonFallback = true
    missingUsage = true
    const path = target === "messages" ? "/v1/messages" : "/v1/chat/completions"
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${KEY}` }, body: JSON.stringify({ model: "perf-alias", max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true }) })
    await response.text()
    const group = (await result()).groups[0]
    expect(group?.metrics.ttftMs).toBeUndefined()
    expect(group?.metrics.outputTokens).toBeUndefined()
    expect(group?.metrics.overallTps).toBeUndefined()
  })
}

test("real API-key middleware limits metrics to the authenticated key", async () => {
  const hour = new Date().toISOString().slice(0, 13)
  const response = await app.request("/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify({ model: "perf-alias", input: "hi", stream: true }) })
  await response.text()
  const collected = await result()
  const own = collected.groups[0]
  if (!own) throw new Error("expected own metrics")
  await platform.repo.apiKeys.save({ id: "foreign-key", name: "foreign", key: "foreign-secret", createdAt: "2026-09-08", modelMappingsEnabled: false, modelMappings: [] })
  await platform.repo.performanceMetrics.record({ hour, legacyRecorded: false, group: { ...own, keyId: "foreign-key" } })
  const path = `/api/performance/metrics?start=${hour}&end=${hour}`
  const query = await app.request(path, { headers: { authorization: `Bearer ${KEY}` } })
  expect(query.status).toBe(200)
  expect((await query.json() as PerformanceMetricsResponse).groups.map(group => group.keyId)).toEqual(["perf-key"])
  const forbidden = await app.request(`${path}&key_id=foreign-key`, { headers: { authorization: `Bearer ${KEY}` } })
  expect(await forbidden.json()).toEqual({ version: 2, groups: [], legacyRequests: 0 })
})

test("hosted search sums upstream usage while excluding tool waiting from upstream duration", async () => {
  await selectNative("chat_completions")
  const key = await platform.repo.apiKeys.getById("perf-key")
  if (!key) throw new Error("missing fixture key")
  await platform.repo.apiKeys.save({ ...key, webSearchEnabled: true, webSearchPriority: ["tavily"], webSearchTavilyKey: "fixture" })
  hostedSearch = true
  const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify({ model: "perf-alias", messages: [{ role: "user", content: "hi" }], stream: true, web_search_options: {} }) })
  expect(response.status).toBe(200)
  const wire = await response.text()
  expect(wire).toContain("Hello")
  expect(upstreamCalls).toBe(2)
  expect(searchCalls).toBe(1)
  const metrics = await result()
  expect(metrics.groups).toHaveLength(1)
  const group = metrics.groups[0]
  expect(group?.requests).toBe(1)
  expect(group?.outcome).toBe("success")
  expect(group?.metrics.inputTokens?.sum).toBe(130)
  expect(group?.metrics.outputTokens?.sum).toBe(25)
  expect(group?.metrics.cachedInputTokens?.sum).toBe(10)
  expect(group?.metrics.reasoningTokens?.sum).toBe(6)
  expect(group?.metrics.firstTextMs?.sum).toBeGreaterThan(group?.metrics.ttftMs?.sum ?? Infinity)
  expect((group?.metrics.totalMs?.sum ?? 0) - (group?.metrics.upstreamMs?.sum ?? Infinity)).toBeGreaterThanOrEqual(25)
  expect(metrics.legacyRequests).toBe(0)
})

test("request timing includes inbound body reading before dispatch", async () => {
  const body = new ReadableStream<Uint8Array>({ async start(controller) {
    await new Promise(resolve => setTimeout(resolve, 45))
    controller.enqueue(encoder.encode(JSON.stringify({ model: "perf-alias", input: "hi", stream: true })))
    controller.close()
  } })
  const response = await app.request("/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body })
  await response.text()
  const group = (await result()).groups[0]
  expect(group?.metrics.ttftMs?.sum).toBeGreaterThanOrEqual(40)
  expect((group?.metrics.totalMs?.sum ?? 0) - (group?.metrics.upstreamMs?.sum ?? Infinity)).toBeGreaterThanOrEqual(40)
})

test("real session shared view verifies grants and redacts only owned keys", async () => {
  const key = await platform.repo.apiKeys.getById("perf-key")
  if (!key) throw new Error("missing fixture key")
  await platform.repo.apiKeys.save({ ...key, ownerId: "metric-owner" })
  await platform.repo.users.create({ id: "metric-viewer", name: "viewer", createdAt: "2026-09-08", disabled: false })
  await platform.repo.sessions.create({ token: "ses_metric_viewer", userId: "metric-viewer", createdAt: "2026-09-08", expiresAt: "2099-01-01" })
  const response = await app.request("/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify({ model: "perf-alias", input: "hi", stream: true }) })
  await response.text()
  await result()
  const hour = new Date().toISOString().slice(0, 13)
  const path = `/api/performance/metrics?start=${hour}&end=${hour}&as_user=metric-owner`
  const headers = { cookie: "session_token=ses_metric_viewer" }
  const env = { SERVER_SECRET: "performance-shared-fixture" }
  expect((await app.request(path, { headers }, env)).status).toBe(403)
  await platform.repo.observabilityShares.share("metric-owner", "metric-viewer", "metric-owner")
  const query = await app.request(path, { headers }, env)
  expect(query.status).toBe(200)
  const shared = await query.json() as PerformanceMetricsResponse
  expect(shared.groups).toHaveLength(1)
  expect(shared.groups[0]?.keyId).toMatch(/^[A-Za-z0-9_-]{16}$/)
  expect(shared.groups[0]?.keyId).not.toBe("perf-key")
  const filtered = await app.request(`${path}&key_id=${shared.groups[0]?.keyId}`, { headers }, env)
  expect((await filtered.json() as PerformanceMetricsResponse).groups).toHaveLength(1)
})


for (const source of ["responses", "messages", "chat-completions", "gemini"] as const) {
  for (const mode of ["cancel", "truncated", "dump-cancel"] as const) test(`${source} real transport ${mode} is not successful`, async () => {
    if (source === "messages") await selectNative("messages")
    if (source === "chat-completions") await selectNative("chat_completions")
    truncateStream = mode === "truncated"
    if (mode === "dump-cancel") {
      const key = await platform.repo.apiKeys.getById("perf-key")
      if (!key) throw new Error("missing fixture key")
      await platform.repo.apiKeys.save({ ...key, dumpRetentionSeconds: 60 })
    }
    const payload = source === "responses" ? { model: "perf-alias", input: "hi", stream: true } : source === "gemini" ? { contents: [{ role: "user", parts: [{ text: "hi" }] }] } : { model: "perf-alias", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }
    const path = source === "gemini" ? "/v1beta/models/perf-alias:streamGenerateContent" : `/v1/${source === "chat-completions" ? "chat/completions" : source}`
    const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${KEY}` }, body: JSON.stringify(payload) })
    expect(response.status).toBe(200)
    if (mode === "dump-cancel") expect(response.headers.get("x-dump-record-id")).toBeTruthy()
    if (mode === "truncated") await response.text()
    else {
      const reader = response.body?.getReader()
      await reader?.read()
      await reader?.cancel()
    }
    const metrics = await result()
    expect(metrics.groups).toHaveLength(1)
    expect(metrics.groups[0]?.outcome).toBe(mode === "truncated" ? "error" : "cancelled")
    expect(metrics.groups[0]?.metrics.outputTokens).toBeUndefined()
    expect(metrics.legacyRequests).toBe(0)
  })
}
