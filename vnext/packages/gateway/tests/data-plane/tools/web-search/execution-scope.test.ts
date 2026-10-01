import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { initRepo } from "../../../../src/repo/index.ts"
import { createWebSearchExecutionScope, type WebSearchExecutionScope } from "../../../../src/data-plane/tools/web-search/execution-scope.ts"
import type { WebSearchExecutionSession } from "../../../../src/data-plane/tools/web-search/operations.ts"
import type { ConfiguredWebSearchProvider, WebSearchProvider, WebSearchProviderResult } from "../../../../src/data-plane/tools/web-search/types.ts"

const deferred = <T>() => {
  let resolve: (value: T) => void = () => { throw new Error("not initialized") }
  let reject: (reason: unknown) => void = () => { throw new Error("not initialized") }
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const ok: WebSearchProviderResult = { type: "ok", results: [{ source: "https://a.example", title: "A", content: [{ type: "text", text: "alpha" }] }] }
const provider = (over: Partial<WebSearchProvider> = {}): WebSearchProvider => ({
  search: async () => ok,
  fetchPage: async ({ urls }) => ({ type: "ok", pages: urls.map(url => ({ url, content: "alpha page", truncated: false, fullContentBytes: 10 })), failures: [] }),
  ...over,
})
const configured = (impl: WebSearchProvider): ConfiguredWebSearchProvider => ({ type: "enabled", provider: "jina", impl })
let db: Database
let repo: BunSqliteRepo
let session: Omit<WebSearchExecutionSession, "pageCache">
beforeEach(async () => {
  __resetPlatformForTests()
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  await repo.apiKeys.save({ id: "scope-key", key: "scope-secret", name: "Scope fixture", createdAt: "2026-10-01T00:00:00Z", modelMappingsEnabled: false, modelMappings: [] })
  const key = await repo.apiKeys.getById("scope-key")
  if (key === null) throw new Error("fixture key missing")
  session = { apiKeyId: key.id, filters: { maxResults: 3 }, includeSearchActionSources: true, getProvider: async () => configured(provider()) }
})
afterEach(() => { db.close(); __resetPlatformForTests() })

test("prepare is pure, start is single-use and normal query fanout stays concurrent and ordered", async () => {
  const starts: string[] = []
  const a = deferred<WebSearchProviderResult>()
  const b = deferred<WebSearchProviderResult>()
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => configured(provider({ search: request => {
    starts.push(request.query)
    expect(request.maxResults).toBe(3)
    return request.query === "a" ? a.promise : b.promise
  } })) })
  const prepared = scope.prepare({ search_query: [{ q: "a", custom: 1 }, { q: "b" }] })
  expect(starts).toEqual([])
  expect(prepared.plans[0]?.arguments).toEqual({ search_query: [{ q: "a", custom: 1 }, { q: "b" }] })
  const batch = prepared.start()
  expect(() => prepared.start()).toThrow()
  await tick()
  expect(starts).toEqual(["a", "b"])
  b.resolve({ type: "ok", results: [{ source: "https://b.example", title: "B", content: [{ type: "text", text: "b" }] }] })
  a.resolve(ok)
  const ir = await batch.calls[0]?.result()
  expect(ir?.results.map(result => result.title)).toEqual(["A", "B"])
  await scope.settled()
  expect(scope.cancel()).toBeUndefined()
})

test("cancel rejects waiting delivery promptly while real settlement waits for the provider", async () => {
  const leaf = deferred<WebSearchProviderResult>()
  const started = deferred<void>()
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => configured(provider({ search: () => { started.resolve(); return leaf.promise } })) })
  const batch = scope.prepare({ search_query: [{ q: "a" }] }).start()
  const result = batch.calls[0]?.result()
  await started.promise
  scope.cancel()
  scope.cancel()
  await expect(result).rejects.toBeDefined()
  expect(() => scope.assertOpen()).toThrow()
  expect(() => scope.prepare(null)).toThrow()
  await expect(batch.calls[0]?.result()).rejects.toBeDefined()
  let settled = false
  const receipt = scope.settled().then(() => { settled = true })
  await tick()
  expect(settled).toBe(false)
  leaf.resolve(ok)
  await receipt
})

test("cancelled delayed provider resolution starts neither a provider nor usage", async () => {
  const resolution = deferred<ConfiguredWebSearchProvider>()
  let starts = 0
  const scope = createWebSearchExecutionScope({ ...session, getProvider: () => resolution.promise })
  const batch = scope.prepare({ search_query: [{ q: "a" }], open: [{ ref_id: "https://a.example" }] }).start()
  scope.cancel()
  resolution.resolve(configured(provider({ search: async () => { starts++; return ok }, fetchPage: async () => { starts++; return { type: "ok", pages: [], failures: [] } } })))
  await scope.settled()
  expect(starts).toBe(0)
  expect(db.query("SELECT COUNT(*) AS total FROM web_search_engine_usage").get()).toEqual({ total: 0 })
  for (const call of batch.calls) await expect(call.result()).rejects.toBeDefined()
})

test("settlement observes all query siblings including each awaited real usage write", async () => {
  const a = deferred<WebSearchProviderResult>()
  const b = deferred<WebSearchProviderResult>()
  const usageGate = deferred<void>()
  const usageStarted = deferred<void>()
  const original = repo.webSearchEngineUsage.record.bind(repo.webSearchEngineUsage)
  repo.webSearchEngineUsage.record = async (...args) => { usageStarted.resolve(); await usageGate.promise; await original(...args) }
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => configured(provider({ search: ({ query }) => query === "a" ? a.promise : b.promise })) })
  scope.prepare({ search_query: [{ q: "a" }, { q: "b" }] }).start()
  await tick()
  a.reject(new DOMException("provider aborted", "AbortError"))
  await usageStarted.promise
  scope.cancel()
  let settled = false
  const receipt = scope.settled().then(() => { settled = true })
  usageGate.resolve()
  await tick()
  expect(settled).toBe(false)
  b.resolve(ok)
  await receipt
  expect(db.query("SELECT SUM(attempts) AS total FROM web_search_engine_usage").get()).toEqual({ total: 2 })
})

test("all eager page and search branches are observed even when results are never consumed", async () => {
  const search = deferred<WebSearchProviderResult>()
  const page = deferred<Awaited<ReturnType<WebSearchProvider["fetchPage"]>>>()
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => configured(provider({ search: () => search.promise, fetchPage: () => page.promise })) })
  scope.prepare({ search_query: [{ q: "a" }, { q: "b" }], open: [{ ref_id: "https://a.example" }] }).start()
  await tick()
  scope.cancel()
  search.reject(new DOMException("closed", "AbortError"))
  page.reject(new DOMException("closed", "AbortError"))
  await scope.settled()
  await tick()
})

test("cache reuse and page batching retain one fetch for opens and find", async () => {
  const starts: string[][] = []
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => configured(provider({ fetchPage: async ({ urls }) => {
    starts.push(urls)
    return { type: "ok", pages: urls.map(url => ({ url, content: "alpha page", truncated: false, fullContentBytes: 10 })), failures: [] }
  } })) })
  const batch = scope.prepare({ open: [{ ref_id: "https://a.example" }, { ref_id: "https://b.example" }], find: [{ ref_id: "https://a.example", pattern: "alpha" }] }).start()
  const results = await Promise.all(batch.calls.map(call => call.result()))
  expect(starts).toEqual([["https://a.example", "https://b.example"]])
  expect(results.map(result => result.action.type)).toEqual(["open_page", "open_page", "find_in_page"])
  await Promise.all(scope.prepare({ open: [{ ref_id: "https://a.example" }] }).start().calls.map(call => call.result()))
  expect(starts).toHaveLength(1)
  scope.cancel()
  await scope.settled()
})

test("parent abort links once and listener cleanup occurs on repeated cancel", async () => {
  const parent = new AbortController()
  const add = parent.signal.addEventListener.bind(parent.signal)
  const remove = parent.signal.removeEventListener.bind(parent.signal)
  let adds = 0
  let removes = 0
  parent.signal.addEventListener = (...args) => { adds++; add(...args) }
  parent.signal.removeEventListener = (...args) => { removes++; remove(...args) }
  const scope = createWebSearchExecutionScope({ ...session, signal: parent.signal })
  scope.prepare(null)
  scope.prepare(null)
  expect(adds).toBe(1)
  parent.abort("downstream closed")
  expect(() => scope.assertOpen()).toThrow("downstream closed")
  scope.cancel()
  expect(removes).toBe(1)
  await scope.settled()
})

test("already-aborted parent prevents preparation and a prepared batch cannot start after close", async () => {
  const parent = new AbortController()
  parent.abort()
  const closed = createWebSearchExecutionScope({ ...session, signal: parent.signal })
  expect(() => closed.prepare(null)).toThrow()
  const scope = createWebSearchExecutionScope(session)
  const prepared = scope.prepare(null)
  scope.cancel()
  expect(() => prepared.start()).toThrow()
  await scope.settled()
})

test("synchronous provider factory failure propagates and is observed without result access", async () => {
  const failure = new Error("resolution factory failed")
  const scope = createWebSearchExecutionScope({ ...session, getProvider: () => { throw failure } })
  const batch = scope.prepare({ search_query: [{ q: "a" }], open: [{ ref_id: "https://a.example" }] }).start()
  await scope.settled()
  for (const call of batch.calls) await expect(call.result()).rejects.toBe(failure)
  scope.cancel()
})

test("synchronous factory cancellation cannot make its settlement receipt miss resolution work", async () => {
  const resolution = deferred<ConfiguredWebSearchProvider>()
  let receipt: Promise<void> | undefined
  let settled = false
  const scope: WebSearchExecutionScope = createWebSearchExecutionScope({ ...session, getProvider: () => {
    scope.cancel()
    receipt = scope.settled().then(() => { settled = true })
    return resolution.promise
  } })
  const batch = scope.prepare({ open: [{ ref_id: "https://a.example" }] }).start()
  await tick()
  expect(settled).toBe(false)
  resolution.resolve(configured(provider()))
  await receipt
  expect(settled).toBe(true)
  await expect(batch.calls[0]?.result()).rejects.toBeDefined()
})

test("real settlement waits for page usage finalization after a late success", async () => {
  const page = deferred<Awaited<ReturnType<WebSearchProvider["fetchPage"]>>>()
  const usage = deferred<void>()
  const usageStarted = deferred<void>()
  const original = repo.webSearchEngineUsage.record.bind(repo.webSearchEngineUsage)
  repo.webSearchEngineUsage.record = async (...args) => { usageStarted.resolve(); await usage.promise; await original(...args) }
  const parent = new AbortController()
  let providerSignal: AbortSignal | undefined
  const scope = createWebSearchExecutionScope({ ...session, signal: parent.signal, getProvider: async () => configured(provider({ fetchPage: request => { providerSignal = request.signal; return page.promise } })) })
  const batch = scope.prepare({ open: [{ ref_id: "https://a.example" }] }).start()
  await tick()
  scope.cancel()
  expect(parent.signal.aborted).toBe(false)
  expect(providerSignal?.aborted).toBe(true)
  await expect(batch.calls[0]?.result()).rejects.toBeDefined()
  page.resolve({ type: "ok", pages: [{ url: "https://a.example", content: "late", truncated: false, fullContentBytes: 4 }], failures: [] })
  await usageStarted.promise
  let settled = false
  const receipt = scope.settled().then(() => { settled = true })
  await tick()
  expect(settled).toBe(false)
  usage.resolve()
  await receipt
  expect(db.query("SELECT SUM(attempts) AS total FROM web_search_engine_usage").get()).toEqual({ total: 1 })
})

test("malformed calls preserve error IR without provider or usage work", async () => {
  let resolutions = 0
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => { resolutions++; return configured(provider()) } })
  const batch = scope.prepare(null).start()
  expect((await batch.calls[0]?.result())?.results[0]?.title).toBe("Malformed arguments")
  expect(resolutions).toBe(0)
  expect(db.query("SELECT COUNT(*) AS total FROM web_search_engine_usage").get()).toEqual({ total: 0 })
  scope.cancel()
  await scope.settled()
})
