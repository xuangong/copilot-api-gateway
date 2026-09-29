import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { initUpstreamRepo, getAuthoritativeUpstreamRepo } from "@vibe-core/upstream-repo"
import { __resetPlatformForTests, initBackground } from "@vibe-core/platform"
import {
  CodexProvider, CODEX_OAUTH_TOKEN_URL, CODEX_MODELS_PATH,
  readCodexUpstreamState, type CodexUpstreamState, type Fetcher,
  ensureCodexAccessToken, invalidateCodexAccessToken, putCodexQuota, readCodexCredential,
  persistCodexTerminalState, codexBearerEffect,
} from "@vibe-llm/provider-codex"
import type { UpstreamRecord } from "../src/repo/types.ts"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import { createProviderFromUpstream } from "../src/data-plane/providers/registry.ts"

const cleanup: Array<() => void> = []
afterEach(() => { __resetPlatformForTests(); for (const close of cleanup.splice(0)) close() })
const entry = (token: string) => ({ token, expiresAt: Date.now() + 3_600_000, refreshedAt: "2026-09-29" })
const state = (access: string | null = "access-old"): CodexUpstreamState => ({ accounts: [{
  chatgptAccountId: "account", refresh_token: "refresh-old", state: "active",
  state_updated_at: "2026-09-29", openaiDeviceId: "device", accessToken: access ? entry(access) : null,
  quotaSnapshot: null,
}] })
const record = (value = state()): UpstreamRecord<unknown> => ({
  id: "codex-race", ownerId: "owner", provider: "codex", name: "Codex", enabled: true, sortOrder: 0,
  config: { accounts: [{ chatgptAccountId: "account", email: "fixture@example.test", chatgptUserId: "user", planType: "plus" }] },
  state: value, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
  createdAt: "2026-09-29", updatedAt: "2026-09-29",
})
const request = (endpoint: "responses" | "alpha_search" = "responses", action: "generate" | "compact" = "generate"): ProviderRequest => ({
  endpoint, action, sourceApi: "openai", payload: { model: "model", input: [], query: "fixture" }, headers: new Headers(),
})
const oauth = () => Response.json({ access_token: "access-minted", refresh_token: "refresh-minted", id_token: "fixture", expires_in: 3600 })
const catalog = () => Response.json({ models: [{ slug: "model", display_name: "Model", context_window: 1000 }] })

async function fixture(initial = state()) {
  const directory = mkdtempSync(join(tmpdir(), "codex-effects-"))
  const a = new Database(join(directory, "test.sqlite"))
  const first = new BunSqliteRepo(a)
  const b = new Database(join(directory, "test.sqlite"))
  const second = new BunSqliteRepo(b)
  cleanup.push(() => { a.close(); b.close(); rmSync(directory, { recursive: true, force: true }) })
  await first.upstreams.save(record(initial))
  initUpstreamRepo(() => first.upstreams)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: promise => { pending.push(promise) } })
  return { first, second, a, b, pending,
    read: async () => readCodexUpstreamState((await second.upstreams.getById("codex-race"))?.state).accounts[0],
    replace: async (recreate = false, revision = false) => {
      const replacement = state("access-replacement")
      const account = replacement.accounts[0]
      if (!account) throw new Error("missing fixture account")
      account.refresh_token = "refresh-replacement"
      if (revision) Object.assign(account, { credentialRevision: "replacement-revision" })
      if (recreate) await second.upstreams.delete("codex-race")
      await second.upstreams.save(record(replacement))
    },
  }
}

async function provider(fetcher: Fetcher, initial = state(), warmCatalog = true) {
  const stored = await getAuthoritativeUpstreamRepo().getById("codex-race")
  if (!stored) throw new Error("missing fixture stored row")
  const result = new CodexProvider({ ...stored, state: initial }, fetcher)
  if (warmCatalog) result.setModelCatalog({ object: "list", data: [{ id: "model", display_name: "Model", owned_by: "openai", kind: "chat", limits: { max_context_window_tokens: 1000 }, endpoints: { responses: {} } }] })
  return result
}

test("refresh publishes rotated refresh and access tokens in one visible state commit", async () => {
  const f = await fixture(state(null))
  const observed: Array<[string | undefined, string | null | undefined]> = []
  const save = f.first.upstreams.saveState.bind(f.first.upstreams)
  f.first.upstreams.saveState = async (id, updater, target) => {
    await save(id, updater, target)
    const account = await f.read()
    observed.push([account?.refresh_token, account?.accessToken?.token])
  }
  const p = await provider(async url => url === CODEX_OAUTH_TOKEN_URL ? oauth() : Response.json({ output: [] }), state(null))
  expect((await p.fetch(request())).status).toBe(200)
  await Promise.all(f.pending)
  expect(observed.length).toBeGreaterThan(0)
  expect(observed.every(([refresh, access]) => refresh === "refresh-minted" && access === "access-minted")).toBe(true)
})

for (const source of ["generation", "catalog"] as const) {
  test(`${source} late mint returns the authoritative replacement without overwriting it`, async () => {
    const f = await fixture(state(null))
    const sent: string[] = []
    const fetcher: Fetcher = async (url, init) => {
      if (url === CODEX_OAUTH_TOKEN_URL) { await f.replace(); return oauth() }
      sent.push(new Headers(init?.headers).get("authorization") ?? "")
      return url.includes(CODEX_MODELS_PATH) ? catalog() : Response.json({ output: [] })
    }
    const p = await provider(fetcher, state(null), source !== "catalog")
    if (source === "catalog") await p.getModels()
    else expect((await p.fetch(request())).status).toBe(200)
    await Promise.all(f.pending)
    expect(sent).toEqual(["Bearer access-replacement"])
    expect((await f.read())?.refresh_token).toBe("refresh-replacement")
    expect((await f.read())?.accessToken?.token).toBe("access-replacement")
  })
}

test("late 401 uses an authoritative sibling bearer without clearing it or refreshing old credentials", async () => {
  const f = await fixture()
  const sent: string[] = []
  let refreshCalls = 0
  const p = await provider(async (url, init) => {
    if (url === CODEX_OAUTH_TOKEN_URL) { refreshCalls++; return oauth() }
    sent.push(new Headers(init?.headers).get("authorization") ?? "")
    if (sent.length === 1) { await f.replace(); return Response.json({ error: { code: "expired_token" } }, { status: 401 }) }
    return Response.json({ output: [] })
  })
  expect((await p.fetch(request())).status).toBe(200)
  await Promise.all(f.pending)
  expect(sent).toEqual(["Bearer access-old", "Bearer access-replacement"])
  expect(refreshCalls).toBe(0)
  expect((await f.read())?.accessToken?.token).toBe("access-replacement")
})

for (const recreate of [false, true]) {
  for (const status of [200, 429, 401]) {
    test(`late ${status} effect preserves ${recreate ? "recreated row" : "reimported revision"}`, async () => {
      const f = await fixture()
      const p = await provider(async () => {
        await f.replace(recreate, !recreate)
        return Response.json({ error: { code: "token_invalidated", message: "old failure" } }, {
          status, headers: { "x-codex-primary-used-percent": "99", "x-codex-primary-reset-after-seconds": "300" },
        })
      })
      await p.fetch(request())
      await Promise.all(f.pending)
      const current = await f.read()
      expect(current?.refresh_token).toBe("refresh-replacement")
      expect(current?.accessToken?.token).toBe("access-replacement")
      expect(current?.state).toBe("active")
      expect(current?.quotaSnapshot).toBeNull()
    })
  }
  for (const error of ["invalid_grant", "app_session_terminated", "invalid_refresh_token", "invalid_client", "unauthorized_client", "access_denied"]) {
    for (const source of ["generation", "catalog"] as const) test(`${source} late ${error} preserves ${recreate ? "recreated row" : "reimported revision"}`, async () => {
      const f = await fixture(state(null))
      const fetcher: Fetcher = async url => {
        if (url === CODEX_OAUTH_TOKEN_URL) {
          await f.replace(recreate, !recreate)
          return Response.json({ error }, { status: 400 })
        }
        return url.includes(CODEX_MODELS_PATH) ? catalog() : Response.json({ output: [] })
      }
      const p = await provider(fetcher, state(null), source !== "catalog")
      const pending = source === "catalog" ? p.getModels() : p.fetch(request())
      if (recreate) await expect(pending).rejects.toMatchObject({ name: "UpstreamReplacedError" })
      else await pending
      await Promise.all(f.pending)
      const current = await f.read()
      expect(current?.refresh_token).toBe("refresh-replacement")
      expect(current?.accessToken?.token).toBe("access-replacement")
      expect(current?.state).toBe("active")
    })
  }
}

for (const block of ["health", "quota"] as const) {
  test(`preflight uses authoritative replacement rather than stale ${block} gate`, async () => {
    const initial = state()
    const account = initial.accounts[0]
    if (!account) throw new Error("missing fixture account")
    if (block === "health") account.state = "refresh_failed"
    else account.quotaSnapshot = { unknown: { fetchedAt: Date.now(), data: { observed_at: "2026-09-29", ratelimited_until: new Date(Date.now() + 300_000).toISOString() } } }
    const f = await fixture(initial)
    const cached = await f.first.upstreams.getById("codex-race")
    initUpstreamRepo(() => ({
      getById: async <T>() => cached ? { ...cached, state: cached.state as T } : null,
      saveState: f.first.upstreams.saveState.bind(f.first.upstreams),
    }), () => f.first.upstreams)
    await f.replace()
    const p = await provider(async () => Response.json({ output: [] }), initial)
    expect((await p.fetch(request())).status).toBe(200)
    await Promise.all(f.pending)
  })
}

const unusedMint = async (): Promise<never> => { throw new Error("unexpected OAuth mint") }
const mintResult = (suffix: string) => ({ accessToken: entry(`access-${suffix}`), refreshToken: `refresh-${suffix}` })

test("same token bytes with a new revision reject stale invalidation, terminal and quota effects", async () => {
  const f = await fixture()
  const old = await ensureCodexAccessToken("codex-race", "account", unusedMint)
  const replacement = state()
  const account = replacement.accounts[0]
  if (!account) throw new Error("missing fixture account")
  account.credentialRevision = "new-revision"
  await f.second.upstreams.save(record(replacement))
  await invalidateCodexAccessToken(old)
  await persistCodexTerminalState(codexBearerEffect(old), "session_terminated", "stale")
  await persistCodexTerminalState({ credential: old.credential, tokenKind: "refresh", token: "refresh-old" }, "refresh_failed", "stale")
  await putCodexQuota(old, { observed_at: "old", primary_used_percent: 99 })
  expect(await f.read()).toEqual(account)
})

test("same timestamp and exact state recreation fences every old bearer effect", async () => {
  const initial = state()
  const f = await fixture(initial)
  const old = await ensureCodexAccessToken("codex-race", "account", unusedMint)
  await f.second.upstreams.delete("codex-race")
  await f.second.upstreams.save(record(initial))
  const recreated = await f.second.upstreams.getById("codex-race")
  expect(recreated?.rowIncarnation).not.toBe(old.credential.rowIncarnation)
  expect(recreated?.createdAt).toBe("2026-09-29")
  await invalidateCodexAccessToken(old)
  await persistCodexTerminalState(codexBearerEffect(old), "session_terminated", "stale")
  await putCodexQuota(old, { observed_at: "old", primary_used_percent: 99 })
  expect(await f.read()).toEqual(initial.accounts[0])
})

for (const change of ["owner_id", "provider"] as const) {
  test(`same physical row with changed ${change} fences delayed effects`, async () => {
    const f = await fixture()
    const old = await ensureCodexAccessToken("codex-race", "account", unusedMint)
    f.b.query(`UPDATE upstreams SET ${change} = ? WHERE id = ?`).run("replacement", "codex-race")
    await invalidateCodexAccessToken(old)
    await persistCodexTerminalState(codexBearerEffect(old), "session_terminated", "stale")
    await putCodexQuota(old, { observed_at: "old" })
    expect((await f.read())?.accessToken?.token).toBe("access-old")
    expect((await f.read())?.state).toBe("active")
    expect((await f.read())?.quotaSnapshot).toBeNull()
    await expect(readCodexCredential("codex-race", "account", old.credential)).rejects.toMatchObject({ name: "UpstreamReplacedError" })
  })
}

test("rotation CAS replays over a quota write from the second connection", async () => {
  const f = await fixture(state(null))
  const save = f.first.upstreams.saveState.bind(f.first.upstreams)
  let calls = 0
  f.first.upstreams.saveState = (id, updater, target) => save(id, current => {
    if (++calls === 1) {
      const concurrent = state(null)
      const account = concurrent.accounts[0]
      if (!account) throw new Error("missing fixture account")
      account.quotaSnapshot = { unknown: { fetchedAt: 100, data: { observed_at: "sibling", primary_used_percent: 20 } } }
      f.b.query("UPDATE upstreams SET state_json = ? WHERE id = ?").run(JSON.stringify(concurrent), id)
    }
    return updater(current)
  }, target)
  const result = await ensureCodexAccessToken("codex-race", "account", async () => mintResult("rotated"))
  expect(result.token).toBe("access-rotated")
  expect(calls).toBe(2)
  expect((await f.read())?.refresh_token).toBe("refresh-rotated")
  expect((await f.read())?.quotaSnapshot?.unknown?.data.primary_used_percent).toBe(20)
})

test("two independent mints only return the atomically committed winner", async () => {
  const f = await fixture(state(null))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const loser = ensureCodexAccessToken("codex-race", "account", async () => {
    entered.resolve()
    await release.promise
    return mintResult("loser")
  }, true)
  await entered.promise
  const winner = await ensureCodexAccessToken("codex-race", "account", async () => mintResult("winner"))
  release.resolve()
  expect(winner.token).toBe("access-winner")
  expect((await loser).token).toBe("access-winner")
  expect((await f.read())?.accessToken?.token).toBe("access-winner")
  expect((await f.read())?.refresh_token).toBe("refresh-winner")
})

test("a new revision does not join an older in-flight mint with identical token bytes", async () => {
  const f = await fixture(state(null))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const older = ensureCodexAccessToken("codex-race", "account", async () => {
    entered.resolve()
    await release.promise
    return mintResult("old")
  })
  await entered.promise
  const replacement = state(null)
  const account = replacement.accounts[0]
  if (!account) throw new Error("missing fixture account")
  account.credentialRevision = "new-revision"
  await f.second.upstreams.save(record(replacement))
  const current = await ensureCodexAccessToken("codex-race", "account", async () => mintResult("new"))
  release.resolve()
  expect(current.token).toBe("access-new")
  expect(current.credential.credentialRevision).toBe("new-revision")
  expect((await older).token).toBe("access-new")
})

test("same-state recreation during successful mint rejects the captured row target", async () => {
  const initial = state(null)
  const f = await fixture(initial)
  await expect(ensureCodexAccessToken("codex-race", "account", async () => {
    await f.second.upstreams.delete("codex-race")
    await f.second.upstreams.save(record(initial))
    return mintResult("old")
  })).rejects.toMatchObject({ name: "UpstreamReplacedError" })
  expect(await f.read()).toEqual(initial.accounts[0])
})

test("a contended credential commit never returns the uncommitted minted bearer", async () => {
  const f = await fixture(state(null))
  const save = f.first.upstreams.saveState.bind(f.first.upstreams)
  let calls = 0
  f.first.upstreams.saveState = (id, updater, target) => save(id, current => {
    const concurrent = state(null)
    const account = concurrent.accounts[0]
    if (!account) throw new Error("missing fixture account")
    account.quotaSnapshot = { unknown: { fetchedAt: ++calls, data: { observed_at: "sibling" } } }
    f.b.query("UPDATE upstreams SET state_json = ? WHERE id = ?").run(JSON.stringify(concurrent), id)
    return updater(current)
  }, target)
  await expect(ensureCodexAccessToken("codex-race", "account", async () => mintResult("old"))).rejects.toMatchObject({ name: "UpstreamContentionError" })
  expect(calls).toBe(8)
  expect((await f.read())?.accessToken).toBeNull()
  expect((await f.read())?.refresh_token).toBe("refresh-old")
})

test("ownerless rows retain the same guarded rotation and observation behavior", async () => {
  const f = await fixture(state(null))
  await f.second.upstreams.save({ ...record(state(null)), ownerId: undefined })
  const lease = await ensureCodexAccessToken("codex-race", "account", async () => mintResult("global"))
  expect(lease.credential.ownerId).toBeUndefined()
  await putCodexQuota(lease, { observed_at: "current", primary_used_percent: 10 })
  expect((await f.read())?.quotaSnapshot?.unknown?.data.primary_used_percent).toBe(10)
  await invalidateCodexAccessToken(lease)
  expect((await f.read())?.accessToken).toBeNull()
  expect((await f.read())?.refresh_token).toBe("refresh-global")
})

test("a losing mint with no usable authoritative bearer fails without publishing its result", async () => {
  const f = await fixture(state(null))
  await expect(ensureCodexAccessToken("codex-race", "account", async () => {
    const replacement = state(null)
    const account = replacement.accounts[0]
    if (!account) throw new Error("missing fixture account")
    account.credentialRevision = "replacement"
    account.refresh_token = "replacement-refresh"
    await f.second.upstreams.save(record(replacement))
    return mintResult("old")
  })).rejects.toMatchObject({ name: "CodexCredentialUnavailableError" })
  expect((await f.read())?.accessToken).toBeNull()
  expect((await f.read())?.refresh_token).toBe("replacement-refresh")
})

test("inactive credentials never mint or return a cached bearer", async () => {
  const initial = state()
  const account = initial.accounts[0]
  if (!account) throw new Error("missing fixture account")
  account.state = "session_terminated"
  const f = await fixture(initial)
  await expect(ensureCodexAccessToken("codex-race", "account", unusedMint)).rejects.toMatchObject({ name: "CodexCredentialUnavailableError" })
  expect(await f.read()).toEqual(initial.accounts[0])
})

for (const [endpoint, action] of [["responses", "generate"], ["responses", "compact"], ["alpha_search", "generate"]] as const) {
  test(`${endpoint}/${action} 401 refreshes the current token and retains prepared body and identity`, async () => {
    const f = await fixture()
    const sent: Array<{ body: string; headers: Headers }> = []
    const refreshed: string[] = []
    const p = await provider(async (url, init) => {
      if (url === CODEX_OAUTH_TOKEN_URL) {
        refreshed.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "")
        return oauth()
      }
      sent.push({ body: String(init?.body), headers: new Headers(init?.headers) })
      if (sent.length === 1) {
        const replacement = state(null)
        const account = replacement.accounts[0]
        if (!account) throw new Error("missing fixture account")
        account.credentialRevision = "new-revision"
        account.refresh_token = "refresh-current"
        await f.second.upstreams.save(record(replacement))
        return Response.json({ error: { code: "expired_token" } }, { status: 401 })
      }
      return Response.json({ output: [] })
    })
    expect((await p.fetch(request(endpoint, action))).status).toBe(200)
    await Promise.all(f.pending)
    expect(refreshed).toEqual(["refresh-current"])
    expect(sent).toHaveLength(2)
    expect(sent[1]?.body).toBe(sent[0]?.body)
    for (const header of ["session-id", "thread-id", "x-client-request-id", "x-codex-window-id", "x-codex-turn-metadata"]) {
      expect(sent[1]?.headers.get(header)).toBe(sent[0]?.headers.get(header))
    }
    expect(sent[1]?.headers.get("authorization")).toBe("Bearer access-minted")
    expect((await f.read())?.credentialRevision).toBe("new-revision")
  })
}

for (const replacement of ["owner", "recreate", "provider"] as const) {
  for (const source of ["catalog", "generation", "compact", "alpha_search"] as const) {
    test(`production plugin fences ${replacement} replacement before first ${source} credential capture`, async () => {
      const f = await fixture()
      const authorized = await f.first.upstreams.getById("codex-race")
      if (!authorized) throw new Error("missing fixture stored row")
      const sent: string[] = []
      const p = await createProviderFromUpstream(authorized, undefined, () => async (url, init) => {
        sent.push(new Headers(init?.headers).get("authorization") ?? "")
        return url.includes(CODEX_MODELS_PATH) ? catalog() : Response.json({ output: [] })
      })
      if (!p) throw new Error("missing fixture provider")
      if (source !== "catalog") p.setModelCatalog?.({ object: "list", data: [{ id: "model", display_name: "Model", owned_by: "openai", kind: "chat", limits: { max_context_window_tokens: 1000 }, endpoints: { responses: {} } }] })
      const next = { ...record(state("access-new-owner")), ownerId: "other-owner" }
      if (replacement === "recreate") await f.second.upstreams.delete("codex-race")
      if (replacement === "provider") await f.second.upstreams.save({ ...next, ownerId: "owner", provider: "claude-code" })
      else await f.second.upstreams.save(next)
      const pending = source === "catalog" ? p.getModels() : p.fetch(request(source === "alpha_search" ? "alpha_search" : "responses", source === "compact" ? "compact" : "generate"))
      await expect(pending).rejects.toMatchObject({ name: "UpstreamReplacedError" })
      expect(sent).toEqual([])
      await Promise.all(f.pending)
      expect((await f.read())?.accessToken?.token).toBe("access-new-owner")
    })
  }
}

test("production plugin requires the authorized stored incarnation rather than capturing the current row later", async () => {
  await fixture()
  await expect(createProviderFromUpstream(record(), undefined, () => async () => catalog())).rejects.toThrow(/stored upstream/)
})

test("provider constructed from an older same-owner row uses its reimported credential", async () => {
  const f = await fixture()
  const authorized = await f.first.upstreams.getById("codex-race")
  if (!authorized) throw new Error("missing fixture stored row")
  const sent: string[] = []
  const p = await createProviderFromUpstream(authorized, undefined, () => async (url, init) => {
    sent.push(new Headers(init?.headers).get("authorization") ?? "")
    return url.includes(CODEX_MODELS_PATH) ? catalog() : Response.json({ output: [] })
  })
  if (!p) throw new Error("missing fixture provider")
  await f.replace(false, true)
  expect((await p.fetch(request())).status).toBe(200)
  await Promise.all(f.pending)
  expect(sent).toEqual(["Bearer access-replacement", "Bearer access-replacement"])
})
