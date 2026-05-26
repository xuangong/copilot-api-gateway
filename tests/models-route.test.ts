import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Elysia } from "elysia"

import type { AppState } from "~/lib/state"
import { getRepo, setRepoForTest } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { listProviderBindings, invalidateUpstreamListCache } from "~/providers/registry"
import { modelsRoute } from "~/routes/models"

const originalFetch = globalThis.fetch

function model(id: string) {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "test",
  }
}

function app(state: AppState | null = null, userId?: string) {
  return new Elysia()
    .derive(() => ({ state, userId }))
    .use(modelsRoute)
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

describe("models route upstream aggregation", () => {
  test("/api/models lists custom and azure upstream models without Copilot state", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ object: "list", data: [model("deepseek-chat")] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch

    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_custom_deepseek",
      ownerId: "owner-1",
      provider: "custom",
      name: "DeepSeek",
      enabled: true,
      sortOrder: 2,
      config: { name: "deepseek", baseUrl: "https://api.example.com/v1", apiKey: "k" },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })
    await getRepo().upstreams.save({
      id: "up_azure_gpt4o",
      ownerId: "owner-1",
      provider: "azure",
      name: "Azure GPT-4o",
      enabled: true,
      sortOrder: 1,
      config: {
        name: "azure-gpt4o",
        endpoint: "https://x.openai.azure.com",
        apiKey: "k",
        deployment: "gpt-4o-prod",
        apiVersion: "2024-08-01-preview",
        endpoints: ["chat_completions"],
      },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    const res = await app(null, "owner-1").handle(new Request("http://localhost/api/models"))
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data.map((m) => m.id)).toEqual(["gpt-4o-prod", "deepseek-chat"])
  })

  test("/api/models without user scope only lists global upstreams", async () => {
    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_azure_global_only",
      ownerId: undefined,
      provider: "azure",
      name: "Global Azure",
      enabled: true,
      sortOrder: 1,
      config: {
        name: "global-azure",
        endpoint: "https://x.openai.azure.com",
        apiKey: "k",
        deployment: "global-model",
        apiVersion: "2024-08-01-preview",
        endpoints: ["chat_completions"],
      },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })
    await getRepo().upstreams.save({
      id: "up_azure_private",
      ownerId: "owner-1",
      provider: "azure",
      name: "Private Azure",
      enabled: true,
      sortOrder: 2,
      config: {
        name: "private-azure",
        endpoint: "https://x.openai.azure.com",
        apiKey: "k",
        deployment: "private-model",
        apiVersion: "2024-08-01-preview",
        endpoints: ["chat_completions"],
      },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    const res = await app().handle(new Request("http://localhost/api/models"))
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data.map((m) => m.id)).toEqual(["global-model"])
  })

  test("/api/models includes global upstreams for user-scoped requests", async () => {
    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_azure_global",
      ownerId: undefined,
      provider: "azure",
      name: "Global Azure",
      enabled: true,
      sortOrder: 1,
      config: {
        name: "global-azure",
        endpoint: "https://x.openai.azure.com",
        apiKey: "k",
        deployment: "global-gpt-4o",
        apiVersion: "2024-08-01-preview",
        endpoints: ["chat_completions"],
      },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    const res = await app(null, "owner-1").handle(new Request("http://localhost/api/models"))
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data.map((m) => m.id)).toEqual(["global-gpt-4o"])
  })

  test("DB-backed Copilot upstream uses its own GitHub token", async () => {
    const authHeaders: string[] = []
    globalThis.fetch = mock(async (url, init) => {
      const href = String(url)
      const rawHeaders = init?.headers as Record<string, string> | undefined
      const auth = init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : rawHeaders?.Authorization ?? rawHeaders?.authorization
      if (auth) authHeaders.push(auth)
      if (href.includes("/copilot_internal/v2/token")) {
        return Response.json({ token: auth === "token db-gho" ? "db-copilot-token" : "request-copilot-token", expires_at: 9999999999, refresh_in: 1800 })
      }
      if (href.endsWith("/models")) {
        return Response.json({ object: "list", data: [model("copilot-db-model")] })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_copilot_db",
      provider: "copilot",
      name: "DB Copilot",
      enabled: true,
      sortOrder: 1,
      config: { githubToken: "db-gho", accountType: "individual" },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    await listProviderBindings({ copilot: { copilotToken: "request-copilot-token", accountType: "individual" } })
    expect(authHeaders).toContain("token db-gho")
  })

  test("provider bindings include model endpoints and effective flags", async () => {
    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_custom_flags",
      provider: "custom",
      name: "Flagged Custom",
      enabled: true,
      sortOrder: 1,
      config: { name: "flagged", baseUrl: "https://api.example.com/v1", apiKey: "k", endpoints: ["embeddings"] },
      flagOverrides: { "vendor-deepseek": true },
      createdAt: now,
      updatedAt: now,
    })
    globalThis.fetch = mock(async () => Response.json({ object: "list", data: [model("embedder")] })) as typeof fetch

    const bindings = await listProviderBindings()
    expect(bindings).toHaveLength(1)
    expect(bindings[0].upstream).toBe("up_custom_flags")
    expect(bindings[0].upstreamEndpoints).toEqual(["embeddings"])
    expect(bindings[0].enabledFlags.has("vendor-deepseek")).toBe(true)
  })

  test("/api/models constructs Copilot provider from DB-backed upstream", async () => {
    globalThis.fetch = mock(async (url) => {
      const href = String(url)
      if (href.includes("/copilot_internal/v2/token")) {
        return Response.json({ token: "copilot-token", expires_at: 9999999999, refresh_in: 1800 })
      }
      if (href.endsWith("/models")) {
        return Response.json({ object: "list", data: [model("copilot-db-model")] })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_copilot_global_1",
      provider: "copilot",
      name: "Copilot DB",
      enabled: true,
      sortOrder: 1,
      config: { githubToken: "gho_x", accountType: "individual" },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    const res = await app().handle(new Request("http://localhost/api/models"))
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data.map((m) => m.id)).toEqual(["copilot-db-model"])
  })

  test("/api/models isolates broken upstreams", async () => {
    const now = "2026-05-26T00:00:00.000Z"
    await getRepo().upstreams.save({
      id: "up_custom_broken",
      provider: "custom",
      name: "Broken",
      enabled: true,
      sortOrder: 1,
      config: { name: "broken", baseUrl: "https://api.example.com/v1", apiKey: "" },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })
    await getRepo().upstreams.save({
      id: "up_azure_ok",
      provider: "azure",
      name: "Azure OK",
      enabled: true,
      sortOrder: 2,
      config: {
        name: "azure-ok",
        endpoint: "https://x.openai.azure.com",
        apiKey: "k",
        deployment: "gpt-4o-prod",
        apiVersion: "2024-08-01-preview",
        endpoints: ["chat_completions"],
      },
      flagOverrides: {},
      createdAt: now,
      updatedAt: now,
    })

    const res = await app().handle(new Request("http://localhost/api/models"))
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data.map((m) => m.id)).toEqual(["gpt-4o-prod"])
  })
})
