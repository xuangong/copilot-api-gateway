/**
 * Two-level cache for the Copilot session token exchanged from a GitHub
 * OAuth token. Mirrors the cache that AppState used to maintain for the
 * single "request copilot" path — extends it to per-upstream tokens so
 * binding-resolved requests don't pay a GitHub round-trip every time.
 *
 * Level 1: in-process Map (fastest, per-isolate)
 * Level 2: KV storage when provided (cross-isolate / cross-region survival)
 *
 * Cache key is sha256(accountType + ":" + githubToken). The token itself
 * is never used as a map key — sha256 keeps it out of any process dump.
 *
 * Expiry honors the upstream-reported `expires_at` minus a 60s safety buffer.
 */

import type { AccountType } from "~/config/constants"
import { getCopilotToken, type CopilotTokenResponse } from "./copilot-token"

interface CachedToken {
  token: string
  expiresAt: number
}

const memCache = new Map<string, CachedToken>()
const SAFETY_BUFFER_SEC = 60
const KV_PREFIX = "copilot_token_v2:"

export interface CopilotTokenCacheKV {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest("SHA-256", buf)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function isFresh(entry: CachedToken | null | undefined, nowSec: number): boolean {
  return entry !== null && entry !== undefined && entry.expiresAt > nowSec + SAFETY_BUFFER_SEC
}

export async function getCachedCopilotToken(
  githubToken: string,
  accountType: AccountType,
  kv?: CopilotTokenCacheKV,
): Promise<string> {
  const cacheKey = await sha256Hex(`${accountType}:${githubToken}`)
  const nowSec = Math.floor(Date.now() / 1000)

  // L1: in-process
  const mem = memCache.get(cacheKey)
  if (isFresh(mem, nowSec)) return mem!.token

  // L2: KV
  if (kv) {
    const raw = await kv.get(KV_PREFIX + cacheKey).catch(() => null)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CachedToken
        if (isFresh(parsed, nowSec)) {
          memCache.set(cacheKey, parsed)
          return parsed.token
        }
      } catch { /* fall through to refresh */ }
    }
  }

  // Refresh from GitHub.
  const fresh = await getCopilotToken(githubToken)
  const entry: CachedToken = { token: fresh.token, expiresAt: fresh.expires_at }
  memCache.set(cacheKey, entry)
  if (kv) {
    const ttl = Math.max(60, entry.expiresAt - nowSec - SAFETY_BUFFER_SEC)
    void ttl
    await kv.set(KV_PREFIX + cacheKey, JSON.stringify(entry)).catch(() => {})
  }
  return entry.token
}

/**
 * Invalidate a single account's cached token. Called when an admin edits or
 * deletes the upstream config, so the next request re-exchanges instead of
 * serving a stale token whose underlying GitHub credential may have changed.
 */
export async function invalidateCopilotToken(
  githubToken: string,
  accountType: AccountType,
  kv?: CopilotTokenCacheKV,
): Promise<void> {
  const cacheKey = await sha256Hex(`${accountType}:${githubToken}`)
  memCache.delete(cacheKey)
  if (kv) await kv.delete(KV_PREFIX + cacheKey).catch(() => {})
}

/** For tests — wipe the in-process cache between cases. */
export function _resetCopilotTokenCacheForTests(): void {
  memCache.clear()
}

export type { CopilotTokenResponse }
