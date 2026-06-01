import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { CustomProvider } from "~/providers/custom/provider"

const originalFetch = globalThis.fetch

describe("CustomProvider.fetch — FormData body", () => {
  let capturedUrl: string | null = null
  let capturedInit: RequestInit | null = null

  beforeEach(() => {
    capturedUrl = null
    capturedInit = null
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init ?? null
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("does NOT force Content-Type: application/json when body is FormData", async () => {
    const p = new CustomProvider({
      name: "x",
      baseUrl: "https://x",
      apiKey: "k",
      endpoints: ["images_edits"],
    })
    const fd = new FormData()
    fd.append("model", "dall-e-2")
    fd.append("prompt", "hi")
    await p.fetch("images_edits", { method: "POST", body: fd })
    const headers = capturedInit!.headers as Record<string, string>
    expect(headers["Content-Type"]).toBeUndefined()
    // Authorization must still be set.
    expect(headers.Authorization).toBe("Bearer k")
  })

  test("still sets Content-Type: application/json when body is a string", async () => {
    const p = new CustomProvider({
      name: "x",
      baseUrl: "https://x",
      apiKey: "k",
      endpoints: ["chat_completions"],
    })
    await p.fetch("chat_completions", { method: "POST", body: JSON.stringify({ model: "m" }) })
    const headers = capturedInit!.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
  })
})
