import { test, expect, describe } from "bun:test"
import { translateMessagesToResponses } from "~/translators/messages-via-responses/request"
import type { AnthropicMessagesPayload } from "~/transforms/types"

describe("translateMessagesToResponses", () => {
  test("basic text turn", () => {
    const p: AnthropicMessagesPayload = {
      model: "claude-opus-4-7",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    }
    const out = translateMessagesToResponses(p)
    expect(out.model).toBe("claude-opus-4-7")
    expect(out.max_output_tokens).toBe(1024)
    expect(out.input).toEqual([{ type: "message", role: "user", content: "hello" }])
    expect(out.tool_choice).toBe("auto")
    expect(out.stream).toBe(true)
  })

  test("system string flows through as instructions", () => {
    const out = translateMessagesToResponses({
      model: "m",
      max_tokens: 1,
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.instructions).toBe("be terse")
  })

  test("system blocks join with double newline", () => {
    const out = translateMessagesToResponses({
      model: "m",
      max_tokens: 1,
      system: [
        { type: "text", text: "rule 1" },
        { type: "text", text: "rule 2" },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.instructions).toBe("rule 1\n\nrule 2")
  })

  test("assistant tool_use becomes function_call item", () => {
    const out = translateMessagesToResponses({
      model: "m",
      max_tokens: 1,
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "t1", name: "search", input: { query: "q" } },
          ],
        },
      ],
    })
    const items = out.input as Array<{ type: string }>
    expect(items[items.length - 1].type).toBe("function_call")
    expect(items[items.length - 2].type).toBe("message")
  })

  test("user tool_result becomes function_call_output", () => {
    const out = translateMessagesToResponses({
      model: "m",
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      ],
    })
    const items = out.input as Array<{ type: string; output?: string; call_id?: string }>
    expect(items[0]).toEqual({ type: "function_call_output", call_id: "t1", output: "ok" })
  })

  test("tools and tool_choice translated", () => {
    const out = translateMessagesToResponses({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "search", input_schema: { type: "object" } }],
    } as AnthropicMessagesPayload)
    expect(out.tools).toEqual([
      { type: "function", name: "search", parameters: { type: "object" }, strict: false },
    ])
  })

  test("reasoning effort propagated from output_config", () => {
    const out = translateMessagesToResponses({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
      output_config: { effort: "high" },
    })
    expect(out.reasoning).toEqual({ effort: "high" })
  })

  test("no synthesized temperature/store", () => {
    const out = translateMessagesToResponses({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    })
    expect(out.temperature).toBeUndefined()
    expect(out.store).toBeUndefined()
  })
})
