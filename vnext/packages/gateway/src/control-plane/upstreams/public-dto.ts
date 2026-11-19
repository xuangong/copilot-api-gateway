import type { UpstreamRecord } from "../../repo/types.ts"
import { substrateTokenExpiry } from "@vibe-llm/provider-sdf"
import { isSynced } from "../sync/read-only.ts"
import { isSyncableProvider, providerPlugin } from "../../data-plane/providers/registry.ts"
import { isSyncableWireUpstream } from "../../sync/protocol.ts"
import type { ProtectionSettings } from "../../repo/protection.ts"
import { readLokiState, publicLokiStatus } from "@vibe-llm/provider-loki"

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

export interface PublicCodexCredentialStatus {
  health: "active" | "access_rejected" | "session_terminated" | "refresh_failed" | "credential_expired"
  renewable: boolean
  expiresAt: number | null
  expiryKnown: boolean
  quotaObservedAt: number | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function publicCodexCredentialStatus(value: unknown): PublicCodexCredentialStatus | undefined {
  const accounts = record(value).accounts
  if (!Array.isArray(accounts) || accounts.length !== 1) return undefined
  const account = record(accounts[0])
  const accessToken = record(account.accessToken)
  const rawExpiry = accessToken.expiresAt
  const expiresAt = typeof rawExpiry === "number" && Number.isFinite(rawExpiry) ? rawExpiry : null
  const renewable = typeof account.refresh_token === "string" && account.refresh_token.length > 0
  const state = account.state
  const health = state === "access_rejected" || state === "session_terminated" || state === "refresh_failed"
    ? state
    : !renewable && (typeof accessToken.token !== "string" || (expiresAt !== null && expiresAt <= Date.now()))
      ? "credential_expired" : "active"
  const quota = record(account.quotaSnapshot)
  const observations = Object.values(quota).map(entry => record(entry).fetchedAt)
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time))
  return {
    health, renewable, expiresAt, expiryKnown: expiresAt !== null,
    quotaObservedAt: observations.length ? Math.max(...observations) : null,
  }
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
  if (upstream.provider === "sdf") {
    const token = record(upstream.config).substrateToken
    const exp = typeof token === "string" ? substrateTokenExpiry(token) : null
    if (exp !== null && exp * 1000 <= Date.now()) dto.tokenExpiredAt = new Date(exp * 1000).toISOString()
  }
  if (upstream.provider === "codex") dto.credentialStatus = publicCodexCredentialStatus(upstream.state)
  if (upstream.provider === "loki") {
    try {
      const state = readLokiState(upstream.state)
      dto.lokiStatus = publicLokiStatus(state)
    } catch { /* Invalid private state grants no public data. */ }
  }
  // Mirrors the device selection check in control-plane/sync/devices.ts.
  const blocked = !isSyncableProvider(upstream.provider) ? "provider" : isSynced(upstream) ? "synced"
    : !isSyncableWireUpstream(upstream) ? "wire" : undefined
  dto.syncable = blocked === undefined
  if (blocked) dto.syncBlocked = blocked
  if (isSynced(upstream)) dto.syncedFrom = { origin: options.syncOrigin ?? null }
  if (options.protection) dto.protection = options.protection
  return dto
}
