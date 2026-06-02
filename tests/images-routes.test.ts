import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { getRepo, setRepoForTest } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { invalidateUpstreamListCache } from "~/providers/registry"
import { imagesRoute } from "~/routes/images"

const originalFetch = globalThis.fetch

const state: AppState = {
  githubToken: "",
  copilotToken: "",
  copilotTokenExpires: 0,
  accountType: "individual",
  tokenMiss: false,
  enabledFlags: new Set<string>(),
}

function app(userId?: string, routeState: AppState = state) {
  return new Elysia()
    .derive(() => ({ state: routeState, userId, colo: "test" }))
    .use(imagesRoute)
}

async function seedImagesUpstream() {
  const now = "2026-05-26T00:00:00.000Z"
  await getRepo().upstreams.save({
    id: "up_custom_images",
    ownerId: "owner-1",
    provider: "custom",
    name: "Custom Images",
    enabled: true,
    sortOrder: 1,
    config: {
      name: "custom-images",
      baseUrl: "https://api.example.com/v1",
      apiKey: "img-key",
      endpoints: ["images_generations", "images_edits"],
    },
    flagOverrides: {},
    createdAt: now,
    updatedAt: now,
  })
}

beforeEach(() => {
  setRepoForTest(new SqliteRepo(new Database(":memory:")))
  invalidateUpstreamListCache()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setRepoForTest(null)
  invalidateUpstreamListCache()
})

describe("/v1/images/generations", () => {
  test("forwards JSON body via provider.fetch('images_generations', ...)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (url, init) => {
      const href = String(url)
      calls.push({ url: href, init })
      if (href.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "dall-e-3", object: "model", created: 0, owned_by: "custom" }] })
      }
      if (href.endsWith("/images/generations")) {
        return Response.json({ created: 1, data: [{ url: "https://x/img.png" }] })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    await seedImagesUpstream()

    const res = await app("owner-1").handle(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", n: 1 }),
    }))

    expect(res.status).toBe(200)
    const upstreamCall = calls.find((c) => c.url.endsWith("/images/generations"))
    expect(upstreamCall).toBeDefined()
    expect(upstreamCall!.init?.method).toBe("POST")
    expect(typeof upstreamCall!.init?.body).toBe("string")
    const json = JSON.parse(upstreamCall!.init!.body as string)
    expect(json.model).toBe("dall-e-3")
    expect(json.prompt).toBe("a cat")
  })

  test("returns 404 when no upstream serves images_generations for the model", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ object: "list", data: [] }),
    ) as typeof fetch

    const res = await app("owner-1").handle(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nonexistent-model", prompt: "hi" }),
    }))
    expect(res.status).toBe(404)
  })

  test("returns 400 when model is missing", async () => {
    const res = await app("owner-1").handle(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "no model" }),
    }))
    expect(res.status).toBe(400)
  })
})

describe("/v1/images/edits", () => {
  test("forwards multipart FormData via provider.fetch('images_edits', ...)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (url, init) => {
      const href = String(url)
      calls.push({ url: href, init })
      if (href.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "dall-e-3", object: "model", created: 0, owned_by: "custom" }] })
      }
      if (href.endsWith("/images/edits")) {
        return Response.json({ created: 1, data: [{ url: "https://x/edited.png" }] })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    await seedImagesUpstream()

    const fd = new FormData()
    fd.append("model", "dall-e-3")
    fd.append("prompt", "make it red")
    fd.append("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), "image.png")

    const res = await app("owner-1").handle(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      body: fd,
    }))

    expect(res.status).toBe(200)
    const upstreamCall = calls.find((c) => c.url.endsWith("/images/edits"))
    expect(upstreamCall).toBeDefined()
    expect(upstreamCall!.init?.body).toBeInstanceOf(FormData)
    const fwd = upstreamCall!.init!.body as FormData
    expect(fwd.get("model")).toBe("dall-e-3")
    expect(fwd.get("prompt")).toBe("make it red")
    expect(fwd.get("image")).toBeInstanceOf(Blob)
  })

  test("returns 400 when content-type is not multipart", async () => {
    const res = await app("owner-1").handle(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "x" }),
    }))
    expect(res.status).toBe(400)
  })

  test("returns 400 when model field is missing", async () => {
    const fd = new FormData()
    fd.append("prompt", "no model here")
    const res = await app("owner-1").handle(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      body: fd,
    }))
    expect(res.status).toBe(400)
  })
})
