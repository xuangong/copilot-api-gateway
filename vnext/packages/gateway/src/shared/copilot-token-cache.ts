/**
 * In-process cache for the Copilot session token exchanged from a GitHub
 * OAuth token. Ported (slim) from src/services/github/copilot-token-cache.ts —
 * KV layer omitted for now; vnext is single-process.
 *
 * Cache key is sha256(githubHost + ":" + accountType + ":" + githubToken).
 * Honors upstream `expires_at` minus a 60s safety buffer.
 *
 * Returns both the session token AND the tenant's `endpoints.api` URL —
 * GHE-with-data-residency tenants (SUBDOMAIN.ghe.com) advertise a
 * per-tenant Copilot API host (e.g. copilot-api.msft.ghe.com) instead of
 * the api.githubcopilot.com family used by github.com accounts.
 */
import { createGithubHeaders, type AccountType } from './config/constants.ts'
import { githubApiOrigin, GITHUB_DOTCOM_HOST } from './config/github-host.ts'

interface CopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: {
    api?: string
    'origin-tracker'?: string
    proxy?: string
    telemetry?: string
  }
}

export interface CopilotSession {
  token: string
  apiEndpoint: string
}

interface CachedSession {
  token: string
  apiEndpoint: string
  expiresAt: number
}

const memCache = new Map<string, CachedSession>()
const SAFETY_BUFFER_SEC = 60

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function isFresh(entry: CachedSession | null | undefined, nowSec: number): boolean {
  return entry !== null && entry !== undefined && entry.expiresAt > nowSec + SAFETY_BUFFER_SEC
}

function defaultApiEndpoint(accountType: AccountType): string {
  return accountType === 'individual'
    ? 'https://api.githubcopilot.com'
    : `https://api.${accountType}.githubcopilot.com`
}

export async function exchangeGithubToken(
  githubToken: string,
  githubHost: string = GITHUB_DOTCOM_HOST,
): Promise<CopilotTokenResponse> {
  const resp = await fetch(`${githubApiOrigin(githubHost)}/copilot_internal/v2/token`, {
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
  githubHost: string = GITHUB_DOTCOM_HOST,
): Promise<CopilotSession> {
  const cacheKey = await sha256Hex(`${githubHost}:${accountType}:${githubToken}`)
  const nowSec = Math.floor(Date.now() / 1000)

  const mem = memCache.get(cacheKey)
  if (isFresh(mem, nowSec)) return { token: mem!.token, apiEndpoint: mem!.apiEndpoint }

  const fresh = await exchangeGithubToken(githubToken, githubHost)
  if (typeof fresh.token !== 'string' || !fresh.token || typeof fresh.expires_at !== 'number') {
    throw new Error('Malformed Copilot token exchange response')
  }
  const apiEndpoint = fresh.endpoints?.api ?? defaultApiEndpoint(accountType)
  const entry: CachedSession = { token: fresh.token, apiEndpoint, expiresAt: fresh.expires_at }
  memCache.set(cacheKey, entry)
  return { token: entry.token, apiEndpoint: entry.apiEndpoint }
}

export async function invalidateCopilotToken(
  githubToken: string,
  accountType: AccountType,
  githubHost: string,
): Promise<void> {
  const cacheKey = await sha256Hex(`${githubHost}:${accountType}:${githubToken}`)
  memCache.delete(cacheKey)
}
