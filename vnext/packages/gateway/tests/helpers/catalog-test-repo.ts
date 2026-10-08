import { Database } from "bun:sqlite"
import { __registerPlatformReset } from "@vibe-core/platform"
import { BunSqliteRepo } from "../../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { initRepo } from "../../src/repo/index.ts"
import type { UpstreamId, UserId } from "../../src/repo/branded-ids.ts"
import type { CatalogRepo } from "../../src/repo/catalogs.ts"
import type { Repo, UpstreamRecord } from "../../src/repo/types.ts"

const databases: Database[] = []
__registerPlatformReset(() => { for (const database of databases.splice(0)) database.close() })

/**
 * Route fixtures retain their own filtering, mutations and capture spies, while
 * catalog discovery uses the real migrated SQL repository and stored identities.
 * Source fixture edits are mirrored before catalog operations; unchanged fixture
 * rows never overwrite credentials rotated by a provider in the SQL repository.
 */
export function initCatalogTestRepo(source: Repo, options: {
  apiKeys?: ReadonlyArray<{ id: string; ownerId?: string }>
} = {}): void {
  const database = new Database(":memory:")
  databases.push(database)
  const stored = new BunSqliteRepo(database)
  // Only explicitly authenticated fixture keys receive real signing state.
  // Keep other key operations (including telemetry spies) on the source repo.
  const seededKeys = new Set(options.apiKeys?.map(key => key.id))
  for (const key of options.apiKeys ?? []) {
    database.run("INSERT INTO api_keys (id, name, key, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [key.id, "fixture", `synthetic-key-${key.id}`, key.ownerId ?? null, "2026-01-01T00:00:00Z"])
  }
  const apiKeys = new Proxy(stored.apiKeys, { get(target, key) {
    if (key === "getById") return async (...args: Parameters<typeof target.getById>) =>
      seededKeys.has(args[0]) ? target.getById(...args) : source.apiKeys?.getById?.(...args) ?? null
    if (key === "getOrCreateAffinitySecret") return async (...args: Parameters<typeof target.getOrCreateAffinitySecret>) =>
      seededKeys.has(args[0]) ? target.getOrCreateAffinitySecret(...args) : source.apiKeys?.getOrCreateAffinitySecret?.(...args) ?? null
    const original: unknown = source.apiKeys && Reflect.get(source.apiKeys, key)
    return typeof original === "function" ? original.bind(source.apiKeys) : original
  } })
  const observed = new Map<string, string>()
  let pending = Promise.resolve()
  const syncRow = (row: UpstreamRecord<unknown>) => {
    const work = pending.then(async () => {
      const value = JSON.stringify(row)
      if (observed.get(row.id) !== value) {
        await stored.upstreams.save(row)
        observed.set(row.id, value)
      }
      return stored.upstreams.getById(row.id as UpstreamId)
    })
    pending = work.then(() => {})
    return work
  }
  const syncById = async (id: string) => {
    const previous = await stored.upstreams.getById(id as UpstreamId)
    const row = source.upstreams?.getById
      ? await source.upstreams.getById(id as UpstreamId)
      : (await source.upstreams?.list({ ownerId: previous?.ownerId as UserId | undefined }) ?? []).find(value => value.id === id)
    if (row) return syncRow(row)
    if (previous) await stored.upstreams.delete(id as UpstreamId)
    observed.delete(id)
    return null
  }
  const upstreams = new Proxy(stored.upstreams, { get(target, key) {
    if (key === "list") return async (...args: Parameters<typeof target.list>) => {
      const rows = await source.upstreams?.list(...args) ?? []
      const result = await Promise.all(rows.map(syncRow))
      return result.filter(row => row !== null)
    }
    if (key === "getById") return syncById
    const original: unknown = source.upstreams && Reflect.get(source.upstreams, key)
    if (typeof original === "function") return original.bind(source.upstreams)
    const value: unknown = Reflect.get(target, key)
    return typeof value === "function" ? value.bind(target) : value
  } })
  const syncProxies = async () => {
    for (const proxy of await source.proxies?.list() ?? []) await stored.proxies.save(proxy)
  }
  const catalogs: CatalogRepo = {
    read: async (id, revision) => { await syncById(id); await syncProxies(); return stored.catalogs.read(id, revision) },
    tryAcquire: async (identity, options) => {
      await syncById(identity.upstreamId)
      return stored.catalogs.tryAcquire(identity, options)
    },
    publish: async (lease, models, options) => {
      await syncById(lease.identity.upstreamId)
      return stored.catalogs.publish(lease, models, options)
    },
    recordFailure: async (lease, code, options) => {
      await syncById(lease.identity.upstreamId)
      return stored.catalogs.recordFailure(lease, code, options)
    },
    deleteInactiveRevisions: options => stored.catalogs.deleteInactiveRevisions(options),
  }
  initRepo(new Proxy(source, { get(target, key) {
    if (key === "upstreams") return upstreams
    if (key === "catalogs") return catalogs
    if (key === "apiKeys" && options.apiKeys) return apiKeys
    if (key === "proxies") return target.proxies ?? stored.proxies
    if (key === "proxyBackoffs") return target.proxyBackoffs ?? stored.proxyBackoffs
    return Reflect.get(target, key)
  } }))
}

/** A stored fixture account's own synthetic exchange, never a request token. */
export function syntheticCopilotTokenResponse(request: Request): Response | null {
  return new URL(request.url).pathname.endsWith("/copilot_internal/v2/token")
    ? Response.json({ token: "stored-fixture-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }) : null
}
