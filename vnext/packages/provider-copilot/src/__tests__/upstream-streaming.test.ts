import { expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import { CopilotProvider } from "../provider"

const JSON_REPLY = '{"id":"upstream-json","vendor_field":"preserved"}'

for (const endpoint of ["chat_completions", "responses", "messages"] as const) {
  for (const stream of [undefined, false, true]) {
    test(`${endpoint} prefers upstream SSE with source stream=${String(stream)} without changing source stream or headers`, async () => {
      const sent: Array<{ payload: Record<string, unknown>; headers: Headers }> = []
      const fetcher: Fetcher = async (_url, init) => {
        sent.push({ payload: JSON.parse(String(init.body)) as Record<string, unknown>, headers: new Headers(init.headers) })
        return new Response(JSON_REPLY, { headers: { "content-type": "application/json", "x-upstream": "kept" } })
      }
      const provider = new CopilotProvider({ copilotToken: "stream-test", accountType: "individual" }, fetcher)
      const payload = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        ...(stream === undefined ? {} : { stream }),
        ...(endpoint === "chat_completions" ? { stream_options: { include_usage: true, vendor_option: "kept" } } : {}),
      }
      const original = structuredClone(payload)
      const request: ProviderRequest = {
        endpoint, payload, headers: new Headers({ "x-source": "preserved", "copilot-integration-id": "" }),
        sourceApi: endpoint === "messages" ? "anthropic" : "openai", flags: { isStreaming: stream === true },
      }

      const response = await provider.fetch(request)

      expect(sent).toHaveLength(1)
      expect(sent[0]?.payload.stream).toBe(true)
      expect(payload.stream).toBe(stream)
      expect(Object.hasOwn(payload, "stream")).toBe(stream !== undefined)
      expect(payload.stream_options).toEqual(original.stream_options)
      expect(request.flags).toEqual({ isStreaming: stream === true })
      expect([...request.headers]).toEqual([["copilot-integration-id", ""], ["x-source", "preserved"]])
      expect(sent[0]?.headers.get("x-source")).toBe("preserved")
      expect(sent[0]?.headers.has("copilot-integration-id")).toBe(false)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/json")
      expect(response.headers.get("x-upstream")).toBe("kept")
      expect(await new Response(response.body).text()).toBe(JSON_REPLY)
    })
  }
}

const excluded: ReadonlyArray<Pick<ProviderRequest, "endpoint" | "action">> = [
  { endpoint: "responses", action: "compact" },
  { endpoint: "messages_count_tokens" },
  { endpoint: "embeddings" },
]

for (const target of excluded) {
  for (const stream of [undefined, false]) {
    test(`${target.endpoint} ${target.action ?? "call"} preserves source stream=${String(stream)}`, async () => {
      const sent: Array<Record<string, unknown>> = []
      const provider = new CopilotProvider({ copilotToken: "stream-test", accountType: "individual" }, async (_url, init) => {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return Response.json({ ok: true })
      })
      const payload = { model: "gpt-4o", input: "hello", messages: [], ...(stream === undefined ? {} : { stream }) }
      await provider.fetch({ ...target, payload, sourceApi: "openai", headers: new Headers() })
      expect(sent).toHaveLength(1)
      expect(sent[0]?.stream).toBe(stream)
      expect(Object.hasOwn(sent[0] ?? {}, "stream")).toBe(stream !== undefined)
    })
  }
}

test("auth retry replays the prepared SSE body with fresh auth without reserializing caller data", async () => {
  const calls: Array<{ body: BodyInit | null | undefined; auth: string | null }> = []
  let serializations = 0
  const metadata = { value: "original", toJSON() { serializations++; return this.value } }
  const provider = new CopilotProvider({
    copilotToken: "stale", accountType: "individual", refreshSession: async () => ({ token: "fresh" }),
  }, async (_url, init) => {
    calls.push({ body: init.body, auth: new Headers(init.headers).get("authorization") })
    if (calls.length === 1) {
      metadata.value = "changed after first send"
      return new Response('{"error":{"message":"unauthorized"}}', { status: 401 })
    }
    return new Response(JSON_REPLY, { headers: { "content-type": "application/json" } })
  })
  const payload = { model: "gpt-4o", messages: [], stream: false, metadata }

  const response = await provider.fetch({ endpoint: "chat_completions", payload, sourceApi: "openai", headers: new Headers() })

  expect(response.status).toBe(200)
  expect(calls).toHaveLength(2)
  expect(calls[0]?.body).toBe('{"model":"gpt-4o","messages":[],"stream":true,"metadata":"original"}')
  expect(calls[1]?.body).toBe(calls[0]?.body)
  expect(calls.map(call => call.auth)).toEqual(["Bearer stale", "Bearer fresh"])
  expect(serializations).toBe(1)
  expect(payload.stream).toBe(false)
})
