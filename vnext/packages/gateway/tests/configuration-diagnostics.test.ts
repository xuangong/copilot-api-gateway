import { expect, spyOn, test } from "bun:test"
import { initBackground } from "@vibe-core/platform"
import { ConfigurationCache, CONFIG_AUTH_LEASE_MS } from "../src/repo/configuration-cache.ts"
import { setupTestPlatform } from "./_setup-platform.ts"
import { app } from "../src/app.ts"

test("configuration diagnostics do not expose internal details in the HTTP response", async () => {
  const { db } = setupTestPlatform()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    db.exec("DROP TABLE configuration_revision")
    const response = await app.request("/responses", { method: "POST" })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { type: "api_error", message: "Gateway configuration temporarily unavailable" },
    })
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ operation: "revision_before", reason: "schema_unavailable" })
  } finally { warn.mockRestore(); db.close() }
})

test.each([
  ["D1_ERROR: database is overloaded: private-credential", "storage_busy"],
  ["D1_ERROR: request timed out: private-credential", "timeout"],
  ["Cannot perform I/O on behalf of a different request: private-credential", "io_context"],
  ["unexpected private-credential", "unknown"],
])("driver errors use a fixed category: %s", async (message, reason) => {
  const { repo, db } = setupTestPlatform()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const list = repo.proxies.list.bind(repo.proxies)
    repo.proxies.list = async () => { await list(); throw new Error(message) }
    await expect(new ConfigurationCache(repo).get()).rejects.toThrow("Gateway configuration temporarily unavailable")
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ operation: "proxies", reason })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-credential")
  } finally { warn.mockRestore(); db.close() }
})

test("a failed shared configuration load logs once without exposing driver text", async () => {
  const { repo, db } = setupTestPlatform()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    db.exec("DROP TABLE configuration_revision")
    const cache = new ConfigurationCache(repo)
    const results = await Promise.allSettled([cache.get(), cache.get(), cache.get()])
    expect(results.every(result => result.status === "rejected"
      && result.reason.message === "Gateway configuration temporarily unavailable")).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toEqual({
      evt: "configuration_refresh_failed", operation: "revision_before", reason: "schema_unavailable",
      has_snapshot: false, snapshot_age_ms: null, dirty: true,
    })
  } finally { warn.mockRestore(); db.close() }
})

test("conversion failures identify the collection without logging private error contents", async () => {
  const { repo, db } = setupTestPlatform()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const list = repo.upstreams.list.bind(repo.upstreams)
    repo.upstreams.list = async opts => {
      await list(opts)
      throw new SyntaxError("private-credential-invalid-json")
    }
    await expect(new ConfigurationCache(repo).get()).rejects.toThrow("Gateway configuration temporarily unavailable")
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ operation: "upstreams", reason: "invalid_data" })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-credential")
  } finally { warn.mockRestore(); db.close() }
})

test("background failures are observable before the authorization lease expires", async () => {
  const { repo, db } = setupTestPlatform()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: promise => { pending.push(promise) } })
  let now = 0
  try {
    const cache = new ConfigurationCache(repo, () => now)
    await cache.get()
    db.exec("DROP TABLE configuration_revision")
    now = 31_000
    await cache.get()
    await Promise.all(pending)
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      operation: "revision_before", has_snapshot: true, snapshot_age_ms: 31_000, dirty: false,
    })
    now = CONFIG_AUTH_LEASE_MS + 1
    await expect(cache.get()).rejects.toThrow("Gateway configuration temporarily unavailable")
    expect(warn).toHaveBeenCalledTimes(2)
  } finally { warn.mockRestore(); db.close() }
})

test("continuous real configuration writes are distinguishable from storage failures", async () => {
  const { repo, db } = setupTestPlatform()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const list = repo.apiKeys.list.bind(repo.apiKeys)
  repo.apiKeys.list = async () => {
    const rows = await list()
    db.exec("UPDATE configuration_revision SET revision = revision + 1")
    return rows
  }
  try {
    await expect(new ConfigurationCache(repo).get()).rejects.toThrow("Gateway configuration temporarily unavailable")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ operation: "snapshot", reason: "revision_unstable" })
  } finally { warn.mockRestore(); db.close() }
})
