import { api } from "./client"
import type { UpstreamRecord, ProxyFallbackEntry } from "./types"

export interface FlagDef {
  id: string
  label: string
  description: string
}
export interface FlagCatalog {
  catalog: FlagDef[]
  defaults: Record<string, string[]>
}

export interface ProbeResult {
  ok: boolean
  error?: string
  hint?: string
  modelCount?: number
  models?: string[]
}

export interface UpstreamModelEntry {
  id: string
  name: string
}
export interface UpstreamModelGroup {
  upstream: string
  provider: string
  models: UpstreamModelEntry[]
}

export function listUpstreams(): Promise<{ upstreams: UpstreamRecord[] }> {
  return api<{ upstreams: UpstreamRecord[] }>("/api/upstreams", { query: { includeDisabled: "1" } })
}

interface RawModel {
  id: string
  name?: string
  _upstream?: string
  _provider?: string
}
export async function listModelsByUpstream(): Promise<Map<string, UpstreamModelEntry[]>> {
  // dedupe=0 keeps the per-upstream mapping intact; allOwners=1 covers upstreams
  // owned by other users (server ignores it unless the caller is an admin).
  const r = await api<{ data: RawModel[] }>("/api/models", {
    query: { dedupe: "0", allOwners: "1" },
  })
  const map = new Map<string, UpstreamModelEntry[]>()
  for (const m of r.data ?? []) {
    const up = m._upstream ?? "(unmanaged)"
    if (!map.has(up)) map.set(up, [])
    map.get(up)!.push({ id: m.id, name: m.name ?? m.id })
  }
  return map
}

export function getFlagCatalog(): Promise<FlagCatalog> {
  return api<FlagCatalog>("/api/upstream-flags")
}

export interface UpstreamPatch {
  name?: string
  enabled?: boolean
  sortOrder?: number
  flagOverrides?: Record<string, boolean>
  disabledPublicModelIds?: string[]
  proxyFallbackList?: ProxyFallbackEntry[]
  config?: Record<string, unknown>
}
export function patchUpstream(id: string, body: UpstreamPatch): Promise<UpstreamRecord> {
  return api<UpstreamRecord>(`/api/upstreams/${encodeURIComponent(id)}`, { method: "PATCH", body })
}

export interface CreateUpstreamBody {
  provider: "azure" | "custom" | "sdf"
  name: string
  config: Record<string, unknown>
  flagOverrides?: Record<string, boolean>
  disabledPublicModelIds?: string[]
  ownerId?: string
}
export function createUpstream(body: CreateUpstreamBody): Promise<UpstreamRecord> {
  return api<UpstreamRecord>("/api/upstreams", { method: "POST", body })
}

export function deleteUpstream(id: string): Promise<{ ok: true }> {
  return api(`/api/upstreams/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export function probeUpstream(id: string): Promise<ProbeResult> {
  return api<ProbeResult>(`/api/upstreams/${encodeURIComponent(id)}/test`, { method: "POST" })
}

export function deleteGithubAccount(userId: number): Promise<unknown> {
  return api(`/auth/github/${userId}`, { method: "DELETE" })
}

// GitHub device-flow auth
export interface DeviceFlowStart {
  user_code: string
  verification_uri: string
  device_code: string
  interval?: number
}
// POST, not GET: the request carries the draft proxy chain, and a GET has
// nowhere to put a body. Always sends at least `{}` so the server's zod
// validator sees a parseable JSON body.
export function startGithubDeviceFlow(
  proxyFallbackList?: ProxyFallbackEntry[],
): Promise<DeviceFlowStart> {
  return api<DeviceFlowStart>("/auth/github", {
    method: "POST",
    body: proxyFallbackList?.length ? { proxy_fallback_list: proxyFallbackList } : {},
  })
}

export interface DeviceFlowPoll {
  status: "pending" | "complete" | "slow_down" | "error"
  interval?: number
  error?: string
}
export function pollGithubDeviceFlow(
  deviceCode: string,
  proxyFallbackList?: ProxyFallbackEntry[],
): Promise<DeviceFlowPoll> {
  return api<DeviceFlowPoll>("/auth/github/poll", {
    method: "POST",
    body: proxyFallbackList?.length
      ? { device_code: deviceCode, proxy_fallback_list: proxyFallbackList }
      : { device_code: deviceCode },
  })
}

export interface PasteTokenResult {
  status: "complete" | "error"
  user?: { login: string; id: number }
  github_host?: string
  account_type?: string
  error?: string
}
export function pasteGithubToken(
  github_token: string,
  github_host: string,
  proxyFallbackList?: ProxyFallbackEntry[],
): Promise<PasteTokenResult> {
  return api<PasteTokenResult>("/auth/github/paste-token", {
    method: "POST",
    body: proxyFallbackList?.length
      ? { github_token, github_host, proxy_fallback_list: proxyFallbackList }
      : { github_token, github_host },
  })
}

export interface UpstreamCatalog {
  models: { id: string; name: string }[]
  disabledPublicModelIds: string[]
}
export function getUpstreamCatalog(id: string): Promise<UpstreamCatalog> {
  return api<UpstreamCatalog>(`/api/upstreams/${encodeURIComponent(id)}/models`)
}

