/**
 * Unit tests for transform modules
 */
import { describe, test, expect } from "bun:test"

import {
  stripReservedKeywords,
  filterThinkingBlocks,
  checkWhitespaceOverflow,
  fixApplyPatchTools,
  stripWebSearchTools,
  createStreamIdTracker,
  fixStreamIds,
  fixChatStreamLine,
  createChatStreamFixer,
  type AnthropicMessagesPayload,
  type ResponsesPayload,
} from "../src/transforms"

describe("stripReservedKeywords", () => {
  test("removes keyword from string system prompt", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      system: "You are an assistant. x-anthropic-billing-header test",
    }

    stripReservedKeywords(payload)

    expect(payload.system).toBe("You are an assistant.  test")
  })

  test("removes keyword from array system prompt", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      system: [
        { type: "text", text: "Part 1 x-anthropic-billing-header" },
        { type: "text", text: "Part 2" },
      ],
    }

    stripReservedKeywords(payload)

    expect(payload.system).toEqual([
      { type: "text", text: "Part 1 " },
      { type: "text", text: "Part 2" },
    ])
  })

  test("removes keyword from message content string", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "Hello x-anthropic-billing-header world" },
      ],
      max_tokens: 100,
    }

    stripReservedKeywords(payload)

    expect(payload.messages[0].content).toBe("Hello  world")
  })

  test("removes keyword from message content blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "x-anthropic-billing-header" }],
        },
      ],
      max_tokens: 100,
    }

    stripReservedKeywords(payload)

    expect(payload.messages[0].content).toEqual([{ type: "text", text: "" }])
  })

  test("leaves payload unchanged when no keyword present", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello world" }],
      max_tokens: 100,
      system: "Normal system prompt",
    }

    stripReservedKeywords(payload)

    expect(payload.system).toBe("Normal system prompt")
    expect(payload.messages[0].content).toBe("Hello world")
  })
})

describe("filterThinkingBlocks", () => {
  test("removes empty thinking blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "Response" },
          ],
        },
      ],
      max_tokens: 100,
    }

    filterThinkingBlocks(payload)

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "Response" },
    ])
  })

  test("removes placeholder thinking blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Thinking..." },
            { type: "text", text: "Response" },
          ],
        },
      ],
      max_tokens: 100,
    }

    filterThinkingBlocks(payload)

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "Response" },
    ])
  })

  test("keeps valid thinking blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me analyze this..." },
            { type: "text", text: "Response" },
          ],
        },
      ],
      max_tokens: 100,
    }

    filterThinkingBlocks(payload)

    expect(payload.messages[0].content).toHaveLength(2)
  })

  test("ignores user messages", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Question" }],
        },
      ],
      max_tokens: 100,
    }

    filterThinkingBlocks(payload)

    expect(payload.messages[0].content).toHaveLength(1)
  })
})

describe("checkWhitespaceOverflow", () => {
  test("returns no overflow for normal text", () => {
    const result = checkWhitespaceOverflow("Hello world", 0)
    expect(result.exceeded).toBe(false)
    expect(result.count).toBe(0)
  })

  test("returns no overflow for few newlines", () => {
    const result = checkWhitespaceOverflow("Hello\n\n\nworld", 0)
    expect(result.exceeded).toBe(false)
    expect(result.count).toBe(0) // resets after non-space character
  })

  test("detects overflow with many consecutive newlines", () => {
    const result = checkWhitespaceOverflow("\n".repeat(25), 0)
    expect(result.exceeded).toBe(true)
    expect(result.count).toBeGreaterThan(20)
  })

  test("accumulates count across calls", () => {
    const result1 = checkWhitespaceOverflow("\n\n\n", 0)
    const result2 = checkWhitespaceOverflow("\n\n\n", result1.count)
    expect(result2.count).toBe(6)
  })

  test("does not count regular spaces", () => {
    const result = checkWhitespaceOverflow("                    text", 0)
    expect(result.count).toBe(0) // spaces don't increment counter
    expect(result.exceeded).toBe(false)
  })

  test("counts tabs", () => {
    const result = checkWhitespaceOverflow("\t".repeat(25), 0)
    expect(result.exceeded).toBe(true)
  })
})

describe("fixApplyPatchTools", () => {
  test("converts custom apply_patch to function type", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.1",
      input: "test",
      tools: [{ type: "custom", name: "apply_patch" }],
    }

    fixApplyPatchTools(payload)

    expect(payload.tools![0].type).toBe("function")
    expect(payload.tools![0].name).toBe("apply_patch")
    expect(payload.tools![0].parameters).toBeDefined()
  })

  test("leaves other custom tools unchanged", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.1",
      input: "test",
      tools: [{ type: "custom", name: "other_tool" }],
    }

    fixApplyPatchTools(payload)

    expect(payload.tools![0].type).toBe("custom")
    expect(payload.tools![0].name).toBe("other_tool")
  })

  test("leaves function tools unchanged", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.1",
      input: "test",
      tools: [{ type: "function", name: "my_func" }],
    }

    fixApplyPatchTools(payload)

    expect(payload.tools![0].type).toBe("function")
  })

  test("handles empty tools array", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.1",
      input: "test",
      tools: [],
    }

    fixApplyPatchTools(payload)

    expect(payload.tools).toEqual([])
  })

  test("handles undefined tools", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.1",
      input: "test",
    }

    fixApplyPatchTools(payload)

    expect(payload.tools).toBeUndefined()
  })
})

describe("stripWebSearchTools", () => {
  test("removes web_search tools", () => {
    const tools = [
      { type: "web_search" as const },
      { type: "function" as const, name: "my_func" },
    ]

    const result = stripWebSearchTools(tools)

    expect(result).toHaveLength(1)
    expect(result![0].type).toBe("function")
  })

  test("returns undefined when only web_search tools", () => {
    const tools = [{ type: "web_search" as const }]

    const result = stripWebSearchTools(tools)

    expect(result).toBeUndefined()
  })

  test("returns undefined for empty array", () => {
    const result = stripWebSearchTools([])

    expect(result).toBeUndefined()
  })

  test("returns undefined for undefined input", () => {
    const result = stripWebSearchTools(undefined)

    expect(result).toBeUndefined()
  })

  test("returns undefined for null input", () => {
    const result = stripWebSearchTools(null)

    expect(result).toBeUndefined()
  })
})

describe("fixStreamIds", () => {
  test("tracks output_item.added IDs", () => {
    const tracker = createStreamIdTracker()
    const data = JSON.stringify({
      output_index: 0,
      item: { id: "item_001" },
    })

    fixStreamIds(data, "response.output_item.added", tracker)

    expect(tracker.outputItemIds.get(0)).toBe("item_001")
  })

  test("fixes mismatched output_item.done IDs", () => {
    const tracker = createStreamIdTracker()
    tracker.outputItemIds.set(0, "item_001")

    const data = JSON.stringify({
      output_index: 0,
      item: { id: "item_wrong" },
    })

    const result = fixStreamIds(data, "response.output_item.done", tracker)
    const parsed = JSON.parse(result)

    expect(parsed.item.id).toBe("item_001")
  })

  test("leaves matching IDs unchanged", () => {
    const tracker = createStreamIdTracker()
    tracker.outputItemIds.set(0, "item_001")

    const data = JSON.stringify({
      output_index: 0,
      item: { id: "item_001" },
    })

    const result = fixStreamIds(data, "response.output_item.done", tracker)

    expect(result).toBe(data)
  })

  test("ignores non-output events", () => {
    const tracker = createStreamIdTracker()
    const data = JSON.stringify({ something: "else" })

    const result = fixStreamIds(data, "response.created", tracker)

    expect(result).toBe(data)
  })
})

describe("fixChatStreamLine", () => {
  test("fixes choice indices to 0", () => {
    const line = 'data: {"choices":[{"index":5,"delta":{"content":"Hi"}}]}'

    const result = fixChatStreamLine(line)
    const parsed = JSON.parse(result.slice(6))

    expect(parsed.choices[0].index).toBe(0)
  })

  test("leaves [DONE] unchanged", () => {
    const line = "data: [DONE]"

    const result = fixChatStreamLine(line)

    expect(result).toBe("data: [DONE]")
  })

  test("leaves non-data lines unchanged", () => {
    const line = "event: message"

    const result = fixChatStreamLine(line)

    expect(result).toBe("event: message")
  })

  test("handles invalid JSON gracefully", () => {
    const line = "data: {invalid json}"

    const result = fixChatStreamLine(line)

    expect(result).toBe(line)
  })
})

describe("createChatStreamFixer", () => {
  test("transforms stream correctly", async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const input = 'data: {"choices":[{"index":1}]}\n'
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(input))
        controller.close()
      },
    })

    const fixer = createChatStreamFixer()
    const transformed = readable.pipeThrough(fixer)
    const reader = transformed.getReader()

    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const output = decoder.decode(new Uint8Array(chunks.flatMap((c) => [...c])))
    const parsed = JSON.parse(output.trim().slice(6))

    expect(parsed.choices[0].index).toBe(0)
  })
})
