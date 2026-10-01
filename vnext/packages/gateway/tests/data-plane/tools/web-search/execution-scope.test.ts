import { createJinaWebSearchProvider } from "../../../../src/data-plane/tools/web-search/providers/jina.ts"
import { createMicrosoftGroundingWebSearchProvider } from "../../../../src/data-plane/tools/web-search/providers/microsoft-grounding.ts"
import { readSuccessfulText } from "../../../../src/data-plane/tools/web-search/providers/success-body.ts"
import { createFallbackWebSearchProvider } from "../../../../src/data-plane/tools/web-search/key-config.ts"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { initRepo } from "../../../../src/repo/index.ts"
import { createWebSearchExecutionScope, type WebSearchExecutionScope } from "../../../../src/data-plane/tools/web-search/execution-scope.ts"
import { DEFAULT_WEB_SEARCH_CAPACITY_POLICY, validateWebSearchCapacityPolicy, WebSearchCapacityError } from "../../../../src/data-plane/tools/web-search/capacity.ts"
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
  const prepared = scope.prepare(scope.admit({ search_query: [{ q: "a", custom: 1 }, { q: "b" }] }))
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
  const batch = scope.prepare(scope.admit({ search_query: [{ q: "a" }] })).start()
  const result = batch.calls[0]?.result()
  await started.promise
  scope.cancel()
  scope.cancel()
  await expect(result).rejects.toBeDefined()
  expect(() => scope.assertOpen()).toThrow()
  expect(() => scope.prepare(scope.admit(null))).toThrow()
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
  const batch = scope.prepare(scope.admit({ search_query: [{ q: "a" }], open: [{ ref_id: "https://a.example" }] })).start()
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
  scope.prepare(scope.admit({ search_query: [{ q: "a" }, { q: "b" }] })).start()
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
  scope.prepare(scope.admit({ search_query: [{ q: "a" }, { q: "b" }], open: [{ ref_id: "https://a.example" }] })).start()
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
  const batch = scope.prepare(scope.admit({ open: [{ ref_id: "https://a.example" }, { ref_id: "https://b.example" }], find: [{ ref_id: "https://a.example", pattern: "alpha" }] })).start()
  const results = await Promise.all(batch.calls.map(call => call.result()))
  expect(starts).toEqual([["https://a.example", "https://b.example"]])
  expect(results.map(result => result.action.type)).toEqual(["open_page", "open_page", "find_in_page"])
  await Promise.all(scope.prepare(scope.admit({ open: [{ ref_id: "https://a.example" }] })).start().calls.map(call => call.result()))
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
  scope.prepare(scope.admit(null))
  scope.prepare(scope.admit(null))
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
  expect(() => closed.prepare(closed.admit(null))).toThrow()
  const scope = createWebSearchExecutionScope(session)
  const prepared = scope.prepare(scope.admit(null))
  scope.cancel()
  expect(() => prepared.start()).toThrow()
  await scope.settled()
})

test("synchronous provider factory failure propagates and is observed without result access", async () => {
  const failure = new Error("resolution factory failed")
  const scope = createWebSearchExecutionScope({ ...session, getProvider: () => { throw failure } })
  const batch = scope.prepare(scope.admit({ search_query: [{ q: "a" }], open: [{ ref_id: "https://a.example" }] })).start()
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
  const batch = scope.prepare(scope.admit({ open: [{ ref_id: "https://a.example" }] })).start()
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
  const batch = scope.prepare(scope.admit({ open: [{ ref_id: "https://a.example" }] })).start()
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
  const batch = scope.prepare(scope.admit(null)).start()
  expect((await batch.calls[0]?.result())?.results[0]?.title).toBe("Malformed arguments")
  expect(resolutions).toBe(0)
  expect(db.query("SELECT COUNT(*) AS total FROM web_search_engine_usage").get()).toEqual({ total: 0 })
  scope.cancel()
  await scope.settled()
})

test("operation admission rejects huge sparse arrays without inspecting elements or starting work", () => {
  let reads = 0
  const huge = new Array(0xffffffff)
  Object.defineProperty(huge, "0", { get: () => { reads++; throw new Error("element read") } })
  const scope = createWebSearchExecutionScope(session)
  expect(() => scope.admit({ search_query: huge })).toThrow("Web search capacity exceeded")
  expect(reads).toBe(0)
  scope.cancel()
})

test("admission counts parser cardinality including unsupported, undefined, empty and null calls", () => {
  const scope = createWebSearchExecutionScope(session, { operations: 8 })
  scope.refuse(scope.admit({ search_query: undefined, open: [], unsupported: undefined })) // 1
  scope.refuse(scope.admit({ search_query: null, unsupported: new Array(2) })) // 3
  scope.refuse(scope.admit(null)) // 1
  scope.refuse(scope.admit({})) // 1
  scope.refuse(scope.admit({ find: [], unsupported: [] })) // 1
  scope.refuse(scope.admit({ open: "bad" })) // 1
  expect(() => scope.admit(null)).toThrow("Web search capacity exceeded")
  scope.cancel()
})

test("merged queries charge separately; excess calls reserve nothing and abandoned tokens never refund", () => {
  const scope = createWebSearchExecutionScope(session, { operations: 3 })
  const prepared = scope.prepare(scope.admit({ search_query: [{ q: "a" }, { q: "b" }] }))
  expect(prepared.plans).toHaveLength(1)
  expect(() => scope.admit({ open: new Array(2) })).toThrow("Web search capacity exceeded")
  scope.admit(null)
  expect(() => scope.admit(null)).toThrow("Web search capacity exceeded")
  scope.cancel()
})

test("admission is scope-owned, consumed once and revoked by cancellation", () => {
  const a = createWebSearchExecutionScope(session)
  const b = createWebSearchExecutionScope(session)
  const token = a.admit(null)
  expect(() => b.prepare(token)).toThrow("Invalid web search admission")
  a.refuse(token)
  expect(() => a.prepare(token)).toThrow("Invalid web search admission")
  expect(() => a.refuse(token)).toThrow("Invalid web search admission")
  const prepared = a.admit(null)
  a.prepare(prepared)
  expect(() => a.refuse(prepared)).toThrow("Invalid web search admission")
  const abandoned = a.admit(null)
  a.cancel()
  expect(() => a.prepare(abandoned)).toThrow()
  b.cancel()
})

test("refusal consumes admission without parsing elements", () => {
  const entries = new Array(2)
  Object.defineProperty(entries, "0", { get: () => { throw new Error("parsed refused argument") } })
  const scope = createWebSearchExecutionScope(session)
  scope.refuse(scope.admit({ search_query: entries }))
  scope.cancel()
})

for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 65, undefined]) test(`policy rejects invalid operation limit ${value}`, () => {
  expect(() => validateWebSearchCapacityPolicy({ operations: value })).toThrow("Invalid web search capacity policy")
})

test("policy validates every domain and capacity errors expose only safe category and limit", () => {
  expect(validateWebSearchCapacityPolicy()).toEqual(DEFAULT_WEB_SEARCH_CAPACITY_POLICY)
  for (const category of Object.keys(DEFAULT_WEB_SEARCH_CAPACITY_POLICY)) {
    expect(() => validateWebSearchCapacityPolicy({ [category]: 0 })).toThrow()
    expect(validateWebSearchCapacityPolicy({ [category]: 1 })).toMatchObject({ [category]: 1 })
  }
  const scope = createWebSearchExecutionScope(session, { operations: 1 })
  try {
    scope.admit({ secret_query: ["sensitive a", "sensitive b"] })
    throw new Error("expected capacity failure")
  } catch (error) {
    expect(error).toBeInstanceOf(WebSearchCapacityError)
    expect(error).toMatchObject({ category: "operations", limit: 1 })
    expect(String(error)).not.toContain("sensitive")
    expect(String(error)).not.toContain("secret_query")
  }
  scope.cancel()
})


test("admission saturates before visiting further own keys and ignores inherited commands", () => {
  const scope = createWebSearchExecutionScope(session, { operations: 1 })
  const args: Record<string, unknown> = { first: [null, null] }
  Object.defineProperty(args, "later", { enumerable: true, get: () => { throw new Error("visited later key") } })
  expect(() => scope.admit(args)).toThrow("Web search capacity exceeded")
  const inherited = Object.create({ unsupported: new Array(64) }) as Record<string, unknown>
  scope.refuse(scope.admit(inherited))
  expect(() => scope.admit(null)).toThrow("Web search capacity exceeded")
  scope.cancel()
})


test("a failed parser consumes admission and never refunds its operation reservation", () => {
  const scope = createWebSearchExecutionScope(session, { operations: 1 })
  const entries = new Array(1)
  Object.defineProperty(entries, "0", { get: () => { throw new Error("parser failed") } })
  const token = scope.admit({ search_query: entries })
  expect(() => scope.prepare(token)).toThrow("parser failed")
  expect(() => scope.prepare(token)).toThrow("Invalid web search admission")
  expect(() => scope.admit(null)).toThrow("Web search capacity exceeded")
  scope.cancel()
})

test("cancellation during argument reflection cannot publish an admission", () => {
  const scope = createWebSearchExecutionScope(session)
  const args = { get search_query() { scope.cancel(); return [] } }
  expect(() => scope.admit(args)).toThrow()
  expect(() => scope.admit(null)).toThrow()
})


for (const category of ["ingressBytes", "responseBodyBytes"] as const) test(`${category} capacity latches immediately before result consumption, blocking sibling fallback and retaining real usage settlement`, async () => {
  const overflow = deferred<void>()
  const sibling = deferred<WebSearchProviderResult>()
  let requests = 0
  let fallbackStarts = 0
  const first = provider({ search: async request => {
    requests++
    if (request.query === "b") return sibling.promise
    await overflow.promise
    await readSuccessfulText(new Response("12345"), request)
    return ok
  } })
  const fallback = createFallbackWebSearchProvider([
    { id: "tavily", impl: first },
    { id: "bing", impl: provider({ search: async () => { fallbackStarts++; return ok } }) },
  ])
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => configured(fallback) }, { [category]: 4 })
  const batch = scope.prepare(scope.admit({ search_query: [{ q: "a" }, { q: "b" }] })).start()
  await tick()
  expect(requests).toBe(2)
  overflow.resolve()
  await tick()
  let reason: unknown
  try { scope.assertOpen() } catch (error) { reason = error }
  expect(reason).toMatchObject({ category, limit: 4 })
  expect(() => scope.admit(null)).toThrow(WebSearchCapacityError)
  await expect(batch.calls[0]?.result()).rejects.toBe(reason)
  let settled = false
  const settlement = scope.settled().then(() => { settled = true })
  await tick()
  expect(settled).toBe(false)
  sibling.resolve({ type: "error", errorCode: "unavailable" })
  await settlement
  expect(fallbackStarts).toBe(0)
  expect(db.query("SELECT SUM(attempts) AS total FROM web_search_engine_usage").get()).toEqual({ total: 2 })
})

test("concurrent sublimit bodies share monotonic ingress", async () => {
  let reads = 0
  const impl = provider({ search: async request => {
    reads++
    await readSuccessfulText(new Response("123"), request)
    return ok
  } })
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => configured(impl) }, { responseBodyBytes: 4, ingressBytes: 5 })
  const batch = scope.prepare(scope.admit({ search_query: [{ q: "a" }, { q: "b" }] })).start()
  await expect(batch.calls[0]?.result()).rejects.toMatchObject({ category: "ingressBytes", limit: 5 })
  await scope.settled()
  expect(reads).toBe(2)
  expect(db.query("SELECT SUM(attempts) AS total FROM web_search_engine_usage").get()).toEqual({ total: 2 })
})


test("successful ingress persists across reentry and page operation failure is fatal", async () => {
  const impl = provider({
    search: async request => { await readSuccessfulText(new Response("123"), request); return ok },
    fetchPage: async request => {
      await readSuccessfulText(new Response("123"), request)
      return { type: "ok", pages: [], failures: [] }
    },
  })
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => configured(impl) }, { ingressBytes: 5 })
  const first = scope.prepare(scope.admit({ search_query: [{ q: "a" }] })).start()
  expect((await first.calls[0]?.result())?.results[0]?.title).toBe("A")
  const second = scope.prepare(scope.admit({ open: [{ ref_id: "https://a.example" }] })).start()
  await expect(second.calls[0]?.result()).rejects.toMatchObject({ category: "ingressBytes" })
  await scope.settled()
  expect(db.query("SELECT SUM(attempts) AS total FROM web_search_engine_usage").get()).toEqual({ total: 2 })
})


for (const [name, create] of [["jina", createJinaWebSearchProvider], ["microsoft", createMicrosoftGroundingWebSearchProvider]] as const) {
  for (const siblingExit of ["resolve", "reject"] as const) test(`${name} page capacity keeps real scope and usage unsettled until started sibling fetch ${siblingExit}`, async () => {
    const sibling = deferred<Response>()
    let starts = 0
    let siblingEnded = false
    const impl = create("test", { fetch: (async () => {
      starts++
      if (starts === 1) return new Response("12345")
      try { return await sibling.promise }
      finally { siblingEnded = true }
    }) as typeof fetch })
    const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => ({ type: "enabled", provider: name === "jina" ? "jina" : "microsoft-grounding", impl }) }, { responseBodyBytes: 4 })
    const batch = scope.prepare(scope.admit({ open: [{ ref_id: "https://a.example" }, { ref_id: "https://b.example" }] })).start()
    await tick()
    expect(starts).toBe(2)
    let reason: unknown
    try { scope.assertOpen() } catch (error) { reason = error }
    expect(reason).toMatchObject({ category: "responseBodyBytes", limit: 4 })
    await expect(batch.calls[0]?.result()).rejects.toBe(reason)
    let settled = false
    const receipt = scope.settled().then(() => { settled = true })
    await tick()
    expect(siblingEnded).toBe(false)
    expect(settled).toBe(false)
    expect(db.query("SELECT COUNT(*) AS total FROM web_search_engine_usage").get()).toEqual({ total: 0 })
    if (siblingExit === "resolve") sibling.resolve(new Response("{}"))
    else sibling.reject(new Error("sibling transport failure"))
    await receipt
    expect(siblingEnded).toBe(true)
    expect(settled).toBe(true)
    expect(db.query("SELECT SUM(attempts) AS total FROM web_search_engine_usage").get()).toEqual({ total: 1 })
    await expect(batch.calls[0]?.result()).rejects.toBe(reason)
  })
}

test("page cache excess latches fatal invocation failure before publication or later starts", async () => {
  const scope = createWebSearchExecutionScope(session, { pageEntries: 1 })
  const batch = scope.prepare(scope.admit({ open: [{ ref_id: "https://a.example" }, { ref_id: "https://b.example" }] })).start()
  await expect(batch.calls[0]?.result()).rejects.toMatchObject({ category: "pageEntries" })
  expect(() => scope.admit({ search_query: [{ q: "later" }] })).toThrow("pageEntries")
  await scope.settled()
})

test("page bytes admit actual normalized title graph instead of trusting source size", async () => {
  const scope = createWebSearchExecutionScope({ ...session, getProvider: async () => configured(provider({ fetchPage: async ({ urls }) => ({ type: "ok", pages: urls.map(url => ({ url, title: "t".repeat(1000), content: "x", truncated: false, fullContentBytes: 1 })), failures: [] }) })) }, { pageBytes: 1000 })
  const batch = scope.prepare(scope.admit({ open: [{ ref_id: "https://a.example" }] })).start()
  await expect(batch.calls[0]?.result()).rejects.toMatchObject({ category: "pageBytes", limit: 1000 })
  expect(() => scope.admit(null)).toThrow("pageBytes")
  await scope.settled()
})
