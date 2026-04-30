import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepoForTest } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { resolveWebSearchKeys, isKeyVisibleTo } from "~/services/web-search/resolver"
import type { ApiKey } from "~/repo/types"

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: overrides.id ?? "k_" + Math.random().toString(36).slice(2, 8),
    name: overrides.name ?? "test",
    key: overrides.key ?? "raw_" + Math.random().toString(36).slice(2, 10),
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("resolveWebSearchKeys", () => {
  beforeEach(() => {
    const db = new Database(":memory:")
    setRepoForTest(new SqliteRepo(db))
  })

  test("literal-only returns the literal", async () => {
    const repo = (await import("~/repo")).getRepo()
    const k = key({ webSearchLangsearchKey: "lit-1" })
    await repo.apiKeys.save(k)
    const result = await resolveWebSearchKeys(k)
    expect(result.langsearchKey).toBe("lit-1")
    expect(result.tavilyKey).toBeUndefined()
  })

  test("ref resolves to source literal when same owner", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchLangsearchKey: "src-lit" })
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower)
    expect(result.langsearchKey).toBe("src-lit")
  })

  test("ref to missing source returns undefined", async () => {
    const repo = (await import("~/repo")).getRepo()
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: "k_does_not_exist" })
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower)
    expect(result.langsearchKey).toBeUndefined()
  })

  test("ref to source with no literal returns undefined (no transitive)", async () => {
    const repo = (await import("~/repo")).getRepo()
    const root = key({ ownerId: "u1", webSearchLangsearchKey: "deep" })
    const middle = key({ ownerId: "u1", webSearchLangsearchRef: root.id })
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: middle.id })
    await repo.apiKeys.save(root)
    await repo.apiKeys.save(middle)
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower)
    expect(result.langsearchKey).toBeUndefined()
  })

  test("ref to invisible source returns undefined", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchLangsearchKey: "secret" })
    const borrower = key({ ownerId: "u2", webSearchLangsearchRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower)
    expect(result.langsearchKey).toBeUndefined()
  })

  test("msGrounding falls back to env when neither literal nor ref present", async () => {
    const repo = (await import("~/repo")).getRepo()
    const k = key({ ownerId: "u1" })
    await repo.apiKeys.save(k)
    const result = await resolveWebSearchKeys(k, "env-ms-key")
    expect(result.msGroundingKey).toBe("env-ms-key")
  })

  test("msGrounding ref overrides env fallback", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchMsGroundingKey: "ref-ms" })
    const borrower = key({ ownerId: "u1", webSearchMsGroundingRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    const result = await resolveWebSearchKeys(borrower, "env-ms-key")
    expect(result.msGroundingKey).toBe("ref-ms")
  })

  test("cache returns stale value within TTL even after source rotation", async () => {
    const { invalidateResolverCache } = await import("~/services/web-search/resolver")
    invalidateResolverCache()
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchLangsearchKey: "v1" })
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    expect((await resolveWebSearchKeys(borrower)).langsearchKey).toBe("v1")
    // Rotate source literal directly in repo, do NOT invalidate.
    await repo.apiKeys.save({ ...source, webSearchLangsearchKey: "v2" })
    expect((await resolveWebSearchKeys(borrower)).langsearchKey).toBe("v1") // cached
    expect((await resolveWebSearchKeys(borrower, undefined, { skipCache: true })).langsearchKey).toBe("v2")
  })

  test("invalidateResolverCache(borrowerId) drops only that entry", async () => {
    const { invalidateResolverCache } = await import("~/services/web-search/resolver")
    invalidateResolverCache()
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1", webSearchLangsearchKey: "v1" })
    const borrower = key({ ownerId: "u1", webSearchLangsearchRef: source.id })
    await repo.apiKeys.save(source)
    await repo.apiKeys.save(borrower)
    await resolveWebSearchKeys(borrower) // populate cache
    await repo.apiKeys.save({ ...source, webSearchLangsearchKey: "v2" })
    invalidateResolverCache(borrower.id)
    expect((await resolveWebSearchKeys(borrower)).langsearchKey).toBe("v2")
  })
})

describe("isKeyVisibleTo", () => {
  beforeEach(() => {
    const db = new Database(":memory:")
    setRepoForTest(new SqliteRepo(db))
  })

  test("same owner is visible", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1" })
    await repo.apiKeys.save(source)
    expect(await isKeyVisibleTo(source, "u1")).toBe(true)
  })

  test("different owner without share is not visible", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1" })
    await repo.apiKeys.save(source)
    expect(await isKeyVisibleTo(source, "u2")).toBe(false)
  })

  test("key-assignment grants visibility", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1" })
    await repo.apiKeys.save(source)
    await repo.keyAssignments.assign(source.id, "u2", "u1")
    expect(await isKeyVisibleTo(source, "u2")).toBe(true)
  })

  test("observability share grants visibility", async () => {
    const repo = (await import("~/repo")).getRepo()
    const source = key({ ownerId: "u1" })
    await repo.apiKeys.save(source)
    await repo.observabilityShares.share("u1", "u2", "u1")
    expect(await isKeyVisibleTo(source, "u2")).toBe(true)
  })
})
