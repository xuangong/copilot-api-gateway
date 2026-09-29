import { expect, test } from "bun:test"
import type { ProtocolFrame } from "@vibe-core/result"
import { parseResponsesStream, type ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { createCodexResponsesLiteAdapter, encodeCodexResponsesLiteRequest, restoreCodexResponsesFrames } from "../responses-lite.ts"

const prepared = (type: "custom" | "function") => encodeCodexResponsesLiteRequest({
  input: [], tools: [{ type, name: "工具" }], instructions: "说明🌍",
}, "会话🧵")
const added: ProtocolFrame<ResponsesStreamEvent> = { type: "event", event: {
  type: "response.output_item.added", output_index: 0,
  item: { type: "function_call", id: "same", call_id: "call", name: "工具", namespace: "functions", arguments: "", status: "in_progress" },
} }
const delta: ProtocolFrame<ResponsesStreamEvent> = { type: "event", event: {
  type: "response.function_call_arguments.delta", output_index: 0, item_id: "same", delta: "你好🌍",
} }

test("per-call adapters isolate identical item IDs and preserve result echoes", () => {
  const custom = createCodexResponsesLiteAdapter(prepared("custom"))
  const func = createCodexResponsesLiteAdapter(prepared("function"))
  custom.frame(added)
  func.frame(added)
  expect(custom.frame(delta)).toMatchObject({ event: { type: "response.custom_tool_call_input.delta", delta: "你好🌍" } })
  expect(func.frame(delta)).toEqual(delta)
  expect(createCodexResponsesLiteAdapter(prepared("custom")).frame(delta)).toEqual(delta)
  const result = custom.result({ id: "r", object: "response", model: "model", status: "completed", output: [], error: null, incomplete_details: null })
  expect(result.tools).toEqual([{ type: "custom", name: "工具" }])
  expect(result.instructions).toBe("说明🌍")
  const done = { type: "done" } as const
  expect(custom.frame(done)).toBe(done)
  const error = { type: "event", event: { type: "error", message: "synthetic" } } as const
  expect(custom.frame(error)).toEqual(error)
})

test.each([
  ["thread", "Base", "at_e1a2e208-dac9-58c5-89fc-ee1b6e558ff6", "msg_6b4ab861-2b3e-5c89-b2b6-338d05f6f6ad"],
  ["会话🧵", "规则：你好🌍", "at_004c4bbc-b31f-59a9-9c92-18358cfa6ba2", "msg_d24397fe-e2f9-528a-9f3e-20c9db1c8b4a"],
  ["other", "规则：你好🌍", "at_9af032af-28e4-55af-82ad-d44a600dc8c8", "msg_06d7b187-8fd9-5def-8149-c193b136303b"],
])("OID UUIDv5 vectors match independent Python uuid derivation: %s", (thread, instructions, toolsId, messageId) => {
  const body = encodeCodexResponsesLiteRequest({ input: [], instructions }, thread).body
  expect(body.input[0]).toHaveProperty("id", toolsId)
  expect(body.input[1]).toHaveProperty("id", messageId)
})

const wireStream = (wire: string) => {
  const bytes = new TextEncoder().encode(wire)
  // One-byte chunks exercise UTF-8 boundaries inside multibyte codepoints.
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
}

test("UTF-8 SSE frames restore through the adapter without changing opaque data", async () => {
  const adapter = createCodexResponsesLiteAdapter(prepared("custom"))
  const events = [added, delta].flatMap(frame => frame.type === "event" ? [`data: ${JSON.stringify(frame.event)}\n\n`] : [])
  const output = []
  for await (const frame of parseResponsesStream(wireStream(events.join("") + "data: [DONE]\n\n"))) output.push(adapter.frame(frame))
  expect(output[1]).toMatchObject({ event: { type: "response.custom_tool_call_input.delta", delta: "你好🌍" } })
  expect(output[2]).toEqual({ type: "done" })
})

test("malformed JSON and null payloads retain parser failure boundaries", async () => {
  for (const malformed of ["{bad", "null"]) {
    const call = prepared("custom")
    const frames = restoreCodexResponsesFrames(parseResponsesStream(wireStream(`event: response\ndata: ${malformed}\n\n`)), call.callableIdentities)
    await expect(Array.fromAsync(frames)).rejects.toThrow()
  }
})

test("frame iterator propagates exceptions and closes upstream on cancellation without inventing done", async () => {
  let closed = false
  const failure = new Error("synthetic upstream failure")
  const source = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    try { yield added; throw failure } finally { closed = true }
  }
  const call = prepared("custom")
  const cancelled = restoreCodexResponsesFrames(source(), call.callableIdentities)
  await cancelled.next()
  await cancelled.return(undefined)
  expect(closed).toBe(true)
  closed = false
  const failed = restoreCodexResponsesFrames(source(), call.callableIdentities)
  await failed.next()
  await expect(failed.next()).rejects.toBe(failure)
  expect(closed).toBe(true)
  const eof = restoreCodexResponsesFrames((async function* () { yield added })(), call.callableIdentities)
  expect(await Array.fromAsync(eof)).toHaveLength(1)
})

// The existing parser projects scalar JSON with an SSE event name to an opaque
// extension event. The adapter must preserve that boundary rather than invent
// validation or silently discard an event the parser accepted.
test("accepted malformed scalar and future events remain opaque", async () => {
  const call = prepared("custom")
  const wire = "event: response\ndata: 42\n\n"
  const source = await Array.fromAsync(parseResponsesStream(wireStream(wire)))
  const adapted = await Array.fromAsync(restoreCodexResponsesFrames(parseResponsesStream(wireStream(wire)), call.callableIdentities))
  expect(adapted).toEqual(source)
})
