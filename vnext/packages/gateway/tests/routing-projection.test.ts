import { expect, test } from "bun:test"
import { RoutingProjection, RoutingProjectionCache } from "../src/data-plane/providers/routing-projection.ts"
import type { CatalogSnapshot } from "../src/repo/catalogs.ts"

function snapshot(id = "up"): CatalogSnapshot {
  return { identity: { upstreamId: id, rowIncarnation: "inc", provider: "custom", ownerId: "owner", configurationGeneration: 1, configurationFingerprint: "fingerprint", catalogRevision: 7 },
    publicationVersion: 1, models: { object: "list", data: [] }, refreshedAtMs: 1, refreshAfterMs: 2 }
}
const projection = (id = "model", raw: Record<string, unknown> = {}) => new RoutingProjection([{ publicId: id, model: { id, endpoints: { responses: {} }, raw } }])

test("projection reuse requires every accepted identity field and publication", () => {
  const cache = new RoutingProjectionCache()
  const accepted = snapshot()
  const entry = projection()
  cache.set(accepted, entry)
  const reloaded = structuredClone(accepted)
  expect(cache.get(reloaded)).toBe(entry)
  expect(Object.isFrozen(reloaded.models.data)).toBe(true)
  for (const identity of [
    { upstreamId: "other" }, { rowIncarnation: "new" }, { ownerId: "other" }, { provider: "azure" },
    { configurationGeneration: 2 }, { configurationFingerprint: "changed" }, { catalogRevision: 8 },
  ]) expect(cache.get({ ...accepted, identity: { ...accepted.identity, ...identity } })).toBeUndefined()
  expect(cache.get({ ...accepted, publicationVersion: 2 })).toBeUndefined()
  const newer = { ...accepted, publicationVersion: 2 }
  cache.set(newer, projection("new"))
  expect(cache.get(accepted)).toBeUndefined()
  expect(cache.get(newer)?.entries[0]?.model.id).toBe("new")
})

test("retention is bounded by aggregate model entries and estimated bytes, not only upstream count", () => {
  const cache = new RoutingProjectionCache({ upstreams: 10, models: 2, bytes: 100_000 })
  cache.set(snapshot("a"), projection("a"))
  cache.set(snapshot("b"), projection("b"))
  cache.set(snapshot("c"), projection("c"))
  expect(cache.get(snapshot("a"))).toBeUndefined()
  expect(cache.get(snapshot("b"))?.entries[0]?.model.id).toBe("b")
  const huge = new RoutingProjection(["a", "b", "c"].map(id => ({ publicId: id, model: { id, endpoints: {} } })))
  cache.set(snapshot("huge"), huge)
  expect(cache.get(snapshot("huge"))).toBeUndefined()
  expect(huge.find(["c"])[0]?.model.id).toBe("c")
  const bytes = new RoutingProjectionCache({ upstreams: 10, models: 1000, bytes: 2000 })
  const large = projection("huge", { vendor: "x".repeat(2000) })
  bytes.set(snapshot("huge"), large)
  expect(bytes.get(snapshot("huge"))).toBeUndefined()
  expect(large.entries[0]?.model.id).toBe("huge")
})

test("model index preserves direct/base upstream order and isolates deeply immutable projection data", () => {
  const raw = { metadata: { vendor: "original" } }
  const entry = new RoutingProjection([
    { publicId: "base", model: { id: "base", endpoints: { responses: {} }, raw } },
    { publicId: "base-high", model: { id: "base-high", endpoints: { responses: {} } } },
  ])
  expect(entry.find(["base-high", "base"]).map(row => row.model.id)).toEqual(["base", "base-high"])
  expect(() => { raw.metadata.vendor = "changed" }).toThrow()
  expect(() => Object.assign(entry.entries[0]?.model.endpoints ?? {}, { responses: { changed: true } })).toThrow()
  expect(Object.isFrozen(entry.entries)).toBe(true)
})
