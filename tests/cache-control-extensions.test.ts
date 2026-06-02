import { describe, expect, test } from "bun:test"

import { applyTopLevelCacheControl, stripCacheControl } from "~/transforms"

describe("applyTopLevelCacheControl", () => {
  test("no-op when payload has no top-level cache_control", () => {
    const payload: Record<string, unknown> = {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }
    expect(applyTopLevelCacheControl(payload)).toBe(false)
    expect(payload.cache_control).toBeUndefined()
    const m = payload.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(m[0]!.content[0]!.cache_control).toBeUndefined()
  })

  test("ports onto the last cacheable block of the last message", () => {
    const payload: Record<string, unknown> = {
      cache_control: { type: "ephemeral" },
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: [{ type: "text", text: "b" }, { type: "tool_use", id: "t", name: "x", input: {} }] },
      ],
    }
    expect(applyTopLevelCacheControl(payload)).toBe(true)
    expect(payload.cache_control).toBeUndefined()
    const m = payload.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(m[0]!.content[0]!.cache_control).toBeUndefined()
    expect(m[1]!.content[0]!.cache_control).toBeUndefined()
    expect(m[1]!.content[1]!.cache_control).toEqual({ type: "ephemeral" })
  })

  test("explicit block-level cache_control wins over auto-apply", () => {
    const existing = { type: "ephemeral", scope: "session" }
    const payload: Record<string, unknown> = {
      cache_control: { type: "ephemeral" },
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: existing }] },
      ],
    }
    applyTopLevelCacheControl(payload)
    const m = payload.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(m[0]!.content[0]!.cache_control).toBe(existing)
  })

  test("lifts string message content into a text block when porting", () => {
    const payload: Record<string, unknown> = {
      cache_control: { type: "ephemeral", ttl: "1h" },
      messages: [{ role: "user", content: "hello" }],
    }
    applyTopLevelCacheControl(payload)
    const m = payload.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(m[0]!.content).toEqual([
      { type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } },
    ])
  })
})

describe("stripCacheControl", () => {
  test("removes scope and ttl from system/tools/messages, keeps ephemeral", () => {
    const payload: Record<string, unknown> = {
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", scope: "session" } }],
      tools: [{ name: "t", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral", scope: "session", ttl: "1h" } },
            { type: "tool_result", tool_use_id: "x", cache_control: { type: "ephemeral", ttl: "5m" } },
          ],
        },
      ],
    }
    const r = stripCacheControl(payload)
    expect(r.stripped).toBe(true)
    expect(r.count).toBe(4)
    const sys = payload.system as Array<Record<string, unknown>>
    expect(sys[0]!.cache_control).toEqual({ type: "ephemeral" })
    const tools = payload.tools as Array<Record<string, unknown>>
    expect(tools[0]!.cache_control).toEqual({ type: "ephemeral" })
    const m = payload.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(m[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" })
    expect(m[0]!.content[1]!.cache_control).toEqual({ type: "ephemeral" })
  })

  test("drops cache_control entirely when nothing recognizable survives", () => {
    const payload: Record<string, unknown> = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { scope: "session", ttl: "1h" } }] },
      ],
    }
    stripCacheControl(payload)
    const m = payload.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect("cache_control" in m[0]!.content[0]!).toBe(false)
  })

  test("leaves clean cache_control untouched (no-op)", () => {
    const payload: Record<string, unknown> = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
      ],
    }
    const r = stripCacheControl(payload)
    expect(r.stripped).toBe(false)
    const m = payload.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(m[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" })
  })
})
