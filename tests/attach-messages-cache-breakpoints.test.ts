import { describe, expect, test } from "bun:test"

import { attachMessagesCacheBreakpoints } from "~/transforms/attach-messages-cache-breakpoints"
import type { AnthropicMessagesPayload } from "~/transforms"

const ephemeral = { type: "ephemeral" } as const

function basePayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-opus-4-7",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "second" },
    ],
    ...overrides,
  }
}

describe("attachMessagesCacheBreakpoints", () => {
  test("string system promoted to one block and marked", () => {
    const p = basePayload({ system: "you are helpful" })
    const r = attachMessagesCacheBreakpoints(p)
    expect(r.injected).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(p.system)).toBe(true)
    const sys = p.system as Array<{ type: string; text: string; cache_control?: unknown }>
    expect(sys[sys.length - 1]!.cache_control).toEqual(ephemeral)
  })

  test("marks last block of multi-block system", () => {
    const p = basePayload({
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    })
    attachMessagesCacheBreakpoints(p)
    const sys = p.system as Array<{ type: string; text: string; cache_control?: unknown }>
    expect(sys[0]!.cache_control).toBeUndefined()
    expect(sys[1]!.cache_control).toEqual(ephemeral)
  })

  test("marks last tool when tools.length >= 3", () => {
    const p = basePayload({
      tools: [
        { name: "t1", description: "", input_schema: { type: "object" } },
        { name: "t2", description: "", input_schema: { type: "object" } },
        { name: "t3", description: "", input_schema: { type: "object" } },
      ] as unknown as AnthropicMessagesPayload["tools"],
    })
    attachMessagesCacheBreakpoints(p)
    const tools = p.tools as unknown as Array<{ name: string; cache_control?: unknown }>
    expect(tools[0]!.cache_control).toBeUndefined()
    expect(tools[1]!.cache_control).toBeUndefined()
    expect(tools[2]!.cache_control).toEqual(ephemeral)
  })

  test("skips tool marker when tools.length < 3", () => {
    const p = basePayload({
      tools: [
        { name: "t1", description: "", input_schema: { type: "object" } },
        { name: "t2", description: "", input_schema: { type: "object" } },
      ] as unknown as AnthropicMessagesPayload["tools"],
    })
    attachMessagesCacheBreakpoints(p)
    const tools = p.tools as unknown as Array<{ name: string; cache_control?: unknown }>
    for (const t of tools) expect(t.cache_control).toBeUndefined()
  })

  test("marks last text block of second-to-last user message", () => {
    const p = basePayload({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "second" },
        { role: "assistant", content: "ack2" },
        { role: "user", content: "third" },
      ],
    })
    attachMessagesCacheBreakpoints(p)
    const target = p.messages[2]!
    const blocks = target.content as Array<{ type: string; text?: string; cache_control?: unknown }>
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[blocks.length - 1]!.cache_control).toEqual(ephemeral)
    // last user message untouched
    expect(typeof p.messages[4]!.content === "string").toBe(true)
  })

  test("no second-to-last user → skips user breakpoint but still marks system", () => {
    const p = basePayload({
      system: "sys",
      messages: [{ role: "user", content: "only" }],
    })
    const r = attachMessagesCacheBreakpoints(p)
    expect(r.injected).toBe(1)
  })

  test("never overwrites caller-provided cache_control anywhere", () => {
    const p = basePayload({
      system: [
        { type: "text", text: "a", cache_control: ephemeral } as { type: "text"; text: string },
      ],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "second" },
      ],
    })
    const r = attachMessagesCacheBreakpoints(p)
    expect(r.injected).toBe(0)
    expect(r.skippedExisting).toBe(true)
  })

  test("respects 4-breakpoint Anthropic ceiling", () => {
    const p = basePayload({
      system: "s",
      tools: [
        { name: "t1", description: "", input_schema: { type: "object" } },
        { name: "t2", description: "", input_schema: { type: "object" } },
        { name: "t3", description: "", input_schema: { type: "object" } },
      ] as unknown as AnthropicMessagesPayload["tools"],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "second" },
      ],
    })
    const r = attachMessagesCacheBreakpoints(p)
    expect(r.injected).toBeLessThanOrEqual(4)
    expect(r.injected).toBe(3)
  })

  test("empty messages array returns zero", () => {
    const p = basePayload({ messages: [] })
    const r = attachMessagesCacheBreakpoints(p)
    expect(r.injected).toBe(0)
    expect(r.skippedExisting).toBe(false)
  })
})
