import { bunSocketDial } from "../../../../apps/platform-bun/src/bun-socket-dial.ts"
import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests, initSocketDial, initBackground } from "@vibe-core/platform"
import { setupTestPlatform } from "../_setup-platform.ts"
import { serveResponses } from "../../src/data-plane/chat-flow/responses/serve.ts"
import { serveMessages } from "../../src/data-plane/chat-flow/messages/serve.ts"
import { serveChatCompletions } from "../../src/data-plane/chat-flow/chat-completions/serve.ts"
import { serveGemini } from "../../src/data-plane/chat-flow/gemini/serve.ts"
import type { AffinityProtocol } from "../../src/shared/affinity/analysis.ts"

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
    const path = new URL(request.url).pathname
    if (path === "/responses") return (await serveResponses(args)).response
    if (path === "/chat_completions") return serveChatCompletions(args)
    if (path === "/gemini") return serveGemini({ ...args, model: "model", forceStream: stream })
    return serveMessages(args)
  } })
  cleanup.unshift(() => { gateway.stop(true) })
  return { sent, db, pending, async call(source: AffinityProtocol, raw: Record<string, unknown>, key = "key") {
    return fetch(new URL(source, gateway.url), { method: "POST", headers: { "content-type": "application/json", "x-test-key": key }, body: JSON.stringify(source === "gemini" ? raw : { model: "model", stream, ...raw }) })
  } }
}
function events(text: string): Array<Record<string, unknown>> { return text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)) as Record<string, unknown>) }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected fixture object"); return value as Record<string, unknown> }
function objects(value: unknown): Array<Record<string, unknown>> { if (!Array.isArray(value)) throw new Error("Expected fixture array"); return value.map(object) }
function naturalItem(items: Array<Record<string, unknown>>, key: string): Record<string, unknown> {
  const item = items.find(value => typeof value[key] === "string" && value[key].startsWith("vnext-affinity:1:"))
  if (!item) throw new Error(`Expected one natural affinity item in ${key}`)
  expect(items.filter(value => typeof value[key] === "string" && value[key].startsWith("vnext-affinity:1:"))).toHaveLength(1)
  return item
}
function messageBlocks(frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const blocks = new Map<number, Record<string, unknown>>()
  const argumentsByIndex = new Map<number, string>()
  for (const frame of frames) {
    const index = frame.index as number
    if (frame.type === "content_block_start") blocks.set(index, structuredClone(object(frame.content_block)))
    if (frame.type === "content_block_delta") {
      const delta = object(frame.delta)
      const block = blocks.get(index)
      if (!block) throw new Error("Content delta preceded its block start")
      if (delta.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + String(delta.thinking)
      if (delta.type === "signature_delta") block.signature = String(block.signature ?? "") + String(delta.signature)
      if (delta.type === "text_delta") block.text = String(block.text ?? "") + String(delta.text)
      if (delta.type === "input_json_delta") argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? "") + String(delta.partial_json))
    }
    if (frame.type === "content_block_stop" && argumentsByIndex.has(index)) blocks.get(index)!.input = JSON.parse(argumentsByIndex.get(index)!)
  }
  return [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block)
}
function outputItems(source: "responses" | "messages", body: string, stream: boolean): Array<Record<string, unknown>> {
  if (!stream) {
    const parsed = object(JSON.parse(body))
    return objects(source === "responses" ? parsed.output : parsed.content)
  }
  const frames = events(body)
  if (source === "messages") return messageBlocks(frames)
  const terminal = frames.find(event => event.type === "response.completed")
  if (!terminal) throw new Error(`Missing completed response: ${JSON.stringify(frames.map(frame => ({ type: frame.type, message: frame.message, error: frame.error })))}`)
  return objects(object(terminal.response).output)
}

for (const source of ["responses", "messages"] as const) for (const target of ["responses", "messages"] as const) for (const stream of [false, true]) {
  test(`actual ${source} -> ${target} ${stream ? "SSE" : "JSON"} signs, replays, and rejects another key before inference`, async () => {
    const f = await fixture(target, stream)
    const initial = source === "responses" ? { input: "question" } : { messages: [{ role: "user", content: "question" }], max_tokens: 100 }
    const first = await f.call(source, initial)
    expect(first.status).toBe(200)
    const text = await first.text()
    const items = outputItems(source, text, stream)
    const item = naturalItem(items, source === "responses" ? "encrypted_content" : "signature")
    if (source === "responses" && stream) {
      const done = events(text).find(event => event.type === "response.output_item.done" && object(event.item).encrypted_content === item.encrypted_content)
      expect(done?.item).toEqual(item)
    }
    expect(source === "responses" ? item.encrypted_content : item.signature).toStartWith("vnext-affinity:1:")
    const replay = source === "responses" ? { input: items } : { messages: [{ role: "assistant", content: items }, { role: "user", content: "continue" }], max_tokens: 100 }
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
    // A streaming prefix may already authenticate the producer before a later
    // native-state overflow. It must never turn that failure into completion.
    expect(body).not.toContain("vnext-affinity:1:")
    expect(body).not.toContain('"type":"response.completed"')
    expect(body).not.toContain('"type":"message_stop"')
    expect(body).not.toContain('"stop_reason":"end_turn"')
    await Promise.all(f.pending)
    const metrics = f.db.query("SELECT dimensions FROM performance_metrics WHERE metric = '__requests'").all() as Array<{ dimensions: string }>
    expect(metrics).toHaveLength(1)
    expect(JSON.parse(metrics[0]!.dimensions).outcome).toBe("error")
  })

  for (const deltas of [false, true]) test(`actual ${source} ${stream ? "SSE" : "JSON"} adds origin while preserving ${deltas ? "delta" : "initial"} tool business fields`, async () => {
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
    expect(body).not.toContain("Invalid authenticated opaque state")
    expect(body).toContain("business")
    expect(body).toContain(input.signature)
    const emitted = source === "responses" && stream
      ? events(body).filter(frame => frame.type === "response.output_item.done").map(frame => object(frame.item))
      : outputItems(source, body, stream)
    const tool = emitted.find(item => item.type === (source === "responses" ? "function_call" : "tool_use"))
    expect(tool).toBeDefined()
    expect(source === "responses" ? JSON.parse(String(tool!.arguments)) : tool!.input).toEqual(input)
    expect(body).toContain("vnext-affinity:2:")
    if (source === "responses" && stream) {
      // This business argument intentionally exceeds 1 MiB. Its item is emitted
      // intact, while the independent terminal-observation bound still applies.
      expect(events(body).at(-1)).toMatchObject({ type: "error", message: "Upstream stream exceeded the terminal observation limit." })
      expect(body).not.toContain('"type":"response.completed"')
    }
    await Promise.all(f.pending)
    expect(object(f.db.query("SELECT affinity_secret FROM api_keys WHERE id = 'key'").get()).affinity_secret).toBeString()
  })
}


function plainInput(source: AffinityProtocol): Record<string, unknown> {
  if (source === "responses") return { input: "question" }
  if (source === "gemini") return { contents: [{ role: "user", parts: [{ text: "question" }] }] }
  return { messages: [{ role: "user", content: "question" }], max_tokens: 100 }
}
function firstObject(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error("Expected fixture array")
  return object(value[0])
}

for (const source of ["responses", "messages", "chat_completions", "gemini"] as const) test(`actual ${source} JSON signs complete upstream SSE state once before exact raw replay`, async () => {
  const f = await fixture("messages", false, () => wire([
    { type: "message_start", message: { id: "m", type: "message", model: "model", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: thought.slice(0, 3), signature: opaque.slice(0, 3) } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thought.slice(3) } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: opaque.slice(3) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]))
  const input = plainInput(source)
  if (source === "gemini") input.generationConfig = { thinkingConfig: { includeThoughts: true } }
  const result = await f.call(source, input)
  expect(result.status).toBe(200)
  const body = object(await result.json())
  const opaqueField = source === "responses" ? "encrypted_content" : source === "messages" ? "signature" : source === "chat_completions" ? "reasoning_opaque" : "thoughtSignature"
  const items = source === "responses" ? objects(body.output) : source === "messages" ? objects(body.content)
    : source === "chat_completions" ? [object(firstObject(body.choices).message)] : objects(object(firstObject(body.candidates).content).parts)
  const item = naturalItem(items, opaqueField)
  expect(item[opaqueField]).toStartWith("vnext-affinity:1:")
  expect(source === "responses" ? firstObject(item.summary).text : source === "messages" ? item.thinking : source === "chat_completions" ? item.reasoning_text : item.text).toBe(thought)
  const replayInput = source === "responses" ? { input: items }
    : source === "gemini" ? { contents: [{ role: "model", parts: items }, { role: "user", parts: [{ text: "continue" }] }] }
    : { messages: [source === "messages" ? { role: "assistant", content: items } : item, { role: "user", content: "continue" }], max_tokens: 100 }
  const replay = await f.call(source, replayInput)
  expect(replay.status).toBe(200)
  await replay.text()
  expect(JSON.stringify(f.sent[1])).toContain(opaque)
  expect(JSON.stringify(f.sent[1])).toContain(JSON.stringify(thought).slice(1, -1))
  expect(JSON.stringify(f.sent[1])).not.toContain("vnext-affinity:")
  await Promise.all(f.pending)
})

for (const source of ["responses", "messages", "chat_completions", "gemini"] as const) test(`actual ${source} ordinary SSE to JSON origin survives history replay and rejects another key`, async () => {
  const f = await fixture("messages", false, () => wire([
    { type: "message_start", message: { id: "m", type: "message", model: "model", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "plain answer" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]))
  const response = await f.call(source, plainInput(source))
  expect(response.status).toBe(200)
  const body = object(await response.json())
  expect(JSON.stringify(body)).toContain("plain answer")
  expect(JSON.stringify(body)).toContain("vnext-affinity:2:")
  expect(JSON.stringify(body)).not.toContain("vnext-affinity:1:")
  const replayInput = source === "responses" ? { input: [...objects(body.output), { role: "user", content: "continue" }] }
    : source === "gemini" ? { contents: [object(firstObject(body.candidates).content), { role: "user", parts: [{ text: "continue" }] }] }
    : { messages: [source === "messages" ? { role: "assistant", content: body.content } : object(firstObject(body.choices).message), { role: "user", content: "continue" }], max_tokens: 100 }
  const replay = await f.call(source, replayInput)
  expect(replay.status).toBe(200)
  await replay.text()
  expect(f.sent).toHaveLength(2)
  expect(JSON.stringify(f.sent[1])).toContain("plain answer")
  expect(JSON.stringify(f.sent[1])).toContain("continue")
  expect(JSON.stringify(f.sent[1])).not.toContain("vnext-affinity:")
  const wrongKey = await f.call(source, replayInput, "other")
  expect(wrongKey.status).toBe(400)
  await wrongKey.text()
  expect(f.sent).toHaveLength(2)
  await Promise.all(f.pending)
  expect(object(f.db.query("SELECT affinity_secret FROM api_keys WHERE id = 'key'").get()).affinity_secret).toBeString()
})

test("Gemini suppressed native thought does not initialize a secret before SSE to JSON translation", async () => {
  const f = await fixture("messages", false, () => upstreamResponse("messages", true))
  const response = await f.call("gemini", plainInput("gemini"))
  expect(response.status).toBe(200)
  const body = object(await response.json())
  expect(object(firstObject(body.candidates).content).parts).toEqual([])
  await Promise.all(f.pending)
  expect(f.db.query("SELECT affinity_secret FROM api_keys WHERE id = 'key'").get()).toEqual({ affinity_secret: null })
})
