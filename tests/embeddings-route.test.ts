import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { getRepo, setRepoForTest } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { invalidateUpstreamListCache } from "~/providers/registry"
import { embeddingsRoute } from "~/routes/embeddings"

const originalFetch = globalThis.fetch

const state: AppState = {
  githubToken: "gho_x",
  copilotToken: "copilot-token",
  copilotTokenExpires: 9999999999,
  accountType: "individual",
  tokenMiss: false,
  enabledFlags: new Set(),
}

function app(userId?: string, routeState: AppState = state) {
  return new Elysia()
    .derive(() => ({ state: routeState, userId, colo: "test" }))
    .use(embeddingsRoute)
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

describe("embeddings upstream routing", () => {
  test("routes embeddings to matching custom upstream", async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (url, init) => {
      const href = String(url)
      calls.push(href)
      if (href.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "embed-custom", object: "model", created: 0, owned_by: "custom" }] })
      }
      if (href.endsWith("/embeddings")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer custom-key" })
        return Response.json({ object: "list", data: [{ object: "embedding", embedding: [0.1], index: 0 }], usage: { prompt_tokens: 1, total_tokens: 1 } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_custom_embed",
      ownerId: "owner-1",
      provider: "custom",
      name: "Custom Embed",
      enabled: true,
      sortOrder: 1,
      config: { name: "custom-embed", baseUrl: "https://api.example.com/v1", apiKey: "custom-key", endpoints: ["embeddings"] },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    const res = await app("owner-1").handle(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embed-custom", input: "hello" }),
    }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ usage: { total_tokens: 1 } })
    expect(calls).toContain("https://api.example.com/v1/models")
    expect(calls.at(-1)).toBe("https://api.example.com/v1/embeddings")
  })

  test("routes custom embeddings without Copilot state", async () => {
    globalThis.fetch = mock(async (url) => {
      const href = String(url)
      if (href.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "embed-custom", object: "model", created: 0, owned_by: "custom" }] })
      }
      if (href.endsWith("/embeddings")) {
        return Response.json({ object: "list", data: [{ object: "embedding", embedding: [0.2], index: 0 }], usage: { total_tokens: 1 } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_custom_embed",
      ownerId: "owner-1",
      provider: "custom",
      name: "Custom Embed",
      enabled: true,
      sortOrder: 1,
      config: { name: "custom-embed", baseUrl: "https://api.example.com/v1", apiKey: "custom-key", endpoints: ["embeddings"] },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    const noCopilotState: AppState = { ...state, githubToken: "", copilotToken: "" }
    const res = await app("owner-1", noCopilotState).handle(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embed-custom", input: "hello" }),
    }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ usage: { total_tokens: 1 } })
  })

  test("does not route unknown embedding models to the first upstream", async () => {
    globalThis.fetch = mock(async (url) => {
      const href = String(url)
      if (href.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "embed-custom", object: "model", created: 0, owned_by: "custom" }] })
      }
      return Response.json({ object: "list", data: [] })
    }) as typeof fetch

    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_custom_embed",
      provider: "custom",
      name: "Custom Embed",
      enabled: true,
      sortOrder: 1,
      config: { name: "custom-embed", baseUrl: "https://api.example.com/v1", apiKey: "custom-key", endpoints: ["embeddings"] },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    const res = await app().handle(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "different-model", input: "hello" }),
    }))

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { message: "No embeddings upstream available for model: different-model. Run GET /v1/models for available ids." } })
  })

  test("returns 404 when no embeddings upstream is available", async () => {
    globalThis.fetch = mock(async () => Response.json({ object: "list", data: [] })) as typeof fetch

    const res = await app().handle(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "missing", input: "hello" }),
    }))

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } })
  })
})
