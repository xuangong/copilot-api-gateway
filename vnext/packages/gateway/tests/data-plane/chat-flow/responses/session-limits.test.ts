import { expect, test } from "bun:test"
import { parseResponsesSessionMessage } from "../../../../src/data-plane/chat-flow/responses/session-protocol.ts"
import { ResponsesLocalContinuation } from "../../../../src/data-plane/chat-flow/responses/local-continuation.ts"
import { RESPONSES_WS_MAX_INBOUND_BYTES, RESPONSES_WS_MAX_LOCAL_STATE_BYTES, RESPONSES_WS_LOCAL_STATE_TTL_MS, utf8Bytes } from "../../../../src/data-plane/chat-flow/responses/session-limits.ts"

for (const delta of [-1, 0, 1]) {
  test(`UTF-8 inbound limit ${delta >= 0 ? "+" : ""}${delta} measures bytes rather than characters`, () => {
    const base = JSON.stringify({ type: "response.create", model: "m", input: "你好🌍", extension: "" })
    const text = base.replace('"extension":""', `"extension":"${"x".repeat(RESPONSES_WS_MAX_INBOUND_BYTES + delta - utf8Bytes(base))}"`)
    expect(utf8Bytes(text)).toBe(RESPONSES_WS_MAX_INBOUND_BYTES + delta)
    if (delta > 0) expect(() => parseResponsesSessionMessage(text)).toThrow("byte limit")
    else expect(parseResponsesSessionMessage(text).raw.input).toBe("你好🌍")
  })
  test(`full local state limit ${delta >= 0 ? "+" : ""}${delta} includes config and items`, () => {
    const local = new ResponsesLocalContinuation()
    const base = local.candidate("r", { model: "m", input: [{ type: "message", role: "user", content: "你好" }], instructions: "" }, [])
    if (!base) throw new Error("missing fixture")
    const create = { model: "m", input: [{ type: "message", role: "user", content: "你好" }], instructions: "x".repeat(RESPONSES_WS_MAX_LOCAL_STATE_BYTES + delta - utf8Bytes(base)) }
    const candidate = local.candidate("r", create, [])
    if (delta > 0) expect(candidate).toBeUndefined()
    else { expect(candidate).toBeDefined(); expect(utf8Bytes(candidate ?? "")).toBe(RESPONSES_WS_MAX_LOCAL_STATE_BYTES + delta) }
  })
}

test("local latest slot expires logically at TTL, isolates copies and retains full source configuration", () => {
  let now = 100
  const local = new ResponsesLocalContinuation(() => now)
  const create = { model: "source", input: [{ type: "message", content: "original" }], instructions: "do work", tools: [{ type: "function", name: "f" }], stream: true, previous_response_id: "old" }
  local.publish("first", local.candidate("first", create, [{ type: "message", content: "reply" }]))
  const a = local.resolve("first")
  expect(a?.create).toEqual({ model: "source", instructions: "do work", tools: [{ type: "function", name: "f" }] })
  a?.items.push({ polluted: true })
  expect(local.resolve("first")?.items).toHaveLength(2)
  now += RESPONSES_WS_LOCAL_STATE_TTL_MS - 1
  expect(local.resolve("first")).toBeDefined()
  now++
  expect(local.resolve("first")).toBeUndefined()
  local.publish("second", local.candidate("second", create, []))
  expect(local.resolve("first")).toBeUndefined()
  expect(local.resolve("second")?.items).toHaveLength(1)
  local.clear()
  expect(local.resolve("second")).toBeUndefined()
})

test("local compaction uses the same replacement window as durable snapshots", () => {
  const local = new ResponsesLocalContinuation()
  const output = [{ type: "compaction", encrypted_content: "opaque" }, { type: "message", content: "retained" }]
  local.publish("r", local.candidate("r", { model: "m", input: [{ type: "compaction_trigger" }] }, output, true))
  expect(local.resolve("r")?.items).toEqual(output)
})
