import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { initUpstreamRepo, type UpstreamWriteTarget } from "@vibe-core/upstream-repo"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { ensureClaudeCodeAccessToken, invalidateClaudeCodeAccessToken, refreshClaudeCodeAccessTokenForRetry } from "../../provider-claude-code/src/access-token.ts"
import { readClaudeCodeCredential } from "../../provider-claude-code/src/credential-effects.ts"
import { readClaudeCodeUpstreamState, type ClaudeCodeUpstreamState } from "../../provider-claude-code/src/state.ts"
import type { Fetcher } from "../../provider-claude-code/src/fetcher.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"

const cleanup: Array<() => void> = []
afterEach(() => { __resetPlatformForTests(); for (const close of cleanup.splice(0)) close() })
const id = "claude-lease"
const entry = (token: string) => ({ token, expiresAt: Date.now() + 3_600_000, refreshedAt: "2026-10-09T00:00:00.000Z" })
const state = (access: string | null = "access-old", refresh = "refresh-old"): ClaudeCodeUpstreamState => ({ accounts: [{
  accountUuid: "account", tokenKind: "oauth", refreshToken: refresh, state: "active",
  stateUpdatedAt: "2026-10-09T00:00:00.000Z", accessToken: access ? entry(access) : null,
  quotaSnapshot: null, usageProbeSnapshot: null,
}] })
const record = (value = state()): UpstreamRecord<unknown> => ({
  id, ownerId: "owner", provider: "claude-code", name: "Claude", enabled: true, sortOrder: 0,
  config: { accounts: [{ accountUuid: "account", email: null, organizationUuid: null, subscriptionType: null, rateLimitTier: null }] },
  state: value, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
  createdAt: "2026-10-09", updatedAt: "2026-10-09",
})
const oauth = (access = "access-minted", refresh = "refresh-minted") => Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600, scope: "user:inference user:profile" })
const oauthError = (code: string) => Response.json({ error: code, error_description: "synthetic OAuth failure" }, { status: 400 })

async function fixture(initial = state()) {
  const directory = mkdtempSync(join(tmpdir(), "claude-credential-effects-"))
  const a = new Database(join(directory, "test.sqlite"))
  const first = new BunSqliteRepo(a)
  const b = new Database(join(directory, "test.sqlite"))
  const second = new BunSqliteRepo(b)
  cleanup.push(() => { a.close(); b.close(); rmSync(directory, { recursive: true, force: true }) })
  await first.upstreams.save(record(initial))
  initUpstreamRepo(() => first.upstreams, () => second.upstreams)
  return { first, second, async row() {
    const row = await second.upstreams.getById(id)
    if (!row) throw new Error("Fixture row missing")
    return row
  }, async account() {
    const row = await second.upstreams.getById(id)
    const account = readClaudeCodeUpstreamState(row?.state).accounts[0]
    if (!account) throw new Error("Fixture account missing")
    return account
  }, async reimport(recreate = false) {
    const replacement = record(state("access-reimport", "refresh-reimport"))
    if (recreate) { await second.upstreams.delete(id); await second.upstreams.save(replacement); return }
    const current = await second.upstreams.getById(id)
    if (!current) throw new Error("Fixture row missing")
    await second.upstreams.replaceCredentials(current, { config: replacement.config, state: replacement.state })
  } }
}

test("cached bearer carries its credential authority without changing stored state", async () => {
  const f = await fixture()
  const before = await f.row()
  const result = await ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => { throw new Error("Unexpected OAuth") } })
  expect(result).toMatchObject({ entry: { token: "access-old" }, freshlyMinted: false,
    credential: { upstreamId: id, provider: "claude-code", rowIncarnation: before.rowIncarnation, ownerId: "owner", accountUuid: "account", tokenKind: "oauth", stateUpdatedAt: "2026-10-09T00:00:00.000Z" } })
  expect((await f.row()).state).toEqual(before.state)
})

for (const recreate of [false, true]) test(`late successful refresh cannot overwrite or return a ${recreate ? "recreated" : "reimported"} credential`, async () => {
  const f = await fixture(state(null))
  const result = await ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => { await f.reimport(recreate); return oauth() } }).then(value => ({ value }), error => ({ error }))
  expect(result).toHaveProperty("error")
  expect(await f.account()).toMatchObject({ state: "active", refreshToken: "refresh-reimport", accessToken: { token: "access-reimport" } })
})

for (const code of ["app_session_terminated", "invalid_grant"] as const) test(`late ${code} leaves a reimported credential active`, async () => {
  const f = await fixture(state(null))
  await ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => { await f.reimport(); return oauthError(code) } }).catch(() => {})
  expect(await f.account()).toMatchObject({ state: "active", refreshToken: "refresh-reimport", accessToken: { token: "access-reimport" } })
})

test("ambiguous invalid_grant leaves the old credential writable for a late winning mint", async () => {
  const f = await fixture(state(null))
  await expect(ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => oauthError("invalid_grant") })).rejects.toThrow()
  expect(await f.account()).toMatchObject({ state: "active", refreshToken: "refresh-old", accessToken: null })
  const result = await ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => oauth() })
  expect(result.entry.token).toBe("access-minted")
  expect(await f.account()).toMatchObject({ state: "active", refreshToken: "refresh-minted", accessToken: { token: "access-minted" } })
})

test("explicit terminal OAuth failure persists only on the credential that failed", async () => {
  const f = await fixture(state(null))
  await expect(ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => oauthError("app_session_terminated") })).rejects.toThrow()
  expect(await f.account()).toMatchObject({ state: "refresh_failed", refreshToken: "refresh-old", accessToken: null })
})

test("metadata changes do not discard a legitimate rotated refresh token", async () => {
  const f = await fixture(state(null))
  const result = await ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => {
    const row = await f.row()
    await f.second.upstreams.patchMetadata(row, current => ({ ...current, name: "Renamed", proxyFallbackList: [{ id: "direct_fetch" }] }))
    return oauth()
  } })
  expect(result.entry.token).toBe("access-minted")
  expect(await f.account()).toMatchObject({ state: "active", refreshToken: "refresh-minted", accessToken: { token: "access-minted" } })
})

test("aborted refresh cannot publish a late OAuth result even when fetch ignores abort", async () => {
  const f = await fixture(state(null))
  const controller = new AbortController()
  let guardCalls = 0
  const args = { upstreamId: id, signal: controller.signal, beforeMint: async () => { guardCalls++ }, fetcher: async () => { controller.abort(); return oauth() } }
  await expect(ensureClaudeCodeAccessToken(args)).rejects.toThrow()
  expect(guardCalls).toBe(1)
  expect(await f.account()).toMatchObject({ state: "active", refreshToken: "refresh-old", accessToken: null })
})

test("different fetcher and guard scopes cannot share an in-flight refresh", async () => {
  await fixture(state(null))
  const pending = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<void>()
  let firstCalls = 0
  let secondCalls = 0
  let firstGuards = 0
  let secondGuards = 0
  const firstArgs = { upstreamId: id, beforeMint: async () => { firstGuards++ }, fetcher: async () => { firstCalls++; entered.resolve(); return pending.promise } }
  const first = ensureClaudeCodeAccessToken(firstArgs)
  await entered.promise
  const secondArgs = { upstreamId: id, beforeMint: async () => { secondGuards++ }, fetcher: async () => { secondCalls++; return oauth("access-second", "refresh-second") } }
  const second = ensureClaudeCodeAccessToken(secondArgs)
  pending.resolve(oauth())
  await Promise.allSettled([first, second])
  expect([firstCalls, secondCalls, firstGuards, secondGuards]).toEqual([1, 1, 1, 1])
})

const forbiddenFetcher: Fetcher = async () => { throw new Error("Unexpected OAuth") }
async function storedLease() {
  return await ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: forbiddenFetcher })
}

test("a late 401 cannot clear a sibling bearer, while its current lease can", async () => {
  const f = await fixture()
  const failed = await storedLease()
  await f.second.upstreams.saveState<ClaudeCodeUpstreamState>(id, current => ({ accounts: [{ ...current.accounts[0]!, accessToken: entry("access-sibling") }] }))
  await invalidateClaudeCodeAccessToken(failed)
  expect((await f.account()).accessToken?.token).toBe("access-sibling")
  await invalidateClaudeCodeAccessToken(await storedLease())
  expect((await f.account()).accessToken).toBeNull()
})

test("401 retry reuses a published sibling within the same credential epoch", async () => {
  const f = await fixture()
  const failed = await storedLease()
  await f.second.upstreams.saveState<ClaudeCodeUpstreamState>(id, current => ({ accounts: [{ ...current.accounts[0]!, accessToken: entry("access-sibling") }] }))
  const next = await refreshClaudeCodeAccessTokenForRetry(failed, { upstreamId: id, fetcher: forbiddenFetcher })
  expect(next.entry.token).toBe("access-sibling")
  expect(next.credential.credentialGeneration).toBe(failed.credential.credentialGeneration)
})

for (const recreate of [false, true]) test(`401 retry rejects a ${recreate ? "recreated" : "reimported"} credential`, async () => {
  const f = await fixture()
  const failed = await storedLease()
  await f.reimport(recreate)
  await expect(refreshClaudeCodeAccessTokenForRetry(failed, { upstreamId: id, fetcher: forbiddenFetcher })).rejects.toThrow()
  expect((await f.account()).accessToken?.token).toBe("access-reimport")
})

test("401 retry never returns the failed bearer from an unchanged cached row", async () => {
  const f = await fixture()
  const stale = await f.row()
  const failed = await storedLease()
  initUpstreamRepo(() => ({ getById: async <T>() => stale as typeof stale & { state: T }, saveState: f.first.upstreams.saveState.bind(f.first.upstreams) }), () => f.second.upstreams)
  let calls = 0
  const next = await refreshClaudeCodeAccessTokenForRetry(failed, { upstreamId: id, fetcher: async () => { calls++; return oauth() } })
  expect(next.entry.token).toBe("access-minted")
  expect(calls).toBe(1)
})

test("rejected setup-token becomes terminal without calling OAuth", async () => {
  const initial: ClaudeCodeUpstreamState = { accounts: [{ ...state().accounts[0]!, tokenKind: "setup-token", refreshToken: null }] }
  const f = await fixture(initial)
  const failed = await storedLease()
  await expect(refreshClaudeCodeAccessTokenForRetry(failed, { upstreamId: id, fetcher: forbiddenFetcher })).rejects.toMatchObject({ code: "setup_token_rejected" })
  expect(await f.account()).toMatchObject({ state: "refresh_failed", tokenKind: "setup-token", accessToken: null })
})

test("a concurrent mint retaining the same refresh token cannot overwrite the committed winner", async () => {
  const f = await fixture(state(null))
  const pending = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<void>()
  const first = ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => { entered.resolve(); return pending.promise } })
  await entered.promise
  const second = await ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => oauth("access-winner", "refresh-old") })
  pending.resolve(oauth("access-loser", "refresh-old"))
  const firstResult = await first
  expect(second.entry.token).toBe("access-winner")
  expect(firstResult).toMatchObject({ entry: { token: "access-winner" }, freshlyMinted: false })
  expect((await f.account()).accessToken?.token).toBe("access-winner")
})

test("late successful mint cannot resurrect an explicitly terminated credential", async () => {
  const f = await fixture(state(null))
  const pending = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<void>()
  const late = ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => { entered.resolve(); return pending.promise } })
  await entered.promise
  await expect(ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => oauthError("app_session_terminated") })).rejects.toThrow()
  pending.resolve(oauth())
  await expect(late).rejects.toThrow()
  expect(await f.account()).toMatchObject({ state: "refresh_failed", refreshToken: "refresh-old", accessToken: null })
})

test("invalid_grant retries a rotated refresh token only once and guards each mint", async () => {
  const f = await fixture(state(null))
  const used: string[] = []
  let guards = 0
  const result = ensureClaudeCodeAccessToken({ upstreamId: id, beforeMint: async () => { guards++ }, fetcher: async (_url, init) => {
    used.push((JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token)
    await f.second.upstreams.saveState<ClaudeCodeUpstreamState>(id, current => ({ accounts: [{ ...current.accounts[0]!, tokenKind: "oauth", refreshToken: `refresh-sibling-${used.length}`, accessToken: null }] }))
    return oauthError("invalid_grant")
  } })
  await expect(result).rejects.toMatchObject({ code: "invalid_grant" })
  expect(used).toEqual(["refresh-old", "refresh-sibling-1"])
  expect(guards).toBe(2)
  expect(await f.account()).toMatchObject({ state: "active", refreshToken: "refresh-sibling-2", accessToken: null })
})

test("beforeMint rejection prevents network and state effects", async () => {
  const f = await fixture(state(null))
  const before = await f.row()
  await expect(ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: forbiddenFetcher, beforeMint: async () => { throw new Error("fence rejected") } })).rejects.toThrow("fence rejected")
  expect((await f.row()).state).toEqual(before.state)
})

test("same credential, fetcher and guard scope coalesce a real refresh", async () => {
  await fixture(state(null))
  const pending = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<void>()
  let calls = 0
  let guards = 0
  const args = { upstreamId: id, beforeMint: async () => { guards++ }, fetcher: async () => { calls++; entered.resolve(); return pending.promise } }
  const first = ensureClaudeCodeAccessToken(args)
  await entered.promise
  const second = ensureClaudeCodeAccessToken(args)
  pending.resolve(oauth())
  const results = await Promise.all([first, second])
  expect(results.map(result => result.entry.token)).toEqual(["access-minted", "access-minted"])
  expect([calls, guards]).toEqual([1, 1])
})

test("one signal's cancellation neither delays nor cancels another refresh scope", async () => {
  const f = await fixture(state(null))
  const pending = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<void>()
  const firstSignal = new AbortController()
  const secondSignal = new AbortController()
  let calls = 0
  const fetcher: Fetcher = async () => { calls++; if (calls === 1) { entered.resolve(); return pending.promise }; return oauth("access-survivor", "refresh-survivor") }
  const first = ensureClaudeCodeAccessToken({ upstreamId: id, fetcher, signal: firstSignal.signal })
  await entered.promise
  firstSignal.abort()
  await expect(first).rejects.toMatchObject({ name: "AbortError" })
  const second = await ensureClaudeCodeAccessToken({ upstreamId: id, fetcher, signal: secondSignal.signal })
  pending.resolve(oauth("access-canceled", "refresh-canceled"))
  await Bun.sleep(0)
  expect(second.entry.token).toBe("access-survivor")
  expect((await f.account()).accessToken?.token).toBe("access-survivor")
  expect(calls).toBe(2)
})

test("a fresh supplied snapshot needs no repository read or state write", async () => {
  const f = await fixture()
  const snapshot = await readClaudeCodeCredential(id)
  let reads = 0
  let writes = 0
  const wrap = (repo: typeof f.first.upstreams) => ({
    getById: async <T>(upstreamId: string) => { reads++; return await repo.getById<T>(upstreamId) },
    saveState: async <T>(upstreamId: string, updater: (value: T) => T, target?: UpstreamWriteTarget) => { writes++; return await repo.saveState(upstreamId, updater, target) },
  })
  initUpstreamRepo(() => wrap(f.first.upstreams), () => wrap(f.second.upstreams))
  const result = await ensureClaudeCodeAccessToken({ upstreamId: id, snapshot, expected: snapshot.credential, fetcher: forbiddenFetcher })
  expect(result.entry.token).toBe("access-old")
  expect([reads, writes]).toEqual([0, 0])
})

test("legacy adapters fence effects by health timestamp and keep the strict state format", async () => {
  const f = await fixture()
  const wrap = (repo: typeof f.first.upstreams) => ({
    getById: async <T>(upstreamId: string) => {
      const row = await repo.getById<T>(upstreamId)
      if (row) { delete row.credentialGeneration; delete row.catalogGeneration }
      return row
    },
    saveState: repo.saveState.bind(repo),
  })
  initUpstreamRepo(() => wrap(f.first.upstreams), () => wrap(f.second.upstreams))
  const stale = await storedLease()
  expect(stale.credential.credentialGeneration).toBeUndefined()
  await f.second.upstreams.saveState<ClaudeCodeUpstreamState>(id, current => ({ accounts: [{ ...current.accounts[0]!, stateUpdatedAt: "2026-10-09T01:00:00.000Z" }] }))
  await invalidateClaudeCodeAccessToken(stale)
  expect((await f.account()).accessToken?.token).toBe("access-old")
  await invalidateClaudeCodeAccessToken(await storedLease())
  const current = await f.account()
  expect(current.accessToken).toBeNull()
  expect(Object.keys(current).sort()).toEqual(Object.keys(state().accounts[0]!).sort())
})

test("cancellation before the invalidation updater preserves the stored bearer", async () => {
  const f = await fixture()
  const failed = await storedLease()
  const controller = new AbortController()
  initUpstreamRepo(() => ({
    getById: f.first.upstreams.getById.bind(f.first.upstreams),
    saveState: async <T>(upstreamId: string, updater: (value: T) => T, target?: UpstreamWriteTarget) => {
      return await f.first.upstreams.saveState<T>(upstreamId, current => { controller.abort(); return updater(current) }, target)
    },
  }), () => f.second.upstreams)
  await expect(refreshClaudeCodeAccessTokenForRetry(failed, { upstreamId: id, fetcher: forbiddenFetcher, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
  expect((await f.account()).accessToken?.token).toBe("access-old")
})

test("returned credential and bearer lease cannot be mutated by another caller", async () => {
  const f = await fixture()
  const lease = await storedLease()
  expect(Object.isFrozen(lease)).toBe(true)
  expect(Object.isFrozen(lease.credential)).toBe(true)
  expect(Object.isFrozen(lease.entry)).toBe(true)
  expect(Reflect.set(lease.credential, "credentialGeneration", 99)).toBe(false)
  expect(Reflect.set(lease.entry, "token", "caller-token")).toBe(false)
  expect((await f.account()).accessToken?.token).toBe("access-old")
})

test("a setup-token with no bearer is fenced into terminal state", async () => {
  const f = await fixture({ accounts: [{ ...state(null).accounts[0]!, tokenKind: "setup-token", refreshToken: null }] })
  await expect(storedLease()).rejects.toMatchObject({ code: "setup_token_expired" })
  expect(await f.account()).toMatchObject({ state: "refresh_failed", tokenKind: "setup-token", accessToken: null })
})

test("an in-flight OAuth mint cannot overwrite a setup-token import", async () => {
  const f = await fixture(state(null))
  await expect(ensureClaudeCodeAccessToken({ upstreamId: id, fetcher: async () => {
    const row = await f.row()
    await f.second.upstreams.replaceCredentials(row, { config: row.config, state: { accounts: [{ ...state("access-setup").accounts[0]!, tokenKind: "setup-token", refreshToken: null }] } })
    return oauth()
  } })).rejects.toThrow()
  expect(await f.account()).toMatchObject({ state: "active", tokenKind: "setup-token", refreshToken: null, accessToken: { token: "access-setup" } })
})

test("a synchronous beforeMint abort leaves no unobserved refresh rejection", async () => {
  const f = await fixture(state(null))
  const controller = new AbortController()
  await expect(ensureClaudeCodeAccessToken({ upstreamId: id, force: true, signal: controller.signal,
    beforeMint: async () => { controller.abort() }, fetcher: forbiddenFetcher,
  })).rejects.toMatchObject({ name: "AbortError" })
  await Bun.sleep(0)
  expect(await f.account()).toMatchObject({ state: "active", refreshToken: "refresh-old", accessToken: null })
})
