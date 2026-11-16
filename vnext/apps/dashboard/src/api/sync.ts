import { api } from "./client"

export interface SyncDevice {
  id: string
  label: string
  upstreamIds: string[]
  createdAt: string
  lastSyncAt: string | null
}

export interface SyncDocument {
  version: 1
  kind: "gateway-sync"
  gatewayOrigin: string
  deviceId: string
  deviceSecret: string
}

export interface SyncSourceView {
  origin: string
  deviceId: string
  status: "active" | "revoked"
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  upstreamCount: number
}

export const listSyncDevices = () => api<{ devices: SyncDevice[] }>("/api/sync/devices")
export const issueSyncDevice = (body: { label: string; upstreamIds: string[] }) =>
  api<{ device: SyncDevice; document: unknown }>("/api/sync/devices", { method: "POST", body })
export const updateSyncDevice = (id: string, body: { label?: string; upstreamIds?: string[] }) =>
  api<{ device: SyncDevice }>(`/api/sync/devices/${encodeURIComponent(id)}`, { method: "PATCH", body })
export const revokeSyncDevice = (id: string) =>
  api<{ devices: SyncDevice[] }>(`/api/sync/devices/${encodeURIComponent(id)}`, { method: "DELETE" })

export const getSyncSource = () => api<{ available: boolean; source: SyncSourceView | null }>("/api/sync/source")
export const connectSyncSource = (document: SyncDocument) =>
  api<{ source: SyncSourceView }>("/api/sync/source", { method: "POST", body: { document } })
export const replaceSyncSource = (document: SyncDocument) =>
  api<{ source: SyncSourceView }>("/api/sync/source", { method: "PUT", body: { document } })
export const disconnectSyncSource = () => api<{ source: null }>("/api/sync/source", { method: "DELETE" })
