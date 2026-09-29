import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { D1Repo, type D1Database } from "./d1-repo.ts"
import type { ApiKeyId, SetupLeaseId, UserId } from "../../../packages/gateway/src/repo/branded-ids.ts"
import type { SetupLease } from "../../../packages/gateway/src/repo/types.ts"

const here = dirname(fileURLToPath(import.meta.url))
const vnext = join(here, "../../..")
const key = "sk_d10a_workerd_private_fixture"
const owner = "d10a-owner" as UserId
const admin = "d10a-admin" as UserId
const keyId = "d10a-key" as ApiKeyId
const session = "ses_d10a_fixture"
const now = "2026-09-29T10:00:00.000Z"
const adminEmails = ["test@local.dev"]
let dir: string
let mf: Miniflare
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>
let repo: D1Repo
let peer: D1Repo

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "d10a-workerd-"))
  const entry = join(dir, "entry.ts")
  const bundle = join(dir, "worker.mjs")
  writeFileSync(entry, `
    import { app } from ${JSON.stringify(join(vnext, "packages/gateway/src/app.ts"))}
    import { initRepo } from ${JSON.stringify(join(vnext, "packages/gateway/src/repo/index.ts"))}
    import { D1Repo } from ${JSON.stringify(join(here, "d1-repo.ts"))}
    export default { fetch(request, env) { initRepo(new D1Repo(env.DB)); return app.fetch(request) } }
  `)
  const build = Bun.spawnSync(["bun", "build", entry, "--target=node", "--external=cloudflare:sockets", `--outfile=${bundle}`], { cwd: vnext })
  if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr))
  mf = new Miniflare({ modules: true, modulesRoot: dir, scriptPath: bundle, host: "127.0.0.1", port: 0,
    compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "d10a-setup" }, d1Persist: join(dir, "d1") })
  db = await mf.getD1Database("DB")
  const migrationDir = join(vnext, "packages/gateway/migrations")
  for (const file of readdirSync(migrationDir).filter(file => file.endsWith(".sql")).sort()) {
    for (const sql of unstable_splitSqlQuery(readFileSync(join(migrationDir, file), "utf8"))) await db.prepare(sql).run()
  }
  repo = new D1Repo(db as unknown as D1Database)
  peer = new D1Repo(db as unknown as D1Database)
})

afterAll(async () => { await mf?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true }) })

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM setup_leases"), db.prepare("DELETE FROM api_keys"), db.prepare("DELETE FROM user_sessions"), db.prepare("DELETE FROM users")])
  await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?),(?,?,?,?)").bind(owner, "Owner", null, now, admin, "Admin", "TEST@LOCAL.DEV", now).run()
  await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)").bind(keyId, "Fixture", key, now, owner).run()
  await db.prepare("INSERT INTO user_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)").bind(session, owner, now, "2099-01-01T00:00:00.000Z").run()
})

async function insert(minter = owner, keyOwner: UserId | null = owner): Promise<SetupLease> {
  const lease: SetupLease = { tokenHash: "a".repeat(64), id: crypto.randomUUID() as SetupLeaseId,
    minterUserId: minter, keyId, keyOwnerId: keyOwner, client: "codex", platform: "posix", settingsJson: '{"model":null}',
    configurationRevision: await repo.configurationRevision?.() ?? -1, keyFingerprint: "b".repeat(64), artifactDigest: "c".repeat(64),
    createdAt: now, expiresAt: "2026-09-29T10:10:00.000Z", consumedAt: null, revokedAt: null }
  await repo.setupLeases.create(lease)
  return lease
}

test.serial("actual D1 migration and two repository redeemers produce exactly one winner", async () => {
  const row = await insert()
  const other = await peer.setupLeases.findByTokenHash(row.tokenHash)
  expect(other).toEqual(row)
  if (!other) throw new Error("Fixture lease missing")
  const outcomes = await Promise.all([repo.setupLeases.consume(row, key, now, adminEmails), peer.setupLeases.consume(other, key, now, adminEmails)])
  expect(outcomes.sort()).toEqual([false, true])
  expect(await repo.configurationRevision?.()).toBe(row.configurationRevision)
  expect((await repo.setupLeases.findById(row.id))?.consumedAt).toBe(now)
  expect(JSON.stringify(await db.prepare("SELECT * FROM setup_leases").all())).not.toContain(key)
})

test.serial("actual D1 permits admin ownerless consumption and rejects wrong-owner consumption", async () => {
  await db.prepare("UPDATE api_keys SET owner_id = NULL WHERE id = ?").bind(keyId).run()
  const authorized = await insert(admin, null)
  expect(await repo.setupLeases.consume(authorized, key, now, adminEmails)).toBe(true)
  await db.prepare("DELETE FROM setup_leases").run()
  const unauthorized = await insert(owner, null)
  expect(await repo.setupLeases.consume(unauthorized, key, now, adminEmails)).toBe(false)
})

for (const change of ["key", "owner", "minter", "owner-disabled", "admin", "revision", "revoke", "expiry", "delete"] as const) {
  test.serial(`D1 atomic consume fences ${change} changed after the pre-read`, async () => {
    const lease = await insert(change === "admin" || change === "owner-disabled" ? admin : owner)
    if (change === "key") await db.prepare("UPDATE api_keys SET key = 'sk_changed' WHERE id = ?").bind(keyId).run()
    if (change === "owner") await db.prepare("UPDATE api_keys SET owner_id = NULL WHERE id = ?").bind(keyId).run()
    if (change === "minter") await db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").bind(lease.minterUserId).run()
    if (change === "owner-disabled") await db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").bind(owner).run()
    if (change === "admin") await db.prepare("UPDATE users SET email = 'removed@example.invalid' WHERE id = ?").bind(admin).run()
    if (change === "revision") await db.prepare("UPDATE users SET name = 'Unrelated' WHERE id = ?").bind(admin).run()
    if (change === "delete") await db.prepare("DELETE FROM api_keys WHERE id = ?").bind(keyId).run()
    if (change === "revoke") await peer.setupLeases.revoke(lease.id, lease.keyId, now)
    if (change !== "revision") await db.prepare("UPDATE configuration_revision SET revision = ? WHERE id = 1").bind(lease.configurationRevision).run()
    expect(await repo.setupLeases.consume(lease, key, change === "expiry" ? lease.expiresAt : now, adminEmails)).toBe(false)
    expect((await peer.setupLeases.findById(lease.id))?.consumedAt).toBeNull()
  })
}

test.serial("workerd HTTP routes exchange an actual D1 lease once and keep plaintext out of the table", async () => {
  const base = (await mf.ready).origin
  const selection = { client: "claude", platform: "posix", settings: { model: "opaque-模型\n\"quotes\"" } }
  const call = (path: string, body: unknown) => mf.dispatchFetch(base + path, { method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  const response = await call(`/api/keys/${keyId}/setup/preview`, selection)
  expect(response.status).toBe(200)
  const preview = await response.json() as { artifactDigest: string; configurationRevision: number }
  const minted = await call(`/api/keys/${keyId}/setup/leases`, { ...selection,
    expectedArtifactDigest: preview.artifactDigest, expectedConfigurationRevision: preview.configurationRevision })
  expect(minted.status).toBe(201)
  const lease = await minted.json() as { leaseToken: string }
  const exchange = () => mf.dispatchFetch(base + "/api/setup/exchange", { method: "POST", headers: { "X-Setup-Lease": lease.leaseToken } })
  const results = await Promise.all([exchange(), exchange()])
  expect(results.map(r => r.status).sort()).toEqual([200, 410])
  const successful = results.find(r => r.status === 200)
  expect(successful?.headers.get("cache-control")).toBe("no-store")
  expect(await successful?.json()).toMatchObject({ artifact: { settings: { env: { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: selection.settings.model } } } })
  const rows = JSON.stringify(await db.prepare("SELECT * FROM setup_leases").all())
  expect(rows).not.toContain(key)
  expect(rows).not.toContain(lease.leaseToken)
})
