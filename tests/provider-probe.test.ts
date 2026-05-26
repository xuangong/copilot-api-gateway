import { afterEach, describe, expect, test } from "bun:test"

import { CustomProvider } from "../src/providers/custom/provider"
import { CopilotProvider } from "../src/providers/copilot/provider"

const ORIGINAL_FETCH = globalThis.fetch
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH })

describe("provider.probe", () => {
  test("Custom provider success: returns ok + first 50 model ids", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `m-${i}`)
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })), object: "list" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch

    const provider = new CustomProvider({
      name: "test",
      baseUrl: "https://api.test.example/v1",
      apiKey: "sk-test",
    })
    const result = await provider.probe()
    expect(result.ok).toBe(true)
    expect(result.modelCount).toBe(60)
    expect(result.models?.length).toBe(50)
    expect(result.models?.[0]).toBe("m-0")
    expect(result.models?.[49]).toBe("m-49")
  })

  test("Custom provider 401 failure: returns ok=false with error", async () => {
    globalThis.fetch = (async () =>
      new Response("invalid key", { status: 401 })) as unknown as typeof fetch

    const provider = new CustomProvider({
      name: "broken",
      baseUrl: "https://api.test.example/v1",
      apiKey: "sk-wrong",
    })
    const result = await provider.probe()
    expect(result.ok).toBe(false)
    expect(result.error?.length).toBeGreaterThan(0)
    expect(result.error?.length).toBeLessThanOrEqual(1000)
  })

  test("Copilot provider success: hits /models with bearer", async () => {
    let observedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observedHeaders = init?.headers as Record<string, string>
      return new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4.7" }, { id: "gpt-4o-mini" }], object: "list" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const provider = new CopilotProvider({ copilotToken: "tok-abc", accountType: "individual" })
    const result = await provider.probe()
    expect(result.ok).toBe(true)
    expect(result.modelCount).toBe(2)
    expect(result.models).toContain("claude-opus-4.7")
    expect(observedHeaders.authorization ?? observedHeaders.Authorization).toContain("tok-abc")
  })

  test("Copilot provider 500 failure: surfaces upstream status", async () => {
    globalThis.fetch = (async () =>
      new Response("internal error", { status: 500 })) as unknown as typeof fetch

    const provider = new CopilotProvider({ copilotToken: "tok", accountType: "individual" })
    const result = await provider.probe()
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  test("error message capped at 1000 chars", async () => {
    const huge = "x".repeat(5000)
    globalThis.fetch = (async () => {
      throw new Error(huge)
    }) as unknown as typeof fetch

    const provider = new CopilotProvider({ copilotToken: "tok", accountType: "individual" })
    const result = await provider.probe()
    expect(result.ok).toBe(false)
    expect(result.error?.length).toBe(1000)
  })
})
