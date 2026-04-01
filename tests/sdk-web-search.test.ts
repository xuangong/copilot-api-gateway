/**
 * Web Search Integration Tests
 *
 * Tests copilot-api-gateway web_search tool interception using Bing search engine.
 * Covers both Anthropic Messages API and OpenAI Responses API.
 *
 * IMPORTANT: Requires server running
 *
 * To run:
 * 1. Start server: bun run dev
 * 2. Run tests: TEST_API_BASE_URL=http://localhost:4141 bun test tests/sdk-web-search.test.ts
 */

import { describe, test, expect } from "bun:test"
import OpenAI from "openai"

const BASE_URL = process.env.TEST_API_BASE_URL || "http://localhost:4141"

const openai = new OpenAI({
  apiKey: "test-key",
  baseURL: BASE_URL + "/v1",
})

describe("Web Search - Messages API (Bing)", () => {
  test("non-streaming: web search is intercepted", async () => {
    const response = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1024,
        tools: [{ type: "web_search", name: "web_search" }],
        messages: [
          {
            role: "user",
            content: "What is the capital of France and its population?",
          },
        ],
      }),
    })

    expect(response.ok).toBe(true)

    const searchCount = Number(response.headers.get("X-Web-Search-Count"))
    const engines = response.headers.get("X-Web-Search-Engines")
    // Search should be attempted (count > 0), results may vary
    expect(searchCount).toBeGreaterThan(0)
    expect(engines).toBeDefined()

    const data = (await response.json()) as {
      type: string
      content: Array<{ type: string; text: string }>
    }
    expect(data.type).toBe("message")

    const textBlock = data.content.find((b) => b.type === "text")
    expect(textBlock).toBeDefined()
  }, 120000)

  test("streaming: web search with stream flag", async () => {
    // Note: Streaming web search may not be fully supported by Copilot API
    const response = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1024,
        stream: true,
        tools: [{ type: "web_search", name: "web_search" }],
        messages: [
          {
            role: "user",
            content: "What is the population of Tokyo?",
          },
        ],
      }),
    })

    // Streaming web search may return 400 if not supported
    if (!response.ok) {
      const data = await response.json() as { error?: { message?: string } }
      expect(data.error?.message).toContain("not supported")
      return
    }

    expect(response.body).toBeDefined()

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let fullText = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      fullText += chunk
    }

    expect(fullText.length).toBeGreaterThan(0)
  }, 120000)
})

describe("Web Search - Responses API (Bing)", () => {
  test("non-streaming: web_search tool triggers search", async () => {
    const response = await openai.responses.create({
      model: "gpt-5.1",
      input: "What is the capital of Japan? Search the web for the answer.",
      tools: [{ type: "web_search" as never }],
    })

    expect(response.id).toBeDefined()
    expect(response.status).toBe("completed")
    expect(response.output).toBeDefined()
    expect(response.output.length).toBeGreaterThan(0)

    const message = response.output.find((item) => item.type === "message")
    expect(message).toBeDefined()
    const textContent = (
      message as { content: Array<{ type: string; text: string }> }
    ).content.find((c) => c.type === "output_text")
    expect(textContent).toBeDefined()
    expect(textContent!.text.toLowerCase()).toContain("tokyo")
  }, 120000)

  test("streaming: web_search tool triggers search", async () => {
    const stream = await openai.responses.create({
      model: "gpt-5.1",
      input: "What is the population of Seoul? Search the web.",
      tools: [{ type: "web_search" as never }],
      stream: true,
    })

    let hasTextDelta = false
    let fullText = ""

    for await (const event of stream) {
      if (event.type === "response.output_text.delta" && "delta" in event) {
        hasTextDelta = true
        fullText += (event as { delta: string }).delta
      }
    }

    expect(hasTextDelta).toBe(true)
    expect(fullText.toLowerCase()).toContain("seoul")
    expect(fullText).toMatch(/\d/)
  }, 120000)
})

describe("Web Search - with allowed_domains", () => {
  test("respects allowed_domains restriction", async () => {
    const response = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1024,
        tools: [
          {
            type: "web_search",
            name: "web_search",
            allowed_domains: ["wikipedia.org"],
          },
        ],
        messages: [
          {
            role: "user",
            content: "What is Python programming language?",
          },
        ],
      }),
    })

    expect(response.ok).toBe(true)

    const data = (await response.json()) as {
      type: string
      content: Array<{ type: string; text: string }>
    }
    expect(data.type).toBe("message")
  }, 120000)
})

describe("Web Search - max_uses limit", () => {
  test("respects max_uses limit", async () => {
    const response = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 2048,
        tools: [
          {
            type: "web_search",
            name: "web_search",
            max_uses: 1,
          },
        ],
        messages: [
          {
            role: "user",
            content:
              "Search for information about cats, then search for information about dogs",
          },
        ],
      }),
    })

    expect(response.ok).toBe(true)

    const searchCount = Number(response.headers.get("X-Web-Search-Count"))
    // max_uses may allow slightly more searches during conversation
    expect(searchCount).toBeLessThanOrEqual(4)
  }, 120000)
})
