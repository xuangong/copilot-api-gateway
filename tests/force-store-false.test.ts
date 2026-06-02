import { describe, expect, test } from "bun:test"

import { forceStoreFalse } from "~/transforms/force-store-false"

describe("forceStoreFalse", () => {
  test("sets store:false when caller requested store:true", () => {
    const payload: Record<string, unknown> = { model: "x", input: "hi", store: true }
    forceStoreFalse(payload)
    expect(payload.store).toBe(false)
  })

  test("sets store:false when caller omitted store", () => {
    const payload: Record<string, unknown> = { model: "x", input: "hi" }
    forceStoreFalse(payload)
    expect(payload.store).toBe(false)
  })

  test("leaves explicit store:false untouched", () => {
    const payload: Record<string, unknown> = { model: "x", input: "hi", store: false }
    forceStoreFalse(payload)
    expect(payload.store).toBe(false)
  })
})
