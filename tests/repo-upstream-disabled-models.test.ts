import { test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepoForTest, getRepo } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import type { UpstreamRecord } from "~/repo"

let db: Database

beforeEach(() => {
  db = new Database(":memory:")
  setRepoForTest(new SqliteRepo(db))
})

afterEach(() => {
  setRepoForTest(null)
  db.close()
})

test("save + list round-trips disabledPublicModelIds", async () => {
  const now = new Date().toISOString()
  const upstream: UpstreamRecord = {
    id: "up_custom_x_aaaaaaaa",
    ownerId: "",
    provider: "custom",
    name: "x",
    enabled: true,
    sortOrder: 0,
    config: { name: "x", baseUrl: "https://x", apiKey: "k" },
    flagOverrides: {},
    disabledPublicModelIds: ["gpt-3.5-turbo", "text-embedding-ada-002"],
    createdAt: now,
    updatedAt: now,
  }
  await getRepo().upstreams.save(upstream)
  const [round] = await getRepo().upstreams.list({})
  expect(round.disabledPublicModelIds).toEqual(["gpt-3.5-turbo", "text-embedding-ada-002"])
})

test("legacy rows default to empty disabledPublicModelIds", async () => {
  // Simulate a row written before this migration by inserting directly.
  const now = new Date().toISOString()
  db.run(
    "INSERT INTO upstreams (id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["up_legacy_a", "", "custom", "legacy", 1, 0, "{}", "{}", now, now],
  )
  const [round] = await getRepo().upstreams.list({})
  expect(round.disabledPublicModelIds).toEqual([])
})
