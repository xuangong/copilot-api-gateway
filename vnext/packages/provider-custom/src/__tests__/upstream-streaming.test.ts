import { expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import { CustomProvider } from "../provider"

const JSON_REPLY = '{"id":"upstream-json","vendor_field":"preserved"}'

for (const endpoint of ["chat_completions", "responses", "messages"] as const) {
  for (const stream of [undefined, false, true]) {
    test(`${endpoint} prefers upstream SSE with source stream=${String(stream)} without changing the source request`, async () => {
      const sent: Array<{ payload: Record<string, unknown>; headers: Headers }> = []
      const fetcher: Fetcher = async (_url, init) => {
        sent.push({ payload: JSON.parse(String(init.body)) as Record<string, unknown>, headers: new Headers(init.headers) })
        return new Response(JSON_REPLY, { headers: { "content-type": "application/json", "x-upstream": "kept" } })
      }
      const provider = new CustomProvider({ name: "stream-test", baseUrl: "https://custom.test/v1", apiKey: "test" }, fetcher)
      const payload = {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        ...(stream === undefined ? {} : { stream }),
        ...(endpoint === "chat_completions" ? { stream_options: { include_usage: true, vendor_option: "kept" } } : {}),
      }
      const original = structuredClone(payload)
      const request: ProviderRequest = {
        endpoint, payload, headers: new Headers({ "x-source": "preserved" }),
        sourceApi: endpoint === "messages" ? "anthropic" : "openai", flags: { isStreaming: stream === true },
      }

      const response = await provider.fetch(request)

      expect(sent).toHaveLength(1)
      expect(sent[0]?.payload).toEqual({ ...original, stream: true })
      expect(payload).toEqual(original)
      expect(request.flags).toEqual({ isStreaming: stream === true })
      expect([...request.headers]).toEqual([["x-source", "preserved"]])
      expect(sent[0]?.headers.get("x-source")).toBe("preserved")
      // Some compatible servers ignore stream:true. Their JSON still reaches
      // the gateway's existing JSON-to-frames branch with its headers intact.
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
  { endpoint: "images_generations" },
  { endpoint: "alpha_search" },
]

for (const target of excluded) {
  for (const stream of [undefined, false]) {
    test(`${target.endpoint} ${target.action ?? "call"} preserves source stream=${String(stream)}`, async () => {
      const sent: unknown[] = []
      const provider = new CustomProvider({ name: "stream-test", baseUrl: "https://custom.test/v1", apiKey: "test" }, async (_url, init) => {
        sent.push(JSON.parse(String(init.body)))
        return Response.json({ ok: true })
      })
      const payload = { model: "test-model", input: "hello", ...(stream === undefined ? {} : { stream }) }
      await provider.fetch({ ...target, payload, sourceApi: "openai", headers: new Headers() })
      expect(sent).toEqual([payload])
    })
  }
}

test("image edits retain the original multipart body without a stream field", async () => {
  let sent: BodyInit | null | undefined
  const provider = new CustomProvider({ name: "stream-test", baseUrl: "https://custom.test/v1", apiKey: "test" }, async (_url, init) => {
    sent = init.body
    return Response.json({ data: [] })
  })
  const payload = new FormData()
  payload.set("model", "image-model")
  payload.set("image", new Blob(["image bytes"], { type: "image/png" }), "image.png")

  await provider.fetch({ endpoint: "images_edits", payload, sourceApi: "openai", headers: new Headers() })

  expect(sent).toBe(payload)
  expect(payload.has("stream")).toBe(false)
})

test("stream preference does not recreate Chat stream options after upstream normalization", async () => {
  let sent: unknown
  const provider = new CustomProvider({ name: "stream-test", baseUrl: "https://custom.test/v1", apiKey: "test" }, async (_url, init) => {
    sent = JSON.parse(String(init.body))
    return Response.json({ id: "chat" })
  })
  await provider.fetch({ endpoint: "chat_completions", payload: { model: "test-model", messages: [], stream: false }, sourceApi: "openai", headers: new Headers() })
  expect(sent).toEqual({ model: "test-model", messages: [], stream: true })
})
