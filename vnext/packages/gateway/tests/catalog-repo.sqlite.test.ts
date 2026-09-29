import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BunSqliteRepo } from "../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { ConfigurationCache } from "../src/repo/configuration-cache.ts"
import { initRepo, getDataPlaneRepo } from "../src/repo/index.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { migrationsDir } from "../src/migrations-dir.ts"
import { catalogFingerprint } from "../src/repo/catalogs.ts"
import { buildSharedRepo } from "../src/repo/shared/repos.ts"
import type { SqlExecutor } from "../src/repo/shared/executor.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"

const resources: Array<() => void> = []
afterEach(() => { for (const close of resources.splice(0)) close() })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "catalog-repo-"))
  const path = join(dir, "shared.sqlite")
  const a = new Database(path)
  const first = new BunSqliteRepo(a)
  const b = new Database(path)
  const second = new BunSqliteRepo(b)
  resources.push(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) })
  return { a, b, first, second, path }
}

function upstream(): UpstreamRecord<unknown> {
  return {
    id: "catalog", ownerId: "owner", provider: "custom", name: "display", enabled: true,
    sortOrder: 0, config: { baseUrl: "https://example.invalid", apiKey: "synthetic-secret", nested: { b: 2, a: 1 } },
    state: { accessToken: "old", quota: 1 }, flagOverrides: {}, disabledPublicModelIds: [],
    proxyFallbackList: [{ id: "proxy", colos: ["SJC"] }, { id: "direct_fetch" }],
    createdAt: "same", updatedAt: "same",
  }
}

const models = { object: "list", data: [{ id: "model-a", capability: { enabled: true } }] }
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("fixture absent")
  return value
}

function withReadBarrier(db: Database, barrier: () => Promise<void>) {
  const binds = (values: unknown[]) => values.map(value => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint"
      || typeof value === "boolean" || value === null || value instanceof Uint8Array) return value
    throw new TypeError("Unsupported fixture SQL bind")
  })
  const executor: SqlExecutor = {
    async all<T>(sql: string, values: unknown[]) { return db.query(sql).all(...binds(values)) as T[] },
    async first<T>(sql: string, values: unknown[]) {
      const row = db.query(sql).get(...binds(values)) as T | null
      if (sql.startsWith("SELECT") && sql.includes("FROM upstreams")) await barrier()
      return row
    },
    async run(sql: string, values: unknown[]) { return { changes: Number(db.query(sql).run(...binds(values)).changes) } },
  }
  return buildSharedRepo(executor)
}

test("discovery metadata ignores display and credential telemetry but follows effective configuration", async () => {
  const { first, second } = fixture()
  await first.upstreams.save(upstream())
  const before = present(await first.upstreams.getById("catalog"))
  expect(before.catalogGeneration).toBe(0)
  const seen = present(await first.catalogs.read("catalog", 5))
  const display = await first.upstreams.patchMetadata(before, row => ({ ...row, name: "renamed", sortOrder: 7, disabledPublicModelIds: ["a"], flagOverrides: { x: true } }))
  await second.upstreams.saveState("catalog", () => ({ accessToken: "rotated", refreshToken: "rotated", quota: 3, state: "healthy" }))
  expect(display.catalogGeneration).toBe(0)
  expect(present(await first.catalogs.read("catalog", 5)).identity).toEqual(seen.identity)
  const edited = await first.upstreams.patchMetadata(display, row => ({ ...row, config: { ...row.config, baseUrl: "https://new.invalid" } }))
  expect(edited.catalogGeneration).toBe(1)
  expect(present(await second.catalogs.read("catalog", 5)).identity.configurationFingerprint).not.toBe(seen.identity.configurationFingerprint)
})

test("two real connections acquire exactly one lease and persist a complete publication", async () => {
  const { first, second } = fixture()
  await first.upstreams.save(upstream())
  expect(first.catalogs).toBeDefined()
  const identity = present(await first.catalogs.read("catalog", 5)).identity
  const leases = await Promise.all([first.catalogs.tryAcquire(identity), second.catalogs.tryAcquire(identity)])
  expect(leases.filter(Boolean)).toHaveLength(1)
  const lease = present(leases.find(value => value !== null))
  expect(lease.token).toMatch(/^[a-f0-9-]{36}$/)
  const snapshot = present(await first.catalogs.publish(lease, models))
  expect(snapshot.models).toEqual(models)
  const read = present(await second.catalogs.read("catalog", 5))
  expect(read.snapshot).toEqual(snapshot)
  expect(read.lease).toBeNull()
  expect(read.failureCount).toBe(0)
})

test("expired lease takeover fences both stale success and stale failure", async () => {
  const { first, second, b } = fixture()
  await first.upstreams.save(upstream())
  const identity = present(await first.catalogs.read("catalog", 5)).identity
  const a = present(await first.catalogs.tryAcquire(identity))
  b.exec("UPDATE model_catalogs SET lease_until_ms = 1")
  const winner = present(await second.catalogs.tryAcquire(identity))
  const accepted = present(await second.catalogs.publish(winner, models))
  expect(await first.catalogs.publish(a, { object: "list", data: [{ id: "late" }] })).toBeNull()
  expect(await first.catalogs.recordFailure(a, "upstream_error")).toBeNull()
  expect(present(await first.catalogs.read("catalog", 5)).snapshot).toEqual(accepted)
})

for (const column of ["owner_id", "provider", "config_json", "enabled", "proxy_fallback_list_json"] as const) {
  test(`a changed ${column} fences the old catalog identity`, async () => {
    const { first, b } = fixture()
    await first.upstreams.save(upstream())
    const identity = present(await first.catalogs.read("catalog", 5)).identity
    const lease = present(await first.catalogs.tryAcquire(identity))
    const values = { owner_id: "other", provider: "azure", config_json: "{}", enabled: 0, proxy_fallback_list_json: "[]" }
    b.query(`UPDATE upstreams SET ${column} = ? WHERE id = 'catalog'`).run(values[column])
    expect(await first.catalogs.publish(lease, models)).toBeNull()
    expect(await first.catalogs.recordFailure(lease, "upstream_error")).toBeNull()
    expect(await first.catalogs.tryAcquire(identity, { explicit: true })).toBeNull()
    const current = present(await first.catalogs.read("catalog", 5))
    expect(current.upstream.catalogGeneration).toBe(1)
    expect(current.snapshot).toBeNull()
    expect(await first.catalogs.tryAcquire(current.identity)).not.toBeNull()
  })
}

test("proxy insertion, transport edits and deletion advance only dependent generations", async () => {
  const { first, second, b } = fixture()
  await first.upstreams.save(upstream())
  await first.upstreams.save({ ...upstream(), id: "unrelated", proxyFallbackList: [] })
  const initial = present(await first.catalogs.read("catalog", 5))
  await first.proxies.save({ id: "proxy", name: "proxy", url: "http://synthetic:secret@localhost:1", dialTimeoutSeconds: 2 })
  let row = present(await first.catalogs.read("catalog", 5))
  expect(row.upstream.catalogGeneration).toBe(1)
  expect(row.proxies.map(p => p.id)).toEqual(["proxy"])
  expect(row.identity.configurationFingerprint).not.toBe(initial.identity.configurationFingerprint)
  await second.proxies.patch("proxy", { name: "label" })
  expect(present(await first.catalogs.read("catalog", 5)).identity).toEqual(row.identity)
  const lease = present(await first.catalogs.tryAcquire(row.identity))
  await second.proxies.patch("proxy", { dialTimeoutSeconds: 4 })
  expect(await first.catalogs.publish(lease, models)).toBeNull()
  await second.proxies.patch("proxy", { url: "http://localhost:2" })
  b.exec("DELETE FROM proxies WHERE id = 'proxy'")
  row = present(await first.catalogs.read("catalog", 5))
  expect(row.upstream.catalogGeneration).toBe(4)
  expect(row.proxies).toEqual([])
  expect(present(await first.upstreams.getById("unrelated")).catalogGeneration).toBe(0)
})

test("same timestamp recreation cleans SQL catalogs and cannot accept an old incarnation", async () => {
  const { first, second, a } = fixture()
  await first.upstreams.save(upstream())
  const old = present(await first.catalogs.read("catalog", 5))
  const lease = present(await first.catalogs.tryAcquire(old.identity))
  await second.upstreams.delete("catalog")
  expect(a.query("SELECT * FROM model_catalogs").all()).toEqual([])
  await second.upstreams.save(upstream())
  const next = present(await first.catalogs.read("catalog", 5))
  expect(next.upstream.createdAt).toBe(old.upstream.createdAt)
  expect(next.upstream.rowIncarnation).not.toBe(old.upstream.rowIncarnation)
  expect(await first.catalogs.publish(lease, models)).toBeNull()
  expect(await first.catalogs.tryAcquire(old.identity)).toBeNull()
})

test("persistent failure retains successful models and explicit retry never bypasses an active lease", async () => {
  const { first, second, path } = fixture()
  await first.upstreams.save(upstream())
  const identity = present(await first.catalogs.read("catalog", 5)).identity
  await first.catalogs.publish(present(await first.catalogs.tryAcquire(identity)), models)
  const failed = present(await first.catalogs.tryAcquire(identity, { explicit: true }))
  expect(await second.catalogs.tryAcquire(identity, { explicit: true })).toBeNull()
  const failure = present(await first.catalogs.recordFailure(failed, "timeout"))
  expect(failure.failureCount).toBe(1)
  const db = new Database(path)
  try {
    const restarted = new BunSqliteRepo(db)
    const read = present(await restarted.catalogs.read("catalog", 5))
    expect(read.snapshot?.models).toEqual(models)
    expect(read.retryAtMs - read.databaseNowMs).toBeGreaterThanOrEqual(23_000)
    expect(read.retryAtMs - read.databaseNowMs).toBeLessThanOrEqual(36_000)
    expect(await restarted.catalogs.tryAcquire(identity)).toBeNull()
    expect(await restarted.catalogs.tryAcquire(identity, { explicit: true })).not.toBeNull()
  } finally { db.close() }
})

test("database lease expiry remains authoritative under a skewed application clock", async () => {
  const { first, b } = fixture()
  await first.upstreams.save(upstream())
  const seen = present(await first.catalogs.read("catalog", 5))
  const original = Date.now
  try {
    Date.now = () => 0
    const lease = present(await first.catalogs.tryAcquire(seen.identity))
    expect(lease.leaseUntilMs - seen.databaseNowMs).toBeGreaterThanOrEqual(30_000)
    b.exec("UPDATE model_catalogs SET lease_until_ms = CAST(strftime('%s','now') AS INTEGER) * 1000")
    expect(await first.catalogs.publish(lease, models)).toBeNull()
    expect(await first.catalogs.recordFailure(lease, "timeout")).toBeNull()
  } finally { Date.now = original }
})

test("explicit replacement uses prior config and state CAS and advances generation exactly once", async () => {
  const { first, second } = fixture()
  await first.upstreams.save(upstream())
  let target = present(await first.upstreams.getById("catalog"))
  const before = await first.configurationRevision?.()
  const saved = await first.upstreams.replaceCredentials(target, { config: { ...target.config, account: "new" }, state: { credentialRevision: "new" } })
  expect(saved.catalogGeneration).toBe(1)
  expect(await first.configurationRevision?.()).not.toBe(before)
  await expect(first.upstreams.replaceCredentials(target, { config: target.config, state: {} })).rejects.toMatchObject({ name: "UpstreamContentionError" })
  target = saved
  await second.upstreams.saveState("catalog", () => ({ credentialRevision: "new", quota: 9 }))
  await expect(first.upstreams.replaceCredentials(target, { config: target.config, state: {} })).rejects.toMatchObject({ name: "UpstreamContentionError" })
  target = present(await first.upstreams.getById("catalog"))
  expect((await first.upstreams.replaceCredentials(target, { config: target.config, state: target.state })).catalogGeneration).toBe(2)
})

test("code revisions coexist and bounded maintenance preserves active revisions and leases", async () => {
  const { first, a } = fixture()
  await first.upstreams.save(upstream())
  for (const revision of [3, 4, 5, 6]) {
    const identity = present(await first.catalogs.read("catalog", revision)).identity
    const lease = present(await first.catalogs.tryAcquire(identity))
    if (revision !== 4) await first.catalogs.publish(lease, { object: "list", data: [{ id: `revision-${revision}` }] })
  }
  a.exec("UPDATE model_catalogs SET last_used_at_ms = 1")
  expect(await first.catalogs.deleteInactiveRevisions({ activeRevisions: [5], inactiveBeforeMs: 2, limit: 1 })).toBe(1)
  expect(await first.catalogs.deleteInactiveRevisions({ activeRevisions: [5], inactiveBeforeMs: 2, limit: 1 })).toBe(1)
  expect(present(await first.catalogs.read("catalog", 5)).snapshot?.models.data[0]?.id).toBe("revision-5")
  expect(present(await first.catalogs.read("catalog", 4)).lease).not.toBeNull()
  expect(await first.catalogs.deleteInactiveRevisions({ activeRevisions: [5], inactiveBeforeMs: 2, limit: 1 })).toBe(0)
})

test("catalog reads bypass a pinned configuration view", async () => {
  const { first, second } = fixture()
  await first.upstreams.save(upstream())
  const cache = new ConfigurationCache(first)
  const pinned = await cache.pinnedView()
  const prior = present(await second.upstreams.getById("catalog"))
  await second.upstreams.patchMetadata(prior, row => ({ ...row, enabled: false }))
  expect(present(await pinned.upstreams.getById("catalog")).enabled).toBe(true)
  expect(present(await pinned.catalogs.read("catalog", 5)).upstream.enabled).toBe(false)
})

test("fingerprints use deterministic Unicode key order and ignore mutable state and display", async () => {
  const { first } = fixture()
  await first.upstreams.save(upstream())
  const row = present(await first.upstreams.getById("catalog"))
  const a = { ...row, config: { "é": 1, "e\u0301": 2, nested: { z: 0, a: 1 } } }
  const b = { ...row, config: { nested: { a: 1, z: 0 }, "e\u0301": 2, "é": 1 }, name: "different", state: { token: "new" } }
  expect(catalogFingerprint(a, [])).toBe(catalogFingerprint(b, []))
  expect(catalogFingerprint(a, [])).toMatch(/^[a-f0-9]{64}$/)
  expect(catalogFingerprint({ ...a, proxyFallbackList: [...a.proxyFallbackList].reverse() }, [])).not.toBe(catalogFingerprint(a, []))
})

test("generation migration preserves preexisting credential bytes and raw inserts receive identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-upgrade-"))
  const db = new Database(join(dir, "legacy.sqlite"))
  resources.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)")
  const path = fileURLToPath(migrationsDir)
  for (const file of readdirSync(path).filter(file => file.endsWith(".sql") && file < "0018").sort()) {
    db.exec(readFileSync(join(path, file), "utf8"))
    db.query("INSERT INTO _migrations (name) VALUES (?)").run(file)
  }
  const config = '{ "account": "synthetic-account" }'
  const state = '{ "refreshToken": "synthetic-secret" }'
  db.query("INSERT INTO upstreams (id,provider,name,config_json,state_json,created_at,updated_at) VALUES ('legacy','codex','legacy',?,?,'same','same')").run(config, state)
  const before = db.query("SELECT row_incarnation FROM upstreams").get()
  new BunSqliteRepo(db)
  new BunSqliteRepo(db)
  expect(db.query("SELECT config_json,state_json,catalog_generation FROM upstreams").get()).toEqual({ config_json: config, state_json: state, catalog_generation: 0 })
  expect(db.query("SELECT row_incarnation FROM upstreams").get()).toEqual(before)
  expect(db.query("SELECT name FROM _migrations WHERE name='0018_catalog_coordination.sql'").all()).toHaveLength(1)
  db.exec("INSERT INTO upstreams (id,provider,name,created_at,updated_at) VALUES ('new','custom','new','same','same')")
  const inserted = present(db.query<{ row_incarnation: string; catalog_generation: number }, []>("SELECT row_incarnation,catalog_generation FROM upstreams WHERE id='new'").get())
  expect(inserted.row_incarnation).toMatch(/^[a-f0-9]{32}$/)
  expect(inserted.catalog_generation).toBeGreaterThanOrEqual(0)
  expect(() => db.exec("UPDATE upstreams SET row_incarnation='other' WHERE id='new'")).toThrow()
  expect(() => db.exec("UPDATE upstreams SET catalog_generation=-1 WHERE id='new'")).toThrow()
})

test("explicit replacement invalidates the local configuration cache even for identical credential bytes", async () => {
  const { first } = fixture()
  await first.upstreams.save(upstream())
  initRepo(first)
  try {
    const target = present(await getDataPlaneRepo().upstreams.getById("catalog"))
    await first.upstreams.replaceCredentials(target, { config: target.config, state: target.state })
    expect(present(await getDataPlaneRepo().upstreams.getById("catalog")).catalogGeneration).toBe(target.catalogGeneration + 1)
  } finally { __resetPlatformForTests() }
})

test("authoritative read retries when config changes between row and catalog reads", async () => {
  const { first, second } = fixture()
  await first.upstreams.save(upstream())
  const original = first.upstreams.getById.bind(first.upstreams)
  let reads = 0
  first.upstreams.getById = async id => {
    const row = await original(id)
    if (++reads === 1 && row) await second.upstreams.patchMetadata(row, value => ({ ...value, config: { endpoint: "new" } }))
    return row
  }
  const observation = present(await first.catalogs.read("catalog", 5))
  expect(reads).toBe(2)
  expect(observation.upstream.config).toEqual({ endpoint: "new" })
  expect(observation.identity.configurationGeneration).toBe(1)
})

test("generation replacement resets old failure state and cannot reuse previous model JSON", async () => {
  const { first } = fixture()
  await first.upstreams.save(upstream())
  const initial = present(await first.catalogs.read("catalog", 5))
  await first.catalogs.publish(present(await first.catalogs.tryAcquire(initial.identity)), models)
  await first.catalogs.recordFailure(present(await first.catalogs.tryAcquire(initial.identity)), "upstream_error")
  await first.upstreams.patchMetadata(initial.upstream, row => ({ ...row, config: { changed: true } }))
  const next = present(await first.catalogs.read("catalog", 5))
  expect(next.snapshot).toBeNull()
  expect(next.failureCount).toBe(0)
  const lease = present(await first.catalogs.tryAcquire(next.identity))
  expect(present(await first.catalogs.read("catalog", 5)).snapshot).toBeNull()
  expect(await first.catalogs.tryAcquire(initial.identity, { explicit: true })).toBeNull()
  await first.catalogs.publish(lease, { object: "list", data: [] })
  expect(present(await first.catalogs.read("catalog", 5)).snapshot?.models.data).toEqual([])
})

test("malformed catalog publication and unsafe error categories cannot alter leased state", async () => {
  const { first, a } = fixture()
  await first.upstreams.save(upstream())
  const identity = present(await first.catalogs.read("catalog", 5)).identity
  const lease = present(await first.catalogs.tryAcquire(identity))
  await expect(first.catalogs.publish(lease, { object: "list", data: [{ id: "" }] })).rejects.toThrow("Invalid")
  // JavaScript/HTTP-boundary misuse must not persist arbitrary exception text.
  const unsafe: unknown = "token=synthetic-secret"
  await expect(Reflect.apply(first.catalogs.recordFailure, first.catalogs, [lease, unsafe])).rejects.toThrow("Invalid")
  expect(present(await first.catalogs.read("catalog", 5)).lease?.token).toBe(lease.token)
  expect(JSON.stringify(a.query("SELECT * FROM model_catalogs").all())).not.toContain("synthetic-secret")
})

test("built-in direct routes never inherit a same-named proxy dependency", async () => {
  const { first } = fixture()
  await first.upstreams.save({ ...upstream(), proxyFallbackList: [{ id: "direct_fetch" }, { id: "direct_connect" }] })
  const before = present(await first.catalogs.read("catalog", 5))
  await first.proxies.save({ id: "direct_fetch", name: "ignored", url: "http://localhost:1", dialTimeoutSeconds: 1 })
  await first.proxies.save({ id: "direct_connect", name: "ignored", url: "http://localhost:2", dialTimeoutSeconds: 2 })
  let after = present(await first.catalogs.read("catalog", 5))
  expect(after.identity).toEqual(before.identity)
  expect(after.proxies).toEqual([])
  await first.proxies.patch("direct_fetch", { url: "http://localhost:3" })
  await first.proxies.deleteAll()
  after = present(await first.catalogs.read("catalog", 5))
  expect(after.identity).toEqual(before.identity)
})

test("publication sequence orders successful snapshots independently of clock resolution", async () => {
  const { first, second } = fixture()
  await first.upstreams.save(upstream())
  const identity = present(await first.catalogs.read("catalog", 5)).identity
  const earlier = present(await first.catalogs.publish(present(await first.catalogs.tryAcquire(identity)), models))
  const later = present(await second.catalogs.publish(present(await second.catalogs.tryAcquire(identity)), { object: "list", data: [{ id: "later" }] }))
  expect(earlier.publicationVersion).toBe(1)
  expect(later.publicationVersion).toBe(2)
  expect(present(await first.catalogs.read("catalog", 5)).snapshot?.publicationVersion).toBe(2)
})

test("persistent retries grow exponentially with bounded jitter and a five-minute cap", async () => {
  const { first } = fixture()
  await first.upstreams.save(upstream())
  const identity = present(await first.catalogs.read("catalog", 5)).identity
  for (const [index, bounds] of [[24_000, 36_000], [48_000, 72_000], [96_000, 144_000], [192_000, 288_000], [300_000, 300_000], [300_000, 300_000]].entries()) {
    const lease = present(await first.catalogs.tryAcquire(identity, { explicit: true }))
    const failure = present(await first.catalogs.recordFailure(lease, "upstream_error"))
    const read = present(await first.catalogs.read("catalog", 5))
    expect(failure.failureCount).toBe(index + 1)
    expect(failure.retryAtMs - read.databaseNowMs).toBeGreaterThanOrEqual(present(bounds[0]) - 1000)
    expect(failure.retryAtMs - read.databaseNowMs).toBeLessThanOrEqual(present(bounds[1]))
  }
})

test("explicit credential CAS rejects a sibling state write after the initial SQL read", async () => {
  const { first, second, a } = fixture()
  await first.upstreams.save(upstream())
  const target = present(await first.upstreams.getById("catalog"))
  let once = false
  const raced = withReadBarrier(a, async () => {
    if (once) return
    once = true
    await second.upstreams.saveState("catalog", () => ({ winner: true }))
  })
  await expect(raced.upstreams.replaceCredentials(target, { config: target.config, state: { loser: true } }))
    .rejects.toMatchObject({ name: "UpstreamContentionError" })
  expect(await second.upstreams.getById("catalog")).toMatchObject({ catalogGeneration: 0, state: { winner: true } })
})

test("ordinary provider rotation during a held catalog lease keeps publication eligible", async () => {
  const { first, second } = fixture()
  await first.upstreams.save({ ...upstream(), provider: "codex", config: { accounts: [{ chatgptAccountId: "synthetic" }] } })
  const observed = present(await first.catalogs.read("catalog", 5))
  const lease = present(await first.catalogs.tryAcquire(observed.identity))
  await second.upstreams.saveState("catalog", () => ({ accounts: [{ refresh_token: "rotated", accessToken: { token: "rotated" }, quotaSnapshot: { used: 1 }, state: "active" }] }))
  expect(present(await first.catalogs.read("catalog", 5)).identity).toEqual(observed.identity)
  expect(await first.catalogs.publish(lease, models)).not.toBeNull()
})

test("malformed persisted snapshot timing cannot be treated as an accepted catalog", async () => {
  const { first, a } = fixture()
  await first.upstreams.save(upstream())
  const identity = present(await first.catalogs.read("catalog", 5)).identity
  await first.catalogs.publish(present(await first.catalogs.tryAcquire(identity)), models)
  a.exec("UPDATE model_catalogs SET refreshed_at_ms = 'invalid'")
  expect(present(await first.catalogs.read("catalog", 5)).snapshot).toBeNull()
})
