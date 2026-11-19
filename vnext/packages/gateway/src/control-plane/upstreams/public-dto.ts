import type { UpstreamRecord } from "../../repo/types.ts"
import { isSynced } from "../sync/read-only.ts"
import { isSyncableProvider, providerPlugin } from "../../data-plane/providers/registry.ts"
import { isSyncableWireUpstream } from "../../sync/protocol.ts"
import type { ProtectionSettings } from "../../repo/protection.ts"
import type { publicLokiStatus } from "@vibe-llm/provider-loki"
import type { PublicCodexCredentialStatus } from "@vibe-llm/provider-codex"

export type PublicUpstream = Pick<UpstreamRecord<unknown>,
  "id" | "ownerId" | "provider" | "name" | "enabled" | "sortOrder" | "config" |
  "flagOverrides" | "disabledPublicModelIds" | "proxyFallbackList" | "createdAt" | "updatedAt"> & {
    tokenExpiredAt?: string
    credentialStatus?: PublicCodexCredentialStatus
    lokiStatus?: ReturnType<typeof publicLokiStatus>
    /** The server would accept this row in a device selection. */
    syncable: boolean
    /** Why `syncable` is false: provider not supported, row synced from another gateway, or id/name not valid on the wire. */
    syncBlocked?: "provider" | "synced" | "wire"
    /** Present on rows created by a sync source; `origin` is null when the source row is gone. */
    syncedFrom?: { origin: string | null }
    /** Upstream error protection settings, resolved with defaults. */
    protection?: ProtectionSettings
  }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * The dashboard-safe config of an upstream. Each provider owns its allowlist
 * (`LlmProviderPlugin.publicConfig`); a provider without one exposes nothing.
 */
export function publicUpstreamConfig(upstream: UpstreamRecord<unknown>): Record<string, unknown> {
  return providerPlugin(upstream.provider)?.publicConfig?.(record(upstream.config)) ?? {}
}

export function serializeUpstream(upstream: UpstreamRecord<unknown>, options: { syncOrigin?: string | null; protection?: ProtectionSettings } = {}): PublicUpstream {
  const dto: PublicUpstream = {
    id: upstream.id, ownerId: upstream.ownerId, provider: upstream.provider, name: upstream.name,
    enabled: upstream.enabled, sortOrder: upstream.sortOrder, config: publicUpstreamConfig(upstream),
    flagOverrides: upstream.flagOverrides, disabledPublicModelIds: upstream.disabledPublicModelIds,
    proxyFallbackList: upstream.proxyFallbackList, createdAt: upstream.createdAt, updatedAt: upstream.updatedAt, syncable: false,
  }
  // Provider-owned status fields (SDF token expiry, Codex credential health, Loki pairing).
  Object.assign(dto, providerPlugin(upstream.provider)?.publicStatus?.(upstream) ?? {})
  // Mirrors the device selection check in control-plane/sync/devices.ts.
  const blocked = !isSyncableProvider(upstream.provider) ? "provider" : isSynced(upstream) ? "synced"
    : !isSyncableWireUpstream(upstream) ? "wire" : undefined
  dto.syncable = blocked === undefined
  if (blocked) dto.syncBlocked = blocked
  if (isSynced(upstream)) dto.syncedFrom = { origin: options.syncOrigin ?? null }
  if (options.protection) dto.protection = options.protection
  return dto
}
