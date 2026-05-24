import { test, expect, describe, afterEach, mock } from "bun:test"
import { Elysia } from "elysia"
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
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

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

  test("azure probe accepts 4xx (non-auth) as proof of connectivity", async () => {
    globalThis.fetch = mock(async () => new Response("bad", { status: 400 })) as typeof fetch
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
            deployment: "d",
            apiVersion: "2024-08-01-preview",
            endpoints: ["chat_completions"],
          },
        },
      }),
    )
    const body = await res.json()
    expect(body.ok).toBe(true)
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
