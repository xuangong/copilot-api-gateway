import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { keyPausedMiddleware } from "../src/data-plane/protection/key-guard"
import { NOW, enforcementFixture } from "./protection-enforcement-fixture"

let close: () => void = () => {}
afterEach(() => { close(); __resetPlatformForTests() })

async function setup(auth: Record<string, unknown> | undefined) {
  const f = await enforcementFixture(["up_test_first"])
  close = f.close
  const app = new Hono()
  app.use("*", async (c, next) => { if (auth) c.set("auth" as never, auth as never); await next() })
  app.use("*", keyPausedMiddleware)
  let reached = 0
  app.all("*", c => { reached++; return c.text("served") })
  return { f, app, reached: () => reached }
}
const call = (app: Hono, path = "/v1/chat/completions") => app.request(path, { method: "POST" })

test("a request with a paused key gets 503 key_paused with Retry-After and never reaches the handler", async () => {
  const { f, app, reached } = await setup({ apiKeyId: "key_test_1" })
  await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first", endsAt: NOW + 90_000 })
  await f.tick()
  const response = await call(app)
  expect(response.status).toBe(503)
  expect(response.headers.get("retry-after")).toBe("80")
  const body = await response.json() as { error: { type: string; code: string; message: string } }
  expect(body.error).toMatchObject({ type: "api_error", code: "key_paused" })
  expect(body.error.message).toContain(new Date(NOW + 90_000).toISOString())
  expect(reached()).toBe(0)
})

test("another key, or a key that only has a warning, passes", async () => {
  const { f, app } = await setup({ apiKeyId: "key_test_2" })
  await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first" })
  await f.pause({ targetKind: "key", targetId: "key_test_2", upstreamId: "up_test_first", mode: "notify" })
  await f.tick()
  expect((await call(app)).status).toBe(200)
})

test("a dashboard session and an anonymous request pass even while a key is paused", async () => {
  const session = await setup({ userId: "u1", authKind: "session" })
  await session.f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first" })
  await session.f.tick()
  expect((await call(session.app)).status).toBe(200)
})

test("an anonymous request passes", async () => {
  const { app } = await setup(undefined)
  expect((await call(app)).status).toBe(200)
})

test("resuming restores the key at once", async () => {
  const { f, app } = await setup({ apiKeyId: "key_test_1" })
  const row = await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first" })
  await f.tick()
  expect((await call(app)).status).toBe(503)
  await f.runtime.resume(row.id, "owner")
  expect((await call(app)).status).toBe(200)
})

const INFERENCE_PATHS = [
  "/v1/chat/completions", "/chat/completions", "/v1/messages", "/v1/messages/count_tokens", "/anthropic/v1/messages", "/v1/responses", "/v1/responses/compact",
  "/v1/embeddings", "/v1/images/generations", "/v1/alpha/search", "/v1/models", "/v1beta/models/shared:generateContent", "/v1/models/shared:generateContent",
  "/v1/decisions", "/decisions", "/v1/systemone", "/systemone", "/api/chat", "/api/generate", "/api/embed", "/engines/v1/chat/completions",
]
const OTHER_PATHS = ["/api/token-usage", "/api/keys", "/api/protection/status", "/api/upstreams", "/health"]

test("a paused key is refused on every inference path", async () => {
  const { f, app, reached } = await setup({ apiKeyId: "key_test_1" })
  await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first" })
  await f.tick()
  for (const path of INFERENCE_PATHS) {
    const response = await call(app, path)
    const code = ((await response.json()) as { error: { code: string | number } }).error.code
    expect([path, response.status, code]).toEqual([path, 503, /^\/v1(?:beta)?\/models\/./.test(path) ? 503 : "key_paused"]) // Gemini's RPC error has a numeric code
  }
  expect(reached()).toBe(0)
})

test("a paused key still reaches dashboard and control-plane routes", async () => {
  const { f, app, reached } = await setup({ apiKeyId: "key_test_1" })
  await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first" })
  await f.tick()
  for (const path of OTHER_PATHS) expect([path, (await call(app, path)).status]).toEqual([path, 200])
  expect(reached()).toBe(OTHER_PATHS.length)
})

test("in the real app a paused key is refused on inference but can still read its usage", async () => {
  const { app: realApp } = await import("../src/app")
  const f = await enforcementFixture(["up_test_first"])
  close = f.close
  const secret = "fixture-paused-key-value"
  await f.repo.apiKeys.save({ id: "key_test_1", ownerId: "user_test_1", name: "k", key: secret, createdAt: new Date().toISOString(), modelMappingsEnabled: false, modelMappings: [] } as never)
  await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first" })
  await f.tick()
  const headers = { "x-api-key": secret, "content-type": "application/json" }
  const env = { SERVER_SECRET: "fixture-server-secret" }
  const chat = await realApp.request("/v1/chat/completions", { method: "POST", headers, body: "{}" }, env)
  expect(chat.status).toBe(503)
  expect(((await chat.json()) as { error: { code: string } }).error.code).toBe("key_paused")
  const usage = await realApp.request("/api/token-usage?start=2026-09-01T00&end=2026-09-02T00", { headers }, env)
  expect(usage.status).toBe(200)
})

test("the key_paused body follows the protocol of the path, always with Retry-After", async () => {
  const { f, app } = await setup({ apiKeyId: "key_test_1" })
  await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first", endsAt: NOW + 90_000 })
  await f.tick()
  for (const path of ["/v1/messages", "/v1/messages/count_tokens", "/anthropic/v1/messages"]) {
    const response = await call(app, path)
    expect([path, response.status, response.headers.get("retry-after")]).toEqual([path, 503, "80"])
    const body = await response.json() as { type: string; error: { type: string; code: string } }
    expect(body).toMatchObject({ type: "error", error: { type: "api_error", code: "key_paused" } })
  }
  const gemini = await call(app, "/v1beta/models/gemini-2.5-pro:generateContent")
  expect([gemini.status, gemini.headers.get("retry-after")]).toEqual([503, "80"])
  const rpc = await gemini.json() as { error: { code: number; status: string; message: string } }
  expect(rpc.error).toMatchObject({ code: 503, status: "UNAVAILABLE" })
  expect(rpc.error.message).toContain(new Date(NOW + 90_000).toISOString())
  for (const path of ["/v1/responses", "/v1/embeddings"]) {
    const openai = await call(app, path)
    expect(openai.headers.get("retry-after")).toBe("80")
    expect(await openai.json()).toMatchObject({ error: { type: "api_error", code: "key_paused" } })
  }
})
