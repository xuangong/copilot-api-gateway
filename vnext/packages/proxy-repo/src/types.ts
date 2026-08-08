/**
 * @vibe-core/proxy-repo — persistence for proxy fallback dispatch.
 *
 * Ported from copilot-gateway/packages/gateway/src/repo/{types.ts,proxy-fallback-list.ts,sql.ts}
 * (Stage D of vNext proxy fallback move). Two independent repo surfaces:
 *
 *  - `ProxyRepo`         — CRUD over `proxies` rows (id / url / dial timeout).
 *  - `ProxyBackoffRepo`  — per-(proxy, upstream) failure schedule stored in
 *    `proxy_upstream_backoffs`. Success clears the row; failure UPSERTs and
 *    advances the geometric schedule (60·2^n clamped to 3600s).
 *
 * Kept in a standalone package so provider plugins / the dispatcher /
 * control-plane routes can depend on this without pulling in the whole
 * gateway. The gateway's shared `Repo` composer adds these fields through
 * the same SqlExecutor seam it already uses for upstreams/api-keys.
 */

/** A single row in the `proxies` table. */
export interface ProxyRecord {
  id: string
  name: string
  url: string
  createdAt: string
  updatedAt: string
  /** Per-proxy dial deadline in seconds; null means "use the dialer default". */
  dialTimeoutSeconds: number | null
}

/**
 * Entry in `upstreams.proxy_fallback_list_json`. `colos` absent → matches
 * every runtime location; non-empty → whitelist. Empty arrays are stripped
 * by `normalizeProxyFallbackList` before storage.
 */
export interface ProxyFallbackEntry {
  id: string
  colos?: string[]
}

export interface ProxyRepo {
  list(): Promise<ProxyRecord[]>
  getById(id: string): Promise<ProxyRecord | null>
  insert(input: {
    id: string
    name: string
    url: string
    dialTimeoutSeconds: number | null
  }): Promise<ProxyRecord>
  patch(
    id: string,
    patch: { name?: string; url?: string; dialTimeoutSeconds?: number | null },
  ): Promise<{ record: ProxyRecord; urlChanged: boolean } | null>
  save(record: {
    id: string
    name: string
    url: string
    dialTimeoutSeconds: number | null
  }): Promise<void>
  /**
   * Refuses to delete a row still referenced by any upstream's fallback list
   * (checked via json_each on `upstreams.proxy_fallback_list_json`).
   * Returns `false` when the row is missing OR when it is still referenced.
   */
  delete(id: string): Promise<boolean>
  deleteAll(): Promise<void>
  /** Returns upstream ids whose `proxy_fallback_list_json` mentions `proxyId`. */
  findUpstreamsReferencing(proxyId: string): Promise<string[]>
}

/** Snapshot row from `proxy_upstream_backoffs`. */
export interface BackoffRow {
  proxyId: string
  upstreamId: string
  failCount: number
  /** Seconds since epoch. */
  expiresAt: number
  lastError: string | null
  /** Seconds since epoch. */
  lastErrorAt: number | null
}

export interface ProxyBackoffRepo {
  recordDialFailure(proxyId: string, upstreamId: string, errorMessage: string): Promise<void>
  recordDialSuccess(proxyId: string, upstreamId: string): Promise<void>
  listForUpstream(upstreamId: string): Promise<BackoffRow[]>
  listForProxy(proxyId: string): Promise<BackoffRow[]>
  listAll(): Promise<BackoffRow[]>
  resetForProxy(proxyId: string): Promise<void>
  resetForUpstream(upstreamId: string): Promise<void>
  reset(proxyId: string, upstreamId: string): Promise<void>
  deleteAll(): Promise<void>
}
