export const SYNC_VERSION = 1 as const
export const SYNC_DEVICE_ID_PATTERN = /^sdv_[a-f0-9]{32}$/
export const SYNC_DEVICE_SECRET_PATTERN = /^sds_[a-f0-9]{64}$/
export const SYNC_MAX_DEVICES_PER_OWNER = 16
export const SYNC_MAX_DEVICE_UPSTREAMS = 256
/** `last_sync_at` is written at most this often per device. */
export const SYNC_LAST_SYNC_STAMP_MS = 10 * 60 * 1000

/** The one-time document handed to a device. */
export interface SyncDocument {
  version: typeof SYNC_VERSION
  kind: "gateway-sync"
  gatewayOrigin: string
  deviceId: string
  deviceSecret: string
}

export function syncDocument(gatewayOrigin: string, deviceId: string, deviceSecret: string): SyncDocument {
  return { version: SYNC_VERSION, kind: "gateway-sync", gatewayOrigin, deviceId, deviceSecret }
}
