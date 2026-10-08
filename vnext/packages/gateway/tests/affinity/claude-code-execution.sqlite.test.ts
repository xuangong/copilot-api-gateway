import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { __resetPlatformForTests, initBackground } from "@vibe-core/platform"
import { initUpstreamRepo } from "@vibe-core/upstream-repo"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { ClaudeCodeProvider, CLAUDE_CODE_OAUTH_TOKEN_URL, readClaudeCodeUpstreamState } from "@vibe-llm/provider-claude-code"
import { affinityTargetMatch, type AffinityExecutionTarget, type LlmModelProvider, type ProviderRequest } from "@vibe-llm/provider-llm"
import type { Fetcher } from "@vibe-core/upstream"
import { ConfigurationCache } from "../../src/repo/configuration-cache.ts"

const cleanup: Array<() => void> = []
afterEach(() => { __resetPlatformForTests(); for (const close of cleanup.splice(0)) close() })
const accountUuid = "00000000-0000-4000-8000-000000000001"
const modelId = "claude-sonnet-4-5-20250929"
const request = (): ProviderRequest => ({ endpoint: "messages", sourceApi: "anthropic", headers: new Headers(), payload: {
  model: "claude-sonnet-4-5", messages: [{ role: "user", content: "fixture" }], max_tokens: 32,
} })
const success = () => new Response('data: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
const oauth = () => Response.json({ access_token: "minted-access", refresh_token: "minted-refresh", expires_in: 3600, scope: "user:inference" })

async function fixture(fetcher: Fetcher, expired = false, tokenKind: "oauth" | "setup-token" = "oauth") {
  const db = new Database(":memory:")
  const repo = new BunSqliteRepo(db)
  cleanup.push(() => db.close())
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: promise => { pending.push(promise) } })
  initUpstreamRepo(() => repo.upstreams)
  await repo.upstreams.save({ id: "claude-fixture", ownerId: "owner", provider: "claude-code", name: "Claude", enabled: true, sortOrder: 0,
    config: { accounts: [{ accountUuid, email: null, organizationUuid: null, subscriptionType: "max", rateLimitTier: null }] },
    state: { accounts: [{ accountUuid, tokenKind, refreshToken: tokenKind === "oauth" ? "initial-refresh" : null, state: "active", stateUpdatedAt: "now",
      accessToken: { token: "initial-access", expiresAt: expired ? 0 : Date.now() + 3_600_000, refreshedAt: "now" }, quotaSnapshot: null, usageProbeSnapshot: null }] },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "now", updatedAt: "now" })
  const row = await repo.upstreams.getById("claude-fixture")
  if (!row) throw new Error("fixture row missing")
  const provider: LlmModelProvider = new ClaudeCodeProvider(row, fetcher)
  const catalog = { object: "list" as const, data: [{ id: "claude-sonnet-4-5", display_name: "Claude", owned_by: "anthropic", kind: "chat" as const,
    providerData: { upstreamModelId: modelId }, limits: { max_context_window_tokens: 1000 }, endpoints: { messages: {} } }] }
  provider.setModelCatalog?.(catalog)
  return { db, repo, row, provider, catalog, pending }
}

function fence(expected: AffinityExecutionTarget) {
  return async (actual: AffinityExecutionTarget) => { if (affinityTargetMatch(expected, actual) !== "exact") throw new Error("target changed") }
}

test("Claude preparation and ordinary dispatch capture the same dated model without catalog or OAuth I/O", async () => {
  const sent: string[] = []
  const f = await fixture(async (url, init) => { sent.push(url); expect(JSON.parse(String(init?.body)).model).toBe(modelId); return success() })
  const target = await f.provider.prepareAffinityExecution?.(request())
  expect(target).toBeDefined()
  if (!target) throw new Error("target missing")
  expect(target.model).toBe(modelId)
  expect(target.credentialSubject).toBe("upstream:claude-fixture")
  expect(sent).toEqual([])
  const response = await f.provider.fetch(request())
  expect(response.affinityExecution).toEqual(target)
  expect(response.execution?.modelKey).toBe(modelId)
  expect(sent).toHaveLength(1)
  await response.body?.cancel()
})

test("Claude preparation never discovers a missing catalog or model", async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; throw new Error("unexpected HTTP") })
  const cold: LlmModelProvider = new ClaudeCodeProvider(f.row, async () => { calls++; throw new Error("unexpected discovery") })
  expect(await cold.prepareAffinityExecution?.(request())).toBeUndefined()
  expect(await f.provider.prepareAffinityExecution?.({ ...request(), payload: { model: "missing" } })).toBeUndefined()
  expect(calls).toBe(0)
})

for (const change of ["credentials", "configuration", "recreation"] as const) {
  test(`Claude rejects ${change} replacement before credential refresh or inference`, async () => {
    let calls = 0
    const f = await fixture(async url => { calls++; return url === CLAUDE_CODE_OAUTH_TOKEN_URL ? oauth() : success() }, true)
    if (change === "credentials") await f.repo.upstreams.replaceCredentials(f.row, { config: f.row.config, state: f.row.state })
    if (change === "configuration") await f.repo.upstreams.patchMetadata(f.row, current => ({ ...current, proxyFallbackList: [{ id: "changed-proxy" }] }))
    if (change === "recreation") { await f.repo.upstreams.delete(f.row.id); await f.repo.upstreams.save({ ...f.row, ownerId: "replacement-owner" }) }
    await expect(f.provider.fetch({ ...request(), beforeInference: async () => {} })).rejects.toThrow()
    expect(await f.provider.prepareAffinityExecution?.(request())).toBeUndefined()
    expect(calls).toBe(0)
  })
}

test("Claude abort before dispatch prevents credential and inference I/O", async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; return success() })
  const controller = new AbortController()
  controller.abort()
  await expect(f.provider.fetch({ ...request(), signal: controller.signal })).rejects.toThrow()
  expect(calls).toBe(0)
})

for (const source of ["request", "discovery"] as const) {
  for (const phase of ["oauth", "catalog"] as const) {
    test(`Claude cold ${source} cancellation during ${phase} prevents publication and subsequent HTTP`, async () => {
      const controller = new AbortController()
      const sent: string[] = []
      const signals: Array<AbortSignal | null | undefined> = []
      const fetcher: Fetcher = async (url, init) => {
        sent.push(url)
        signals.push(init.signal)
        controller.abort()
        return url === CLAUDE_CODE_OAUTH_TOKEN_URL ? oauth() : Response.json({ data: [{
          id: modelId, display_name: "Claude", max_input_tokens: 200000,
        }] })
      }
      const scopedFetcher = source === "discovery" ? Object.assign(fetcher, { signal: controller.signal }) : fetcher
      const f = await fixture(scopedFetcher, phase === "oauth")
      const provider = new ClaudeCodeProvider(f.row, scopedFetcher)
      const result = source === "request"
        ? provider.fetch({ ...request(), signal: controller.signal }) : provider.getModels()
      await expect(result).rejects.toMatchObject({ name: "AbortError" })
      expect(sent).toEqual([phase === "oauth" ? CLAUDE_CODE_OAUTH_TOKEN_URL : "https://api.anthropic.com/v1/models?limit=100"])
      expect(signals).toEqual([controller.signal])
      expect(await provider.prepareAffinityExecution(request())).toBeUndefined()
      const current = await f.repo.upstreams.getById(f.row.id)
      expect(current?.state).toEqual(f.row.state)
    })
  }
}

test("Claude required dispatch fences both OAuth mint and inference against the same prepared target", async () => {
  const phases: string[] = []
  const seen: AffinityExecutionTarget[] = []
  const f = await fixture(async url => {
    expect(phases.at(-1)).toBe("fence")
    phases.push(url === CLAUDE_CODE_OAUTH_TOKEN_URL ? "mint" : "inference")
    return url === CLAUDE_CODE_OAUTH_TOKEN_URL ? oauth() : success()
  }, true)
  const target = await f.provider.prepareAffinityExecution?.(request())
  if (!target) throw new Error("target missing")
  const response = await f.provider.fetch({ ...request(), beforeInference: async actual => {
    await fence(target)(actual)
    seen.push(actual)
    phases.push("fence")
  } })
  expect(response.affinityExecution).toEqual(target)
  expect(seen.length).toBeGreaterThanOrEqual(2)
  expect(phases.filter(phase => phase !== "fence")).toEqual(["mint", "inference"])
  await response.body?.cancel()
})

test("Claude ordinary fresh cached dispatch shares one snapshot and performs zero SQL statements", async () => {
  const f = await fixture(async () => success())
  const cache = new ConfigurationCache(f.repo)
  const view = await cache.pinnedView()
  let reads = 0
  initUpstreamRepo(() => ({
    getById: async id => { reads++; return await view.upstreams.getById(id) },
    saveState: f.repo.upstreams.saveState.bind(f.repo.upstreams),
  }), () => f.repo.upstreams)
  const sql = spyOn(f.db, "query")
  try {
    const response = await f.provider.fetch(request())
    expect(response.status).toBe(200)
    expect(response.affinityExecution).toBeDefined()
    expect(reads).toBe(1)
    expect(sql).toHaveBeenCalledTimes(0)
    await response.body?.cancel()
  } finally { sql.mockRestore() }
})

test("Claude display-name metadata preserves the prepared execution target", async () => {
  const f = await fixture(async () => success())
  const target = await f.provider.prepareAffinityExecution?.(request())
  if (!target) throw new Error("target missing")
  await f.repo.upstreams.patchMetadata(f.row, current => ({ ...current, name: "Changed" }))
  const response = await f.provider.fetch({ ...request(), beforeInference: fence(target) })
  expect(response.affinityExecution).toEqual(target)
  await response.body?.cancel()
})

for (const missing of ["credentialGeneration", "catalogGeneration"] as const) {
  test(`Claude legacy adapter without ${missing} can dispatch but cannot issue affinity`, async () => {
    let calls = 0
    const fetcher: Fetcher = async () => { calls++; return success() }
    const f = await fixture(fetcher)
    const row = { ...f.row, [missing]: undefined }
    initUpstreamRepo(() => ({
      getById: async <T>() => ({ ...row, state: row.state as T }),
      saveState: f.repo.upstreams.saveState.bind(f.repo.upstreams),
    }))
    const provider = new ClaudeCodeProvider(row, fetcher)
    provider.setModelCatalog(f.catalog)
    expect(await provider.prepareAffinityExecution(request())).toBeUndefined()
    const response = await provider.fetch(request())
    expect(response.status).toBe(200)
    expect(response.affinityExecution).toBeUndefined()
    expect(response.execution).toEqual({ modelKey: modelId })
    await response.body?.cancel()
    await expect(provider.fetch({ ...request(), beforeInference: async () => {} })).rejects.toThrow()
    expect(calls).toBe(1)
  })
}

test("Claude missing accepted catalog rejects required execution before discovery or OAuth", async () => {
  let calls = 0
  const fetcher: Fetcher = async () => { calls++; throw new Error("unexpected HTTP") }
  const f = await fixture(fetcher, true)
  const provider = new ClaudeCodeProvider(f.row, fetcher)
  await expect(provider.fetch({ ...request(), beforeInference: async () => {} })).rejects.toThrow()
  expect(calls).toBe(0)
})

for (const operation of ["inference", "catalog"] as const) {
  test(`Claude configuration replacement during OAuth preserves rotated credentials and prevents ${operation} HTTP`, async () => {
    const sent: string[] = []
    let replace = async () => {}
    const fetcher: Fetcher = async url => {
      sent.push(url)
      if (url !== CLAUDE_CODE_OAUTH_TOKEN_URL) throw new Error("unexpected post-mint HTTP")
      await replace()
      return oauth()
    }
    const f = await fixture(fetcher, true)
    replace = async () => { await f.repo.upstreams.patchMetadata(f.row, current => ({ ...current, proxyFallbackList: [{ id: "changed-proxy" }] })) }
    const run = operation === "inference" ? f.provider.fetch(request()) : new ClaudeCodeProvider(f.row, fetcher).getModels()
    await expect(run).rejects.toThrow()
    expect(sent).toEqual([CLAUDE_CODE_OAUTH_TOKEN_URL])
    const row = await f.repo.upstreams.getById(f.row.id)
    expect(readClaudeCodeUpstreamState(row?.state).accounts[0]?.refreshToken).toBe("minted-refresh")
  })
}

test("Claude required fence refusal after refresh prevents inference", async () => {
  let minted = false
  let inference = 0
  const f = await fixture(async url => {
    if (url === CLAUDE_CODE_OAUTH_TOKEN_URL) { minted = true; return oauth() }
    inference++
    return success()
  }, true)
  await expect(f.provider.fetch({ ...request(), beforeInference: async () => {
    if (minted) throw new Error("authorization revoked")
  } })).rejects.toThrow("authorization revoked")
  expect(minted).toBe(true)
  expect(inference).toBe(0)
})

for (const change of ["credentials", "configuration", "recreation"] as const) {
  test(`late Claude 401 after ${change} replacement cancels the old body and never refreshes or retries`, async () => {
    let calls = 0
    let canceled = false
    let replace = async () => {}
    const f = await fixture(async () => {
      calls++
      await replace()
      return new Response(new ReadableStream({ cancel() { canceled = true } }), { status: 401 })
    })
    const replacementState = { accounts: readClaudeCodeUpstreamState(f.row.state).accounts.map(account => ({ ...account,
      accessToken: { token: "replacement-access", expiresAt: Date.now() + 3_600_000, refreshedAt: "replacement" },
    })) }
    replace = async () => {
      if (change === "credentials") await f.repo.upstreams.replaceCredentials(f.row, { config: f.row.config, state: replacementState })
      if (change === "configuration") await f.repo.upstreams.patchMetadata(f.row, current => ({ ...current, proxyFallbackList: [{ id: "changed-proxy" }] }))
      if (change === "recreation") {
        await f.repo.upstreams.delete(f.row.id)
        await f.repo.upstreams.save({ ...f.row, state: replacementState })
      }
    }
    await expect(f.provider.fetch(request())).rejects.toThrow()
    expect(calls).toBe(1)
    expect(canceled).toBe(true)
    if (change !== "configuration") {
      const row = await f.repo.upstreams.getById(f.row.id)
      expect(readClaudeCodeUpstreamState(row?.state).accounts[0]?.accessToken?.token).toBe("replacement-access")
    }
  })
}

test("Claude abort after pending 401 cancels the body and prevents refresh and retry", async () => {
  const controller = new AbortController()
  let calls = 0
  let canceled = false
  const f = await fixture(async () => {
    calls++
    controller.abort()
    return new Response(new ReadableStream({ cancel() { canceled = true } }), { status: 401 })
  })
  await expect(f.provider.fetch({ ...request(), signal: controller.signal })).rejects.toThrow()
  expect(calls).toBe(1)
  expect(canceled).toBe(true)
})

for (const status of [200, 401] as const) {
  test(`Claude setup-token ${status} never enters OAuth refresh`, async () => {
    const sent: string[] = []
    let canceled = false
    const f = await fixture(async url => {
      sent.push(url)
      return status === 200 ? success() : new Response(new ReadableStream({ cancel() { canceled = true } }), { status })
    }, false, "setup-token")
    const target = await f.provider.prepareAffinityExecution?.(request())
    if (!target) throw new Error("target missing")
    const response = await f.provider.fetch({ ...request(), beforeInference: fence(target) })
    expect(response.status).toBe(status === 200 ? 200 : 503)
    expect(sent).toEqual(["https://api.anthropic.com/v1/messages?beta=true"])
    if (status === 200) expect(response.affinityExecution).toEqual(target)
    else {
      expect(canceled).toBe(true)
      expect(response.affinityExecution).toBeUndefined()
    }
    await response.body?.cancel()
  })
}

test("late Claude 401 reuses a sibling bearer, cancels the old body, and preserves prepared request bytes", async () => {
  const sent: Array<{ token: string | null; body: string }> = []
  let refreshed = 0
  let canceled = false
  let rotate = async () => {}
  const f = await fixture(async (url, init) => {
    if (url === CLAUDE_CODE_OAUTH_TOKEN_URL) { refreshed++; return oauth() }
    sent.push({ token: new Headers(init?.headers).get("authorization"), body: String(init?.body) })
    if (sent.length === 1) {
      await rotate()
      return new Response(new ReadableStream({ cancel() { canceled = true } }), { status: 401 })
    }
    expect(canceled).toBe(true)
    return success()
  })
  rotate = async () => f.repo.upstreams.saveState(f.row.id, current => {
    const state = readClaudeCodeUpstreamState(current)
    return { ...state, accounts: state.accounts.map(account => ({ ...account, accessToken: { token: "sibling-access", expiresAt: Date.now() + 3_600_000, refreshedAt: "sibling" } })) }
  })
  const result = await f.provider.fetch(request())
  expect(result.status).toBe(200)
  expect(sent.map(value => value.token)).toEqual(["Bearer initial-access", "Bearer sibling-access"])
  expect(sent[1]?.body).toBe(sent[0]?.body)
  expect(refreshed).toBe(0)
  await result.body?.cancel()
})

test("late Claude quota response cannot attach a prior credential's observation to a replacement", async () => {
  let replace = async () => {}
  const f = await fixture(async () => {
    await replace()
    return new Response(null, { headers: { "anthropic-ratelimit-unified-status": "allowed" } })
  })
  replace = async () => { await f.repo.upstreams.replaceCredentials(f.row, { config: f.row.config, state: f.row.state }) }
  await f.provider.fetch(request())
  await Promise.all(f.pending)
  const current = await f.repo.upstreams.getById(f.row.id)
  expect(readClaudeCodeUpstreamState(current?.state).accounts[0]?.quotaSnapshot).toBeNull()
})
