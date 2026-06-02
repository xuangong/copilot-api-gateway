import { test, expect, describe } from "bun:test"

import { stripSafetyIdentifier } from "~/transforms/strip-safety-identifier"
import type { ResponsesPayload } from "~/transforms/types"

describe("stripSafetyIdentifier", () => {
  test("returns false when field absent", () => {
    const payload = { model: "gpt-5", input: [] } as unknown as ResponsesPayload
    expect(stripSafetyIdentifier(payload)).toBe(false)
    expect(payload).toEqual({ model: "gpt-5", input: [] } as unknown as ResponsesPayload)
  })

  test("strips safety_identifier when present", () => {
    const payload = {
      model: "gpt-5",
      input: [],
      safety_identifier: "user-123",
    } as unknown as ResponsesPayload
    expect(stripSafetyIdentifier(payload)).toBe(true)
    expect("safety_identifier" in (payload as object)).toBe(false)
  })

  test("strips empty-string safety_identifier", () => {
    const payload = {
      model: "gpt-5",
      input: [],
      safety_identifier: "",
    } as unknown as ResponsesPayload
    expect(stripSafetyIdentifier(payload)).toBe(true)
    expect("safety_identifier" in (payload as object)).toBe(false)
  })

  test("strips null safety_identifier", () => {
    const payload = {
      model: "gpt-5",
      input: [],
      safety_identifier: null,
    } as unknown as ResponsesPayload
    expect(stripSafetyIdentifier(payload)).toBe(true)
    expect("safety_identifier" in (payload as object)).toBe(false)
  })

  test("does not touch other fields", () => {
    const payload = {
      model: "gpt-5",
      input: [{ role: "user", content: "hi" }],
      safety_identifier: "user-x",
      metadata: { foo: "bar" },
    } as unknown as ResponsesPayload
    stripSafetyIdentifier(payload)
    expect(payload).toEqual({
      model: "gpt-5",
      input: [{ role: "user", content: "hi" }],
      metadata: { foo: "bar" },
    } as unknown as ResponsesPayload)
  })
})
