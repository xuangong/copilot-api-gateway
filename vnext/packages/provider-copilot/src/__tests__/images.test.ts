import { test, expect } from "bun:test"
import { copilotModelEndpoints } from "../endpoints"
import { CopilotProvider } from "../provider"
import type { Model } from "../models"
import type { Fetcher } from "@vibe-core/upstream"

// Catalog entry shape observed on a production Copilot `/models` response
// (2026-11-03): image-only, advertised through `/v1`-prefixed image paths.
const FLARE: Model = {
  id: "gpt-image-2.5-flare",
  name: "GPT Image 2.5 Flare",
  object: "model",
  vendor: "Experimental",
  version: "gpt-image-2.5-flare",
  preview: true,
  model_picker_enabled: false,
  capabilities: {
    family: "gpt-image-2.5-flare",
    limits: { max_prompt_tokens: 32000 },
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "image",
  },
  supported_endpoints: ["/v1/images/generations", "/v1/images/edits"],
}

interface SeenCall { url: string; body: RequestInit["body"]; contentType: string | null }

const recordingFetcher = (seen: SeenCall[]): Fetcher => async (url, init) => {
  seen.push({ url, body: init.body, contentType: new Headers(init.headers).get("content-type") })
  return Response.json({ created: 1, data: [{ b64_json: "aGk=" }] })
}

test("advertised Copilot image paths map to image endpoints only", () => {
  const endpoints = copilotModelEndpoints(FLARE)
  expect(endpoints.images_generations).toBeDefined()
  expect(endpoints.images_edits).toBeDefined()
  expect(endpoints.chat_completions).toBeUndefined()
  expect(endpoints.responses).toBeUndefined()
  expect(endpoints.messages).toBeUndefined()
  expect(endpoints.messages_count_tokens).toBeUndefined()
})

test("CopilotProvider declares image endpoints as supported", () => {
  const provider = new CopilotProvider({ copilotToken: "tok", accountType: "individual" })
  expect(provider.supportedEndpoints).toContain("images_generations")
  expect(provider.supportedEndpoints).toContain("images_edits")
})

test("images_generations posts the JSON body to the advertised Copilot path", async () => {
  const seen: SeenCall[] = []
  const provider = new CopilotProvider({ copilotToken: "tok", accountType: "individual" }, recordingFetcher(seen))
  const response = await provider.fetch({
    endpoint: "images_generations",
    sourceApi: "openai",
    headers: new Headers({ "content-type": "application/json" }),
    payload: { model: "gpt-image-2.5-flare", prompt: "a tree" },
  })

  expect(response.status).toBe(200)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.url).toBe("https://api.githubcopilot.com/v1/images/generations")
  expect(seen[0]!.contentType).toBe("application/json")
  expect(JSON.parse(seen[0]!.body as string)).toEqual({ model: "gpt-image-2.5-flare", prompt: "a tree" })
})

test("images_edits forwards multipart FormData without a JSON content type", async () => {
  const seen: SeenCall[] = []
  const provider = new CopilotProvider({ copilotToken: "tok", accountType: "individual" }, recordingFetcher(seen))
  const form = new FormData()
  form.append("model", "gpt-image-2.5-flare")
  form.append("prompt", "make it blue")
  form.append("image", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "image-0.png")

  const response = await provider.fetch({
    endpoint: "images_edits",
    sourceApi: "openai",
    headers: new Headers(),
    payload: form,
  })

  expect(response.status).toBe(200)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.url).toBe("https://api.githubcopilot.com/v1/images/edits")
  // fetch derives the multipart boundary itself; a JSON content type would
  // make the upstream misparse the body.
  expect(seen[0]!.contentType).toBeNull()
  expect(seen[0]!.body).toBe(form)
})

test("images_edits still requires a model field", async () => {
  const provider = new CopilotProvider({ copilotToken: "tok", accountType: "individual" }, recordingFetcher([]))
  const form = new FormData()
  form.append("prompt", "make it blue")
  await expect(provider.fetch({ endpoint: "images_edits", sourceApi: "openai", headers: new Headers(), payload: form }))
    .rejects.toThrow("Model is required")
})
