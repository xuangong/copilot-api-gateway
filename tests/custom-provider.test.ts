import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test"
import { CustomProvider } from "~/providers/custom/provider"

describe("CustomProvider constructor", () => {
  test("throws when apiKey is empty", () => {
    expect(() => new CustomProvider({ name: "x", baseUrl: "https://x", apiKey: "" })).toThrow(
      /apiKey/,
    )
  })
  test("throws when baseUrl is empty", () => {
    expect(() => new CustomProvider({ name: "x", baseUrl: "", apiKey: "k" })).toThrow(/baseUrl/)
  })
  test("defaults to chat_completions + embeddings endpoints", () => {
    const p = new CustomProvider({ name: "x", baseUrl: "https://x", apiKey: "k" })
    expect(p.supportedEndpoints).toEqual(["chat_completions", "embeddings"])
    expect(p.kind).toBe("custom")
    expect(p.name).toBe("x")
  })
  test("accepts custom endpoint list", () => {
    const p = new CustomProvider({
      name: "x",
      baseUrl: "https://x",
      apiKey: "k",
      endpoints: ["chat_completions", "responses"],
    })
    expect(p.supportedEndpoints).toEqual(["chat_completions", "responses"])
  })
})

describe("CustomProvider request shape", () => {
  const originalFetch = globalThis.fetch
  let captured: { url: string; init: RequestInit } | null = null

  beforeEach(() => {
    captured = null
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("fetch('chat_completions') sends bearer auth and POST body", async () => {
    const p = new CustomProvider({
      name: "deepseek",
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "sk-123",
    })
    await p.fetch(
      "chat_completions",
      { method: "POST", body: JSON.stringify({ model: "x", messages: [] }) },
    )
    expect(captured).not.toBeNull()
    expect(captured!.url).toBe("https://api.deepseek.com/v1/chat/completions")
    expect(captured!.init.method).toBe("POST")
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer sk-123")
    expect(headers["Content-Type"]).toBe("application/json")
  })

  test("defaultHeaders are merged on every request", async () => {
    const p = new CustomProvider({
      name: "x",
      baseUrl: "https://x",
      apiKey: "k",
      defaultHeaders: { "X-Trace": "abc" },
    })
    await p.callEmbeddings({ input: "hi" })
    const headers = captured!.init.headers as Record<string, string>
    expect(headers["X-Trace"]).toBe("abc")
    expect(headers.Authorization).toBe("Bearer k")
  })
})
