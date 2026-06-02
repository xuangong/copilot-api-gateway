import { describe, expect, test } from "bun:test"

import { stripStructuredOutputFormat } from "~/transforms/strip-structured-output-format"
import type { AnthropicMessagesPayload } from "~/transforms"

const mk = (overrides: Partial<AnthropicMessagesPayload>): AnthropicMessagesPayload =>
  ({
    model: "claude-test",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  }) as AnthropicMessagesPayload

const jsonSchemaFormat = {
  type: "json_schema",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
}

describe("stripStructuredOutputFormat", () => {
  test("strips output_config.format and drops emptied container", () => {
    const payload = mk({ output_config: { format: jsonSchemaFormat } as never })
    expect(stripStructuredOutputFormat(payload)).toBe(true)
    expect((payload as { output_config?: unknown }).output_config).toBeUndefined()
  })

  test("preserves sibling output_config.effort", () => {
    const payload = mk({ output_config: { effort: "medium", format: jsonSchemaFormat } as never })
    expect(stripStructuredOutputFormat(payload)).toBe(true)
    expect(payload.output_config).toEqual({ effort: "medium" } as never)
  })

  test("no-op when output_config absent", () => {
    const payload = mk({})
    expect(stripStructuredOutputFormat(payload)).toBe(false)
    expect((payload as { output_config?: unknown }).output_config).toBeUndefined()
  })

  test("no-op when output_config carries only sibling fields", () => {
    const payload = mk({ output_config: { effort: "low" } })
    expect(stripStructuredOutputFormat(payload)).toBe(false)
    expect(payload.output_config).toEqual({ effort: "low" })
  })
})
