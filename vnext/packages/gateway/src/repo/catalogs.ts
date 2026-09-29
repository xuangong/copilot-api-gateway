import { createHash } from "node:crypto"
import type { ProxyRecord } from "@vibe-core/proxy-repo"
import { isDirectFallbackId } from "@vibe-core/proxy-repo"
import type { UpstreamId } from "./branded-ids.ts"
import type { StoredUpstreamRecord } from "./types.ts"

export interface CatalogIdentity {
  upstreamId: string
  rowIncarnation: string
  ownerId?: string
  provider: string
  configurationGeneration: number
  configurationFingerprint: string
  /** Owned by the catalog projection/adapter, independent of upstream generation. */
  catalogRevision: number
}

export interface CatalogModels {
  object: string
  data: Array<{ id: string; [key: string]: unknown }>
  [key: string]: unknown
}

export interface CatalogSnapshot {
  identity: CatalogIdentity
  /** Orders accepted publications even when the database clock has equal ticks. */
  publicationVersion: number
  models: CatalogModels
  refreshedAtMs: number
  refreshAfterMs: number
}

export interface CatalogLease {
  identity: CatalogIdentity
  token: string
  leaseUntilMs: number
}

export type CatalogErrorCode = "timeout" | "aborted" | "upstream_error" | "invalid_catalog" | "unavailable"
export interface CatalogFailure {
  failureCount: number
  retryAtMs: number
  lastErrorCode: CatalogErrorCode | null
}

export interface CatalogObservation extends CatalogFailure {
  upstream: StoredUpstreamRecord
  /** Authoritative referenced rows, including credentials; never serialize to clients. */
  proxies: ProxyRecord[]
  identity: CatalogIdentity
  snapshot: CatalogSnapshot | null
  lease: CatalogLease | null
  databaseNowMs: number
}

export interface CatalogRepo {
  /** Coherent raw row/proxy observation; four attempts before typed contention. */
  read(id: UpstreamId, catalogRevision: number): Promise<CatalogObservation | null>
  /** Null means lost eligibility. Inspect read() for a competing lease/backoff.
   * Freshness and enabled/owner visibility remain the coordinator's decision. */
  tryAcquire(identity: CatalogIdentity, options?: { explicit?: boolean; leaseMs?: number }): Promise<CatalogLease | null>
  /** Null means publication was fenced out; it must never be installed in L1. */
  publish(lease: CatalogLease, models: CatalogModels, options?: { freshnessMs?: number }): Promise<CatalogSnapshot | null>
  recordFailure(lease: CatalogLease, code: CatalogErrorCode, options?: { backoffMs?: number }): Promise<CatalogFailure | null>
  /** Caller supplies every revision still active in the rolling deployment. */
  deleteInactiveRevisions(options: { activeRevisions: readonly number[]; inactiveBeforeMs: number; limit: number }): Promise<number>
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

/** Bump the caller-owned catalog revision when this discovery projection changes.
 * The full configured route is hashed, not the currently selected colo/fallback:
 * catalogs are upstream-scoped and must be invariant across allowed egress routes.
 * Mutable credentials, telemetry, display fields and proxy health are excluded. */
export function catalogFingerprint(upstream: StoredUpstreamRecord, proxies: readonly ProxyRecord[]): string {
  const byId = new Map(proxies.map(proxy => [proxy.id, proxy]))
  const projection = {
    id: upstream.id, incarnation: upstream.rowIncarnation, owner: upstream.ownerId ?? "",
    provider: upstream.provider, enabled: upstream.enabled, config: upstream.config,
    routes: upstream.proxyFallbackList.map(route => {
      const proxy = isDirectFallbackId(route.id) ? undefined : byId.get(route.id)
      return { id: route.id, colos: route.colos ?? [],
        proxy: proxy ? { url: proxy.url, dialTimeoutSeconds: proxy.dialTimeoutSeconds } : null }
    }),
  }
  return createHash("sha256").update(JSON.stringify(canonical(projection))).digest("hex")
}

export function validCatalogModels(value: unknown): value is CatalogModels {
  return typeof value === "object" && value !== null && "object" in value && typeof value.object === "string"
    && "data" in value && Array.isArray(value.data)
    && value.data.every((model: unknown) => typeof model === "object" && model !== null
      && "id" in model && typeof model.id === "string" && model.id.length > 0)
}
