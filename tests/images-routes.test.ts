import { describe, test, expect, beforeEach, mock } from "bun:test"

let upstreamCall: { endpoint: string; init: RequestInit } | null = null
let upstreamResponse: Response | null = null

mock.module("~/providers/registry", () => ({
  createCopilotProvider: () => ({
    supportedEndpoints: [],
    fetch: async () => { throw new Error("copilot should not be called for images") },
  }),
  listProviderBindings: async (_opts: unknown) => {
    if (!upstreamResponse) return []
    return [
      {
        upstream: "up_test",
        kind: "custom",
        model: { id: "dall-e-3" },
        upstreamEndpoints: ["images_generations", "images_edits"],
        enabledFlags: new Set<string>(),
        provider: {
          name: "test-provider",
          supportedEndpoints: ["images_generations", "images_edits"],
          fetch: async (endpoint: string, init: RequestInit) => {
            upstreamCall = { endpoint, init }
            return upstreamResponse!
          },
        },
      },
    ]
  },
  invalidateUpstreamListCache: () => {},
}))

import { imagesRoute } from "~/routes/images"
import { Elysia } from "elysia"

function app() {
  return new Elysia()
    .derive(() => ({
      state: {
        githubToken: "",
        copilotToken: "",
        copilotTokenExpires: 0,
        accountType: "individual",
        tokenMiss: false,
        enabledFlags: new Set<string>(),
      },
      userId: undefined as string | undefined,
      colo: "test",
    }))
    .use(imagesRoute)
}

describe("/v1/images/generations", () => {
  beforeEach(() => { upstreamCall = null; upstreamResponse = null })

  test("forwards JSON body via provider.fetch('images_generations', ...)", async () => {
    upstreamResponse = new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://x/img.png" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
    const res = await app().handle(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", n: 1 }),
    }))
    expect(res.status).toBe(200)
    expect(upstreamCall?.endpoint).toBe("images_generations")
    expect(upstreamCall?.init.method).toBe("POST")
    expect(typeof upstreamCall?.init.body).toBe("string")
    const json = JSON.parse(upstreamCall!.init.body as string)
    expect(json.model).toBe("dall-e-3")
    expect(json.prompt).toBe("a cat")
  })

  test("returns 404 when no upstream serves images_generations for the model", async () => {
    // upstreamResponse = null → listProviderBindings returns []
    const res = await app().handle(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nonexistent-model", prompt: "hi" }),
    }))
    expect(res.status).toBe(404)
  })

  test("returns 400 when model is missing", async () => {
    const res = await app().handle(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "no model" }),
    }))
    expect(res.status).toBe(400)
  })
})

describe("/v1/images/edits", () => {
  beforeEach(() => { upstreamCall = null; upstreamResponse = null })

  test("forwards multipart FormData via provider.fetch('images_edits', ...)", async () => {
    upstreamResponse = new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://x/edited.png" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
    const fd = new FormData()
    fd.append("model", "dall-e-3")
    fd.append("prompt", "make it red")
    fd.append("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), "image.png")
    const res = await app().handle(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      body: fd,
    }))
    expect(res.status).toBe(200)
    expect(upstreamCall?.endpoint).toBe("images_edits")
    expect(upstreamCall?.init.body).toBeInstanceOf(FormData)
    const fwd = upstreamCall!.init.body as FormData
    expect(fwd.get("model")).toBe("dall-e-3")
    expect(fwd.get("prompt")).toBe("make it red")
    expect(fwd.get("image")).toBeInstanceOf(Blob)
  })

  test("returns 400 when content-type is not multipart", async () => {
    const res = await app().handle(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "x" }),
    }))
    expect(res.status).toBe(400)
  })

  test("returns 400 when model field is missing", async () => {
    upstreamResponse = new Response("{}", { status: 200 })
    const fd = new FormData()
    fd.append("prompt", "no model here")
    const res = await app().handle(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      body: fd,
    }))
    expect(res.status).toBe(400)
  })
})
