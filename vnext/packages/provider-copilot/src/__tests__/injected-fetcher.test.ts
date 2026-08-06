import { test, expect } from "bun:test"
import { CopilotProvider } from "../provider"
import type { Fetcher } from "@vibe-core/upstream"

test("CopilotProvider uses injected fetcher instead of global fetch", async () => {
  const seen: { url: string; method: string; hasAuth: boolean }[] = []

  const mockFetcher: Fetcher = async (url, init) => {
    seen.push({
      url,
      method: (init.method as string) ?? "GET",
      hasAuth: Boolean((init.headers as Record<string, string>)?.Authorization),
    })
    return new Response(
      JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }

  const provider = new CopilotProvider(
    { copilotToken: "tok_test", accountType: "individual" },
    mockFetcher,
  )

  const resp = await provider.fetch({
    endpoint: "messages",
    sourceApi: "anthropic",
    headers: new Headers(),
    payload: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
  })

  expect(resp.status).toBe(200)
  expect(seen.length).toBe(1)
  expect(seen[0]!.url).toContain("/v1/messages")
  expect(seen[0]!.method).toBe("POST")
  expect(seen[0]!.hasAuth).toBe(true)
})
