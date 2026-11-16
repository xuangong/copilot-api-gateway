import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { UpstreamId, UserId } from "../src/repo/branded-ids"
import { syncLock } from "../src/sync/lock"
import { connectSource, disconnectSource, runScheduledSync, syncSource, withSyncLock, type SyncDeps } from "../src/sync/engine"
import { syncDocument, type SyncedUpstream } from "../src/sync/protocol"

let db: Database
let repo: BunSqliteRepo
let clock = Date.parse("2026-11-16T10:00:00.000Z")
beforeEach(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db); clock = Date.parse("2026-11-16T10:00:00.000Z") })
afterEach(() => db.close())

const deviceId = `sdv_${"1".repeat(32)}`
const secret = `sds_${"2".repeat(64)}`
const doc = syncDocument("https://central.example", deviceId, secret)
const owner = "device-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const entry = (id: string, over: Partial<SyncedUpstream> = {}): SyncedUpstream => ({
  id, provider: "copilot", name: id, config: { githubToken: `token-${id}` }, state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over,
})

/** A scripted central gateway. */
function central(entries: SyncedUpstream[] = [], forDevice = deviceId) {
  const script = { entries, mode: "ok" as "ok" | "revoked" | "generic401" | "down" | "error" | "garbage", calls: 0, sentEtags: [] as Array<string | null> }
  const fetcher = async (_url: string, init: RequestInit) => {
    script.calls++
    const sent = new Headers(init.headers).get("if-none-match")
    script.sentEtags.push(sent)
    if (script.mode === "down") throw new Error("network down")
    if (script.mode === "revoked") return new Response('{"error":{"code":"invalid_device"}}', { status: 401 })
    if (script.mode === "generic401") return new Response(null, { status: 401 })
    if (script.mode === "error") return new Response("boom", { status: 500 })
    if (script.mode === "garbage") return new Response("not json")
    const body = JSON.stringify({ version: 1, deviceId: forDevice, upstreams: script.entries })
    const etag = `"${sha256(body)}"`
    return sent === etag ? new Response(null, { status: 304 }) : new Response(body, { status: 200 })
  }
  return { script, fetcher }
}
const deps = (fetcher: SyncDeps["fetcher"]): SyncDeps => ({ repo, fetcher, now: () => clock, isKnownProvider: kind => kind === "copilot" || kind === "loki" })
const ids = async () => (await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()
const connect = (fetcher: SyncDeps["fetcher"], mode: "create" | "replace" = "create", document = doc) =>
  connectSource({ mode, ownerId: owner, document }, deps(fetcher))

test("connecting fetches first, stores the source for the connecting user and applies the snapshot", async () => {
  const { script, fetcher } = central([entry("up_a"), entry("up_b")])
  const outcome = await connect(fetcher)
  expect(outcome.kind).toBe("connected")
  expect(script.sentEtags).toEqual([null])
  const source = (await repo.syncSources.get())!
  expect(source).toMatchObject({ ownerId: owner, origin: "https://central.example", deviceId, secret, status: "active", lastError: null,
    lastSuccessAt: "2026-11-16T10:00:00.000Z" })
  expect(source.etag).toMatch(/^"[a-f0-9]{64}"$/)
  expect(await ids()).toEqual(["up_a", "up_b"])
  expect((await repo.upstreams.getById("up_a" as UpstreamId))).toMatchObject({ ownerId: owner, syncSourceId: source.id })
})

test("a revoked, unreachable or malformed central stores nothing, and an existing source is refused before any request", async () => {
  for (const [mode, expected] of [["revoked", "invalid_document"], ["down", "unreachable"], ["error", "unreachable"], ["garbage", "unreachable"]] as const) {
    const { script, fetcher } = central([entry("up_a")])
    script.mode = mode
    expect((await connect(fetcher)).kind).toBe(expected)
    expect(await repo.syncSources.get()).toBeNull()
    expect(await ids()).toEqual([])
  }
  const live = central([entry("up_a")])
  await connect(live.fetcher)
  const before = live.script.calls
  expect((await connect(live.fetcher)).kind).toBe("exists")
  expect(live.script.calls).toBe(before)
})

test("an unchanged central answers 304 and the sync only records the attempt", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  const etag = (await repo.syncSources.get())!.etag
  clock += 60_000
  expect(await syncSource(deps(fetcher))).toBe("not_modified")
  expect(script.sentEtags.at(-1)).toBe(etag)
  expect(await repo.syncSources.get()).toMatchObject({ etag, lastAttemptAt: "2026-11-16T10:01:00.000Z", lastSuccessAt: "2026-11-16T10:01:00.000Z", lastError: null })
})

test("a changed snapshot adds, updates and removes upstreams and stores the new ETag", async () => {
  const { script, fetcher } = central([entry("up_a"), entry("up_b")])
  await connect(fetcher)
  const firstEtag = (await repo.syncSources.get())!.etag
  script.entries = [entry("up_b", { name: "Renamed" }), entry("up_c")]
  expect(await syncSource(deps(fetcher))).toBe("applied")
  expect(await ids()).toEqual(["up_b", "up_c"])
  expect((await repo.upstreams.getById("up_b" as UpstreamId))?.name).toBe("Renamed")
  expect((await repo.syncSources.get())!.etag).not.toBe(firstEtag)
})

test("failures keep the last snapshot, record a fixed code and recover on the next tick", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  for (const [mode, code] of [["down", "unreachable"], ["error", "http_error"], ["garbage", "bad_response"]] as const) {
    script.mode = mode
    expect(await syncSource(deps(fetcher))).toBe("failed")
    expect(await repo.syncSources.get()).toMatchObject({ lastError: code, status: "active" })
    expect(await ids()).toEqual(["up_a"])
  }
  script.mode = "ok"
  expect(await syncSource(deps(fetcher))).toBe("not_modified")
  expect((await repo.syncSources.get())!.lastError).toBeNull()
})

test("a 401 removes the synced upstreams, marks the source revoked and stops polling until a document is re-imported", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  await repo.upstreams.save({ id: "up_local", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  script.mode = "revoked"
  expect(await syncSource(deps(fetcher))).toBe("revoked")
  expect(await ids()).toEqual(["up_local"])
  expect(await repo.syncSources.get()).toMatchObject({ status: "revoked", etag: null })
  const calls = script.calls
  expect(await syncSource(deps(fetcher))).toBe("idle")
  expect(script.calls).toBe(calls)
  script.mode = "ok"
  const replaced = await connect(fetcher, "replace")
  expect(replaced.kind).toBe("connected")
  expect(await repo.syncSources.get()).toMatchObject({ status: "active", lastError: null })
  expect(await ids()).toEqual(["up_a", "up_local"])
})

test("a generic 401 without invalid_device keeps the synced upstreams and the source active", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  script.mode = "generic401"
  expect(await syncSource(deps(fetcher))).toBe("failed")
  expect(await ids()).toEqual(["up_a"])
  expect(await repo.syncSources.get()).toMatchObject({ status: "active", lastError: "http_error" })
})

test("a 401 for a source replaced in flight deletes nothing", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  script.mode = "revoked"
  const swapping: typeof fetcher = async (url, init) => {
    const response = await fetcher(url, init)
    await repo.syncSources.replaceDocument((await repo.syncSources.get())!.id, { origin: "https://central.example", deviceId: `sdv_${"9".repeat(32)}`, secret: `sds_${"9".repeat(64)}` }, stamp)
    return response
  }
  expect(await syncSource(deps(swapping))).toBe("idle")
  expect(await ids()).toEqual(["up_a"])
  expect(await repo.syncSources.get()).toMatchObject({ status: "active" })
})

test("the default provider check accepts only syncable providers; a previously synced row of another provider is deleted", async () => {
  const { script, fetcher } = central([entry("up_a"), entry("up_codex", { provider: "codex", config: {} }), entry("up_custom", { provider: "custom", config: {} })])
  const real: SyncDeps = { repo, fetcher, now: () => clock }
  expect((await connectSource({ mode: "create", ownerId: owner, document: doc }, real)).kind).toBe("connected")
  expect(await ids()).toEqual(["up_a"])
  expect(await repo.syncSources.get()).toMatchObject({ lastError: "unsupported_provider", etag: null })
  // D18: a row of a provider that is known but not syncable is removed on the next sync.
  const id = (await repo.syncSources.get())!.id
  await repo.upstreams.applySynced(id, { id: "up_old", ownerId: owner, provider: "custom", name: "old", config: {}, state: null, flagOverrides: {}, disabledPublicModelIds: [] }, stamp)
  expect(await ids()).toEqual(["up_a", "up_old"])
  script.entries = [entry("up_a"), entry("up_custom", { provider: "custom", config: {} })]
  expect(await syncSource(real)).toBe("applied")
  expect(await ids()).toEqual(["up_a"])
})

test("skipped entries are recorded and the ETag is withheld so they are retried", async () => {
  await repo.upstreams.save({ id: "up_clash", ownerId: owner, provider: "custom", name: "Clash", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const { script, fetcher } = central([entry("up_clash"), entry("up_future", { provider: "future" }), entry("up_ok")])
  await connect(fetcher)
  expect(await repo.syncSources.get()).toMatchObject({ lastError: "id_conflict", etag: null })
  expect(await ids()).toEqual(["up_clash", "up_ok"])
  expect(await syncSource(deps(fetcher))).toBe("applied")
  expect(script.sentEtags.at(-1)).toBeNull()
  await repo.upstreams.delete("up_clash" as UpstreamId)
  script.entries = [entry("up_clash"), entry("up_ok")]
  expect(await syncSource(deps(fetcher))).toBe("applied")
  expect(await repo.syncSources.get()).toMatchObject({ lastError: null })
  expect((await repo.syncSources.get())!.etag).not.toBeNull()
  expect(await ids()).toEqual(["up_clash", "up_ok"])
})

test("an apply failure clears the ETag, records apply_failed and the next tick refetches without If-None-Match", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  expect((await repo.syncSources.get())!.etag).not.toBeNull()
  script.entries = [entry("up_a"), entry("up_b")]
  const original = repo.upstreams.applySynced.bind(repo.upstreams)
  repo.upstreams.applySynced = async () => { throw new Error("storage down") }
  expect(await syncSource(deps(fetcher))).toBe("failed")
  expect(await repo.syncSources.get()).toMatchObject({ etag: null, lastError: "apply_failed" })
  repo.upstreams.applySynced = original
  expect(await syncSource(deps(fetcher))).toBe("applied")
  expect(script.sentEtags.at(-1)).toBeNull()
  expect(await ids()).toEqual(["up_a", "up_b"])
})

test("a source deleted while its fetch is in flight is not re-created by the tick", async () => {
  const live = central([entry("up_a")])
  await connect(live.fetcher)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  live.script.entries = [entry("up_a"), entry("up_b")]
  const blocked: SyncDeps["fetcher"] = async (url, init) => { await gate; return live.fetcher(url, init) }
  const tick = syncSource(deps(blocked))
  await new Promise(resolve => setTimeout(resolve, 0))
  const source = (await repo.syncSources.get())!
  await repo.upstreams.deleteSynced(source.id)
  await repo.syncSources.delete(source.id)
  release()
  expect(await tick).toBe("idle")
  expect(await ids()).toEqual([])
  expect(await repo.syncSources.get()).toBeNull()
})

test("replacing the document swaps the secret, prunes absent upstreams and keeps ownership; a failed replace changes nothing", async () => {
  const first = central([entry("up_a"), entry("up_b")])
  await connect(first.fetcher)
  const before = (await repo.syncSources.get())!
  const other = syncDocument("https://other.example", `sdv_${"3".repeat(32)}`, `sds_${"4".repeat(64)}`)
  const second = central([entry("up_b"), entry("up_z")], other.deviceId)
  const replace = () => connectSource({ mode: "replace", ownerId: "someone-else" as UserId, document: other }, deps(second.fetcher))
  for (const [mode, kind] of [["down", "unreachable"], ["revoked", "invalid_document"]] as const) {
    second.script.mode = mode
    expect((await replace()).kind).toBe(kind)
    expect(await repo.syncSources.get()).toEqual(before)
    expect(await ids()).toEqual(["up_a", "up_b"])
  }
  second.script.mode = "ok"
  expect((await replace()).kind).toBe("connected")
  expect(await repo.syncSources.get()).toMatchObject({ id: before.id, ownerId: owner, origin: "https://other.example",
    secret: other.deviceSecret, status: "active" })
  expect(await ids()).toEqual(["up_b", "up_z"])
})

test("replacing without a source is not found, and disconnecting deletes the source and every synced upstream", async () => {
  const { fetcher } = central([entry("up_a")])
  expect((await connect(fetcher, "replace")).kind).toBe("not_found")
  expect(await disconnectSource(deps(fetcher))).toBe(false)
  await connect(fetcher)
  await repo.upstreams.save({ id: "up_local", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  expect(await disconnectSource(deps(fetcher))).toBe(true)
  expect(await repo.syncSources.get()).toBeNull()
  expect(await ids()).toEqual(["up_local"])
})

test("one sync runs at a time: a scheduled tick skips while a connect holds the lock", async () => {
  const live = central([entry("up_a")])
  await connect(live.fetcher)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const slow = withSyncLock(async () => { await gate; return "done" })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(await runScheduledSync(deps(live.fetcher))).toBe("busy")
  release()
  expect(await slow).toBe("done")
  expect(await runScheduledSync(deps(live.fetcher))).toBe("not_modified")
})

test("a release closure is idempotent: a double release neither hands the lock on nor unlocks it", async () => {
  const first = syncLock.tryAcquire()!
  first()
  const second = syncLock.tryAcquire()!
  expect(second).not.toBeNull()
  first()
  expect(syncLock.tryAcquire()).toBeNull()
  let got = false
  const waiter = syncLock.acquire().then(release => { got = true; return release })
  await new Promise(resolve => setTimeout(resolve, 0))
  first()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(got).toBe(false)
  second()
  ;(await waiter)()
  const last = syncLock.tryAcquire()
  expect(last).not.toBeNull()
  last!()
  expect(syncLock.waiting).toBe(0)
})
