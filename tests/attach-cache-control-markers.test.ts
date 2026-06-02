import { describe, expect, test } from "bun:test"

import { attachCacheControlMarkers } from "~/transforms/attach-cache-control-markers"

type Msg = { role?: string; content?: unknown; copilot_cache_control?: { type: "ephemeral" } }

const marker = { type: "ephemeral" } as const

describe("attachCacheControlMarkers", () => {
  test("marks first 2 systems + last 2 non-systems", () => {
    const messages: Msg[] = [
      { role: "system", content: "s0" },
      { role: "system", content: "s1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u4" },
      { role: "tool", content: "t5" },
    ]
    expect(attachCacheControlMarkers({ messages })).toBe(4)
    expect(messages[0].copilot_cache_control).toEqual(marker)
    expect(messages[1].copilot_cache_control).toEqual(marker)
    expect(messages[2].copilot_cache_control).toBeUndefined()
    expect(messages[3].copilot_cache_control).toBeUndefined()
    expect(messages[4].copilot_cache_control).toEqual(marker)
    expect(messages[5].copilot_cache_control).toEqual(marker)
  })

  test("single system → marks only [0]", () => {
    const messages: Msg[] = [{ role: "system", content: "s" }]
    expect(attachCacheControlMarkers({ messages })).toBe(1)
    expect(messages[0].copilot_cache_control).toEqual(marker)
  })

  test("no systems, 4 mixed → marks last two non-systems", () => {
    const messages: Msg[] = [
      { role: "user", content: "u0" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "tool", content: "t3" },
    ]
    expect(attachCacheControlMarkers({ messages })).toBe(2)
    expect(messages[0].copilot_cache_control).toBeUndefined()
    expect(messages[1].copilot_cache_control).toBeUndefined()
    expect(messages[2].copilot_cache_control).toEqual(marker)
    expect(messages[3].copilot_cache_control).toEqual(marker)
  })

  test("empty content (string or array) skipped", () => {
    const messages: Msg[] = [
      { role: "system", content: "" },
      { role: "system", content: [] },
      { role: "user", content: "u" },
    ]
    expect(attachCacheControlMarkers({ messages })).toBe(1)
    expect(messages[0].copilot_cache_control).toBeUndefined()
    expect(messages[1].copilot_cache_control).toBeUndefined()
    expect(messages[2].copilot_cache_control).toEqual(marker)
  })

  test("5+ systems → only first two marked", () => {
    const messages: Msg[] = [
      { role: "system", content: "s0" },
      { role: "system", content: "s1" },
      { role: "system", content: "s2" },
      { role: "system", content: "s3" },
      { role: "system", content: "s4" },
    ]
    expect(attachCacheControlMarkers({ messages })).toBe(2)
    expect(messages[0].copilot_cache_control).toEqual(marker)
    expect(messages[1].copilot_cache_control).toEqual(marker)
    expect(messages[2].copilot_cache_control).toBeUndefined()
    expect(messages[3].copilot_cache_control).toBeUndefined()
    expect(messages[4].copilot_cache_control).toBeUndefined()
  })

  test("each marker is a fresh object (no shared reference)", () => {
    const messages: Msg[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]
    attachCacheControlMarkers({ messages })
    expect(messages[0].copilot_cache_control).not.toBe(messages[1].copilot_cache_control as object)
  })

  test("no messages field → 0", () => {
    expect(attachCacheControlMarkers({})).toBe(0)
  })
})
