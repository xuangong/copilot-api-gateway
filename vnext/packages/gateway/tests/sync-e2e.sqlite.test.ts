import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { app } from "../src/app"
import { _clearModelsMemoForTest } from "../src/data-plane/providers/registry"
import { initRepo } from "../src/repo/index"
import type { Repo } from "../src/repo/types"
import type { SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids"
import { runScheduledSync } from "../src/sync/engine"
import { setupTestPlatform } from "./_setup-platform"
import { syntheticCopilotTokenResponse } from "./helpers/catalog-test-repo"
import { realFetch, stubGlobalFetch } from "./_stub-global-fetch"

const stamp = "2026-11-16T00:00:00.000Z"
const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const centralOwner = "central-owner" as UserId
const deviceOwner = "device-owner" as UserId
const centralSession = "ses_central_owner"
const deviceSession = "ses_device_owner"
const lokiState = (token: string) => ({ version: 1, profileId: "loki-df-v1", generation: "g", syncSecretHash: "pairing-hash", revision: 1,
  assistantStatus: "authorized", account, lastReceipt: { requestId: "r", payloadHash: "p" },
  credential: { accessToken: token, tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, account } })
const copilotModel = { id: "gpt-4o", object: "model", name: "gpt-4o", vendor: "openai", version: "gpt-4o", model_picker_enabled: true, preview: false,
  capabilities: { family: "gpt-4o", limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 }, object: "model_capabilities",
    supports: {}, tokenizer: "o200k_base", type: "chat" } }

let central: BunSqliteRepo
let device: Repo
let current: Repo
const traffic = { central: 0, copilot: [] as string[], loki: [] as string[], exchange: [] as string[] }

const use = (repo: Repo) => { current = repo; initRepo(repo) }
async function onCentral<T>(run: () => Promise<T>): Promise<T> {
  const previous = current
  use(central)
  try { return await run() } finally { use(previous) }
}
const call = (host: "central" | "device", path: string, method = "GET", body?: unknown) => {
  use(host === "central" ? central : device)
  return app.request(`https://${host}.example${path}`, { method, headers: { authorization: `Bearer ${host === "central" ? centralSession : deviceSession}`,
    "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const inference = (path: string, body: unknown) => {
  use(device)
  return app.request(`https://device.example${path}`, { method: "POST",
    headers: { authorization: "Bearer device-inference-key", "content-type": "application/json", "X-ConversationId": "e2e-conversation" }, body: JSON.stringify(body) })
}
const deviceUpstreams = async () => ((await (await call("device", "/api/upstreams?includeDisabled=1")).json()) as
  { upstreams: Array<{ id: string; enabled: boolean; syncedFrom?: { origin: string | null } }> }).upstreams

beforeEach(async () => {
  const platform = setupTestPlatform()
  device = platform.repo
  central = new BunSqliteRepo(new Database(":memory:"))
  traffic.central = 0; traffic.copilot = []; traffic.loki = []; traffic.exchange = []
  _clearModelsMemoForTest()
  for (const [repo, id, token, email] of [[central, centralOwner, centralSession, "central@example.com"], [device, deviceOwner, deviceSession, "device@example.com"]] as const) {
    await repo.users.create({ id, name: id, email, createdAt: stamp, disabled: false })
    await repo.sessions.create({ token: token as SessionToken, userId: id, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await device.apiKeys.save({ id: "device-key", name: "inference", key: "device-inference-key", ownerId: deviceOwner,
    modelMappingsEnabled: false, modelMappings: [], createdAt: stamp })
  const base = { ownerId: centralOwner, enabled: true, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "trojan" }], createdAt: stamp, updatedAt: stamp }
  await central.upstreams.save({ ...base, id: "up_copilot_c", provider: "copilot", name: "Central Copilot", sortOrder: 1,
    config: { githubToken: "ghp_central_token", accountType: "individual", user: { id: 1, login: "octo" } }, state: null })
  await central.upstreams.save({ ...base, id: "up_loki_c", provider: "loki", name: "Central Loki", sortOrder: 2,
    config: { profileId: "loki-df-v1" }, state: lokiState("central-loki-token") })
  await central.upstreams.save({ ...base, id: "up_copilot_d", provider: "copilot", name: "Second Copilot", sortOrder: 3,
    config: { githubToken: "ghp_second_token", accountType: "individual", user: { id: 2, login: "octo2" } }, state: null })
  stubGlobalFetch(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.origin === "https://central.example") {
      traffic.central++
      return onCentral(() => app.request(request.url, { method: request.method, headers: request.headers }))
    }
    const bearer = request.headers.get("authorization") ?? ""
    if (url.pathname.endsWith("/copilot_internal/v2/token")) traffic.exchange.push(bearer)
    if (url.pathname.endsWith("/copilot_internal/v2/token")) return syntheticCopilotTokenResponse(request)!
    if (url.origin === "https://api.githubcopilot.com") {
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [copilotModel] })
      traffic.copilot.push(bearer)
      return Response.json({ id: "chatcmpl-1", object: "chat.completion", created: 1, model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "hello from copilot" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    }
    if (url.origin === "https://loki.delve.office.com") {
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"] }] })
      traffic.loki.push(bearer)
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5.5",
        content: [{ type: "text", text: "hello from loki" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    }
    throw new Error(`unexpected egress ${request.url}`)
  })
})
afterEach(() => { globalThis.fetch = realFetch; __resetPlatformForTests() })

test("issue, import, serve with synced credentials, follow central edits and token rotation, then lose everything on revoke", async () => {
  // 1. Central issues a document for the Copilot and Loki upstreams.
  const issued = await call("central", "/api/sync/devices", "POST", { label: "MacBook", upstreamIds: ["up_copilot_c", "up_loki_c"] })
  expect(issued.status).toBe(201)
  const { device: issuedDevice, document } = await issued.json() as { device: { id: string }; document: Record<string, string> }
  expect(document.gatewayOrigin).toBe("https://central.example")

  // 2. The device imports it: one sync, then the source is stored.
  const connected = await call("device", "/api/sync/source", "POST", { document })
  expect(connected.status).toBe(201)
  expect((await connected.json() as { source: { upstreamCount: number } }).source.upstreamCount).toBe(2)
  const rows = await deviceUpstreams()
  expect(rows.map(row => row.id)).toEqual(["up_copilot_c", "up_loki_c"])
  for (const row of rows) expect(row.syncedFrom).toEqual({ origin: "https://central.example" })
  expect(JSON.stringify(await device.upstreams.list({ includeDisabled: true }))).not.toContain("trojan")
  expect(await device.upstreams.getById("up_copilot_c" as UpstreamId)).toMatchObject({ proxyFallbackList: [], ownerId: deviceOwner })
  expect(JSON.stringify(await device.upstreams.getById("up_loki_c" as UpstreamId))).not.toContain("pairing-hash")

  // Fixture: the proxy list is device-local and starts empty, so give the synced rows a direct route (allowed on read-only rows).
  const direct = async (id: string) => expect((await call("device", `/api/upstreams/${id}`, "PATCH", { proxyFallbackList: [{ id: "direct_fetch" }] })).status).toBe(200)
  await direct("up_copilot_c"); await direct("up_loki_c")

  // 3. Inference on the device uses the synced credentials and never calls central; nothing stored is rewritten.
  const writes: string[] = []
  for (const name of ["saveState", "replaceCredentials", "patchMetadata", "save", "createIfAbsent", "delete", "deleteAll"] as const) {
    const original = (device.upstreams[name] as (...args: unknown[]) => Promise<unknown>).bind(device.upstreams)
    ;(device.upstreams as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { writes.push(name); return original(...args) }
  }
  const centralBefore = traffic.central
  const chat = await inference("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] })
  expect(chat.status, await chat.clone().text()).toBe(200)
  expect(await chat.text()).toContain("hello from copilot")
  const message = await inference("/v1/messages", { model: "claude-opus-5.5", max_tokens: 16, messages: [{ role: "user", content: "hello" }] })
  expect(message.status, await message.clone().text()).toBe(200)
  expect(await message.text()).toContain("hello from loki")
  expect(traffic.copilot).toEqual(["Bearer stored-fixture-token"])
  expect(traffic.exchange.length).toBeGreaterThan(0)
  for (const header of traffic.exchange) expect(header).toContain("ghp_central_token")
  expect(traffic.loki).toEqual(["Bearer central-loki-token"])
  expect(traffic.central).toBe(centralBefore)
  expect(writes).toEqual([])

  // 4. Central edits the selection: drop Loki, add the second Copilot. The next sync removes and adds.
  use(device)
  expect(await runScheduledSync()).toBe("not_modified")
  const edited = await call("central", `/api/sync/devices/${issuedDevice.id}`, "PATCH", { upstreamIds: ["up_copilot_c", "up_copilot_d"] })
  expect(edited.status).toBe(200)
  use(device)
  expect(await runScheduledSync()).toBe("applied")
  expect((await deviceUpstreams()).map(row => row.id)).toEqual(["up_copilot_c", "up_copilot_d"])

  // 5. The Loki upstream comes back, device-local fields survive, and a later token rotation reaches the device
  //    without advancing generations.
  await call("device", "/api/upstreams/up_copilot_c", "PATCH", { enabled: false })
  expect((await call("central", `/api/sync/devices/${issuedDevice.id}`, "PATCH", { upstreamIds: ["up_copilot_c", "up_loki_c"] })).status).toBe(200)
  use(device)
  expect(await runScheduledSync()).toBe("applied")
  expect((await deviceUpstreams()).map(row => [row.id, row.enabled])).toEqual([["up_copilot_c", false], ["up_loki_c", true]])
  await direct("up_loki_c") // re-created on the device, so its device-local proxy list is empty again
  const before = (await device.upstreams.getById("up_loki_c" as UpstreamId))!
  await central.upstreams.saveState<unknown>("up_loki_c" as UpstreamId, () => lokiState("rotated-loki-token"))
  use(device)
  expect(await runScheduledSync()).toBe("applied")
  const after = (await device.upstreams.getById("up_loki_c" as UpstreamId))!
  expect([after.catalogGeneration, after.credentialGeneration]).toEqual([before.catalogGeneration, before.credentialGeneration])
  const rotated = await inference("/v1/messages", { model: "claude-opus-5.5", max_tokens: 16, messages: [{ role: "user", content: "hello" }] })
  expect(rotated.status, await rotated.clone().text()).toBe(200)
  expect(traffic.loki.at(-1)).toBe("Bearer rotated-loki-token")

  // 6. Revoking on central removes every synced upstream from the device on its next sync, then polling stops.
  const revoked = await call("central", `/api/sync/devices/${issuedDevice.id}`, "DELETE")
  expect(revoked.status).toBe(200)
  use(device)
  expect(await runScheduledSync()).toBe("revoked")
  expect(await deviceUpstreams()).toEqual([])
  expect(await device.syncSources.get()).toMatchObject({ status: "revoked" })
  const calls = traffic.central
  expect(await runScheduledSync()).toBe("idle")
  expect(traffic.central).toBe(calls)
})
