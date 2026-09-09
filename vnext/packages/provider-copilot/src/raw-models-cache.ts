import { waitUntil } from "@vibe-core/platform"
/**
 * Tiny in-process cache for the raw Copilot model list, used at request time to
 * resolve Claude variant ids (e.g. claude-opus-4.7 + context-1m-2025-08-07 →
 * claude-opus-4.7-1m-internal). Keyed by accountType + token-hash; TTL 60s.
 *
 * We intentionally avoid sharing this cache with the `/models` surface (which
 * goes through mergeClaudeVariants) so the raw structure remains available for
 * variant resolution.
 */

import type { AccountType } from "./account-type"
import type { Fetcher } from "@vibe-core/upstream"

import { getRawModels, type ModelsResponse } from "./models"

const TTL_MS = 60_000
const pending = new Map<string, Promise<ModelsResponse>>()
let generation = 0
const cache = new Map<string, { fetchedAt: number; data: ModelsResponse }>()

const hashToken = (token: string): string => {
  // FNV-1a 32-bit; sufficient to scope the cache without exposing the token.
  let hash = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

// baseUrl is part of the key: the same token resolves to a different catalog on
// a GHE data-residency tenant than on the accountType-derived public host.
// The fetcher is deliberately NOT part of the key — it only decides how the
// bytes leave this host, not which catalog comes back, and the token already
// scopes the entry to one tenant.
const rawModelsCacheKey = (
  copilotToken: string,
  accountType: AccountType,
  baseUrlOverride?: string,
): string => `${accountType}:${baseUrlOverride ?? ""}:${hashToken(copilotToken)}`

export async function getCachedRawModels(
  copilotToken: string,
  accountType: AccountType,
  baseUrlOverride?: string,
  fetcher?: Fetcher,
): Promise<ModelsResponse> {
  const key = rawModelsCacheKey(copilotToken, accountType, baseUrlOverride)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.fetchedAt < TTL_MS) return hit.data
  let refresh = pending.get(key)
  if (!refresh) {
    const epoch = generation
    refresh = getRawModels(copilotToken, accountType, baseUrlOverride, fetcher).then(data => {
      if (epoch === generation) rememberRawModels(copilotToken, accountType, baseUrlOverride, data)
      return data
    }).finally(() => { if (pending.get(key) === refresh) pending.delete(key) })
    pending.set(key, refresh)
  }
  if (hit) {
    hit.fetchedAt = now - TTL_MS + 30_000
    const background = refresh.catch(() => {})
    try { waitUntil(background) } catch { void background }
    return hit.data
  }
  return refresh
}

/**
 * Drop every cached model list. Called when bulk invalidation is needed
 * (e.g. multi-upstream config sync). For single-upstream edits prefer
 * invalidateRawModelsForToken(token, accountType).
 */
export function clearRawModelsCache(): void {
  generation++
  cache.clear()
  pending.clear()
}

/**
 * Targeted invalidation for a single Copilot session token. Mirrors the
 * key shape used by getCachedRawModels so admin edits that swap a single
 * upstream's token don't blow away unrelated entries.
 */
export function invalidateRawModelsForToken(
  copilotToken: string,
  accountType: AccountType,
  baseUrlOverride?: string,
): void {
  generation++
  const key = rawModelsCacheKey(copilotToken, accountType, baseUrlOverride)
  cache.delete(key)
  pending.delete(key)
}

/** Bounded across token rotations; normal gateway calls seed this from its catalog. */
export function rememberRawModels(token: string, account: AccountType, baseUrl: string | undefined, data: ModelsResponse): void {
  const key = rawModelsCacheKey(token, account, baseUrl)
  cache.delete(key)
  cache.set(key, { fetchedAt: Date.now(), data })
  while (cache.size > 256) cache.delete(cache.keys().next().value!)
}
