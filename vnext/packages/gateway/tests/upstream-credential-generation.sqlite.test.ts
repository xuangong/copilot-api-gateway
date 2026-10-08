import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { applyMigrations } from "@vibe-llm/platform-bun/src/migrate.ts"
import type { StoredUpstreamRecord, UpstreamRecord } from "../src/repo/types.ts"
import type { SqlExecutor } from "../src/repo/shared/executor.ts"
import { buildSharedRepo } from "../src/repo/shared/repos.ts"
import { migrationsDir } from "../src/migrations-dir.ts"

const resources: Array<() => void> = []
afterEach(() => { for (const close of resources.splice(0)) close() })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "upstream-credentials-"))
  const a = new Database(join(dir, "shared.sqlite"))
  const first = new BunSqliteRepo(a)
  const b = new Database(join(dir, "shared.sqlite"))
  const second = new BunSqliteRepo(b)
  resources.push(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) })
  return { a, b, first, second }
}

function upstream(ownerId?: string): UpstreamRecord<unknown> {
  return {
    id: "credential-generation", ownerId, provider: "claude-code", name: "display", enabled: true,
    sortOrder: 0, config: {}, state: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", quota: 1 },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
    createdAt: "same", updatedAt: "same",
  }
}

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("fixture absent")
  return value
}

function observedRepo(db: Database, hooks: {
  beforeRead?: (read: number) => Promise<void>
  afterRead?: (read: number) => Promise<void>
} = {}) {
  const statements: string[] = []
  let reads = 0
  const binds = (values: unknown[]) => values.map(value => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint"
      || typeof value === "boolean" || value === null || value instanceof Uint8Array) return value
    throw new TypeError("Unsupported fixture SQL bind")
  })
  const executor: SqlExecutor = {
    async all<T>(sql: string, values: unknown[]) {
      statements.push(sql)
      return db.query(sql).all(...binds(values)) as T[]
    },
    async first<T>(sql: string, values: unknown[]) {
      statements.push(sql)
      const fullRead = sql.startsWith("SELECT") && sql.includes("created_at") && sql.includes("FROM upstreams")
      if (fullRead) {
        reads++
        await hooks.beforeRead?.(reads)
      }
      const row = db.query(sql).get(...binds(values)) as T | null
      if (fullRead) await hooks.afterRead?.(reads)
      return row
    },
    async run(sql: string, values: unknown[]) {
      statements.push(sql)
      return { changes: Number(db.query(sql).run(...binds(values)).changes) }
    },
  }
  return { repo: buildSharedRepo(executor), statements }
}

function lease(row: StoredUpstreamRecord) {
  return {
    rowIncarnation: row.rowIncarnation, ownerId: row.ownerId, provider: row.provider,
    credentialGeneration: row.credentialGeneration,
  }
}

for (const ownerId of [undefined, "owner"]) {
  const owner = ownerId ?? "ownerless"

  test(`${owner}: creates start at zero and every full credential replacement advances both generations`, async () => {
    const { first, second } = fixture()
    const input = upstream(ownerId)
    const created = present(await first.upstreams.createIfAbsent(input))
    expect(created).toMatchObject({ credentialGeneration: 0, catalogGeneration: 0 })
    expect(await second.upstreams.createIfAbsent(input)).toBeNull()
    const replaced = await second.upstreams.replaceCredentials(created, { config: created.config, state: created.state })
    expect(replaced).toMatchObject({ credentialGeneration: 1, catalogGeneration: 1, rowIncarnation: created.rowIncarnation })
    await first.upstreams.save(input)
    expect(await second.upstreams.getById(input.id)).toMatchObject({ credentialGeneration: 2, catalogGeneration: 2 })
    await first.upstreams.save({ ...input, state: { imported: true } })
    expect(await second.upstreams.getById(input.id)).toMatchObject({ credentialGeneration: 3, catalogGeneration: 3, state: { imported: true } })
    await first.upstreams.save({ ...input, id: "save-created" })
    expect(await second.upstreams.getById("save-created")).toMatchObject({ credentialGeneration: 0, catalogGeneration: 0 })
  })

  test(`${owner}: metadata, configuration, proxies and quota preserve a credential lease`, async () => {
    const { b, first, second } = fixture()
    const created = present(await first.upstreams.createIfAbsent(upstream(ownerId)))
    const patched = await second.upstreams.patchMetadata(created, row => ({
      ...row, name: "renamed", config: { baseUrl: "https://example.invalid" },
      proxyFallbackList: [{ id: "proxy" }],
    }))
    expect(patched).toMatchObject({ credentialGeneration: 0, catalogGeneration: 1 })
    await second.proxies.save({ id: "proxy", name: "proxy", url: "http://localhost:1", dialTimeoutSeconds: 1 })
    await second.proxies.save({ id: "proxy", name: "proxy", url: "http://localhost:2", dialTimeoutSeconds: 1 })
    expect(await second.proxies.delete("proxy")).toBe(false)
    b.query("DELETE FROM proxies WHERE id = ?").run("proxy")
    await first.upstreams.saveState(created.id, () => ({ quota: 9 }), lease(created))
    const updated = present(await second.upstreams.getById(created.id))
    expect(updated).toMatchObject({ credentialGeneration: 0, catalogGeneration: 4, state: { quota: 9 } })
    await first.upstreams.saveState(created.id, current => current, lease(created))
    expect(await second.upstreams.getById(created.id)).toEqual(updated)
  })

  for (const mode of ["replace", "save"] as const) {
    test(`${owner}: a stale lease rejects same-byte ${mode} before invoking its updater`, async () => {
      const { first, second } = fixture()
      const created = present(await first.upstreams.createIfAbsent(upstream(ownerId)))
      if (mode === "replace") await second.upstreams.replaceCredentials(created, { config: created.config, state: created.state })
      else await second.upstreams.save(created)
      let calls = 0
      await expect(first.upstreams.saveState(created.id, () => { calls++; return { stale: true } }, lease(created)))
        .rejects.toMatchObject({ name: "UpstreamReplacedError" })
      expect(calls).toBe(0)
      expect((await second.upstreams.getById(created.id))?.state).toEqual(created.state)
    })
  }

  for (const noOp of [false, true]) {
    test(`${owner}: a same-byte replacement after the read rejects a leased ${noOp ? "no-op" : "write"}`, async () => {
      const { a, first, second } = fixture()
      const created = present(await first.upstreams.createIfAbsent(upstream(ownerId)))
      const { repo } = observedRepo(a, { afterRead: async read => {
        if (read === 1) await second.upstreams.replaceCredentials(created, { config: created.config, state: created.state })
      } })
      let calls = 0
      await expect(repo.upstreams.saveState(created.id, current => {
        calls++
        return noOp ? current : { stale: true }
      }, lease(created))).rejects.toMatchObject({ name: "UpstreamReplacedError" })
      expect(calls).toBe(1)
      expect((await second.upstreams.getById(created.id))?.state).toEqual(created.state)
    })
  }

  test(`${owner}: CAS retries cannot rebase an old lease onto replacement credentials`, async () => {
    const { a, b, first, second } = fixture()
    const created = present(await first.upstreams.createIfAbsent(upstream(ownerId)))
    const { repo } = observedRepo(a, { beforeRead: async read => {
      if (read === 2) {
        const current = present(await second.upstreams.getById(created.id))
        await second.upstreams.replaceCredentials(current, { config: current.config, state: current.state })
      }
    } })
    let calls = 0
    await expect(repo.upstreams.saveState(created.id, () => {
      calls++
      b.query("UPDATE upstreams SET state_json = ? WHERE id = ?").run('{"quota":9}', created.id)
      return { stale: true }
    }, lease(created))).rejects.toMatchObject({ name: "UpstreamReplacedError" })
    expect(calls).toBe(1)
    expect(await second.upstreams.getById(created.id)).toMatchObject({ credentialGeneration: 1, state: { quota: 9 } })
  })

  test(`${owner}: legacy callers may omit the credential fence`, async () => {
    const { first, second } = fixture()
    const created = present(await first.upstreams.createIfAbsent(upstream(ownerId)))
    await second.upstreams.save(created)
    await first.upstreams.saveState(created.id, () => ({ quota: 5 }), {
      rowIncarnation: created.rowIncarnation, ownerId: created.ownerId, provider: created.provider,
    })
    await first.upstreams.saveState(created.id, () => ({ quota: 6 }))
    expect(await second.upstreams.getById(created.id)).toMatchObject({ credentialGeneration: 1, state: { quota: 6 } })
  })

  test(`${owner}: leases retain owner and delete/recreate fences even when generation is unchanged`, async () => {
    const { b, first, second } = fixture()
    const created = present(await first.upstreams.createIfAbsent(upstream(ownerId)))
    b.query("UPDATE upstreams SET owner_id = ? WHERE id = ?").run("other", created.id)
    await expect(first.upstreams.saveState(created.id, () => ({ stale: true }), lease(created)))
      .rejects.toMatchObject({ name: "UpstreamReplacedError" })
    await second.upstreams.delete(created.id)
    await second.upstreams.save(upstream(ownerId))
    expect((await second.upstreams.getById(created.id))?.credentialGeneration).toBe(0)
    await expect(first.upstreams.saveState(created.id, current => current, lease(created)))
      .rejects.toMatchObject({ name: "UpstreamReplacedError" })
  })
}

test("credential generation uses existing read/write statements without extra SQL", async () => {
  const { a, first } = fixture()
  const created = present(await first.upstreams.createIfAbsent(upstream()))
  const { repo, statements } = observedRepo(a)
  await repo.upstreams.getById(created.id)
  expect(statements).toHaveLength(1)
  statements.length = 0
  await repo.upstreams.saveState(created.id, () => ({ quota: 2 }), lease(created))
  expect(statements).toHaveLength(2)
  statements.length = 0
  await repo.upstreams.saveState(created.id, current => current, lease(created))
  expect(statements).toHaveLength(2)
  const current = present(await first.upstreams.getById(created.id))
  statements.length = 0
  await repo.upstreams.replaceCredentials(current, { config: current.config, state: current.state })
  expect(statements).toHaveLength(3)
  statements.length = 0
  await repo.upstreams.save(current)
  expect(statements).toHaveLength(1)
})

test("credential generation migration preserves legacy bytes and old INSERT defaults across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-upgrade-"))
  const legacy = join(dir, "legacy")
  mkdirSync(legacy)
  const source = fileURLToPath(migrationsDir)
  for (const name of readdirSync(source).filter(name => name.endsWith(".sql") && name < "0022")) {
    copyFileSync(join(source, name), join(legacy, name))
  }
  const db = new Database(join(dir, "upgrade.sqlite"))
  resources.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  applyMigrations(db, legacy)
  const state = '{ "refreshToken": "synthetic-legacy", "quota": 10 }'
  const config = '{ "baseUrl": "https://example.invalid" }'
  db.query("INSERT INTO upstreams (id, provider, name, config_json, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("legacy", "claude-code", "legacy", config, state, "same", "same")
  const original = db.query("SELECT row_incarnation, catalog_generation FROM upstreams WHERE id = 'legacy'").get()
  new BunSqliteRepo(db)
  new BunSqliteRepo(db)
  expect(db.query("SELECT row_incarnation, catalog_generation FROM upstreams WHERE id = 'legacy'").get()).toEqual(original)
  expect(db.query("SELECT state_json, config_json, credential_generation FROM upstreams WHERE id = 'legacy'").get())
    .toEqual({ state_json: state, config_json: config, credential_generation: 0 })
  expect(db.query("SELECT name FROM _migrations WHERE name = '0022_upstream_credential_generation.sql'").all()).toHaveLength(1)
  db.exec("INSERT INTO upstreams (id, provider, name, created_at, updated_at) VALUES ('old-insert', 'claude-code', 'old', 'same', 'same')")
  expect(db.query("SELECT credential_generation FROM upstreams WHERE id = 'old-insert'").get()).toEqual({ credential_generation: 0 })
  expect(() => db.exec("UPDATE upstreams SET credential_generation = -1 WHERE id = 'legacy'")).toThrow()
  db.exec("UPDATE upstreams SET credential_generation = 2 WHERE id = 'legacy'")
  expect(() => db.exec("UPDATE upstreams SET credential_generation = 1 WHERE id = 'legacy'")).toThrow()
  expect(() => db.exec("INSERT INTO upstreams (id, provider, name, credential_generation, created_at, updated_at) VALUES ('negative', 'claude-code', 'bad', -1, 'same', 'same')")).toThrow()
})
