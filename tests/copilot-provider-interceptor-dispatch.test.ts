import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { CopilotProvider } from "~/providers/copilot/provider"
import { clearRawModelsCache } from "~/services/copilot/raw-models-cache"
import { initImageProcessor } from "~/image"
import type { ImageProcessor, ImageSizeCalculator } from "~/image/types"

type ForwardCall = {
  url: string
  payload: Record<string, unknown>
  extraHeaders: Record<string, string>
}

const originalFetch = globalThis.fetch
const calls: ForwardCall[] = []

const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00,
])

const PNG_B64 = btoa(String.fromCharCode(...PNG_HEADER))

class SpyImageProcessor implements ImageProcessor {
  callCount = 0
  async compressToWebp(input: Uint8Array, _targetSize: ImageSizeCalculator): Promise<Uint8Array> {
    this.callCount++
    return input
  }
}

let spyProcessor: SpyImageProcessor

function installFetchStub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const href = String(url)
    if (href.endsWith("/models")) {
      return Response.json({ object: "list", data: [] })
    }
    const bodyStr = typeof init?.body === "string" ? init.body : ""
    const payload = bodyStr ? JSON.parse(bodyStr) as Record<string, unknown> : {}
    const headerObj: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => { headerObj[k] = v })
    }
    calls.push({ url: href, payload, extraHeaders: headerObj })
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
}

function provider(): CopilotProvider {
  return new CopilotProvider({ copilotToken: "token", accountType: "individual" })
}

beforeEach(() => {
  calls.length = 0
  clearRawModelsCache()
  installFetchStub()
  spyProcessor = new SpyImageProcessor()
  initImageProcessor(spyProcessor)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearRawModelsCache()
})

describe("CopilotProvider dispatch via interceptors", () => {
  test("messages: initiator + claude-agent + compact + vision headers all set in one fetch()", async () => {
    await provider().fetch(
      "messages",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hi" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
              ],
            },
          ],
          max_tokens: 100,
          metadata: { user_id: "user_session_abc123" },
        }),
      },
    )

    const call = calls[0]
    expect(call).toBeDefined()
    expect(call!.extraHeaders["x-initiator"]).toBe("user")
    expect(call!.extraHeaders["copilot-vision-request"]).toBe("true")
    expect(call!.extraHeaders["x-interaction-id"]).toBeDefined()
    expect(call!.extraHeaders["copilot-integration-id"]).toBeDefined()
  })

  test("messages_count_tokens: now runs compressInlineImagesMessages (latent bug fix)", async () => {
    await provider().fetch(
      "messages_count_tokens",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
              ],
            },
          ],
        }),
      },
    )

    expect(spyProcessor.callCount).toBeGreaterThan(0)
  })

  test("responses: vision header + safety_identifier strip on translated calls", async () => {
    await provider().fetch(
      "responses",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_image", image_url: `data:image/png;base64,${PNG_B64}` },
              ],
            },
          ],
          safety_identifier: "hash_xyz",
          store: true,
        }),
      },
      { sourceApi: "messages" },
    )

    const call = calls[0]
    expect(call).toBeDefined()
    expect(call!.payload.safety_identifier).toBeUndefined()
    expect(call!.payload.store).toBe(false)
    expect(call!.extraHeaders["copilot-vision-request"]).toBe("true")
  })

  test("chat_completions: cache-control + vision header applied", async () => {
    await provider().fetch(
      "chat_completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "you are helpful" },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
              ],
            },
          ],
        }),
      },
    )

    const call = calls[0]
    expect(call).toBeDefined()
    expect(call!.extraHeaders["copilot-vision-request"]).toBe("true")
    expect(call!.extraHeaders["x-initiator"]).toBe("user")
  })

  test("embeddings: chain is empty — no initiator, no variant rewrite", async () => {
    await provider().fetch(
      "embeddings",
      {
        method: "POST",
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "hello",
        }),
      },
    )

    const call = calls[0]
    expect(call).toBeDefined()
    expect(call!.extraHeaders["x-initiator"]).toBeUndefined()
    expect(call!.payload.model).toBe("text-embedding-3-small")
  })
})
