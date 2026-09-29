import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BunSqliteRepo } from "../../../../apps/platform-bun/src/bun-sqlite-repo.ts"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "affinity-secret-"))
  const a = new Database(join(dir, "db.sqlite"))
  const first = new BunSqliteRepo(a)
  const b = new Database(join(dir, "db.sqlite"))
  const second = new BunSqliteRepo(b)
  cleanup.push(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) })
  a.run("INSERT INTO api_keys (id, name, key, owner_id, created_at) VALUES ('key', 'name', 'raw-key', 'owner', 'now')")
  return { a, first, second }
}

test("concurrent conditional initialization returns one persisted winner, kept private on ordinary reads and saves", async () => {
  const { first, second } = fixture()
  const key = await first.apiKeys.findByRawKey("raw-key")
  if (!key?.ownerId) throw new Error("fixture missing")
  const values = await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? first : second).apiKeys.getOrCreateAffinitySecret(key.id, key.ownerId)))
  const winner = values[0]
  if (!winner) throw new Error("winner missing")
  expect(winner.secret).toHaveLength(32)
  expect(winner.version).toBe(1)
  for (const value of values) expect(value).toEqual(winner)
  await second.apiKeys.save({ ...key, name: "renamed", key: "rotated" })
  expect(await first.apiKeys.getOrCreateAffinitySecret(key.id, key.ownerId)).toEqual(winner)
  const publicReads = JSON.stringify([await first.apiKeys.list(), await first.apiKeys.getById(key.id), await first.apiKeys.findByRawKey("rotated")])
  expect(publicReads).not.toContain("affinity")
  expect(publicReads).not.toContain(winner.keyId)
  expect(publicReads).not.toContain(Buffer.from(winner.secret).toString("hex"))
})

test("ownerless and mismatched owner keys do not initialize a secret", async () => {
  const { a, first } = fixture()
  const key = await first.apiKeys.findByRawKey("raw-key")
  if (!key?.ownerId) throw new Error("fixture missing")
  expect(await first.apiKeys.getOrCreateAffinitySecret(key.id, undefined)).toBeNull()
  a.run("UPDATE api_keys SET owner_id = 'other' WHERE id = 'key'")
  expect(await first.apiKeys.getOrCreateAffinitySecret(key.id, key.ownerId)).toBeNull()
  expect(a.query("SELECT affinity_secret FROM api_keys").get()).toEqual({ affinity_secret: null })
  a.run("UPDATE api_keys SET owner_id = NULL WHERE id = 'key'")
  expect(await first.apiKeys.getOrCreateAffinitySecret(key.id, undefined)).toBeNull()
})
