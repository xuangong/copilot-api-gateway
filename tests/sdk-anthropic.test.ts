/**
 * Anthropic SDK Integration Tests
 *
 * Tests copilot-api-gateway endpoints using official @anthropic-ai/sdk
 *
 * Test cases are adapted from official Anthropic SDK tests:
 * https://github.com/anthropics/anthropic-sdk-typescript/tree/main/tests
 *
 * IMPORTANT: Requires server running
 *
 * To run:
 * 1. Start server: bun run local
 * 2. Run tests: TEST_API_BASE_URL=http://localhost:41414 bun test tests/sdk-anthropic.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"
import Anthropic from "@anthropic-ai/sdk"

const BASE_URL = process.env.TEST_API_BASE_URL || "http://localhost:41414"
const TEST_TIMEOUT = 30_000

describe("Anthropic SDK - Messages API", () => {
  let client: Anthropic

  beforeAll(() => {
    client = new Anthropic({
      apiKey: "test-key", // Copilot doesn't need this, but SDK requires it
      baseURL: BASE_URL,
    })
  })

  // Reference: messages.test.ts - 'create: only required params'
  test("create message - minimal params", async () => {
    const response = await client.messages.create({
      max_tokens: 100,
      messages: [{ role: "user", content: "Say hello in one word" }],
      model: "claude-sonnet-4",
    })

    expect(response.id).toBeDefined()
    expect(response.type).toBe("message")
    expect(response.role).toBe("assistant")
    expect(response.content).toBeInstanceOf(Array)
    expect(response.content.length).toBeGreaterThan(0)
    expect(response.model).toContain("claude")
    expect(response.usage).toBeDefined()
    expect(response.usage.input_tokens).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  // Reference: messages.test.ts - system content block
  test("create message - with system prompt", async () => {
    const response = await client.messages.create({
      max_tokens: 100,
      messages: [{ role: "user", content: "What are you?" }],
      model: "claude-sonnet-4",
      system: "You are a helpful assistant. Respond in one sentence.",
    })

    expect(response.content[0].type).toBe("text")
    expect(response.stop_reason).toBeDefined()
  }, TEST_TIMEOUT)

  // Reference: messages.test.ts - temperature and top_p params
  test("create message - with temperature and top_p", async () => {
    const response = await client.messages.create({
      max_tokens: 50,
      messages: [{ role: "user", content: "Hi" }],
      model: "claude-sonnet-4",
      temperature: 0.5,
      top_p: 0.9,
    })

    expect(response.id).toBeDefined()
    expect(response.usage.output_tokens).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  // Reference: messages.test.ts - top_k param
  test("create message - with top_k", async () => {
    const response = await client.messages.create({
      max_tokens: 50,
      messages: [{ role: "user", content: "Say yes" }],
      model: "claude-sonnet-4",
      top_k: 5,
    })

    expect(response.content.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  // Reference: messages.test.ts - countTokens tests
  test("count tokens - basic", async () => {
    const response = await client.messages.countTokens({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ],
      model: "claude-sonnet-4",
    })

    expect(response.input_tokens).toBeGreaterThan(0)
    expect(typeof response.input_tokens).toBe("number")
  }, TEST_TIMEOUT)

  test("count tokens - with system", async () => {
    const response = await client.messages.countTokens({
      messages: [{ role: "user", content: "Hello" }],
      model: "claude-sonnet-4",
      system: "You are a helpful assistant",
    })

    expect(response.input_tokens).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  test("multi-turn conversation", async () => {
    const response = await client.messages.create({
      max_tokens: 100,
      messages: [
        { role: "user", content: "Remember: my name is Alice" },
        { role: "assistant", content: "Got it! I'll remember your name is Alice." },
        { role: "user", content: "What's my name?" },
      ],
      model: "claude-sonnet-4",
    })

    expect(response.content[0].type).toBe("text")
    const textBlock = response.content[0] as { type: "text"; text: string }
    expect(textBlock.text.toLowerCase()).toContain("alice")
  }, TEST_TIMEOUT)

  // Reference: messages.test.ts - stop_sequences param
  test("create message - with stop sequences", async () => {
    const response = await client.messages.create({
      max_tokens: 100,
      messages: [{ role: "user", content: "Count: 1, 2, 3, 4, 5" }],
      model: "claude-sonnet-4",
      stop_sequences: ["3"],
    })

    expect(response.stop_reason).toBe("end_turn")
    // Text should stop before or at "3"
  }, TEST_TIMEOUT)

  // Reference: messages.test.ts - metadata param
  test("create message - with metadata", async () => {
    const response = await client.messages.create({
      max_tokens: 50,
      messages: [{ role: "user", content: "Hi" }],
      model: "claude-sonnet-4",
      metadata: { user_id: "test-user-123" },
    })

    expect(response.id).toBeDefined()
  }, TEST_TIMEOUT)
})

describe("Anthropic SDK - Streaming", () => {
  let client: Anthropic

  beforeAll(() => {
    client = new Anthropic({
      apiKey: "test-key",
      baseURL: BASE_URL,
    })
  })

  // Reference: MessageStream.test.ts - basic streaming events
  test("streaming message - event types", async () => {
    const stream = await client.messages.create({
      max_tokens: 100,
      messages: [{ role: "user", content: "Count to 3" }],
      model: "claude-sonnet-4",
      stream: true,
    })

    let receivedEvents = 0
    let hasMessageStart = false
    let hasContentBlockStart = false
    let hasContentBlockDelta = false
    let hasContentBlockStop = false
    let hasMessageDelta = false
    let hasMessageStop = false

    for await (const event of stream) {
      receivedEvents++
      if (event.type === "message_start") hasMessageStart = true
      if (event.type === "content_block_start") hasContentBlockStart = true
      if (event.type === "content_block_delta") hasContentBlockDelta = true
      if (event.type === "content_block_stop") hasContentBlockStop = true
      if (event.type === "message_delta") hasMessageDelta = true
      if (event.type === "message_stop") hasMessageStop = true
    }

    expect(receivedEvents).toBeGreaterThan(0)
    expect(hasMessageStart).toBe(true)
    expect(hasContentBlockStart).toBe(true)
    expect(hasContentBlockDelta).toBe(true)
    expect(hasContentBlockStop).toBe(true)
    expect(hasMessageDelta).toBe(true)
    expect(hasMessageStop).toBe(true)
  }, TEST_TIMEOUT)

  // Reference: MessageStream.test.ts - accumulating text
  test("streaming message - accumulate text", async () => {
    const stream = await client.messages.create({
      max_tokens: 100,
      messages: [{ role: "user", content: "Say hello" }],
      model: "claude-sonnet-4",
      stream: true,
    })

    let accumulatedText = ""

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        accumulatedText += event.delta.text
      }
    }

    expect(accumulatedText.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  // Reference: MessageStream.test.ts - final message structure
  test("streaming message - message_start contains message structure", async () => {
    const stream = await client.messages.create({
      max_tokens: 50,
      messages: [{ role: "user", content: "Hi" }],
      model: "claude-sonnet-4",
      stream: true,
    })

    let messageStartEvent: unknown = null

    for await (const event of stream) {
      if (event.type === "message_start") {
        messageStartEvent = event
        break
      }
    }

    expect(messageStartEvent).toBeDefined()
    const msg = (messageStartEvent as { message: unknown }).message as {
      id: string
      type: string
      role: string
      model: string
    }
    expect(msg.id).toBeDefined()
    expect(msg.type).toBe("message")
    expect(msg.role).toBe("assistant")
    expect(msg.model).toBeDefined()
  }, TEST_TIMEOUT)

  // Reference: MessageStream.test.ts - message_delta contains stop_reason
  test("streaming message - message_delta contains stop info", async () => {
    const stream = await client.messages.create({
      max_tokens: 50,
      messages: [{ role: "user", content: "Say yes" }],
      model: "claude-sonnet-4",
      stream: true,
    })

    let messageDeltaEvent: unknown = null

    for await (const event of stream) {
      if (event.type === "message_delta") {
        messageDeltaEvent = event
      }
    }

    expect(messageDeltaEvent).toBeDefined()
    const delta = (messageDeltaEvent as { delta: unknown }).delta as {
      stop_reason: string
    }
    expect(delta.stop_reason).toBeDefined()
  }, TEST_TIMEOUT)

  test("streaming with system instruction", async () => {
    const stream = await client.messages.create({
      max_tokens: 100,
      messages: [{ role: "user", content: "I say high" }],
      model: "claude-sonnet-4",
      system: "When I say high, you say low",
      stream: true,
    })

    let accumulatedText = ""

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        accumulatedText += event.delta.text
      }
    }

    expect(accumulatedText.toLowerCase()).toContain("low")
  }, TEST_TIMEOUT)
})

describe("Anthropic SDK - Tool Use", () => {
  let client: Anthropic

  beforeAll(() => {
    client = new Anthropic({
      apiKey: "test-key",
      baseURL: BASE_URL,
    })
  })

  // Reference: messages.test.ts - tools param
  test("create message - with tool definition", async () => {
    const response = await client.messages.create({
      max_tokens: 200,
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      model: "claude-sonnet-4",
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather for a location",
          input_schema: {
            type: "object" as const,
            properties: {
              location: {
                type: "string",
                description: "The city name",
              },
            },
            required: ["location"],
          },
        },
      ],
    })

    expect(response.content).toBeDefined()
    expect(response.content.length).toBeGreaterThan(0)
    // Model may call the tool or respond with text
  }, TEST_TIMEOUT)

  // Reference: messages.test.ts - tool_choice param
  test("create message - with tool_choice auto", async () => {
    const response = await client.messages.create({
      max_tokens: 200,
      messages: [{ role: "user", content: "What is 2 + 2?" }],
      model: "claude-sonnet-4",
      tools: [
        {
          name: "calculator",
          description: "Perform calculations",
          input_schema: {
            type: "object" as const,
            properties: {
              expression: { type: "string" },
            },
          },
        },
      ],
      tool_choice: { type: "auto" },
    })

    expect(response.content.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  test("tool response in conversation", async () => {
    // Simulate a tool call response flow
    const response = await client.messages.create({
      max_tokens: 200,
      messages: [
        { role: "user", content: "What's the weather in Paris?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_123",
              name: "get_weather",
              input: { location: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_123",
              content: JSON.stringify({ temperature: 22, condition: "sunny" }),
            },
          ],
        },
      ],
      model: "claude-sonnet-4",
      tools: [
        {
          name: "get_weather",
          description: "Get weather for a location",
          input_schema: {
            type: "object" as const,
            properties: {
              location: { type: "string" },
            },
          },
        },
      ],
    })

    // Model should use the tool response to answer
    expect(response.content[0].type).toBe("text")
    const text = (response.content[0] as { type: "text"; text: string }).text
    expect(text.toLowerCase()).toMatch(/22|sunny|paris|weather/i)
  }, TEST_TIMEOUT)
})

describe("Anthropic SDK - Response Validation", () => {
  let client: Anthropic

  beforeAll(() => {
    client = new Anthropic({
      apiKey: "test-key",
      baseURL: BASE_URL,
    })
  })

  test("response includes all required fields", async () => {
    const response = await client.messages.create({
      max_tokens: 50,
      messages: [{ role: "user", content: "Hi" }],
      model: "claude-sonnet-4",
    })

    // Verify all required response fields per Anthropic API spec
    expect(response.id).toBeDefined()
    expect(typeof response.id).toBe("string")
    expect(response.type).toBe("message")
    expect(response.role).toBe("assistant")
    expect(response.content).toBeInstanceOf(Array)
    expect(response.model).toBeDefined()
    expect(response.stop_reason).toBeDefined()
    expect(response.usage).toBeDefined()
    expect(typeof response.usage.input_tokens).toBe("number")
    expect(typeof response.usage.output_tokens).toBe("number")
  }, TEST_TIMEOUT)

  test("text content block structure", async () => {
    const response = await client.messages.create({
      max_tokens: 50,
      messages: [{ role: "user", content: "Say yes" }],
      model: "claude-sonnet-4",
    })

    const textBlock = response.content.find((b) => b.type === "text")
    expect(textBlock).toBeDefined()
    expect(textBlock!.type).toBe("text")
    expect(typeof (textBlock as { text: string }).text).toBe("string")
  }, TEST_TIMEOUT)

  test("stop_reason values", async () => {
    const response = await client.messages.create({
      max_tokens: 100,
      messages: [{ role: "user", content: "Say yes" }],
      model: "claude-sonnet-4",
    })

    // Valid stop_reason values per Anthropic API
    expect(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).toContain(
      response.stop_reason
    )
  }, TEST_TIMEOUT)
})
