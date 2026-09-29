import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { ConfigurationCache } from "../src/repo/configuration-cache.ts"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids.ts"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "c12-fresh-"))
  const path = join(dir, "db.sqlite")
  const db = new Database(path)
  const repo = new BunSqliteRepo(db)
  const external = new Database(path)
  cleanup.push(() => { external.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { repo, external }
}

test("fresh authority does not reuse an older pending revision read after external key deletion", async () => {
  const { repo, external } = fixture()
  await repo.apiKeys.save({ id: "key" as ApiKeyId, key: "secret", name: "fixture", createdAt: "now", modelMappingsEnabled: false, modelMappings: [] })
  let now = 0
  const cache = new ConfigurationCache(repo, () => now)
  await cache.pinnedView()
  const revision = repo.configurationRevision?.bind(repo)
  if (!revision) throw new Error("missing revision")
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let reads = 0
  repo.configurationRevision = async () => {
    const value = await revision()
    if (++reads === 1) { started.resolve(); await release.promise }
    return value
  }
  now = 121_000
  const old = cache.pinnedView()
  await started.promise
  external.exec("DELETE FROM api_keys WHERE id = 'key'")
  try {
    expect(typeof Reflect.get(cache, "freshPinnedView")).toBe("function")
    const fresh = cache.freshPinnedView()
    release.resolve()
    await old
    expect(await (await fresh).apiKeys.findByRawKey("secret")).toBeNull()
    expect(reads).toBeGreaterThanOrEqual(2)
  } finally { release.resolve(); await old }
})

test("fresh session lookup bypasses the cached token", async () => {
  const { repo, external } = fixture()
  const owner = "owner" as UserId
  await repo.users.create({ id: owner, email: "fixture@example.test", name: "Fixture", disabled: false, createdAt: "now", updatedAt: "now" })
  const token = "ses_fixture" as SessionToken
  await repo.sessions.create({ token, userId: owner, expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: "now", authenticatedAt: Date.now() })
  const cache = new ConfigurationCache(repo)
  const pinned = await cache.pinnedView()
  expect(await pinned.sessions.findByToken(token)).not.toBeNull()
  external.exec("DELETE FROM user_sessions")
  expect(typeof Reflect.get(cache, "freshPinnedView")).toBe("function")
  expect(await (await cache.freshPinnedView()).sessions.findByToken(token)).toBeNull()
})

test("fresh token resolution does not join a pre-revocation pending session lookup", async () => {
  const { repo, external } = fixture()
  const owner = "owner" as UserId
  const token = "ses_pending" as SessionToken
  await repo.users.create({ id: owner, name: "fixture", disabled: false, createdAt: "now" })
  await repo.sessions.create({ token, userId: owner, createdAt: "now", expiresAt: "2099-01-01" })
  const original = repo.sessions.findByToken.bind(repo.sessions)
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let reads = 0
  repo.sessions.findByToken = async value => {
    const row = await original(value)
    if (++reads === 1) { started.resolve(); await gate.promise }
    return row
  }
  const cache = new ConfigurationCache(repo)
  const old = cache.view.sessions.findByToken(token)
  await started.promise
  external.exec("DELETE FROM user_sessions")
  try {
    const fresh = await cache.freshPinnedView()
    expect(await fresh.sessions.findByToken(token)).toBeNull()
    expect(reads).toBe(2)
  } finally { gate.resolve(); await old }
})
