// Admin-only proxy node pool + backoff inspection.
// Keep in sync with packages/gateway/src/control-plane/proxies/routes.ts
// (shapes mirror packages/proxy-repo/src/types.ts field-for-field).
import { api } from "./client"

export interface ProxyRecord {
  id: string
  name: string
  url: string
  createdAt: string
  updatedAt: string
  /** Per-proxy dial deadline in seconds; null means "use the dialer default". */
  dialTimeoutSeconds: number | null
}

export interface ProxyBackoffRow {
  proxyId: string
  upstreamId: string
  failCount: number
  /** Seconds since epoch. */
  expiresAt: number
  lastError: string | null
  /** Seconds since epoch. */
  lastErrorAt: number | null
}

export function listProxies(): Promise<{ proxies: ProxyRecord[] }> {
  return api<{ proxies: ProxyRecord[] }>("/api/proxies")
}

export function createProxy(body: {
  name: string
  url: string
  dialTimeoutSeconds?: number | null
}): Promise<{ proxy: ProxyRecord }> {
  return api<{ proxy: ProxyRecord }>("/api/proxies", { method: "POST", body })
}

export function patchProxy(
  id: string,
  body: { name?: string; url?: string; dialTimeoutSeconds?: number | null },
): Promise<{ proxy: ProxyRecord }> {
  return api<{ proxy: ProxyRecord }>(`/api/proxies/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  })
}

// Throws ApiError(409, { error, upstreamIds }) when the node is still
// referenced by an upstream's fallback list.
export function deleteProxy(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/proxies/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export function listBackoffs(): Promise<{ backoffs: ProxyBackoffRow[] }> {
  return api<{ backoffs: ProxyBackoffRow[] }>("/api/proxies/backoffs")
}

export function resetBackoffs(proxyId: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/proxies/${encodeURIComponent(proxyId)}/backoffs`, {
    method: "DELETE",
  })
}
