import { test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepoForTest, getRepo } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { listProviderBindings, invalidateUpstreamListCache } from "~/providers/registry"
import type { UpstreamRecord } from "~/repo"

let db: Database

beforeEach(() => {
  db = new Database(":memory:")
  setRepoForTest(new SqliteRepo(db))
  invalidateUpstreamListCache()
})

afterEach(() => {
  setRepoForTest(null)
  invalidateUpstreamListCache()
  db.close()
})

test("listProviderBindings hides disabled public model ids", async () => {
  const now = new Date().toISOString()
  const upstream: UpstreamRecord = {
    id: "up_custom_test_aaaaaaaa",
    ownerId: "",
    provider: "custom",
    name: "test",
    enabled: true,
    sortOrder: 0,
    config: {
      name: "test",
      baseUrl: "https://example.invalid",
      apiKey: "k",
      // Manual model list short-circuits the live /models fetch.
      models: ["gpt-4o-mini", "gpt-3.5-turbo", "text-embedding-ada-002"],
    },
    flagOverrides: {},
    disabledPublicModelIds: ["gpt-3.5-turbo", "text-embedding-ada-002"],
    createdAt: now,
    updatedAt: now,
  }
  await getRepo().upstreams.save(upstream)

  const bindings = await listProviderBindings()
  const ids = bindings.map((b) => b.model.id)
  expect(ids).toEqual(["gpt-4o-mini"])
})

test("listProviderBindings is unaffected when disabled list is empty", async () => {
  const now = new Date().toISOString()
  const upstream: UpstreamRecord = {
    id: "up_custom_full_aaaaaaaa",
    ownerId: "",
    provider: "custom",
    name: "full",
    enabled: true,
    sortOrder: 0,
    config: {
      name: "full",
      baseUrl: "https://example.invalid",
      apiKey: "k",
      models: ["a", "b", "c"],
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now,
    updatedAt: now,
  }
  await getRepo().upstreams.save(upstream)

  const bindings = await listProviderBindings()
  const ids = bindings.map((b) => b.model.id).sort()
  expect(ids).toEqual(["a", "b", "c"])
})
