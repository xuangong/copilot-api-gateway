import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { __resetPlatformForTests, initBackground, initSocketDial } from "@vibe-core/platform"
import { bunSocketDial } from "../../../../apps/platform-bun/src/bun-socket-dial.ts"
import { setupTestPlatform } from "../_setup-platform.ts"
import { serveChatCompletions } from "../../src/data-plane/chat-flow/chat-completions/serve.ts"
import { serveResponses } from "../../src/data-plane/chat-flow/responses/serve.ts"
import { serveMessages } from "../../src/data-plane/chat-flow/messages/serve.ts"

type Protocol = "chat_completions" | "responses" | "messages"
type Mode = "respect-stream" | "json-fallback" | "json-fallback-untyped" | "json-fallback-text" | "runaway"
type JsonObject = Record<string, unknown>
const protocols: readonly Protocol[] = ["chat_completions", "responses", "messages"]
const encoder = new TextEncoder()
const toolArguments = '{"city":"Oslo"}'
const text = "Weather ready."

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object")
  return value as JsonObject
}

function items(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error("Expected array")
  return value.map(object)
}

function terminal(protocol: Protocol): JsonObject {
  if (protocol === "chat_completions") return {
    id: "chat_fixture", object: "chat.completion", created: 1, model: "model",
    choices: [{ index: 0, message: { role: "assistant", content: text, tool_calls: [{ id: "call_fixture", type: "function", function: { name: "weather", arguments: toolArguments } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
  }
  if (protocol === "responses") return {
    id: "resp_fixture", object: "response", model: "model", status: "completed",
    output: [
      { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
      { id: "fc_fixture", type: "function_call", call_id: "call_fixture", name: "weather", arguments: toolArguments, status: "completed" },
    ],
    usage: { input_tokens: 31, output_tokens: 7, total_tokens: 38 },
  }
  return {
    id: "msg_fixture", type: "message", role: "assistant", model: "model",
    content: [{ type: "text", text }, { type: "tool_use", id: "call_fixture", name: "weather", input: { city: "Oslo" } }],
    stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 31, output_tokens: 7 },
  }
}

function generationEvents(protocol: Protocol): Array<JsonObject | string> {
  const final = terminal(protocol)
  if (protocol === "chat_completions") {
    const base = { id: "chat_fixture", object: "chat.completion.chunk", model: "model", created: 1 }
    const chunk = (delta: JsonObject, finish_reason: string | null = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] })
    return [
      chunk({ role: "assistant", content: "Weather " }),
      chunk({ content: "ready." }),
      chunk({ tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "weather", arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }),
      chunk({}, "tool_calls"),
      { ...base, choices: [], usage: final.usage },
      "[DONE]",
    ]
  }
  if (protocol === "responses") {
    const [message, call] = items(final.output)
    return [
      { type: "response.created", response: { ...final, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_fixture", type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_fixture", part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_fixture", delta: "Weather " },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_fixture", delta: "ready." },
      { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_fixture", text },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_fixture", delta: '{"city":' },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_fixture", delta: '"Oslo"}' },
      { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_fixture", arguments: toolArguments },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.completed", response: final },
    ]
  }
  return [
    { type: "message_start", message: { ...final, content: [], stop_reason: null, usage: { input_tokens: 31, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Weather " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ready." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_fixture", name: "weather", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Oslo"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]
}

function wire(events: Array<JsonObject | string>): Uint8Array {
  return encoder.encode(events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""))
}

function input(protocol: Protocol, stream = false): JsonObject {
  const common = { model: "model", stream }
  if (protocol === "responses") return { ...common, input: [{ role: "user", content: "Find Oslo weather" }], tools: [{ type: "function", name: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } }] }
  const messages = [{ role: "user", content: "Find Oslo weather" }]
  if (protocol === "messages") return { ...common, messages, max_tokens: 100, tools: [{ name: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }] }
  return { ...common, messages, stream_options: { include_usage: false }, tools: [{ type: "function", function: { name: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }] }
}

async function withDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Gateway did not finish before upstream completion was released")), 3000) })])
  } finally {
    clearTimeout(timer)
  }
}

async function fixture(target: Protocol, mode: Mode = "respect-stream") {
  const { db, repo } = setupTestPlatform()
  initSocketDial(bunSocketDial)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: promise => { pending.push(promise) } })
  db.run("INSERT INTO api_keys (id, name, key, owner_id, created_at) VALUES ('key', 'test', 'fixture-key', 'owner', 'now')")
  const sent: JsonObject[] = []
  const received: Array<{ raw: JsonObject; before: JsonObject }> = []
  const disconnected = Promise.withResolvers<void>()
  let normalCompletionSent = false
  let release: (() => void) | undefined
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const payload = object(await request.json())
    sent.push(payload)
    if (mode === "json-fallback-text") return new Response(JSON.stringify(terminal(target)), { headers: { "content-type": "text/plain" } })
    // The fixture obeys the real request, so pre-adoption providers take JSON.
    if (mode === "json-fallback" || payload.stream !== true) return Response.json(terminal(target))
    if (mode !== "runaway") {
      const events = generationEvents(target)
      const includeUsage = target !== "chat_completions" || object(payload.stream_options ?? {}).include_usage === true
      return new Response(wire(includeUsage ? events : events.filter(event => typeof event === "string" || event.usage === undefined)), { headers: { "content-type": "text/event-stream" } })
    }
    request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true })
    const prefix = target === "chat_completions" ? [
      { id: "chat_runaway", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_runaway", type: "function", function: { name: "weather", arguments: "{" } }] }, finish_reason: null }] },
      ...Array.from({ length: 4 }, () => ({ id: "chat_runaway", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\n\t\r".repeat(4) } }] }, finish_reason: null }] })),
    ] : [
      { type: "response.created", response: { id: "resp_runaway", object: "response", model: "model", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_runaway", type: "function_call", call_id: "call_runaway", name: "weather", arguments: "", status: "in_progress" } },
      ...Array.from({ length: 4 }, () => ({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_runaway", delta: "\n\t\r".repeat(4) })),
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(wire(prefix))
        // The successful terminal stays gated until test cleanup. A passing
        // request must return an error and disconnect without releasing it.
        release = () => {
          if (request.signal.aborted) return
          try {
            controller.enqueue(wire(generationEvents(target)))
            controller.close()
            normalCompletionSent = true
          } catch { /* Cancellation can close the controller before signal delivery. */ }
        }
      },
      cancel() { disconnected.resolve() },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  } })
  let gateway: ReturnType<typeof Bun.serve> | undefined
  let untypedUpstream: ReturnType<typeof createServer> | undefined
  async function close() {
    release?.()
    gateway?.stop(true)
    upstream.stop(true)
    untypedUpstream?.closeAllConnections()
    untypedUpstream?.close()
    await Promise.allSettled(pending)
    db.close()
    __resetPlatformForTests()
  }
  try {
    let baseUrl = upstream.url.toString().replace(/\/$/, "")
    if (mode === "json-fallback-untyped") {
      // Bun synthesizes Content-Type for byte responses. Node HTTP lets this
      // compatibility fixture omit the header on the actual network wire.
      untypedUpstream = createServer((request, response) => {
        let body = ""
        request.setEncoding("utf8")
        request.on("data", (chunk: string) => { body += chunk })
        request.on("end", () => {
          sent.push(object(JSON.parse(body)))
          response.end(JSON.stringify(terminal(target)))
        })
      })
      const server = untypedUpstream
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Expected fixture TCP address")
      baseUrl = `http://127.0.0.1:${address.port}`
    }
    await repo.upstreams.save({ id: "up", provider: "custom", ownerId: "owner", name: "test", enabled: true, sortOrder: 0,
      config: { name: "test", baseUrl, authStyle: "none", endpoints: [target], models: ["model"] },
      state: {}, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "now", updatedAt: "now" })
    gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      const raw = object(await request.json())
      received.push({ raw, before: structuredClone(raw) })
      const args = { raw, auth: { userId: "owner", apiKeyId: "key" }, obsCtx: {}, signal: request.signal }
      const path = new URL(request.url).pathname
      if (path === "/responses") return (await serveResponses(args)).response
      return path === "/messages" ? serveMessages(args) : serveChatCompletions(args)
    } })
    const gatewayUrl = gateway.url
    return {
      sent, received, disconnected: disconnected.promise, close,
      normalCompletionSent: () => normalCompletionSent,
      call(source: Protocol, stream = false) {
        return fetch(new URL(source, gatewayUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input(source, stream)), signal: AbortSignal.timeout(5000) })
      },
      async metrics() {
        await Promise.all(pending)
        const hour = new Date().toISOString().slice(0, 13)
        return (await repo.performanceMetrics.query({ start: hour, end: hour })).groups
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

function expectFinal(source: Protocol, body: JsonObject): void {
  if (source === "chat_completions") {
    const choice = items(body.choices)[0]
    expect(choice).toMatchObject({ finish_reason: "tool_calls", message: { role: "assistant", content: text, tool_calls: [{ id: "call_fixture", type: "function", function: { name: "weather", arguments: toolArguments } }] } })
    expect(body.usage).toMatchObject({ prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 })
  } else if (source === "responses") {
    expect(body.status).toBe("completed")
    const output = items(body.output)
    expect(output.find(item => item.type === "message")).toMatchObject({ role: "assistant", content: [{ type: "output_text", text }] })
    expect(output.find(item => item.type === "function_call")).toMatchObject({ call_id: "call_fixture", name: "weather", arguments: toolArguments })
    expect(body.usage).toMatchObject({ input_tokens: 31, output_tokens: 7, total_tokens: 38 })
  } else {
    expect(body).toMatchObject({ type: "message", role: "assistant", stop_reason: "tool_use", usage: { input_tokens: 31, output_tokens: 7 } })
    const content = items(body.content)
    const [origin, ...visible] = content
    expect(origin).toMatchObject({ type: "redacted_thinking", data: expect.stringContaining("vnext-affinity:2:") })
    expect(Object.keys(origin ?? {}).sort()).toEqual(["data", "type"])
    expect(visible).toEqual([{ type: "text", text }, { type: "tool_use", id: "call_fixture", name: "weather", input: { city: "Oslo" } }])
  }
}

for (const target of protocols) for (const source of protocols) {
  test(`${source} JSON preserves text, tools and usage while Custom ${target} requests SSE`, async () => {
    const f = await fixture(target)
    try {
      const response = await f.call(source)
      const body = object(await response.json())
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(f.sent).toHaveLength(1)
      expect(f.sent[0]?.stream).toBe(true)
      if (target === "chat_completions") expect(f.sent[0]?.stream_options).toMatchObject({ include_usage: true })
      expectFinal(source, body)
      expect(f.received).toHaveLength(1)
      expect(f.received[0]?.raw).toEqual(f.received[0]?.before)
      const metrics = await f.metrics()
      expect(metrics).toHaveLength(1)
      expect(metrics[0]).toMatchObject({ outcome: "success", stream: false })
      expect(metrics[0]?.metrics.outputTokens?.sum).toBe(7)
      expect(metrics[0]?.metrics.ttftMs).toBeUndefined()
      expect(metrics[0]?.metrics.upstreamTtftMs?.count).toBe(1)
      expect(metrics[0]?.metrics.upstreamTtftMs?.sum).toBeGreaterThanOrEqual(0)
    } finally { await f.close() }
  })
}

for (const protocol of protocols) for (const mode of ["respect-stream", "json-fallback"] as const) {
  test(`${protocol} SSE client ${mode === "json-fallback" ? "accepts JSON fallback without fabricated" : "records real SSE"} TTFT`, async () => {
    const f = await fixture(protocol, mode)
    try {
      const response = await f.call(protocol, true)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      expect(body).toContain("Weather")
      expect(body).toContain("Oslo")
      expect(f.sent[0]?.stream).toBe(true)
      const metrics = await f.metrics()
      expect(metrics).toHaveLength(1)
      expect(metrics[0]).toMatchObject({ outcome: "success", stream: true })
      expect(metrics[0]?.metrics.outputTokens?.sum).toBe(7)
      if (mode === "json-fallback") {
        expect(metrics[0]?.metrics.ttftMs).toBeUndefined()
        expect(metrics[0]?.metrics.upstreamTtftMs).toBeUndefined()
      }
      else {
        expect(metrics[0]?.metrics.ttftMs?.count).toBe(1)
        expect(metrics[0]?.metrics.ttftMs?.sum).toBeGreaterThanOrEqual(0)
        expect(metrics[0]?.metrics.upstreamTtftMs?.count).toBe(1)
        expect(metrics[0]?.metrics.upstreamTtftMs?.sum).toBeGreaterThanOrEqual(0)
      }
    } finally { await f.close() }
  })
}

for (const protocol of protocols) {
  test(`${protocol} JSON client accepts an upstream that ignores stream=true`, async () => {
    const f = await fixture(protocol, "json-fallback")
    try {
      const response = await f.call(protocol)
      const body = object(await response.json())
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(f.sent[0]?.stream).toBe(true)
      expectFinal(protocol, body)
      const metrics = await f.metrics()
      expect(metrics[0]?.outcome).toBe("success")
      expect(metrics[0]?.metrics.ttftMs).toBeUndefined()
      expect(metrics[0]?.metrics.upstreamTtftMs).toBeUndefined()
    } finally { await f.close() }
  })
}

for (const source of protocols) for (const mode of ["json-fallback-untyped", "json-fallback-text"] as const) {
  test(`${source} JSON client accepts Custom Chat JSON fallback with ${mode === "json-fallback-untyped" ? "missing Content-Type" : "text/plain"}`, async () => {
    const f = await fixture("chat_completions", mode)
    try {
      const response = await f.call(source)
      const body = object(await response.json())
      expect(f.sent[0]?.stream).toBe(true)
      expect(f.sent[0]?.stream_options).toMatchObject({ include_usage: true })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/json")
      expectFinal(source, body)
      expect(f.received[0]?.raw).toEqual(f.received[0]?.before)
      const metrics = await f.metrics()
      expect(metrics).toHaveLength(1)
      expect(metrics[0]?.outcome).toBe("success")
      expect(metrics[0]?.metrics.inputTokens?.sum).toBe(31)
      expect(metrics[0]?.metrics.outputTokens?.sum).toBe(7)
      expect(metrics[0]?.metrics.ttftMs).toBeUndefined()
      expect(metrics[0]?.metrics.upstreamTtftMs).toBeUndefined()
    } finally { await f.close() }
  })
}

for (const target of ["chat_completions", "responses"] as const) for (const source of protocols) {
  test(`${source} JSON aborts Custom ${target} runaway arguments before upstream completion`, async () => {
    const f = await fixture(target, "runaway")
    try {
      const response = await withDeadline(f.call(source))
      const body = await response.text()
      expect(f.sent[0]?.stream).toBe(true)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(object(JSON.parse(body)).error).toBeDefined()
      expect(body).not.toContain('"status":"completed"')
      await withDeadline(f.disconnected)
      expect(f.normalCompletionSent()).toBe(false)
      const metrics = await f.metrics()
      expect(metrics).toHaveLength(1)
      expect(metrics[0]?.outcome).toBe("error")
    } finally { await f.close() }
  })
}
