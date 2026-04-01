/**
 * Unit tests for web search interceptor utilities
 */
import { describe, test, expect } from "bun:test"

import {
  hasWebSearch,
  prepareWebSearchPayload,
  classifyToolUses,
  filterThinkingBlocks,
  createToolResult,
  type MessagesPayload,
  type ClientTool,
  type MessageContent,
  type ToolUseBlock,
} from "../src/services/web-search"

describe("hasWebSearch", () => {
  test("returns true when web_search tool present", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Search for news" }],
      tools: [{ name: "web_search", type: "web_search" }],
    }

    expect(hasWebSearch(payload)).toBe(true)
  })

  test("returns false when no web_search tool", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "other_tool" }],
    }

    expect(hasWebSearch(payload)).toBe(false)
  })

  test("returns false when no tools", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
    }

    expect(hasWebSearch(payload)).toBe(false)
  })

  test("returns false for empty tools array", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    }

    expect(hasWebSearch(payload)).toBe(false)
  })
})

describe("prepareWebSearchPayload", () => {
  test("returns original payload when no web_search tool", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "other_tool" }],
    }

    const result = prepareWebSearchPayload(payload)

    expect(result.webSearchTool).toBeNull()
    expect(result.modifiedPayload).toBe(payload)
  })

  test("replaces web_search with function tool", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Search news" }],
      tools: [{ name: "web_search", type: "web_search" }],
    }

    const result = prepareWebSearchPayload(payload)

    expect(result.webSearchTool).not.toBeNull()
    expect(result.webSearchTool!.name).toBe("web_search")

    const modifiedTool = result.modifiedPayload.tools![0]
    expect(modifiedTool.name).toBe("web_search")
    expect(modifiedTool.input_schema).toBeDefined()
    expect(modifiedTool.description).toContain("Search the web")
  })

  test("preserves other tools", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Search and calculate" }],
      tools: [
        { name: "web_search", type: "web_search" },
        { name: "calculator" },
      ],
    }

    const result = prepareWebSearchPayload(payload)

    expect(result.modifiedPayload.tools).toHaveLength(2)
    expect(result.modifiedPayload.tools![0].name).toBe("calculator")
    expect(result.modifiedPayload.tools![1].name).toBe("web_search")
  })

  test("preserves web_search options", () => {
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Search" }],
      tools: [
        {
          name: "web_search",
          type: "web_search",
          max_uses: 2,
          allowed_domains: ["example.com"],
        },
      ],
    }

    const result = prepareWebSearchPayload(payload)

    expect(result.webSearchTool!.max_uses).toBe(2)
    expect(result.webSearchTool!.allowed_domains).toEqual(["example.com"])
  })
})

describe("classifyToolUses", () => {
  test("identifies web_search tool uses", () => {
    const content: MessageContent[] = [
      { type: "text", text: "Let me search" },
      { type: "tool_use", id: "tu_001", name: "web_search", input: { query: "test" } },
    ]

    const result = classifyToolUses(content)

    expect(result.webSearchToolUses).toHaveLength(1)
    expect(result.webSearchToolUses[0].name).toBe("web_search")
    expect(result.hasOtherTools).toBe(false)
  })

  test("identifies mixed tool uses", () => {
    const content: MessageContent[] = [
      { type: "tool_use", id: "tu_001", name: "web_search", input: { query: "test" } },
      { type: "tool_use", id: "tu_002", name: "calculator", input: { expression: "1+1" } },
    ]

    const result = classifyToolUses(content)

    expect(result.webSearchToolUses).toHaveLength(1)
    expect(result.hasOtherTools).toBe(true)
  })

  test("handles content with no tool uses", () => {
    const content: MessageContent[] = [
      { type: "text", text: "Just text" },
    ]

    const result = classifyToolUses(content)

    expect(result.webSearchToolUses).toHaveLength(0)
    expect(result.hasOtherTools).toBe(false)
  })

  test("filters tool_use without id", () => {
    const content: MessageContent[] = [
      { type: "tool_use", name: "web_search", input: { query: "test" } } as MessageContent,
    ]

    const result = classifyToolUses(content)

    expect(result.webSearchToolUses).toHaveLength(0)
  })

  test("filters tool_use without input", () => {
    const content: MessageContent[] = [
      { type: "tool_use", id: "tu_001", name: "web_search" } as MessageContent,
    ]

    const result = classifyToolUses(content)

    expect(result.webSearchToolUses).toHaveLength(0)
  })
})

describe("filterThinkingBlocks", () => {
  test("removes thinking blocks", () => {
    const content: MessageContent[] = [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Response" },
    ]

    const result = filterThinkingBlocks(content)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("text")
  })

  test("removes redacted_thinking blocks", () => {
    const content: MessageContent[] = [
      { type: "redacted_thinking" } as MessageContent,
      { type: "text", text: "Response" },
    ]

    const result = filterThinkingBlocks(content)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("text")
  })

  test("keeps other content types", () => {
    const content: MessageContent[] = [
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "tu_001", name: "test", input: {} },
    ]

    const result = filterThinkingBlocks(content)

    expect(result).toHaveLength(2)
  })

  test("handles empty array", () => {
    const result = filterThinkingBlocks([])

    expect(result).toEqual([])
  })
})

describe("createToolResult", () => {
  test("creates tool result block", () => {
    const result = createToolResult("tu_001", "Search results here")

    expect(result.type).toBe("tool_result")
    expect(result.tool_use_id).toBe("tu_001")
    expect(result.content).toBe("Search results here")
    expect(result.is_error).toBe(false)
  })

  test("creates error tool result", () => {
    const result = createToolResult("tu_001", "Error occurred", true)

    expect(result.type).toBe("tool_result")
    expect(result.tool_use_id).toBe("tu_001")
    expect(result.content).toBe("Error occurred")
    expect(result.is_error).toBe(true)
  })
})
