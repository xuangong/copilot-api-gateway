/**
 * Gemini API Format Compatibility Tests
 *
 * Tests Gemini API format compatibility using Google GenAI SDK
 *
 * Test cases are adapted from official Google GenAI SDK tests:
 * https://github.com/googleapis/js-genai/tree/main/test
 *
 * IMPORTANT: Requires server running
 *
 * To run:
 * 1. Start server: bun run src/local.ts
 * 2. Run tests: TEST_API_BASE_URL=http://localhost:41414 bun test tests/sdk-gemini.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test"
import { GoogleGenAI } from "@google/genai"

const BASE_URL = process.env.TEST_API_BASE_URL || "http://localhost:41414"
const TEST_TIMEOUT = 30_000

// Reusable client factory
function createClient() {
  return new GoogleGenAI({
    apiKey: "test-key",
    httpOptions: {
      baseUrl: BASE_URL,
    },
  })
}

describe("Gemini API - generateContent", () => {
  let client: ReturnType<typeof createClient>

  beforeAll(() => {
    client = createClient()
  })

  test("minimal params", async () => {
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Say hello in one word" }],
        },
      ],
    })

    expect(response.candidates).toBeInstanceOf(Array)
    expect(response.candidates!.length).toBeGreaterThan(0)
    expect(response.candidates![0].content).toBeDefined()
    expect(response.candidates![0].content.parts).toBeInstanceOf(Array)
    expect(response.candidates![0].content.parts[0].text).toBeDefined()
    expect(response.candidates![0].finishReason).toBeDefined()
  }, TEST_TIMEOUT)

  test("with system instruction", async () => {
    // Reference: client_test.ts - system instructions test
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "I say high" }],
        },
      ],
      systemInstruction: {
        parts: [{ text: "I say high you say low" }],
      },
    })

    expect(response.usageMetadata).toBeDefined()
    expect(response.usageMetadata!.promptTokenCount).toBeGreaterThan(0)
    expect(response.usageMetadata!.candidatesTokenCount).toBeGreaterThan(0)
    expect(response.usageMetadata!.totalTokenCount).toBeGreaterThan(0)

    // Should respond with "low" based on system instruction
    const text = response.candidates![0].content.parts[0].text?.toLowerCase()
    expect(text).toContain("low")
  }, TEST_TIMEOUT)

  test("with generation config - maxOutputTokens", async () => {
    // Reference: client_test.ts - token budget tests
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Tell me a one-liner joke" }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 100,
      },
    })

    expect(response.candidates![0].content.parts[0].text).toBeDefined()
    // Ensure output is constrained
    expect(response.usageMetadata!.candidatesTokenCount).toBeLessThanOrEqual(100)
  }, TEST_TIMEOUT)

  test("with temperature and topP", async () => {
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Say hi" }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 50,
      },
    })

    expect(response.candidates![0].content.parts[0].text).toBeDefined()
  }, TEST_TIMEOUT)

  test("multi-turn conversation", async () => {
    // Reference: chats_test.ts - conversation history
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Remember: the password is 'secret42'" }],
        },
        {
          role: "model",
          parts: [{ text: "I'll remember that the password is 'secret42'." }],
        },
        {
          role: "user",
          parts: [{ text: "What was the password I told you?" }],
        },
      ],
    })

    // Model should recall from conversation history
    expect(response.candidates![0].content.parts[0].text).toContain("secret42")
  }, TEST_TIMEOUT)

  test("response includes usage metadata", async () => {
    // Reference: client_test.ts - token counting
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Hello" }],
        },
      ],
    })

    expect(response.usageMetadata).toBeDefined()
    expect(typeof response.usageMetadata!.promptTokenCount).toBe("number")
    expect(typeof response.usageMetadata!.candidatesTokenCount).toBe("number")
    expect(typeof response.usageMetadata!.totalTokenCount).toBe("number")
    expect(response.usageMetadata!.totalTokenCount).toBe(
      response.usageMetadata!.promptTokenCount + response.usageMetadata!.candidatesTokenCount
    )
  }, TEST_TIMEOUT)

  test("response includes model version", async () => {
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Hi" }],
        },
      ],
    })

    expect(response.modelVersion).toBeDefined()
    expect(response.modelVersion).toContain("gemini")
  }, TEST_TIMEOUT)

  test("finish reason STOP on complete response", async () => {
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Say yes" }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 100,
      },
    })

    expect(response.candidates![0].finishReason).toBe("STOP")
  }, TEST_TIMEOUT)
})

describe("Gemini API - generateContentStream", () => {
  let client: ReturnType<typeof createClient>

  beforeAll(() => {
    client = createClient()
  })

  test("streams content chunks", async () => {
    // Reference: client_test.ts - streaming tests
    const stream = await client.models.generateContentStream({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Count to 5" }],
        },
      ],
    })

    let receivedChunks = 0
    let hasCandidate = false
    let accumulatedText = ""

    for await (const chunk of stream) {
      receivedChunks++
      if (chunk.candidates && chunk.candidates.length > 0) {
        hasCandidate = true
        const text = chunk.candidates[0].content?.parts?.[0]?.text
        if (text) {
          accumulatedText += text
        }
      }
    }

    expect(receivedChunks).toBeGreaterThan(0)
    expect(hasCandidate).toBe(true)
    expect(accumulatedText.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  test("streaming with system instruction", async () => {
    // Reference: client_test.ts - streaming with system instructions
    const stream = await client.models.generateContentStream({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "I say high" }],
        },
      ],
      systemInstruction: {
        parts: [{ text: "I say high you say low" }],
      },
    })

    let accumulatedText = ""

    for await (const chunk of stream) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text
      if (text) {
        accumulatedText += text
      }
    }

    expect(accumulatedText.toLowerCase()).toContain("low")
  }, TEST_TIMEOUT)

  test("streaming with generation config", async () => {
    const stream = await client.models.generateContentStream({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Tell me a short story" }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 50,
        temperature: 0.5,
      },
    })

    let chunks = 0
    for await (const _chunk of stream) {
      chunks++
    }

    expect(chunks).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  test("final chunk has finish reason", async () => {
    const stream = await client.models.generateContentStream({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "Say yes" }],
        },
      ],
    })

    let lastFinishReason: string | undefined

    for await (const chunk of stream) {
      if (chunk.candidates?.[0]?.finishReason) {
        lastFinishReason = chunk.candidates[0].finishReason
      }
    }

    expect(lastFinishReason).toBe("STOP")
  }, TEST_TIMEOUT)
})

describe("Gemini API - Function Calling", () => {
  let client: ReturnType<typeof createClient>

  beforeAll(() => {
    client = createClient()
  })

  test("with function declaration", async () => {
    // Reference: client_test.ts - function calling tests
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "What's the weather in Tokyo?" }],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
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
          ],
        },
      ],
    })

    expect(response.candidates).toBeDefined()
    expect(response.candidates!.length).toBeGreaterThan(0)

    // Model should either call the function or respond with text
    const content = response.candidates![0].content
    expect(content.parts).toBeInstanceOf(Array)
  }, TEST_TIMEOUT)

  test("with tool config - AUTO mode", async () => {
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "What is 2 + 2?" }],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "calculate",
              description: "Perform a calculation",
              parameters: {
                type: "object",
                properties: {
                  expression: { type: "string" },
                },
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
    })

    expect(response.candidates![0].content.parts.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  test("function response in conversation", async () => {
    // Simulate a function call response flow
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: "What's the weather in Paris?" }],
        },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "get_weather",
                args: { location: "Paris" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "get_weather",
                response: { temperature: 22, condition: "sunny" },
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Get weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                },
              },
            },
          ],
        },
      ],
    })

    // Model should use the function response to answer
    const text = response.candidates![0].content.parts[0].text
    expect(text).toBeDefined()
    // Should mention the weather data
    expect(text?.toLowerCase()).toMatch(/22|sunny|paris|weather/i)
  }, TEST_TIMEOUT)
})

describe("Gemini API - Simple String Input", () => {
  test("accepts string as contents", async () => {
    const client = createClient()

    // The SDK allows simple string input
    const response = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: "Say hello",
    })

    expect(response.candidates).toBeDefined()
    expect(response.candidates!.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)
})
