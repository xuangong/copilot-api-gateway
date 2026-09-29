import { bunSocketDial } from "../../../../apps/platform-bun/src/bun-socket-dial.ts"
import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests, initSocketDial, initBackground } from "@vibe-core/platform"
import { setupTestPlatform } from "../_setup-platform.ts"
import { serveResponses } from "../../src/data-plane/chat-flow/responses/serve.ts"
import { serveMessages } from "../../src/data-plane/chat-flow/messages/serve.ts"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); __resetPlatformForTests() })
const thought = "  complete thought\n"
const opaque = "native-signature"
const reasoning = { type: "reasoning", id: "reasoning", summary: [{ type: "summary_text", text: thought }], encrypted_content: opaque }
const thinking = { type: "thinking", thinking: thought, signature: opaque }
function wire(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
}
function upstreamResponse(protocol: "responses" | "messages", stream: boolean): Response {
  if (protocol === "responses") {
    const body = { id: "response", object: "response", model: "model", status: "completed", output: [reasoning], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    return stream ? wire([
      { type: "response.created", response: { ...body, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.completed", response: body },
    ]) : Response.json(body)
  }
  const body = { id: "message", type: "message", role: "assistant", model: "model", content: [thinking], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  return stream ? wire([
    { type: "message_start", message: { ...body, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: opaque } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]) : Response.json(body)
}
async function fixture(protocol: "responses" | "messages", stream: boolean, customResponse?: () => Response) {
  const { db, repo } = setupTestPlatform()
  initSocketDial(bunSocketDial)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: promise => { pending.push(promise) } })
  cleanup.push(() => db.close())
  db.run("INSERT INTO api_keys (id, name, key, owner_id, created_at) VALUES ('key', 'test', 'fixture-key', 'owner', 'now'), ('other', 'test', 'other-key', 'owner', 'now')")
  const sent: Record<string, unknown>[] = []
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    sent.push(await request.json() as Record<string, unknown>)
    return customResponse?.() ?? upstreamResponse(protocol, stream)
  } })
  cleanup.unshift(() => { upstream.stop(true) })
  await repo.upstreams.save({ id: "up", provider: "custom", ownerId: "owner", name: "test", enabled: true, sortOrder: 0,
    config: { name: "test", baseUrl: upstream.url.toString().replace(/\/$/, ""), authStyle: "none", endpoints: [protocol], models: ["model"] }, state: {},
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "now", updatedAt: "now" })
  const gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const raw = await request.json()
    const auth = { userId: "owner", apiKeyId: request.headers.get("x-test-key") ?? "key" }
    const args = { raw, auth, obsCtx: {}, signal: request.signal }
    return new URL(request.url).pathname === "/responses" ? (await serveResponses(args)).response : await serveMessages(args)
  } })
  cleanup.unshift(() => { gateway.stop(true) })
  return { sent, db, pending, async call(source: "responses" | "messages", raw: Record<string, unknown>, key = "key") {
    return fetch(new URL(source, gateway.url), { method: "POST", headers: { "content-type": "application/json", "x-test-key": key }, body: JSON.stringify({ model: "model", stream, ...raw }) })
  } }
}
function events(text: string): Array<Record<string, unknown>> { return text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)) as Record<string, unknown>) }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected fixture object"); return value as Record<string, unknown> }

for (const source of ["responses", "messages"] as const) for (const target of ["responses", "messages"] as const) for (const stream of [false, true]) {
  test(`actual ${source} -> ${target} ${stream ? "SSE" : "JSON"} signs, replays, and rejects another key before inference`, async () => {
    const f = await fixture(target, stream)
    const initial = source === "responses" ? { input: "question" } : { messages: [{ role: "user", content: "question" }], max_tokens: 100 }
    const first = await f.call(source, initial)
    expect(first.status).toBe(200)
    let item: Record<string, unknown>
    if (!stream) {
      const body = await first.json()
      item = object((source === "responses" ? body.output : body.content)[0])
    } else {
      const frames = events(await first.text())
      if (source === "responses") {
        const body = object(frames.find(event => event.type === "response.completed")?.response)
        item = object((body.output as unknown[])[0])
        const done = frames.find(event => event.type === "response.output_item.done")
        expect(done?.item).toEqual(item)
      } else {
        const deltas = frames.filter(event => event.type === "content_block_delta").map(event => object(event.delta))
        item = { type: "thinking", thinking: deltas.filter(delta => delta.type === "thinking_delta").map(delta => delta.thinking).join(""), signature: deltas.filter(delta => delta.type === "signature_delta").map(delta => delta.signature).join("") }
      }
    }
    expect(source === "responses" ? item.encrypted_content : item.signature).toStartWith("vnext-affinity:1:")
    const replay = source === "responses" ? { input: [item] } : { messages: [{ role: "assistant", content: [item] }, { role: "user", content: "continue" }], max_tokens: 100 }
    const second = await f.call(source, replay)
    expect(second.status).toBe(200)
    await second.text()
    expect(f.sent).toHaveLength(2)
    expect(JSON.stringify(f.sent[1])).toContain(opaque)
    expect(JSON.stringify(f.sent[1])).not.toContain("vnext-affinity")
    expect(JSON.stringify(f.sent[1])).toContain(JSON.stringify(thought).slice(1, -1))
    const wrongKey = await f.call(source, replay, "other")
    expect(wrongKey.status).toBe(400)
    await wrongKey.text()
    expect(f.sent).toHaveLength(2)
  })
}

for (const source of ["responses", "messages"] as const) for (const stream of [false, true]) {
  test(`actual ${source} ${stream ? "SSE" : "JSON"} rejects upstream SSE overflow as error, not caller cancellation`, async () => {
    const f = await fixture("messages", stream, () => wire([
      { type: "message_start", message: { id: "m", type: "message", model: "model", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      ...Array.from({ length: 10 }, () => ({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "a".repeat(128 * 1024) } })),
    ]))
    const response = await f.call(source, source === "responses" ? { input: "question" } : { messages: [{ role: "user", content: "question" }], max_tokens: 100 })
    const body = await response.text()
    expect(body).toContain("Invalid authenticated opaque state")
    expect(body).not.toContain("vnext-affinity:")
    expect(body).not.toContain('"type":"response.completed"')
    await Promise.all(f.pending)
    const metrics = f.db.query("SELECT dimensions FROM performance_metrics WHERE metric = '__requests'").all() as Array<{ dimensions: string }>
    expect(metrics).toHaveLength(1)
    expect(JSON.parse(metrics[0]!.dimensions).outcome).toBe("error")
  })

  for (const deltas of [false, true]) test(`actual ${source} ${stream ? "SSE" : "JSON"} preserves ${deltas ? "delta" : "initial"} tool fields from upstream SSE without secret creation`, async () => {
    const input = { type: "thinking", signature: "x".repeat(1024 * 1024 + 1), encrypted_content: "business", fingerprint: "business" }
    const block = { type: "tool_use", id: "call", name: "save", input }
    const f = await fixture("messages", stream, () => wire([
      { type: "message_start", message: { id: "m", type: "message", model: "model", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: block },
      ...(deltas ? [{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }] : []),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]))
    const response = await f.call(source, source === "responses" ? { input: "question" } : { messages: [{ role: "user", content: "question" }], max_tokens: 100 })
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).not.toContain("Invalid opaque")
    expect(body).toContain("business")
    expect(body).toContain(input.signature)
    await Promise.all(f.pending)
    expect(f.db.query("SELECT affinity_secret FROM api_keys WHERE id = 'key'").get()).toEqual({ affinity_secret: null })
  })
}


for (const source of ["responses", "messages"] as const) test(`actual ${source} JSON reconstructs complete thinking and signature from upstream SSE`, async () => {
  const f = await fixture("messages", false, () => wire([
    { type: "message_start", message: { id: "m", type: "message", model: "model", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: thought.slice(0, 3), signature: opaque.slice(0, 3) } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought.slice(3) } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: opaque.slice(3) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]))
  const result = await f.call(source, source === "responses" ? { input: "question" } : { messages: [{ role: "user", content: "question" }], max_tokens: 100 })
  const body = await result.json()
  const item = source === "responses" ? body.output[0] : body.content[0]
  expect(source === "responses" ? item.encrypted_content : item.signature).toStartWith("vnext-affinity:1:")
  expect(source === "responses" ? item.summary[0].text : item.thinking).toBe(thought)
  const replay = await f.call(source, source === "responses" ? { input: [item] } : { messages: [{ role: "assistant", content: [item] }, { role: "user", content: "continue" }], max_tokens: 100 })
  expect(replay.status).toBe(200)
  await replay.text()
  expect(JSON.stringify(f.sent[1])).toContain(opaque)
  expect(JSON.stringify(f.sent[1])).toContain(JSON.stringify(thought).slice(1, -1))
  expect(JSON.stringify(f.sent[1])).not.toContain("vnext-affinity:")
  await Promise.all(f.pending)
})
