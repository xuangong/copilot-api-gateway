import { expect, test } from "bun:test"
import { estimateMessagesInputTokens } from "../token-estimate"

const user = (content: unknown) => ({ model: "claude-opus-5.5", max_tokens: 1, messages: [{ role: "user", content }] })
const base64 = (bytes: number[]) => Buffer.from(Uint8Array.from([...bytes, ...new Array(64).fill(0)])).toString("base64")
const png = (width: number, height: number) => base64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
  0x49, 0x48, 0x44, 0x52, width >>> 24, (width >>> 16) & 255, (width >>> 8) & 255, width & 255,
  height >>> 24, (height >>> 16) & 255, (height >>> 8) & 255, height & 255])
const jpeg = (width: number, height: number) => base64([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0),
  0xff, 0xc0, 0, 17, 8, height >>> 8, height & 255, width >>> 8, width & 255])
const image = (data: string, media_type = "image/png") => ({ type: "image", source: { type: "base64", media_type, data } })

test("ASCII text costs about one token per 2.6 characters", () => {
  expect(estimateMessagesInputTokens(user("a".repeat(26_000)))).toBe(10_000)
})

test("non-ASCII text costs about 1.3 tokens per character", () => {
  expect(estimateMessagesInputTokens(user("上下文".repeat(1_000)))).toBe(3_900)
})

test("system prompt, tool definitions, tool calls and tool results all count", () => {
  const text = "x".repeat(2_600)
  const total = estimateMessagesInputTokens({
    system: [{ type: "text", text }],
    tools: [{ name: "Read", description: text, input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: { path: text } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text }] }] },
    ],
  })
  expect(total).toBeGreaterThan(5_000)
  expect(total).toBeLessThan(5_100)
})

test("retained thinking is estimated from its signature, not its summary", () => {
  const thinking = { type: "thinking", thinking: "short summary", signature: "s".repeat(60_000) }
  expect(estimateMessagesInputTokens({ messages: [{ role: "assistant", content: [thinking] }] })).toBe(10_000)
  const redacted = { type: "redacted_thinking", data: "d".repeat(6_000) }
  expect(estimateMessagesInputTokens({ messages: [{ role: "assistant", content: [redacted] }] })).toBe(1_000)
})

test("images cost their visual tokens, never their base64 length", () => {
  expect(estimateMessagesInputTokens(user([image(png(1920, 1080))]))).toBe(2_765)
  expect(estimateMessagesInputTokens(user([image(jpeg(1280, 720), "image/jpeg")]))).toBe(1_229)
  // Long edge is capped at 2576px and the total at the 4784-token maximum.
  expect(estimateMessagesInputTokens(user([image(png(6000, 4000))]))).toBe(4_784)
  // Unknown dimensions fall back to the pre-high-resolution per-image cap.
  const opaque = image("A".repeat(2_000_000))
  expect(estimateMessagesInputTokens(user([opaque]))).toBe(1_600)
  expect(estimateMessagesInputTokens(user([{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }]))).toBe(1_600)
})

test("images nested in tool results are counted as images", () => {
  const result = { type: "tool_result", tool_use_id: "t", content: [image(png(1920, 1080)), { type: "text", text: "a".repeat(260) }] }
  expect(estimateMessagesInputTokens(user([result]))).toBe(2_865)
})

test("malformed payloads estimate to zero instead of throwing", () => {
  expect(estimateMessagesInputTokens({})).toBe(0)
  expect(estimateMessagesInputTokens({ messages: "nope", system: 3, tools: {} })).toBe(0)
  expect(estimateMessagesInputTokens(user([null, 4, { type: "image" }]))).toBe(1_600)
})
