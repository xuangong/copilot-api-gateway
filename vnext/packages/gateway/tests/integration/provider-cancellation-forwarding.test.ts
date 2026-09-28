import { expect, test } from "bun:test"
import { CustomProvider } from "@vibe-llm/provider-custom"
import { AzureProvider } from "@vibe-llm/provider-azure"
import { SdfProvider } from "@vibe-llm/provider-sdf"
import type { Fetcher } from "@vibe-core/upstream"
import { createServer } from "node:http"

test("Custom forwards caller cancellation to inference fetch", async () => {
  const controller = new AbortController()
  const reason = new Error("client disconnected")
  let observed: AbortSignal | null | undefined
  const fetcher: Fetcher = async (_url, init) => {
    observed = init.signal
    controller.abort(reason)
    throw new DOMException("aborted", "AbortError")
  }
  const provider = new CustomProvider({
    name: "test", baseUrl: "https://example.com", apiKey: "key", endpoints: ["chat_completions"],
  }, fetcher)
  await expect(provider.fetch({ endpoint: "chat_completions", sourceApi: "openai", headers: new Headers(), payload: {}, signal: controller.signal })).rejects.toBe(reason)
  expect(observed?.aborted).toBe(true)
})

test("Azure forwards caller cancellation to inference fetch", async () => {
  const controller = new AbortController()
  const reason = new Error("client disconnected")
  let observed: AbortSignal | null | undefined
  const fetcher: Fetcher = async (_url, init) => {
    observed = init.signal
    controller.abort(reason)
    throw new DOMException("aborted", "AbortError")
  }
  const provider = new AzureProvider({
    name: "test", endpoint: "https://example.openai.azure.com", apiKey: "key",
    deployment: "gpt-4o", apiVersion: "2024-10-21", endpoints: ["chat_completions"],
  }, fetcher)
  await expect(provider.fetch({ endpoint: "chat_completions", sourceApi: "openai", headers: new Headers(), payload: { model: "gpt-4o" }, signal: controller.signal })).rejects.toBe(reason)
  expect(observed?.aborted).toBe(true)
})

test("SDF forwards caller cancellation to inference fetch", async () => {
  const controller = new AbortController()
  const reason = new Error("client disconnected")
  let observed: AbortSignal | null | undefined
  const fetcher: Fetcher = async (_url, init) => {
    observed = init.signal
    controller.abort(reason)
    throw new DOMException("aborted", "AbortError")
  }
  const provider = new SdfProvider({ name: "test", substrateToken: "token", passport: { enabled: false } }, fetcher)
  await expect(provider.fetch({ endpoint: "images_generations", sourceApi: "openai", headers: new Headers(), payload: { model: "gpt-image-2", prompt: "cat" }, signal: controller.signal })).rejects.toBe(reason)
  expect(observed?.aborted).toBe(true)
})

test("Custom caller disconnect closes the real upstream localhost socket", async () => {
  let markClosed: () => void = () => {}
  const closed = new Promise<void>(resolve => { markClosed = resolve })
  const upstream = createServer((request, response) => {
    request.socket.once("close", markClosed)
    response.setHeader("content-type", "text/event-stream")
    response.write("data: first\n\n")
  })
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  try {
    const address = upstream.address()
    if (!address || typeof address === "string") throw new Error("expected TCP address")
    const provider = new CustomProvider({
      name: "local", baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "key", endpoints: ["chat_completions"],
    })
    const controller = new AbortController()
    const result = await provider.fetch({
      endpoint: "chat_completions", sourceApi: "openai", headers: new Headers(),
      payload: { stream: true }, signal: controller.signal, timeout: 1000,
    })
    const reader = result.body?.getReader()
    if (!reader) throw new Error("expected response body")
    await reader.read()
    const pendingRead = reader.read()
    controller.abort(new Error("downstream disconnected"))
    await expect(pendingRead).rejects.toThrow()
    await expect(Promise.race([
      closed,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("upstream socket stayed open")), 1500)),
    ])).resolves.toBeUndefined()
  } finally {
    upstream.closeAllConnections()
    upstream.close()
  }
})
