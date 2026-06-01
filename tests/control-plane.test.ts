import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { Elysia } from "elysia"
import { setRepoForTest } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { invalidateUpstreamListCache } from "~/providers/registry"
import { controlPlaneRoute } from "~/routes/control-plane"

function req(path: string, opts: { admin?: boolean; body?: unknown; method?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (opts.admin) headers["x-admin"] = "1"
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

const app = new Elysia()
  .derive(({ request }) => ({ isAdmin: request.headers.get("x-admin") === "1" }))
  .use(controlPlaneRoute)

const originalFetch = globalThis.fetch

beforeEach(() => {
  setRepoForTest(new SqliteRepo(new Database(":memory:")))
  invalidateUpstreamListCache()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setRepoForTest(null)
  invalidateUpstreamListCache()
})

describe("GET /api/upstream-flags", () => {
  test("403 without admin", async () => {
    const res = await app.handle(req("/api/upstream-flags"))
    expect(res.status).toBe(403)
  })

  test("returns catalog and per-kind defaults for admin", async () => {
    const res = await app.handle(req("/api/upstream-flags", { admin: true }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      catalog: Array<{ id: string; label: string; defaultFor: string[] }>
      defaults: Record<string, string[]>
    }
    expect(Array.isArray(body.catalog)).toBe(true)
    expect(body.catalog.length).toBeGreaterThan(0)
    expect(body.defaults).toHaveProperty("copilot")
    expect(body.defaults).toHaveProperty("custom")
    expect(body.defaults).toHaveProperty("azure")
    expect(body.defaults.copilot).toContain("retry-cyber-policy")
  })
})

describe("POST /api/upstream-probe", () => {
  test("403 without admin", async () => {
    const res = await app.handle(
      req("/api/upstream-probe", { method: "POST", body: { kind: "custom", config: {} } }),
    )
    expect(res.status).toBe(403)
  })

  test("400 on missing kind/config", async () => {
    const res = await app.handle(req("/api/upstream-probe", { admin: true, method: "POST", body: {} }))
    expect(res.status).toBe(400)
  })

  test("custom probe reports ok when upstream models endpoint returns 200", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as typeof fetch
    const res = await app.handle(
      req("/api/upstream-probe", {
        admin: true,
        method: "POST",
        body: {
          kind: "custom",
          config: { name: "x", baseUrl: "https://api.example.com/v1", apiKey: "k" },
        },
      }),
    )
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  test("custom probe reports failure on auth error", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 401 })) as typeof fetch
    const res = await app.handle(
      req("/api/upstream-probe", {
        admin: true,
        method: "POST",
        body: {
          kind: "custom",
          config: { name: "x", baseUrl: "https://api.example.com/v1", apiKey: "k" },
        },
      }),
    )
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain("401")
  })

  test("azure probe lists deployments via management endpoint on success", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch
    const res = await app.handle(
      req("/api/upstream-probe", {
        admin: true,
        method: "POST",
        body: {
          kind: "azure",
          config: {
            name: "az",
            endpoint: "https://x.openai.azure.com",
            apiKey: "k",
            deployment: "gpt-4o",
            apiVersion: "2024-08-01-preview",
            endpoints: ["chat_completions"],
          },
        },
      }),
    )
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.modelCount).toBe(2)
  })

  test("unknown kind returns 400", async () => {
    const res = await app.handle(
      req("/api/upstream-probe", {
        admin: true,
        method: "POST",
        body: { kind: "vertex", config: {} },
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe("/api/upstreams CRUD", () => {
  test("403 without admin", async () => {
    const res = await app.handle(req("/api/upstreams"))
    expect(res.status).toBe(403)
  })

  test("creates, lists, updates, tests, and deletes a custom upstream", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as typeof fetch

    const create = await app.handle(req("/api/upstreams", {
      admin: true,
      method: "POST",
      body: {
        ownerId: "owner-1",
        provider: "custom",
        name: "DeepSeek",
        enabled: true,
        sortOrder: 3,
        config: { name: "deepseek", baseUrl: "https://api.example.com/v1/", apiKey: "k", endpoints: ["chat_completions"] },
        flagOverrides: { "retry-cyber-policy": true },
      },
    }))
    expect(create.status).toBe(201)
    const created = await create.json() as { upstream: { id: string; config: Record<string, unknown> } }
    expect(created.upstream.id).toStartWith("up_custom_deepseek_")
    expect(created.upstream.config.apiKey).toBe("***")

    const list = await app.handle(req("/api/upstreams?ownerId=owner-1&includeDisabled=1", { admin: true }))
    expect(list.status).toBe(200)
    const listed = await list.json() as { upstreams: Array<{ id: string; config: Record<string, unknown> }> }
    expect(listed.upstreams).toHaveLength(1)
    expect(listed.upstreams[0].config.baseUrl).toBe("https://api.example.com/v1")
    expect(listed.upstreams[0].config.apiKey).toBe("***")

    const patch = await app.handle(req(`/api/upstreams/${created.upstream.id}`, {
      admin: true,
      method: "PATCH",
      body: { name: "DeepSeek Backup", enabled: false, sortOrder: 9 },
    }))
    expect(patch.status).toBe(200)
    const patched = await patch.json() as { upstream: { name: string; enabled: boolean; sortOrder: number } }
    expect(patched.upstream).toMatchObject({ name: "DeepSeek Backup", enabled: false, sortOrder: 9 })

    const testRes = await app.handle(req(`/api/upstreams/${created.upstream.id}/test`, { admin: true, method: "POST" }))
    expect(testRes.status).toBe(200)
    expect(await testRes.json()).toMatchObject({ ok: true, modelCount: 0, models: [] })

    const del = await app.handle(req(`/api/upstreams/${created.upstream.id}`, { admin: true, method: "DELETE" }))
    expect(del.status).toBe(200)
    const afterDelete = await app.handle(req("/api/upstreams?ownerId=owner-1&includeDisabled=1", { admin: true }))
    expect((await afterDelete.json() as { upstreams: unknown[] }).upstreams).toHaveLength(0)
  })

  test("rejects provider changes and unknown flag overrides", async () => {
    const create = await app.handle(req("/api/upstreams", {
      admin: true,
      method: "POST",
      body: {
        provider: "custom",
        name: "Custom",
        config: { name: "custom", baseUrl: "https://api.example.com/v1", apiKey: "k" },
      },
    }))
    const created = await create.json() as { upstream: { id: string } }

    const providerChange = await app.handle(req(`/api/upstreams/${created.upstream.id}`, {
      admin: true,
      method: "PATCH",
      body: { provider: "azure" },
    }))
    expect(providerChange.status).toBe(400)

    const badFlag = await app.handle(req(`/api/upstreams/${created.upstream.id}`, {
      admin: true,
      method: "PATCH",
      body: { flagOverrides: { nope: true } },
    }))
    expect(badFlag.status).toBe(400)
  })
})

describe("disabledPublicModelIds normalization", () => {
  test("POST stores disabledPublicModelIds as deduped trimmed array", async () => {
    const res = await app.handle(req("/api/upstreams", {
      admin: true, method: "POST",
      body: {
        provider: "custom",
        name: "deepseek",
        config: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-x" },
        disabledPublicModelIds: [" gpt-3.5-turbo ", "gpt-3.5-turbo", "", "ada-002"],
      },
    }))
    expect(res.status).toBe(201)
    const body = await res.json() as { upstream: { disabledPublicModelIds: string[] } }
    expect(body.upstream.disabledPublicModelIds).toEqual(["gpt-3.5-turbo", "ada-002"])
  })

  test("POST rejects non-array disabledPublicModelIds with 400", async () => {
    const res = await app.handle(req("/api/upstreams", {
      admin: true, method: "POST",
      body: {
        provider: "custom",
        name: "x",
        config: { name: "x", baseUrl: "https://x", apiKey: "k" },
        disabledPublicModelIds: "gpt-3.5-turbo",
      },
    }))
    expect(res.status).toBe(400)
  })

  test("PATCH updates only the disabled set without touching config", async () => {
    const create = await app.handle(req("/api/upstreams", {
      admin: true, method: "POST",
      body: {
        provider: "custom",
        name: "ds2",
        config: { name: "ds2", baseUrl: "https://api.deepseek.com", apiKey: "sk-x" },
      },
    }))
    const { upstream } = await create.json() as { upstream: { id: string } }

    const patch = await app.handle(req(`/api/upstreams/${encodeURIComponent(upstream.id)}`, {
      admin: true, method: "PATCH",
      body: { disabledPublicModelIds: ["gpt-3.5-turbo"] },
    }))
    expect(patch.status).toBe(200)
    const body = await patch.json() as { upstream: { disabledPublicModelIds: string[] } }
    expect(body.upstream.disabledPublicModelIds).toEqual(["gpt-3.5-turbo"])
  })
})
