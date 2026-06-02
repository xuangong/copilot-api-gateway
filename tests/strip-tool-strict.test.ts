import { describe, expect, test } from "bun:test"

import { stripToolStrict } from "~/transforms/strip-tool-strict"
import type { AnthropicMessagesPayload } from "~/transforms"

const base = (tools: unknown[]): AnthropicMessagesPayload =>
  ({
    model: "claude-sonnet-4-6",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tools,
  }) as unknown as AnthropicMessagesPayload

describe("stripToolStrict", () => {
  test("removes strict from tools that have it, leaves the rest intact", () => {
    const payload = base([
      { name: "a", input_schema: { type: "object" }, strict: true },
      { name: "b", description: "keep me", input_schema: { type: "object", properties: {} } },
    ])
    expect(stripToolStrict(payload)).toBe(true)
    expect(payload.tools).toEqual([
      { name: "a", input_schema: { type: "object" } },
      { name: "b", description: "keep me", input_schema: { type: "object", properties: {} } },
    ] as never)
  })

  test("returns false and is a no-op when no tool carries strict", () => {
    const payload = base([
      { name: "a", input_schema: { type: "object" } },
    ])
    expect(stripToolStrict(payload)).toBe(false)
    expect(payload.tools).toEqual([
      { name: "a", input_schema: { type: "object" } },
    ] as never)
  })

  test("returns false when payload has no tools field", () => {
    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    } as unknown as AnthropicMessagesPayload
    expect(stripToolStrict(payload)).toBe(false)
  })

  test("strips strict:false as well — Vertex rejects the key regardless of value", () => {
    const payload = base([{ name: "a", input_schema: { type: "object" }, strict: false }])
    expect(stripToolStrict(payload)).toBe(true)
    expect(payload.tools).toEqual([{ name: "a", input_schema: { type: "object" } }] as never)
  })
})
