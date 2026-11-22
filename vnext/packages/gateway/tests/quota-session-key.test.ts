// packages/gateway/tests/quota-session-key.test.ts
import { expect, test } from "bun:test"
import { deriveSessionInput, newBalanceSession, resolveSessionKey } from "../src/quota-balance/session-key"

const key = async (protocol: Parameters<typeof deriveSessionInput>[0], payload: unknown, headers: Record<string, string> = {}, apiKeyId = "key_test_1") =>
  resolveSessionKey(newBalanceSession(deriveSessionInput(protocol, payload, new Headers(headers), apiKeyId)))

test("chat completions: prompt_cache_key wins, and is read from the payload before any interceptor strips it", async () => {
  const body = { model: "m", prompt_cache_key: "conv-1", messages: [{ role: "user", content: "hello" }] }
  const a = await key("chat_completions", body)
  expect(a).toMatch(/^[0-9a-f]{32}$/)
  expect(await key("chat_completions", { ...body, messages: [{ role: "user", content: "something else" }] })).toBe(a)
  expect(await key("chat_completions", { ...body, prompt_cache_key: "conv-2" })).not.toBe(a)
  expect(await key("chat_completions", body, {}, "key_test_2")).not.toBe(a)
})

test("the fallback fingerprint is the system prompt plus the first user message and is stable while the conversation grows", async () => {
  const first = { model: "m", messages: [{ role: "system", content: "You are terse." }, { role: "user", content: "What is 2+2?" }] }
  const grown = { model: "m", messages: [...first.messages, { role: "assistant", content: "4" }, { role: "user", content: "And 3+3?" }] }
  const k = await key("chat_completions", first)
  expect(await key("chat_completions", grown)).toBe(k)
  expect(await key("chat_completions", { model: "m", messages: [{ role: "system", content: "You are verbose." }, first.messages[1]] })).not.toBe(k)
  expect(await key("chat_completions", { model: "m", messages: [first.messages[0], { role: "user", content: [{ type: "text", text: "Different question" }] }] })).not.toBe(k)
})

test("a bare single message without a system prompt still gets a key; a request without any text has none", async () => {
  expect(await key("chat_completions", { messages: [{ role: "user", content: "just this" }] })).toMatch(/^[0-9a-f]{32}$/)
  expect(await key("chat_completions", { messages: [] })).toBeNull()
  expect(await key("chat_completions", null)).toBeNull()
})

test("responses: prompt_cache_key, Codex session headers, then instructions plus the first user input", async () => {
  const body = { model: "m", instructions: "be brief", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi there" }] }] }
  const byInput = await key("responses", body)
  expect(await key("responses", { ...body, input: [...body.input, { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "more" }] }] })).toBe(byInput)
  const byHeader = await key("responses", body, { session_id: "codex-session-1" })
  expect(byHeader).not.toBe(byInput)
  expect(await key("responses", { ...body, instructions: "other" }, { session_id: "codex-session-1" })).toBe(byHeader)
  expect(await key("responses", body, { "conversation-id": "codex-session-1" })).toBe(byHeader)
  expect(await key("responses", { ...body, prompt_cache_key: "pck" }, { session_id: "codex-session-1" })).not.toBe(byHeader)
  expect(await key("responses", { model: "m", input: "plain string input" })).toMatch(/^[0-9a-f]{32}$/)
})

test("messages: Claude Code session header, then the session part of metadata.user_id in both formats, then the fingerprint", async () => {
  const body = { model: "m", system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=aaaa;" }, { type: "text", text: "You are Claude Code." }], messages: [{ role: "user", content: [{ type: "text", text: "start" }] }] }
  const byHeader = await key("messages", body, { "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555" })
  const legacy = await key("messages", { ...body, metadata: { user_id: "user_abc_account_def_session_11111111-2222-3333-4444-555555555555" } })
  const json = await key("messages", { ...body, metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "11111111-2222-3333-4444-555555555555" }) } })
  expect(legacy).toBe(byHeader)
  expect(json).toBe(byHeader)
  // The billing attribution block changes on every request and must not leak into the fingerprint.
  const a = await key("messages", body)
  const b = await key("messages", { ...body, system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=bbbb;" }, body.system[1]] })
  expect(b).toBe(a)
  expect(a).not.toBe(byHeader)
})

test("gemini: system instruction plus the first user content", async () => {
  const body = { systemInstruction: { parts: [{ text: "be nice" }] }, contents: [{ role: "user", parts: [{ text: "hello" }] }] }
  const k = await key("gemini", body)
  expect(k).toMatch(/^[0-9a-f]{32}$/)
  expect(await key("gemini", { ...body, contents: [...body.contents, { role: "model", parts: [{ text: "hi" }] }, { role: "user", parts: [{ text: "again" }] }] })).toBe(k)
})

test("the hash runs once per session object", async () => {
  const session = newBalanceSession(deriveSessionInput("chat_completions", { messages: [{ role: "user", content: "x" }] }, undefined, "key_test_1"))
  const first = resolveSessionKey(session)
  expect(resolveSessionKey(session)).toBe(first)
})

test("conversation_id is accepted as a header alias", async () => {
  const body = { model: "m", input: "x" }
  expect(await key("responses", body, { conversation_id: "codex-session-1" })).toBe(await key("responses", body, { session_id: "codex-session-1" }))
})

test("a first user message without text parts (image, tool_result with nested text) still yields a stable key", async () => {
  const image = { model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] }
  const a = await key("chat_completions", image)
  expect(a).toMatch(/^[0-9a-f]{32}$/)
  expect(await key("chat_completions", image)).toBe(a)
  expect(await key("chat_completions", { model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }] }] })).not.toBe(a)
  const tool = (text: string) => ({ model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text }] }] }] })
  const t = await key("messages", tool("result one"))
  expect(t).toMatch(/^[0-9a-f]{32}$/)
  expect(await key("messages", tool("result two"))).not.toBe(t)
})

test("a large non-text part is represented by its type and a short prefix only", async () => {
  const big = (tail: string) => ({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,AAAA${"x".repeat(5_000_000)}${tail}` } }] }] })
  const started = performance.now()
  const a = await key("chat_completions", big("1"))
  expect(performance.now() - started).toBeLessThan(200)
  expect(a).toBe(await key("chat_completions", big("2"))) // only the prefix counts
})
