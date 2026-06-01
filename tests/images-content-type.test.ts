import { describe, test, expect, beforeEach, mock } from "bun:test"

let captured: { url: string; init: RequestInit } | null = null
mock.module("~/lib/fetch-retry", () => ({
  fetchWithRetry: async (url: string, init: RequestInit) => {
    captured = { url, init }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  },
}))

import { CustomProvider } from "~/providers/custom/provider"

describe("CustomProvider.fetch — FormData body", () => {
  beforeEach(() => { captured = null })

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
    const headers = captured!.init.headers as Record<string, string>
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
    const headers = captured!.init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
  })
})
