import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { ApiKeyId, SetupLeaseId, UserId } from "../../src/repo/branded-ids.ts"
import type { SetupLease } from "../../src/repo/types.ts"

const owner = "lease-owner" as UserId
const admin = "lease-admin" as UserId
const keyId = "lease-key" as ApiKeyId
const rawKey = "sk_repo_fixture_private"
const now = "2026-09-29T10:00:00.000Z"
const admins = ["test@local.dev"]
let dir: string
let db: Database
let peerDb: Database
let repo: BunSqliteRepo
let peer: BunSqliteRepo

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "d10a-repo-"))
  const path = join(dir, "gateway.sqlite")
  db = new Database(path)
  repo = new BunSqliteRepo(db)
  peerDb = new Database(path)
  peer = new BunSqliteRepo(peerDb)
  await repo.users.create({ id: owner, name: "Owner", createdAt: now, disabled: false })
  await repo.users.create({ id: admin, name: "Admin", email: "TEST@LOCAL.DEV", createdAt: now, disabled: false })
  await repo.apiKeys.save({ id: keyId, name: "Fixture", key: rawKey, ownerId: owner, createdAt: now, modelMappingsEnabled: false, modelMappings: [] })
})
afterEach(() => { peerDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

async function insert(minter = owner, keyOwner: UserId | null = owner): Promise<SetupLease> {
  const row: SetupLease = {
    tokenHash: "a".repeat(64), id: crypto.randomUUID() as SetupLeaseId, minterUserId: minter,
    keyId, keyOwnerId: keyOwner, client: "codex", platform: "posix", settingsJson: '{"model":null}',
    configurationRevision: await repo.configurationRevision?.() ?? -1, keyFingerprint: "b".repeat(64), artifactDigest: "c".repeat(64),
    createdAt: now, expiresAt: "2026-09-29T10:10:00.000Z", consumedAt: null, revokedAt: null,
  }
  await repo.setupLeases.create(row)
  return row
}

test("two independent SQLite connections consume one lease once without advancing configuration revision", async () => {
  const row = await insert()
  const revision = await repo.configurationRevision?.()
  const otherView = await peer.setupLeases.findByTokenHash(row.tokenHash)
  expect(otherView).toEqual(row)
  if (!otherView) throw new Error("Missing fixture lease")
  const outcomes = await Promise.all([repo.setupLeases.consume(row, rawKey, now, admins), peer.setupLeases.consume(otherView, rawKey, now, admins)])
  expect(outcomes.sort()).toEqual([false, true])
  expect((await peer.setupLeases.findById(row.id))?.consumedAt).toBe(now)
  await peer.setupLeases.revoke(row.id, keyId, now)
  expect(await repo.configurationRevision?.()).toBe(revision)
})

test("admin consumes ownerless and other-owned keys while an ordinary minter cannot", async () => {
  db.query("UPDATE api_keys SET owner_id = NULL WHERE id = ?").run(keyId)
  const row = await insert(admin, null)
  expect(await repo.setupLeases.consume(row, rawKey, now, admins)).toBe(true)
  db.query("DELETE FROM setup_leases").run()
  const ordinary = await insert(owner, null)
  expect(await repo.setupLeases.consume(ordinary, rawKey, now, admins)).toBe(false)
  db.query("DELETE FROM setup_leases").run()
  db.query("UPDATE api_keys SET owner_id = ? WHERE id = ?").run(owner, keyId)
  const delegated = await insert(admin)
  expect(await repo.setupLeases.consume(delegated, rawKey, now, admins)).toBe(true)
})

for (const change of ["delete-key", "raw-key", "owner-null", "minter-disabled", "owner-disabled", "admin-lost", "revoked", "expiry", "metadata", "revision"] as const) {
  test(`atomic predicate rejects ${change} committed by another connection after reading the lease`, async () => {
    const row = await insert(change === "admin-lost" || change === "owner-disabled" ? admin : owner)
    if (change === "delete-key") peerDb.query("DELETE FROM api_keys WHERE id = ?").run(keyId)
    if (change === "raw-key") peerDb.query("UPDATE api_keys SET key = 'sk_changed' WHERE id = ?").run(keyId)
    if (change === "owner-null") peerDb.query("UPDATE api_keys SET owner_id = NULL WHERE id = ?").run(keyId)
    if (change === "minter-disabled") peerDb.query("UPDATE users SET disabled = 1 WHERE id = ?").run(row.minterUserId)
    if (change === "owner-disabled") peerDb.query("UPDATE users SET disabled = 1 WHERE id = ?").run(owner)
    if (change === "admin-lost") peerDb.query("UPDATE users SET email = 'removed@example.invalid' WHERE id = ?").run(admin)
    if (change === "revoked") await peer.setupLeases.revoke(row.id, row.keyId, now)
    if (change === "metadata") peerDb.query("UPDATE setup_leases SET settings_json = '{\"model\":\"other\"}'").run()
    if (change === "revision") peerDb.query("UPDATE users SET name = 'Unrelated' WHERE id = ?").run(admin)
    if (change !== "revision") peerDb.query("UPDATE configuration_revision SET revision = ? WHERE id = 1").run(row.configurationRevision)
    expect(await repo.setupLeases.consume(row, rawKey, change === "expiry" ? row.expiresAt : now, admins)).toBe(false)
    expect((await repo.setupLeases.findById(row.id))?.consumedAt).toBeNull()
  })
}

test("SQL migration bounds settings and independent IDs and stores no raw credentials", async () => {
  const row = await insert()
  await expect(repo.setupLeases.create({ ...row, tokenHash: "d".repeat(64) })).rejects.toThrow()
  await expect(repo.setupLeases.create({ ...row, id: crypto.randomUUID() as SetupLeaseId, tokenHash: "e".repeat(64), settingsJson: "😀".repeat(2049) })).rejects.toThrow()
  expect(JSON.stringify(db.query("SELECT * FROM setup_leases").all())).not.toContain(rawKey)
  expect(db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'setup_leases'").all()).toEqual([])
})
