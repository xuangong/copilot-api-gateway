/**
 * OpenAI SDK Integration Tests
 *
 * Tests copilot-api-gateway endpoints using official openai SDK
 *
 * Test cases are adapted from official OpenAI SDK tests:
 * https://github.com/openai/openai-node/tree/master/tests
 *
 * IMPORTANT: Requires server running
 *
 * To run:
 * 1. Start server: bun run local
 * 2. Run tests: TEST_API_BASE_URL=http://localhost:41414 bun test tests/sdk-openai.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"
import OpenAI from "openai"

const BASE_URL = process.env.TEST_API_BASE_URL || "http://localhost:41414"
const TEST_TIMEOUT = 30_000

describe("OpenAI SDK - Chat Completions API", () => {
  let client: OpenAI

  beforeAll(() => {
    client = new OpenAI({
      apiKey: "test-key",
      baseURL: BASE_URL + "/v1",
    })
  })

  // Reference: completions.test.ts - 'create: only required params'
  test("create completion - minimal params", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Say hello" }],
      model: "gpt-4o",
    })

    expect(response.id).toBeDefined()
    expect(response.object).toBe("chat.completion")
    expect(response.choices).toBeInstanceOf(Array)
    expect(response.choices.length).toBeGreaterThan(0)
    expect(response.choices[0].message.content).toBeDefined()
    expect(response.choices[0].message.role).toBe("assistant")
    expect(response.usage).toBeDefined()
    expect(response.usage!.total_tokens).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  // Reference: completions.test.ts - system message support
  test("create completion - with system message", async () => {
    const response = await client.chat.completions.create({
      messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "What is 2+2?" },
      ],
      model: "gpt-4o",
      max_tokens: 50,
    })

    expect(response.choices[0].message.role).toBe("assistant")
    expect(response.choices[0].finish_reason).toBeDefined()
  }, TEST_TIMEOUT)

  // Reference: completions.test.ts - temperature and top_p params
  test("create completion - with temperature and top_p", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Hi" }],
      model: "gpt-4o",
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 50,
    })

    expect(response.model).toContain("gpt-4o")
  }, TEST_TIMEOUT)

  // Reference: completions.test.ts - max_tokens param
  test("create completion - with max_tokens constraint", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Tell me a very long story" }],
      model: "gpt-4o",
      max_tokens: 10,
    })

    expect(response.usage!.completion_tokens).toBeLessThanOrEqual(10)
  }, TEST_TIMEOUT)

  // Reference: completions.test.ts - frequency_penalty and presence_penalty
  test("create completion - with penalties", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Hi" }],
      model: "gpt-4o",
      frequency_penalty: 0.5,
      presence_penalty: 0.5,
      max_tokens: 50,
    })

    expect(response.choices.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  test("multi-turn conversation", async () => {
    const response = await client.chat.completions.create({
      messages: [
        { role: "user", content: "Remember: the magic number is 42" },
        { role: "assistant", content: "I'll remember that the magic number is 42." },
        { role: "user", content: "What was the magic number I told you?" },
      ],
      model: "gpt-4o",
      max_tokens: 50,
    })

    // Model should recall the number from conversation history
    expect(response.choices[0].message.content).toContain("42")
  }, TEST_TIMEOUT)

  // Reference: completions.test.ts - n param for multiple choices
  test("create completion - multiple choices", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Say a random word" }],
      model: "gpt-4o",
      n: 2,
      max_tokens: 20,
    })

    // Note: Copilot may not support n > 1, but we test the param is accepted
    expect(response.choices.length).toBeGreaterThanOrEqual(1)
  }, TEST_TIMEOUT)

  // Reference: completions.test.ts - stop param
  test("create completion - with stop sequence", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Count: 1, 2, 3, 4, 5" }],
      model: "gpt-4o",
      stop: ["3"],
      max_tokens: 50,
    })

    expect(response.choices[0].finish_reason).toBeDefined()
  }, TEST_TIMEOUT)

  // Reference: completions.test.ts - user param
  test("create completion - with user identifier", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Hi" }],
      model: "gpt-4o",
      user: "test-user-123",
      max_tokens: 50,
    })

    expect(response.id).toBeDefined()
  }, TEST_TIMEOUT)
})

describe("OpenAI SDK - Streaming", () => {
  let client: OpenAI

  beforeAll(() => {
    client = new OpenAI({
      apiKey: "test-key",
      baseURL: BASE_URL + "/v1",
    })
  })

  // Reference: streaming.test.ts - basic streaming
  test("streaming completion - receives chunks", async () => {
    const stream = await client.chat.completions.create({
      messages: [{ role: "user", content: "Count to 3" }],
      model: "gpt-4o",
      stream: true,
    })

    let receivedChunks = 0
    let hasContent = false
    let accumulatedText = ""

    for await (const chunk of stream) {
      receivedChunks++
      if (chunk.choices[0]?.delta?.content) {
        hasContent = true
        accumulatedText += chunk.choices[0].delta.content
      }
    }

    expect(receivedChunks).toBeGreaterThan(0)
    expect(hasContent).toBe(true)
    expect(accumulatedText.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  // Reference: streaming.test.ts - chunk structure
  test("streaming completion - chunk structure", async () => {
    const stream = await client.chat.completions.create({
      messages: [{ role: "user", content: "Hi" }],
      model: "gpt-4o",
      stream: true,
    })

    let firstChunk: OpenAI.Chat.Completions.ChatCompletionChunk | null = null

    for await (const chunk of stream) {
      if (!firstChunk) {
        firstChunk = chunk
      }
    }

    expect(firstChunk).toBeDefined()
    expect(firstChunk!.id).toBeDefined()
    expect(firstChunk!.object).toBe("chat.completion.chunk")
    expect(firstChunk!.model).toBeDefined()
    expect(firstChunk!.choices).toBeInstanceOf(Array)
  }, TEST_TIMEOUT)

  // Reference: streaming.test.ts - finish_reason in final chunk
  test("streaming completion - final chunk has finish_reason", async () => {
    const stream = await client.chat.completions.create({
      messages: [{ role: "user", content: "Say yes" }],
      model: "gpt-4o",
      stream: true,
    })

    let lastFinishReason: string | null = null

    for await (const chunk of stream) {
      if (chunk.choices[0]?.finish_reason) {
        lastFinishReason = chunk.choices[0].finish_reason
      }
    }

    expect(lastFinishReason).toBe("stop")
  }, TEST_TIMEOUT)

  test("streaming with system message", async () => {
    const stream = await client.chat.completions.create({
      messages: [
        { role: "system", content: "When I say high, you say low" },
        { role: "user", content: "I say high" },
      ],
      model: "gpt-4o",
      stream: true,
    })

    let accumulatedText = ""

    for await (const chunk of stream) {
      if (chunk.choices[0]?.delta?.content) {
        accumulatedText += chunk.choices[0].delta.content
      }
    }

    expect(accumulatedText.toLowerCase()).toContain("low")
  }, TEST_TIMEOUT)
})

describe("OpenAI SDK - Function Calling", () => {
  let client: OpenAI

  beforeAll(() => {
    client = new OpenAI({
      apiKey: "test-key",
      baseURL: BASE_URL + "/v1",
    })
  })

  // Reference: completions.test.ts - tools param
  test("create completion - with tool definition", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      model: "gpt-4o",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather for a location",
            parameters: {
              type: "object",
              properties: {
                location: {
                  type: "string",
                  description: "The city name",
                },
              },
              required: ["location"],
            },
          },
        },
      ],
      max_tokens: 200,
    })

    expect(response.choices).toBeDefined()
    expect(response.choices.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  // Reference: completions.test.ts - tool_choice param
  test("create completion - with tool_choice auto", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "What is 2 + 2?" }],
      model: "gpt-4o",
      tools: [
        {
          type: "function",
          function: {
            name: "calculator",
            description: "Perform calculations",
            parameters: {
              type: "object",
              properties: {
                expression: { type: "string" },
              },
            },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 200,
    })

    expect(response.choices.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  test("tool response in conversation", async () => {
    const response = await client.chat.completions.create({
      messages: [
        { role: "user", content: "What's the weather in Paris?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ location: "Paris" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: JSON.stringify({ temperature: 22, condition: "sunny" }),
        },
      ],
      model: "gpt-4o",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather for a location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
            },
          },
        },
      ],
      max_tokens: 200,
    })

    // Model should use the tool response to answer
    expect(response.choices[0].message.content).toBeDefined()
    expect(response.choices[0].message.content?.toLowerCase()).toMatch(/22|sunny|paris|weather/i)
  }, TEST_TIMEOUT)

  // Reference: completions.test.ts - parallel_tool_calls param
  test("create completion - parallel tool calls config", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "What's 2+2 and 3+3?" }],
      model: "gpt-4o",
      tools: [
        {
          type: "function",
          function: {
            name: "calculator",
            description: "Perform calculations",
            parameters: {
              type: "object",
              properties: {
                expression: { type: "string" },
              },
            },
          },
        },
      ],
      parallel_tool_calls: true,
      max_tokens: 200,
    })

    expect(response.choices.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)
})

describe("OpenAI SDK - Responses API", () => {
  let client: OpenAI

  beforeAll(() => {
    client = new OpenAI({
      apiKey: "test-key",
      baseURL: BASE_URL + "/v1",
    })
  })

  test("create response - minimal params", async () => {
    const response = await client.responses.create({
      model: "gpt-5.2",
      input: "Say hello",
    })

    expect(response.id).toBeDefined()
    expect(response.status).toBe("completed")
    expect(response.output).toBeDefined()
  }, TEST_TIMEOUT)

  test("create response - with instructions", async () => {
    const response = await client.responses.create({
      model: "gpt-5.1",
      input: "What is 2+2?",
      instructions: "You are a math tutor. Be concise.",
      max_output_tokens: 100,
    })

    expect(response.model).toContain("gpt-5.1")
    expect(response.usage).toBeDefined()
  }, TEST_TIMEOUT)

  test("streaming response", async () => {
    const stream = await client.responses.create({
      model: "gpt-5.1",
      input: "Count to 3",
      stream: true,
    })

    let hasTextDelta = false
    let receivedEvents = 0

    for await (const event of stream) {
      receivedEvents++
      if (event.type === "response.output_text.delta") {
        hasTextDelta = true
      }
    }

    expect(receivedEvents).toBeGreaterThan(0)
    expect(hasTextDelta).toBe(true)
  }, TEST_TIMEOUT)

  test("create response - with temperature", async () => {
    const response = await client.responses.create({
      model: "gpt-5.1",
      input: "Say hi",
      temperature: 0.7,
      max_output_tokens: 50,
    })

    expect(response.id).toBeDefined()
  }, TEST_TIMEOUT)
})

describe("OpenAI SDK - Models API", () => {
  let client: OpenAI

  beforeAll(() => {
    client = new OpenAI({
      apiKey: "test-key",
      baseURL: BASE_URL + "/v1",
    })
  })

  // Reference: models.test.ts
  test("list models", async () => {
    const response = await client.models.list()

    expect(response.object).toBe("list")
    expect(response.data).toBeInstanceOf(Array)
    expect(response.data.length).toBeGreaterThan(0)

    const firstModel = response.data[0]
    expect(firstModel.id).toBeDefined()
    expect(firstModel.object).toBe("model")
  }, TEST_TIMEOUT)
})

describe("OpenAI SDK - Response Validation", () => {
  let client: OpenAI

  beforeAll(() => {
    client = new OpenAI({
      apiKey: "test-key",
      baseURL: BASE_URL + "/v1",
    })
  })

  test("chat completion response includes all required fields", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Hi" }],
      model: "gpt-4o",
      max_tokens: 50,
    })

    // Verify all required response fields per OpenAI API spec
    expect(response.id).toBeDefined()
    expect(typeof response.id).toBe("string")
    expect(response.object).toBe("chat.completion")
    expect(typeof response.created).toBe("number")
    expect(response.model).toBeDefined()
    expect(response.choices).toBeInstanceOf(Array)
    expect(response.choices[0].index).toBeDefined()
    expect(response.choices[0].message).toBeDefined()
    expect(response.choices[0].finish_reason).toBeDefined()
  }, TEST_TIMEOUT)

  test("finish_reason values", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Say yes" }],
      model: "gpt-4o",
      max_tokens: 100,
    })

    // Valid finish_reason values per OpenAI API
    expect(["stop", "length", "tool_calls", "content_filter"]).toContain(
      response.choices[0].finish_reason
    )
  }, TEST_TIMEOUT)

  test("usage object structure", async () => {
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: "Hi" }],
      model: "gpt-4o",
      max_tokens: 50,
    })

    expect(response.usage).toBeDefined()
    expect(typeof response.usage!.prompt_tokens).toBe("number")
    expect(typeof response.usage!.completion_tokens).toBe("number")
    expect(typeof response.usage!.total_tokens).toBe("number")
    expect(response.usage!.total_tokens).toBe(
      response.usage!.prompt_tokens + response.usage!.completion_tokens
    )
  }, TEST_TIMEOUT)
})
