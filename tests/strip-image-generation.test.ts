import { describe, expect, test } from "bun:test"

import { hasResponsesImageGenerationTool, stripImageGeneration } from "~/transforms/strip-image-generation"
import type { ResponsesPayload } from "~/transforms"

const mk = (overrides: Partial<ResponsesPayload>): ResponsesPayload =>
  ({
    model: "gpt-test",
    input: "test",
    ...overrides,
  }) as ResponsesPayload

describe("stripImageGeneration", () => {
  test("removes image_generation tool, preserves others, keeps auto choice", () => {
    const payload = mk({
      tools: [
        { type: "image_generation" } as never,
        { type: "function", name: "lookup", parameters: { type: "object" }, strict: false },
      ],
      tool_choice: "auto",
    })
    expect(stripImageGeneration(payload)).toBe(true)
    expect(payload.tools?.length).toBe(1)
    expect(payload.tools?.[0].type).toBe("function")
    expect(payload.tool_choice).toBe("auto")
  })

  test("removes forced image_generation tool_choice and empties tools", () => {
    const payload = mk({
      tools: [{ type: "image_generation" } as never],
      tool_choice: { type: "image_generation" },
    })
    stripImageGeneration(payload)
    expect("tools" in payload).toBe(false)
    expect("tool_choice" in payload).toBe(false)
  })

  test("removes 'required' tool_choice when no tools survive", () => {
    const payload = mk({
      tools: [{ type: "image_generation" } as never],
      tool_choice: "required",
    })
    stripImageGeneration(payload)
    expect("tools" in payload).toBe(false)
    expect("tool_choice" in payload).toBe(false)
  })

  test("preserves hosted/deferred tools Copilot accepts", () => {
    const payload = mk({
      tools: [
        { type: "function", name: "lookup", parameters: { type: "object" }, strict: false },
        { type: "web_search" } as never,
        { type: "tool_search", execution: "x", description: "y", parameters: {} } as never,
        { type: "namespace", name: "ns", tools: [] } as never,
        { type: "image_generation", output_format: "png" } as never,
      ],
      tool_choice: "auto",
    })
    stripImageGeneration(payload)
    expect(payload.tools?.map((t) => t.type)).toEqual(["function", "web_search", "tool_search", "namespace"])
    expect(payload.tool_choice).toBe("auto")
  })

  test("preserves forced non-image hosted tool_choices", () => {
    for (const type of ["web_search", "tool_search", "namespace"] as const) {
      const payload = mk({
        tools: [{ type } as never],
        tool_choice: { type } as never,
      })
      stripImageGeneration(payload)
      expect(payload.tools).toEqual([{ type } as never])
      expect(payload.tool_choice).toEqual({ type } as never)
    }
  })

  test("preserves custom Freeform tools", () => {
    const payload = mk({
      tools: [
        { type: "function", name: "lookup", parameters: { type: "object" }, strict: false },
        { type: "custom", name: "freeform_other", description: "x" },
      ],
      tool_choice: { type: "custom", name: "freeform_other" },
    })
    stripImageGeneration(payload)
    expect(payload.tools?.length).toBe(2)
    expect(payload.tools?.[1].type).toBe("custom")
    expect(payload.tool_choice).toEqual({ type: "custom", name: "freeform_other" })
  })

  test("no-op on payload without tools", () => {
    const payload = mk({})
    expect(stripImageGeneration(payload)).toBe(false)
  })
})

describe("hasResponsesImageGenerationTool", () => {
  test("true when tools[] contains image_generation", () => {
    const payload = mk({
      tools: [
        { type: "function", name: "lookup", parameters: { type: "object" }, strict: false },
        { type: "image_generation" } as never,
      ],
    })
    expect(hasResponsesImageGenerationTool(payload)).toBe(true)
  })

  test("true when tool_choice forces image_generation", () => {
    const payload = mk({
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" }, strict: false }],
      tool_choice: { type: "image_generation" },
    })
    expect(hasResponsesImageGenerationTool(payload)).toBe(true)
  })

  test("false when no image_generation tool or choice present", () => {
    const payload = mk({
      tools: [
        { type: "function", name: "lookup", parameters: { type: "object" }, strict: false },
        { type: "web_search" } as never,
      ],
      tool_choice: "auto",
    })
    expect(hasResponsesImageGenerationTool(payload)).toBe(false)
  })

  test("false on payload with no tools / no tool_choice", () => {
    expect(hasResponsesImageGenerationTool(mk({}))).toBe(false)
    expect(hasResponsesImageGenerationTool(mk({ tools: [] }))).toBe(false)
  })

  test("false on non-image hosted tool_choice forms", () => {
    expect(hasResponsesImageGenerationTool(mk({ tool_choice: "required" }))).toBe(false)
    expect(hasResponsesImageGenerationTool(mk({ tool_choice: { type: "web_search" } as never }))).toBe(false)
  })
})
