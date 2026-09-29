import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, readdirSync, mkdirSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"
import { migrationsDir } from "@vibe-llm/gateway/migrations"
import { fileURLToPath } from "node:url"
import { applyMigrations } from "@vibe-llm/platform-bun/src/migrate.ts"

const resources: Array<() => void> = []
afterEach(() => { for (const close of resources.splice(0)) close() })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "upstream-cas-"))
  const a = new Database(join(dir, "test.sqlite"))
  const first = new BunSqliteRepo(a)
  const b = new Database(join(dir, "test.sqlite"))
  const second = new BunSqliteRepo(b)
  resources.push(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) })
  return { a, b, first, second }
}

function upstream(state: unknown = { access: "old", quota: 1 }): UpstreamRecord<unknown> {
  return {
    id: "up_cas", ownerId: "owner", provider: "copilot", name: "before", enabled: true,
    sortOrder: 0, config: { githubToken: "private", accountType: "individual" },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state,
    createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
  }
}

test("state CAS replays a pure update and preserves a sibling connection's quota", async () => {
  const { first, second, b } = fixture()
  await first.upstreams.save(upstream())
  let calls = 0
  await first.upstreams.saveState<{ access: string; quota: number }>("up_cas", current => {
    if (++calls === 1) b.query("UPDATE upstreams SET state_json = ? WHERE id = ?").run('{"access":"old","quota":9}', "up_cas")
    return { ...current, access: "rotated" }
  })
  expect(calls).toBe(2)
  expect((await second.upstreams.getById("up_cas"))?.state).toEqual({ access: "rotated", quota: 9 })
})

test("CAS compares raw bytes and handles NULL while avoiding unchanged writes", async () => {
  const { first, second, b } = fixture()
  await first.upstreams.save(upstream(null))
  await first.upstreams.saveState("up_cas", () => ({ access: "first" }))
  const before = await first.configurationRevision?.()
  await first.upstreams.saveState("up_cas", current => current)
  expect(await first.configurationRevision?.()).toBe(before)
  let calls = 0
  await first.upstreams.saveState<{ access: string }>("up_cas", current => {
    if (++calls === 1) b.query("UPDATE upstreams SET state_json = ? WHERE id = ?").run('{ "access": "first" }', "up_cas")
    return { ...current, access: "next" }
  })
  expect(calls).toBe(2)
  expect((await second.upstreams.getById("up_cas"))?.state).toEqual({ access: "next" })
})

for (const unchanged of [false, true]) {
  test(`same timestamp and state recreation rejects the old ${unchanged ? "no-op" : "write"} target`, async () => {
    const { first, second, b } = fixture()
    await first.upstreams.save(upstream())
    const original = await first.upstreams.getById("up_cas")
    const pending = first.upstreams.saveState<{ access: string; quota: number }>("up_cas", current => {
      b.exec("CREATE TEMP TABLE replacement AS SELECT * FROM upstreams; DELETE FROM upstreams")
      b.exec("INSERT INTO upstreams (id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at) SELECT id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at FROM replacement")
      return unchanged ? current : { ...current, access: "must-not-write" }
    })
    await expect(pending).rejects.toMatchObject({ name: "UpstreamReplacedError" })
    const replacement = await second.upstreams.getById("up_cas")
    expect(replacement?.rowIncarnation).not.toBe(original?.rowIncarnation)
    expect(replacement?.createdAt).toBe(original?.createdAt)
    expect(replacement?.state).toEqual(original?.state)
  })
}

test("missing and deleted rows report gone instead of a successful write", async () => {
  const { first, b } = fixture()
  await expect(first.upstreams.saveState("missing", () => ({}))).rejects.toMatchObject({ name: "UpstreamGoneError" })
  await first.upstreams.save(upstream())
  await expect(first.upstreams.saveState("up_cas", current => {
    b.query("DELETE FROM upstreams WHERE id = ?").run("up_cas")
    return current
  })).rejects.toMatchObject({ name: "UpstreamGoneError" })
})

test("continued state contention is bounded without overwriting the winner", async () => {
  const { first, second, b } = fixture()
  await first.upstreams.save(upstream())
  let calls = 0
  await expect(first.upstreams.saveState("up_cas", () => {
    b.query("UPDATE upstreams SET state_json = ? WHERE id = ?").run(JSON.stringify({ winner: ++calls }), "up_cas")
    return { loser: true }
  })).rejects.toMatchObject({ name: "UpstreamContentionError" })
  expect(calls).toBeGreaterThan(1)
  expect(calls).toBeLessThanOrEqual(10)
  expect((await second.upstreams.getById("up_cas"))?.state).toEqual({ winner: calls })
})

test("metadata CAS rebases a sibling patch and returns its latest private state untouched", async () => {
  const { first, second, b } = fixture()
  await first.upstreams.save(upstream())
  const target = await first.upstreams.getById("up_cas")
  if (!target) throw new Error("fixture absent")
  let calls = 0
  const saved = await first.upstreams.patchMetadata(target, current => {
    if (++calls === 1) b.query("UPDATE upstreams SET name = ?, state_json = ? WHERE id = ?").run("sibling", '{"quota":22}', "up_cas")
    return { ...current, enabled: false }
  })
  expect(calls).toBe(2)
  expect(saved).toMatchObject({ name: "sibling", enabled: false, state: { quota: 22 } })
  expect(await second.upstreams.getById("up_cas")).toEqual(saved)
})

test("metadata authorization fences owner and incarnation across stale reads", async () => {
  const { first, second, b } = fixture()
  await first.upstreams.save(upstream())
  const target = await first.upstreams.getById("up_cas")
  if (!target) throw new Error("fixture absent")
  b.query("UPDATE upstreams SET owner_id = ? WHERE id = ?").run("other", "up_cas")
  await expect(first.upstreams.patchMetadata(target, row => ({ ...row, name: "stale" })))
    .rejects.toMatchObject({ name: "UpstreamReplacedError" })
  await second.upstreams.delete("up_cas")
  await second.upstreams.save(upstream())
  await expect(first.upstreams.patchMetadata(target, row => ({ ...row, name: "stale" })))
    .rejects.toMatchObject({ name: "UpstreamReplacedError" })
  expect((await second.upstreams.getById("up_cas"))?.name).toBe("before")
})

test("create-if-absent cannot overwrite a concurrent credential or owner", async () => {
  const { first, second } = fixture()
  const inserted = await first.upstreams.createIfAbsent(upstream())
  expect(inserted?.rowIncarnation).toMatch(/^[a-f0-9]{32}$/)
  expect(await second.upstreams.createIfAbsent({ ...upstream(), ownerId: "other", state: { erased: true } })).toBeNull()
  expect((await first.upstreams.getById("up_cas"))?.state).toEqual({ access: "old", quota: 1 })
})

test("row incarnation is immutable and full saves explicitly replace state without replacing row identity", async () => {
  const { first, a } = fixture()
  await first.upstreams.save(upstream())
  const original = await first.upstreams.getById("up_cas")
  expect(original?.rowIncarnation).toMatch(/^[a-f0-9]{32}$/)
  expect(() => a.query("UPDATE upstreams SET row_incarnation = ? WHERE id = ?").run("changed", "up_cas")).toThrow()
  await first.upstreams.save(upstream({ imported: true }))
  expect(await first.upstreams.getById("up_cas")).toMatchObject({ rowIncarnation: original?.rowIncarnation, state: { imported: true } })
})

test("two repository handles concurrently increment state without losing updates", async () => {
  const { first, second } = fixture()
  await first.upstreams.save(upstream({ count: 0 }))
  await Promise.all([first, second, first, second].map(repo =>
    repo.upstreams.saveState<{ count: number }>("up_cas", current => ({ count: current.count + 1 }))))
  expect((await second.upstreams.getById("up_cas"))?.state).toEqual({ count: 4 })
})

test("a no-op rechecks a changed state but does not update timestamps", async () => {
  const { first, second, b } = fixture()
  await first.upstreams.save(upstream())
  let calls = 0
  await first.upstreams.saveState("up_cas", current => {
    if (++calls === 1) b.query("UPDATE upstreams SET state_json = ? WHERE id = ?").run('{"winner":true}', "up_cas")
    return current
  })
  expect(calls).toBe(2)
  expect(await second.upstreams.getById("up_cas")).toMatchObject({ state: { winner: true }, updatedAt: "2026-09-29T00:00:00.000Z" })
})

test("metadata contention stops boundedly and metadata updater cannot write private state", async () => {
  const { first, second, b } = fixture()
  await first.upstreams.save(upstream())
  const target = await first.upstreams.getById("up_cas")
  if (!target) throw new Error("fixture absent")
  const saved = await first.upstreams.patchMetadata(target, current => ({ ...current, state: { erased: true }, provider: "custom", createdAt: "wrong" }))
  expect(saved).toMatchObject({ provider: "copilot", createdAt: target.createdAt, state: target.state })
  let calls = 0
  await expect(first.upstreams.patchMetadata(target, current => {
    b.query("UPDATE upstreams SET name = ? WHERE id = ?").run(`winner-${++calls}`, "up_cas")
    return { ...current, name: "loser" }
  })).rejects.toMatchObject({ name: "UpstreamContentionError" })
  expect(calls).toBeGreaterThan(1)
  expect(calls).toBeLessThanOrEqual(10)
  expect((await second.upstreams.getById("up_cas"))?.name).toBe(`winner-${calls}`)
  await second.upstreams.delete("up_cas")
  await expect(first.upstreams.patchMetadata(target, current => current)).rejects.toMatchObject({ name: "UpstreamGoneError" })
})

test("owner change during metadata CAS and an explicitly fenced state write reject stale authorization", async () => {
  const { first, b } = fixture()
  await first.upstreams.save(upstream())
  const target = await first.upstreams.getById("up_cas")
  if (!target) throw new Error("fixture absent")
  await expect(first.upstreams.patchMetadata(target, current => {
    b.query("UPDATE upstreams SET owner_id = ? WHERE id = ?").run("other", "up_cas")
    return { ...current, name: "hijacked" }
  })).rejects.toMatchObject({ name: "UpstreamReplacedError" })
  await expect(first.upstreams.saveState("up_cas", () => ({ erased: true }), target)).rejects.toMatchObject({ name: "UpstreamReplacedError" })
})

test("incarnation migration retains legacy credentials byte-for-byte and initializes old INSERT callers", () => {
  const dir = mkdtempSync(join(tmpdir(), "upstream-upgrade-"))
  const legacy = join(dir, "legacy")
  mkdirSync(legacy)
  const source = fileURLToPath(migrationsDir)
  for (const name of readdirSync(source).filter(name => name.endsWith(".sql") && name < "0017")) copyFileSync(join(source, name), join(legacy, name))
  const db = new Database(join(dir, "upgrade.sqlite"))
  resources.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  applyMigrations(db, legacy)
  const state = '{ "refresh_token": "historical-credential", "quota": 10 }'
  db.query("INSERT INTO upstreams (id, provider, name, config_json, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("legacy", "copilot", "legacy", '{"githubToken":"historical-token"}', state, "same", "same")
  // The migration is applied by the real runtime bootstrap, not a schema fake.
  new BunSqliteRepo(db)
  const row = db.query<{ state_json: string; config_json: string; row_incarnation: string }, []>("SELECT state_json, config_json, row_incarnation FROM upstreams WHERE id = 'legacy'").get()
  expect(row).toMatchObject({ state_json: state, config_json: '{"githubToken":"historical-token"}' })
  expect(row?.row_incarnation).toMatch(/^[a-f0-9]{32}$/)
  db.exec("INSERT INTO upstreams (id, provider, name, created_at, updated_at) VALUES ('old-insert', 'copilot', 'old', 'same', 'same')")
  const inserted = db.query<{ row_incarnation: string }, []>("SELECT row_incarnation FROM upstreams WHERE id = 'old-insert'").get()
  expect(inserted?.row_incarnation).toMatch(/^[a-f0-9]{32}$/)
  expect(inserted?.row_incarnation).not.toBe(row?.row_incarnation)
})

test("async updaters are rejected before any state write", async () => {
  const { first, second } = fixture()
  await first.upstreams.save(upstream())
  await expect(first.upstreams.saveState<unknown>("up_cas", async current => current)).rejects.toThrow("synchronous")
  expect((await second.upstreams.getById("up_cas"))?.state).toEqual({ access: "old", quota: 1 })
})
