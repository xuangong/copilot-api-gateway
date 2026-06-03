/**
 * Tiny in-process cache for the raw Copilot model list, used at request time to
 * resolve Claude variant ids (e.g. claude-opus-4.7 + context-1m-2025-08-07 →
 * claude-opus-4.7-1m-internal). Keyed by accountType + token-hash; TTL 60s.
 *
 * We intentionally avoid sharing this cache with the `/models` surface (which
 * goes through mergeClaudeVariants) so the raw structure remains available for
 * variant resolution.
 */

import type { AccountType } from "../../../shared/config/constants.ts"

import { getRawModels, type ModelsResponse } from "./models"

const TTL_MS = 60_000
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

export async function getCachedRawModels(
  copilotToken: string,
  accountType: AccountType,
): Promise<ModelsResponse> {
  const key = `${accountType}:${hashToken(copilotToken)}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.fetchedAt < TTL_MS) return hit.data
  const data = await getRawModels(copilotToken, accountType)
  cache.set(key, { fetchedAt: now, data })
  return data
}

/**
 * Drop every cached model list. Called when bulk invalidation is needed
 * (e.g. multi-upstream config sync). For single-upstream edits prefer
 * invalidateRawModelsForToken(token, accountType).
 */
export function clearRawModelsCache(): void {
  cache.clear()
}

/**
 * Targeted invalidation for a single Copilot session token. Mirrors the
 * key shape used by getCachedRawModels so admin edits that swap a single
 * upstream's token don't blow away unrelated entries.
 */
export function invalidateRawModelsForToken(
  copilotToken: string,
  accountType: AccountType,
): void {
  cache.delete(`${accountType}:${hashToken(copilotToken)}`)
}
