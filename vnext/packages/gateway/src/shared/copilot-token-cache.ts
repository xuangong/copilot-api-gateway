/**
 * In-process cache for the Copilot session token exchanged from a GitHub
 * OAuth token. Ported (slim) from src/services/github/copilot-token-cache.ts —
 * KV layer omitted for now; vnext is single-process.
 *
 * Cache key is sha256(accountType + ":" + githubToken). Honors upstream
 * `expires_at` minus a 60s safety buffer.
 */
import { GITHUB_API_BASE_URL, createGithubHeaders, type AccountType } from './config/constants.ts'

interface CopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}

interface CachedToken {
  token: string
  expiresAt: number
}

const memCache = new Map<string, CachedToken>()
const SAFETY_BUFFER_SEC = 60

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function isFresh(entry: CachedToken | null | undefined, nowSec: number): boolean {
  return entry !== null && entry !== undefined && entry.expiresAt > nowSec + SAFETY_BUFFER_SEC
}

async function exchangeGithubToken(githubToken: string): Promise<CopilotTokenResponse> {
  const resp = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
    headers: createGithubHeaders(githubToken),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Failed to exchange GitHub token (${resp.status}): ${text}`)
  }
  return (await resp.json()) as CopilotTokenResponse
}

export async function getCachedCopilotToken(
  githubToken: string,
  accountType: AccountType,
): Promise<string> {
  const cacheKey = await sha256Hex(`${accountType}:${githubToken}`)
  const nowSec = Math.floor(Date.now() / 1000)

  const mem = memCache.get(cacheKey)
  if (isFresh(mem, nowSec)) return mem!.token

  const fresh = await exchangeGithubToken(githubToken)
  memCache.set(cacheKey, { token: fresh.token, expiresAt: fresh.expires_at })
  return fresh.token
}

export async function invalidateCopilotToken(
  githubToken: string,
  accountType: AccountType,
): Promise<void> {
  const cacheKey = await sha256Hex(`${accountType}:${githubToken}`)
  memCache.delete(cacheKey)
}
