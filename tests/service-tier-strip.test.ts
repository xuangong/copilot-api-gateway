import { describe, expect, test } from "bun:test"

import { stripServiceTier } from "../src/transforms/service-tier-strip"

describe("stripServiceTier", () => {
  test("removes service_tier when present", () => {
    const payload: Record<string, unknown> = { model: "gpt-5", service_tier: "auto" }
    const result = stripServiceTier(payload)
    expect(result.stripped).toBe(true)
    expect("service_tier" in payload).toBe(false)
  })

  test("no-op when absent", () => {
    const payload: Record<string, unknown> = { model: "gpt-5" }
    const result = stripServiceTier(payload)
    expect(result.stripped).toBe(false)
    expect(payload).toEqual({ model: "gpt-5" })
  })
})
