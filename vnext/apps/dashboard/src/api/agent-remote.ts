import { api, ApiError } from "./client"

export interface RemoteHost {
  id: string
  name: string
  online: boolean
  providers: { providerId: string; displayName: string }[]
  managed: boolean
  access: "owner" | "shared"
  sessionQuota?: { limit: number; used: number }
}
export interface HostShare {
  subject: string
  label: string
  sessionLimit: number
  used: number
  revoked: boolean
}
export function parseSessionLimit(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const limit = Number(value)
  return Number.isSafeInteger(limit) && limit <= 10_000 ? limit : undefined
}
const sharesPath = (hostId: string) => `/api/agent-remote/hosts/${encodeURIComponent(hostId)}/shares`
export const listRemoteHosts = (signal?: AbortSignal) => api<{ hosts: RemoteHost[] }>("/api/agent-remote/hosts", { signal })
export const listHostShares = (hostId: string, signal?: AbortSignal) => api<{ shares: HostShare[] }>(sharesPath(hostId), { signal })
export const saveHostShare = (hostId: string, email: string, sessionLimit: number) => api<{ ok: true }>(sharesPath(hostId), { method: "PUT", body: { email, sessionLimit } })
export const revokeHostShare = (hostId: string, email: string) => api<{ ok: true }>(sharesPath(hostId), { method: "DELETE", body: { email } })

export function remoteReauthenticationUrl(cause: unknown, origin: string): string | undefined {
  if (!(cause instanceof ApiError) || cause.status !== 403 || !cause.body || typeof cause.body !== "object" ||
    !("code" in cause.body) || cause.body.code !== "reauthentication_required" || !("loginUrl" in cause.body) || typeof cause.body.loginUrl !== "string") return undefined
  try {
    const url = new URL(cause.body.loginUrl)
    if (url.origin !== origin || url.pathname !== "/agent-remote" || url.hash || url.username || url.password ||
      url.searchParams.get("reauthenticate") !== "1" || url.searchParams.getAll("reauthenticate").length !== 1) return undefined
    for (const key of url.searchParams.keys()) if (key !== "reauthenticate" && key !== "host") return undefined
    const hosts = url.searchParams.getAll("host")
    if (hosts.length > 1 || (hosts[0] !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(hosts[0]))) return undefined
    return url.href
  } catch { return undefined }
}
