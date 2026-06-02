import { describe, test, expect } from "bun:test"

import {
  applyLastMessageCacheBreakpoint,
  applyLastToolCacheBreakpoint,
  systemWithCacheBreakpoint,
} from "~/translators/shared/cache-breakpoints"
import type { AnthropicMessage, AnthropicTool } from "~/transforms/types"

const EPH = { type: "ephemeral" }

describe("systemWithCacheBreakpoint", () => {
  test("undefined when no text", () => {
    expect(systemWithCacheBreakpoint(undefined)).toBeUndefined()
    expect(systemWithCacheBreakpoint("")).toBeUndefined()
  })
  test("wraps non-empty text in cached text block", () => {
    expect(systemWithCacheBreakpoint("hello")).toEqual([
      { type: "text", text: "hello", cache_control: EPH },
    ])
  })
})

describe("applyLastToolCacheBreakpoint", () => {
  test("noop on empty/undefined", () => {
    applyLastToolCacheBreakpoint(undefined)
    const empty: AnthropicTool[] = []
    applyLastToolCacheBreakpoint(empty)
    expect(empty).toEqual([])
  })
  test("marks last custom tool", () => {
    const tools: AnthropicTool[] = [
      { name: "a", input_schema: { type: "object" } },
      { name: "b", input_schema: { type: "object" } },
    ]
    applyLastToolCacheBreakpoint(tools)
    expect((tools[0] as { cache_control?: unknown }).cache_control).toBeUndefined()
    expect((tools[1] as { cache_control?: unknown }).cache_control).toEqual(EPH)
  })
  test("skips native server-side tools at tail", () => {
    const tools: AnthropicTool[] = [
      { name: "search", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search" } as unknown as AnthropicTool,
    ]
    applyLastToolCacheBreakpoint(tools)
    expect((tools[0] as { cache_control?: unknown }).cache_control).toEqual(EPH)
    expect((tools[1] as { cache_control?: unknown }).cache_control).toBeUndefined()
  })
})

describe("applyLastMessageCacheBreakpoint", () => {
  test("promotes string content to text block with cache_control", () => {
    const messages: AnthropicMessage[] = [{ role: "user", content: "hi" }]
    applyLastMessageCacheBreakpoint(messages)
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "hi", cache_control: EPH },
    ])
  })
  test("marks last cacheable block in last message", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]
    applyLastMessageCacheBreakpoint(messages)
    const blocks = messages[0]?.content as Array<{ cache_control?: unknown }>
    expect(blocks[0]?.cache_control).toBeUndefined()
    expect(blocks[1]?.cache_control).toEqual(EPH)
  })
  test("only the newest message receives a breakpoint", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ]
    applyLastMessageCacheBreakpoint(messages)
    expect(messages[0]?.content).toBe("first")
    const last = messages[1]?.content as Array<{ cache_control?: unknown }>
    expect(last[0]?.cache_control).toEqual(EPH)
  })
})
