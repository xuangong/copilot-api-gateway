import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test"
import { AzureProvider } from "~/providers/azure/provider"

describe("AzureProvider constructor", () => {
  const base = {
    name: "azure-e",
    endpoint: "https://x.openai.azure.com",
    apiKey: "k",
    deployment: "d1",
    apiVersion: "2024-08-01-preview",
    endpoints: ["chat_completions"] as const,
  }

  test("requires apiKey", () => {
    expect(() => new AzureProvider({ ...base, apiKey: "" })).toThrow(/apiKey/)
  })
  test("requires endpoint", () => {
    expect(() => new AzureProvider({ ...base, endpoint: "" })).toThrow(/endpoint/)
  })
  test("requires deployment", () => {
    expect(() => new AzureProvider({ ...base, deployment: "" })).toThrow(/deployment/)
  })
  test("requires apiVersion", () => {
    expect(() => new AzureProvider({ ...base, apiVersion: "" })).toThrow(/apiVersion/)
  })
  test("kind=azure and endpoints copied", () => {
    const p = new AzureProvider(base)
    expect(p.kind).toBe("azure")
    expect(p.supportedEndpoints).toEqual(["chat_completions"])
  })
})

describe("AzureProvider request shape", () => {
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

  test("OpenAI-shape endpoint uses /openai/deployments/<name>/<op>?api-version=", async () => {
    const p = new AzureProvider({
      name: "x",
      endpoint: "https://acc.openai.azure.com/",
      apiKey: "k",
      deployment: "gpt-4o",
      apiVersion: "2024-08-01-preview",
      endpoints: ["chat_completions"],
    })
    await p.callChatCompletions({ messages: [] })
    expect(captured!.url).toBe(
      "https://acc.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview",
    )
    const headers = captured!.init.headers as Record<string, string>
    expect(headers["api-key"]).toBe("k")
    expect(headers.Authorization).toBeUndefined()
  })

  test("Anthropic-shape endpoint uses /anthropic/v1/messages with no api-version", async () => {
    const p = new AzureProvider({
      name: "x",
      endpoint: "https://acc.openai.azure.com",
      apiKey: "k",
      deployment: "claude-sonnet",
      apiVersion: "2024-08-01-preview",
      endpoints: ["messages"],
    })
    await p.callMessages({ messages: [] })
    expect(captured!.url).toBe("https://acc.openai.azure.com/anthropic/v1/messages")
  })

  test("throws when called on unsupported endpoint", async () => {
    const p = new AzureProvider({
      name: "x",
      endpoint: "https://acc.openai.azure.com",
      apiKey: "k",
      deployment: "d",
      apiVersion: "2024-08-01-preview",
      endpoints: ["chat_completions"],
    })
    await expect(p.callMessages({ messages: [] })).rejects.toThrow(/does not serve endpoint/)
  })
})
