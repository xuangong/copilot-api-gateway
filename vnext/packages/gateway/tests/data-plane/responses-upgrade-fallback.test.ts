import { afterEach, beforeEach, expect, test } from "bun:test"
import { app } from "../../src/app.ts"
import { setupTestPlatform } from "../_setup-platform.ts"

const KEY = "responses-upgrade-key"
const UPGRADE_HEADERS = {
  authorization: `Bearer ${KEY}`,
  connection: "keep-alive, Upgrade",
  upgrade: "websocket",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
}

let platform: ReturnType<typeof setupTestPlatform>

beforeEach(async () => {
  platform = setupTestPlatform()
  await platform.repo.apiKeys.save({
    id: "responses-upgrade-id",
    name: "responses upgrade",
    key: KEY,
    createdAt: "2026-09-29T00:00:00Z",
    modelMappingsEnabled: false,
    modelMappings: [],
  } as never)
})

afterEach(() => {
  platform.db.close()
})

test.each([
  "/v1/responses",
  "/responses",
  "/azure-api.codex/v1/responses",
  "/azure-api.codex/responses",
])("authenticated WebSocket upgrade at %s immediately offers HTTP fallback", async (path) => {
  const response = await app.request(path, { headers: UPGRADE_HEADERS })
  expect(response.status).toBe(426)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(response.headers.get("upgrade")).toBeNull()
  expect(await response.json()).toEqual({
    error: {
      type: "unsupported_transport",
      message: "WebSocket transport is not supported; use HTTP POST /v1/responses.",
    },
  })
})

test("ordinary GET and incomplete upgrade headers keep the Responses 404", async () => {
  expect((await app.request("/v1/responses", { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(404)
  expect((await app.request("/v1/responses", {
    headers: { ...UPGRADE_HEADERS, connection: "keep-alive" },
  })).status).toBe(404)
  expect((await app.request("/v1/responses", {
    headers: { ...UPGRADE_HEADERS, upgrade: "h2c" },
  })).status).toBe(404)
  expect((await app.request("/v1/responses", {
    headers: { ...UPGRADE_HEADERS, "sec-websocket-key": "" },
  })).status).toBe(404)
  expect((await app.request("/v1/responses", {
    headers: { ...UPGRADE_HEADERS, "sec-websocket-version": "12" },
  })).status).toBe(404)
})

test("unrelated and compact WebSocket upgrades keep their existing route behavior", async () => {
  expect((await app.request("/v1/chat/completions", { headers: UPGRADE_HEADERS })).status).toBe(404)
  expect((await app.request("/v1/responses/compact", { headers: UPGRADE_HEADERS })).status).toBe(404)
})

test("missing, invalid, and revoked credentials never receive an upgrade fallback", async () => {
  expect((await app.request("/v1/responses", {
    headers: { ...UPGRADE_HEADERS, authorization: "" },
  })).status).toBe(404)

  const invalid = await app.request("/v1/responses", {
    headers: { ...UPGRADE_HEADERS, authorization: "Bearer invalid" },
  })
  expect(invalid.status).toBe(401)
  expect(await invalid.json()).toEqual({ error: { type: "authentication_error", message: "Invalid API key or session" } })

  await platform.repo.apiKeys.delete("responses-upgrade-id" as never)
  const revoked = await app.request("/v1/responses", { headers: UPGRADE_HEADERS })
  expect(revoked.status).toBe(401)
  expect(await revoked.json()).toEqual({ error: { type: "authentication_error", message: "Invalid API key or session" } })
})

test("POST remains on the existing Responses handler even with upgrade headers", async () => {
  const response = await app.request("/v1/responses", {
    method: "POST",
    headers: { ...UPGRADE_HEADERS, "content-type": "application/json" },
    body: "{}",
  })
  expect(response.status).toBe(400)
})
