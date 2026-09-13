import { api } from "./client"

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
