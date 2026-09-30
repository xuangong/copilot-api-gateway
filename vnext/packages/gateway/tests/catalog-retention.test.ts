import { expect, test } from "bun:test"
import { CatalogOrdering, CatalogRetention } from "../src/data-plane/providers/catalog-retention.ts"
import type { CatalogSnapshot } from "../src/repo/catalogs.ts"

function entry(metadata: unknown) {
  const snapshot: CatalogSnapshot = {
    identity: { upstreamId: "up", rowIncarnation: "inc", provider: "custom", configurationGeneration: 1,
      configurationFingerprint: "fingerprint", catalogRevision: 5 },
    publicationVersion: 1, models: { object: "list", data: [{ id: "model", metadata }] }, refreshedAtMs: 1, refreshAfterMs: 2,
  }
  return { result: { snapshot } }
}

test("retention rejects executable and non-JSON model metadata", () => {
  const cache = new CatalogRetention<ReturnType<typeof entry>>()
  for (const metadata of [() => "request", new Date(), new Map(), new AbortController(), new Uint8Array(1), Symbol("request")]) {
    cache.set("up", entry({ nested: metadata }))
    expect(cache.get("up")).toBeUndefined()
  }
  cache.set("up", entry({ nested: { json: "accepted" } }))
  expect(cache.get("up")?.result.snapshot.models.data[0]?.id).toBe("model")
})

test("retention does not execute getters while deciding whether a graph is retainable", () => {
  const cache = new CatalogRetention<ReturnType<typeof entry>>()
  let invoked = false
  cache.set("up", entry({ get credentials() { invoked = true; return "request-owned" } }))
  expect(invoked).toBe(false)
  expect(cache.get("up")).toBeUndefined()
})

test("non-enumerable and symbol properties cannot hide request closures in retained data", () => {
  const cache = new CatalogRetention<ReturnType<typeof entry>>()
  const hidden = Object.defineProperty({}, "fetcher", { value: () => "request-owned" })
  for (const metadata of [hidden, { [Symbol("credentials")]: () => "request-owned" }]) {
    cache.set("up", entry(metadata))
    expect(cache.get("up")).toBeUndefined()
  }
})

test("ordering protects newer publications independently of payload retention and read start order", () => {
  const order = new CatalogOrdering()
  const identity = entry({}).result.snapshot.identity
  expect(order.observe(identity, 2, 1, 64)).toBe(true)
  expect(order.observe(identity, 1, 2, 64)).toBe(false)
  expect(order.observe(identity, 2, 3, 64)).toBe(true)
  expect(order.observe(identity, 2, 2, 64)).toBe(false)
  expect(order.observe({ ...identity, configurationGeneration: 0 }, 3, 4, 64)).toBe(false)
  order.clear(65)
  expect(order.observe(identity, 2, 64, 65)).toBe(false)
})

test("identity changes retire different in-flight identities without advancing stable peers", () => {
  const order = new CatalogOrdering()
  const identity = entry({}).result.snapshot.identity
  expect(order.observe(identity, 2, 1, 64)).toBe(true)
  expect(order.observe(identity, 2, 2, 65)).toBe(true)
  expect(order.observe({ ...identity, rowIncarnation: "earlier" }, 2, 64, 65)).toBe(false)
  expect(order.observe({ ...identity, rowIncarnation: "later" }, 1, 65, 65)).toBe(true)
})

test("target invalidation retires all in-flight observations for only that upstream", () => {
  const order = new CatalogOrdering()
  const identity = entry({}).result.snapshot.identity
  expect(order.observe(identity, 2, 2, 3)).toBe(true)
  order.invalidate(identity.upstreamId, 3)
  expect(order.observe(identity, 2, 3, 3)).toBe(false)
  expect(order.observe({ ...identity, upstreamId: "other" }, 1, 3, 3)).toBe(true)
  expect(order.observe({ ...identity, rowIncarnation: "replacement" }, 1, 4, 4)).toBe(true)
})

test("ordering caps heads and long identity fields while distinguishing every identity field", () => {
  const order = new CatalogOrdering()
  const identity = entry({}).result.snapshot.identity
  for (let i = 0; i < 513; i++) {
    expect(order.observe({ ...identity, upstreamId: `${i}-${"x".repeat(1000)}` }, 2, i + 1, i + 1)).toBe(true)
  }
  const heads = Reflect.get(order, "heads") as Map<string, Record<string, unknown>>
  expect(heads.size).toBe(512)
  for (const [key, head] of heads) {
    expect(key.length).toBeLessThanOrEqual(66)
    for (const value of Object.values(head)) {
      if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(66)
      else expect(typeof value).toBe("number")
    }
  }
  expect(order.observe(identity, 2, 512, 513)).toBe(false)
  for (const changed of [
    { rowIncarnation: "other" }, { ownerId: "other" }, { provider: "other" },
    { configurationFingerprint: "other" }, { catalogRevision: 6 }, { configurationGeneration: 2 },
  ]) {
    const isolated = new CatalogOrdering()
    expect(isolated.observe(identity, 2, 1, 1)).toBe(true)
    expect(isolated.observe({ ...identity, ...changed }, 1, 2, 2)).toBe(true)
  }
})
