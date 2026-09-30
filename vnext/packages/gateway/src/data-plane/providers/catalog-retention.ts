import { createHash } from "node:crypto"
import type { CatalogIdentity, CatalogSnapshot } from "../../repo/catalogs.ts"

export interface CatalogRetentionLimits {
  entries: number
  models: number
  bytes: number
}

const DEFAULT_LIMITS: CatalogRetentionLimits = { entries: 512, models: 16_384, bytes: 16 * 1024 * 1024 }

/** Estimate the retained JSON graph without another serialization. Stop once
 * it cannot fit; non-JSON values must not smuggle request capabilities into it. */
function estimateBytes(root: unknown, limit: number): number | undefined {
  const visited = new WeakSet<object>()
  const pending: unknown[] = [root]
  let bytes = 64 // Map entry and accounting record.
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === "string") bytes += value.length * 2 + 16
    else if (typeof value === "function" || typeof value === "symbol") return undefined
    else if (value !== null && typeof value === "object") {
      if (visited.has(value)) continue
      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return undefined
      visited.add(value)
      bytes += 32
      let fields = 0
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        fields++
        bytes += key.length * 2 + 16
        if (bytes > limit) return undefined
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !("value" in descriptor)) return undefined
        pending.push(descriptor.value)
      }
      // JSON objects have only enumerable string properties; arrays also own
      // their non-enumerable length. Reject hidden state without reading it.
      if (Reflect.ownKeys(value).length !== fields + (Array.isArray(value) ? 1 : 0)) return undefined
    } else bytes += 8
    if (bytes > limit) return undefined
  }
  return bytes
}

/** Accounting belongs to the retained owner, not to the request using a result.
 * Replacement, eviction and clear all release the same stored reservation.
 * Estimates assume retained graphs are not expanded in place: accepted catalog
 * publications are shared read-only data, including for cache-only/admin reads.
 * This owner does not freeze upstream credential/state objects to enforce size. */
export class CatalogRetention<T extends { result: { snapshot: CatalogSnapshot } | null }> {
  private readonly entries = new Map<string, { value: T; models: number; bytes: number }>()
  private readonly limits: CatalogRetentionLimits
  private models = 0
  private bytes = 0
  constructor(limits: Partial<CatalogRetentionLimits> = {}) {
    this.limits = {
      entries: limits.entries ?? DEFAULT_LIMITS.entries,
      models: limits.models ?? DEFAULT_LIMITS.models,
      bytes: limits.bytes ?? DEFAULT_LIMITS.bytes,
    }
    for (const key of ["entries", "models", "bytes"] as const) {
      const value = this.limits[key]
      if (!Number.isSafeInteger(value) || value < 0 || value > DEFAULT_LIMITS[key]) throw new TypeError("Invalid catalog retention policy")
    }
  }
  get(id: string): T | undefined { return this.entries.get(id)?.value }
  delete(id: string): void {
    const old = this.entries.get(id)
    if (!old) return
    this.models -= old.models
    this.bytes -= old.bytes
    this.entries.delete(id)
  }
  clear(): void {
    this.entries.clear()
    this.models = 0
    this.bytes = 0
  }
  /** Reports payload admission only; authority ordering has its own owner. */
  set(id: string, value: T): boolean {
    this.delete(id)
    const models = value.result?.snapshot.models.data.length ?? 0
    if (this.limits.entries === 0 || models > this.limits.models) return true
    const bytes = estimateBytes([id, value], this.limits.bytes)
    if (bytes === undefined) return true
    this.entries.set(id, { value, models, bytes })
    this.models += models
    this.bytes += bytes
    let evicted = false
    while (this.entries.size > this.limits.entries || this.models > this.limits.models || this.bytes > this.limits.bytes) {
      const first = this.entries.keys().next()
      if (first.done) break
      this.delete(first.value)
      evicted = true
    }
    return evicted
  }
}

interface OrderingHead extends CatalogIdentity {
  observed: number
  publicationVersion: number
  identitySinceSequence: number
}

interface OrderingBarrier { upstreamId: string; observed: number }

// Ordinary UUIDs, provider names and existing SHA-256 fingerprints stay inline.
// Exceptional long strings cannot bypass the fixed-size ordering-head budget.
// UTF-16 preserves distinct JS strings, including unpaired surrogate code units.
function orderingField(value: string): string {
  return value.length <= 64 ? `s:${value}` : `h:${createHash("sha256").update(value, "utf16le").digest("hex")}`
}

/** Ordering survives payload rejection/eviction without retaining models,
 * credentials, proxies or request capabilities. At most 512 heads, each with
 * five strings of at most 66 code units and five numeric scalars, are retained.
 * A target invalidation uses a smaller barrier until authority is reread. */
export class CatalogOrdering {
  private readonly heads = new Map<string, OrderingHead | OrderingBarrier>()
  private installAfter = 0

  clear(sequence: number): void { this.heads.clear(); this.installAfter = sequence }

  observe(identity: CatalogIdentity, publicationVersion: number, ticket: number, sequence: number): boolean {
    if (ticket < this.installAfter) return false
    const next: OrderingHead = {
      upstreamId: orderingField(identity.upstreamId), rowIncarnation: orderingField(identity.rowIncarnation),
      ownerId: orderingField(identity.ownerId ?? ""), provider: orderingField(identity.provider),
      configurationGeneration: identity.configurationGeneration,
      configurationFingerprint: orderingField(identity.configurationFingerprint), catalogRevision: identity.catalogRevision,
      observed: ticket, publicationVersion, identitySinceSequence: sequence,
    }
    const old = this.heads.get(next.upstreamId)
    if (old) {
      if (old.observed > ticket) return false
      if ("rowIncarnation" in old) {
        if (old.rowIncarnation === next.rowIncarnation && old.configurationGeneration > next.configurationGeneration) return false
        const same = old.rowIncarnation === next.rowIncarnation && old.ownerId === next.ownerId && old.provider === next.provider
          && old.configurationGeneration === next.configurationGeneration && old.configurationFingerprint === next.configurationFingerprint
          && old.catalogRevision === next.catalogRevision
        if (same) {
          if (old.publicationVersion > publicationVersion) return false
          // Stable observations do not fence their concurrent peers. Only the
          // first observation of an identity retires other in-flight identities.
          next.identitySinceSequence = old.identitySinceSequence
        } else if (ticket <= old.identitySinceSequence) return false
      }
    }
    this.retain(next, sequence)
    return true
  }

  private retain(next: OrderingHead | OrderingBarrier, sequence: number): void {
    this.heads.delete(next.upstreamId)
    this.heads.set(next.upstreamId, next)
    if (this.heads.size > 512) {
      const first = this.heads.keys().next()
      if (!first.done) this.heads.delete(first.value)
      // Only loss of ordering metadata retires all earlier outstanding reads.
      this.installAfter = Math.max(this.installAfter, sequence + 1)
    }
  }

  invalidate(id: string, sequence: number): void {
    // A missing/replaced target is evidence even when its read started before
    // a retained head's ticket. Read start order is not SQL observation order:
    // require a new read for this ID instead of accepting another in-flight row.
    this.retain({ upstreamId: orderingField(id), observed: sequence + 1 }, sequence)
  }
}
