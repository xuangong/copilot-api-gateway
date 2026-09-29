import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BunSqliteRepo } from "../../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { initUpstreamRepo } from "@vibe-core/upstream-repo"
import { __resetPlatformForTests, initBackground } from "@vibe-core/platform"
import { CodexProvider } from "@vibe-llm/provider-codex"
import { affinityTargetMatch } from "@vibe-llm/provider-llm"
import type { ProviderRequest, AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { Fetcher } from "@vibe-core/upstream"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); __resetPlatformForTests() })
const request = (): ProviderRequest => ({ endpoint: "responses", payload: { model: "fixture-raw", input: [], stream: true }, headers: new Headers(), sourceApi: "openai" })
async function fixture(fetcher: Fetcher, revision: string | undefined = "revision-one", lite = false) {
  const dir = mkdtempSync(join(tmpdir(), "affinity-execution-"))
  const db = new Database(join(dir, "db.sqlite"))
  const repo = new BunSqliteRepo(db)
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  initUpstreamRepo(() => repo.upstreams)
  initBackground({ waitUntil: promise => { void promise.catch(() => {}) } })
  await repo.upstreams.save({ id: "fixture", ownerId: "owner", provider: "codex", name: "fixture", enabled: true, sortOrder: 0,
    config: { accounts: [{ email: null, chatgptAccountId: "account", chatgptUserId: null, planType: null }] },
    state: { accounts: [{ chatgptAccountId: "account", credentialRevision: revision, refresh_token: null, state: "active",
      state_updated_at: "now", openaiDeviceId: "device", accessToken: { token: "fixture-token", expiresAt: Date.now() + 3_600_000, refreshedAt: "now" }, quotaSnapshot: null }] },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "now", updatedAt: "now" })
  const row = (await repo.upstreams.list({ includeDisabled: true }))[0]
  if (!row) throw new Error("fixture missing")
  const provider = new CodexProvider(row, fetcher)
  provider.setModelCatalog({ object: "list", data: [{ id: "fixture-raw", display_name: "Fixture", owned_by: "openai", kind: "chat", providerData: { useResponsesLite: lite }, limits: { max_context_window_tokens: 1000 }, endpoints: { responses: {} } }] })
  return { db, repo, row, provider }
}
const success = () => new Response('data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n', { headers: { "content-type": "text/event-stream" } })
function fence(expected: AffinityExecutionTarget) {
  return async (actual: AffinityExecutionTarget) => { if (affinityTargetMatch(expected, actual) !== "exact") throw new Error("target changed") }
}

test("read-only preparation and normal/Lite dispatch report the exact same raw target", async () => {
  for (const lite of [false, true]) {
    let calls = 0
    let liteHeader: string | null = null
    const { provider } = await fixture(async (_url, init) => {
      calls++
      liteHeader = new Headers(init?.headers).get("x-openai-internal-codex-responses-lite")
      expect(JSON.parse(String(init?.body)).model).toBe("fixture-raw")
      return success()
    }, "revision-one", lite)
    const target = await provider.prepareAffinityExecution(request())
    expect(calls).toBe(0)
    if (!target) throw new Error("target missing")
    expect(target.model).toBe("fixture-raw")
    expect(target.credentialSubject).toBe("account")
    const result = await provider.fetch({ ...request(), beforeInference: fence(target) })
    expect(result.affinityExecution).toEqual(target)
    expect(result.execution?.modelKey).toBe("fixture-raw")
    expect(calls).toBe(1)
    expect(liteHeader).toBe(lite ? "true" : null)
    await result.body?.cancel()
  }
})

test("missing catalog/revision does not discover, refresh, or manufacture a target", async () => {
  let calls = 0
  const { provider, db } = await fixture(async () => { calls++; return success() })
  db.run("UPDATE upstreams SET state_json = json_remove(state_json, '$.accounts[0].credentialRevision')")
  expect(await provider.prepareAffinityExecution(request())).toBeUndefined()
  expect(await provider.prepareAffinityExecution({ ...request(), payload: { model: "missing" } })).toBeUndefined()
  expect(calls).toBe(0)
})

test("configuration and account replacement reject before inference", async () => {
  for (const change of ["config", "revision", "incarnation"] as const) {
    let calls = 0
    const { provider, db, repo, row } = await fixture(async () => { calls++; return success() })
    const target = await provider.prepareAffinityExecution(request())
    if (!target) throw new Error("target missing")
    if (change === "config") {
      db.run("UPDATE upstreams SET config_json = json_set(config_json, '$.accounts[0].planType', 'different')")
      expect(await provider.prepareAffinityExecution(request())).toBeUndefined()
    }
    if (change === "revision") db.run("UPDATE upstreams SET state_json = json_set(state_json, '$.accounts[0].credentialRevision', 'revision-two')")
    if (change === "incarnation") { await repo.upstreams.delete(row.id); await repo.upstreams.save(row) }
    await expect(provider.fetch({ ...request(), beforeInference: fence(target) })).rejects.toThrow()
    expect(calls).toBe(0)
  }
})


test("account replacement during auth recovery is fenced before a retry inference", async () => {
  let calls = 0
  let replace = () => {}
  const { provider, db } = await fixture(async () => {
    calls++
    if (calls === 1) { replace(); return Response.json({ error: { code: "unauthorized" } }, { status: 401 }) }
    return success()
  })
  db.run("UPDATE upstreams SET state_json = json_set(state_json, '$.accounts[0].refresh_token', 'fixture-refresh')")
  const target = await provider.prepareAffinityExecution(request())
  if (!target) throw new Error("target missing")
  replace = () => { db.run("UPDATE upstreams SET state_json = json_set(state_json, '$.accounts[0].credentialRevision', 'replacement', '$.accounts[0].accessToken.token', 'replacement-token')") }
  await expect(provider.fetch({ ...request(), beforeInference: fence(target) })).rejects.toThrow()
  expect(calls).toBe(1)
})


test("ordinary state refresh preserves affinity; explicit replacement advances configuration identity", async () => {
  const { provider, db, repo, row } = await fixture(async () => success())
  const first = await provider.prepareAffinityExecution(request())
  expect(first).toBeDefined()
  db.run("UPDATE upstreams SET state_json = json_set(state_json, '$.accounts[0].accessToken.token', 'rotated-access')")
  expect(await provider.prepareAffinityExecution(request())).toEqual(first)
  const current = (await repo.upstreams.list({ includeDisabled: true }))[0]
  if (!current) throw new Error("fixture missing")
  await repo.upstreams.replaceCredentials(current, { config: current.config, state: current.state })
  expect(await provider.prepareAffinityExecution(request())).toBeUndefined()
  const replacement = (await repo.upstreams.list({ includeDisabled: true }))[0]
  expect(replacement?.rowIncarnation).toBe(row.rowIncarnation)
  expect(replacement?.catalogGeneration).toBeGreaterThan(row.catalogGeneration)
})


test("a changed required target is rejected before expired credentials can refresh", async () => {
  let calls = 0
  const { provider, db } = await fixture(async () => { calls++; return success() })
  const target = await provider.prepareAffinityExecution(request())
  if (!target) throw new Error("target missing")
  db.run("UPDATE upstreams SET state_json = json_set(state_json, '$.accounts[0].credentialRevision', 'replacement', '$.accounts[0].refresh_token', 'fixture-refresh', '$.accounts[0].accessToken.expiresAt', 0)")
  await expect(provider.fetch({ ...request(), beforeInference: fence(target) })).rejects.toThrow("target changed")
  expect(calls).toBe(0)
})


test("cancellation before or inside the early fence prevents hooks or credential I/O", async () => {
  for (const initiallyAborted of [true, false]) {
    let calls = 0
    let hooks = 0
    const { provider, db } = await fixture(async () => { calls++; return success() })
    db.run("UPDATE upstreams SET state_json = json_set(state_json, '$.accounts[0].refresh_token', 'fixture-refresh', '$.accounts[0].accessToken.expiresAt', 0)")
    const controller = new AbortController()
    if (initiallyAborted) controller.abort()
    await expect(provider.fetch({ ...request(), signal: controller.signal, beforeInference: async () => { hooks++; controller.abort() } })).rejects.toThrow()
    expect(calls).toBe(0)
    expect(hooks).toBe(initiallyAborted ? 0 : 1)
  }
})

test("internal OAuth recovery fences the exact replacement before invalid-grant and losing-CAS remints", async () => {
  for (const initialResult of ["invalid-grant", "success"] as const) {
    let oauthA = 0
    let oauthB = 0
    let inference = 0
    let release: (response: Response) => void = () => { throw new Error("barrier not initialized") }
    let started: () => void = () => { throw new Error("barrier not initialized") }
    const arrived = new Promise<void>(resolve => { started = resolve })
    const pending = new Promise<Response>(resolve => { release = resolve })
    const { provider, db, repo } = await fixture(async (url, init) => {
      if (String(url).includes("/oauth/token")) {
        const refresh = new URLSearchParams(String(init?.body)).get("refresh_token")
        if (refresh === "refresh-a") { oauthA++; started(); return pending }
        oauthB++
        return Response.json({ access_token: "access-b", refresh_token: "refresh-b-next", expires_in: 3600, id_token: "fixture" })
      }
      inference++
      return success()
    })
    db.run("UPDATE upstreams SET state_json = json_set(state_json, '$.accounts[0].refresh_token', 'refresh-a', '$.accounts[0].accessToken.expiresAt', 0)")
    const target = await provider.prepareAffinityExecution(request())
    if (!target) throw new Error("target missing")
    // Observe rejection immediately so the deliberate barrier race never leaves
    // an unhandled promise while SQLite replaces the authoritative credential.
    const result = provider.fetch({ ...request(), beforeInference: fence(target) }).then(
      value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }))
    await arrived
    const row = (await repo.upstreams.list({ includeDisabled: true }))[0]
    if (!row) throw new Error("fixture missing")
    const state: unknown = row.state
    if (!state || typeof state !== "object" || !("accounts" in state) || !Array.isArray(state.accounts)) throw new Error("fixture state missing")
    const account: unknown = state.accounts[0]
    if (!account || typeof account !== "object") throw new Error("fixture account missing")
    await repo.upstreams.replaceCredentials(row, { config: row.config, state: { accounts: [{ ...account, credentialRevision: "revision-b", refresh_token: "refresh-b", accessToken: null }] } })
    release(initialResult === "invalid-grant"
      ? Response.json({ error: "invalid_grant", error_description: "fixture revoked" }, { status: 400 })
      : Response.json({ access_token: "access-a", refresh_token: "refresh-a-next", expires_in: 3600, id_token: "fixture" }))
    const outcome = await result
    expect(outcome.ok).toBe(false)
    if (outcome.ok) await outcome.value.body?.cancel()
    else { expect(outcome.error).toBeInstanceOf(Error); expect(outcome.error instanceof Error ? outcome.error.message : "").toBe("target changed") }
    expect(oauthA).toBe(1)
    expect(oauthB).toBe(0)
    expect(inference).toBe(0)
  }
})
