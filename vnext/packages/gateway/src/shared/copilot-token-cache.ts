/**
 * In-process cache for the Copilot session token exchanged from a GitHub
 * OAuth token. Ported (slim) from src/services/github/copilot-token-cache.ts —
 * KV layer omitted for now; vnext is single-process.
 *
 * Cache key is sha256(githubHost + ":" + accountType + ":" + githubToken).
 * Honors upstream `expires_at` minus a 60s safety buffer.
 *
 * `expires_at` is not the whole story: GitHub can revoke a session token well
 * before it nominally expires, and a cache that only reads the clock will keep
 * serving the dead token until it ages out — the caller sees an unbroken run of
 * 401/403 with no way to recover short of re-authorising the account. Hence the
 * `forceRefresh` option: a caller that has *observed* a rejection can demand a
 * fresh exchange. It is rate-limited (REFRESH_COOLDOWN_MS) and de-duplicated
 * (one in-flight exchange per key) so that a genuinely unauthorised caller —
 * e.g. a model the tenant is not entitled to, which also answers 403 — cannot
 * turn every request into a round trip to GitHub.
 *
 * Returns both the session token AND the tenant's `endpoints.api` URL —
 * GHE-with-data-residency tenants (SUBDOMAIN.ghe.com) advertise a
 * per-tenant Copilot API host (e.g. copilot-api.msft.ghe.com) instead of
 * the api.githubcopilot.com family used by github.com accounts.
 */
import type { Fetcher } from '@vibe-core/upstream'
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
/** One shared exchange per key, so N concurrent rejections cost one round trip. */
const inflight = new Map<string, Promise<CopilotSession>>()
/** When each key last *actually* exchanged, for the forceRefresh cooldown. */
const lastExchangeAt = new Map<string, number>()
const SAFETY_BUFFER_SEC = 60
const REFRESH_COOLDOWN_MS = 60_000

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
  // Optional so the three call sites — data-plane/providers/registry.ts,
  // control-plane/auth/session-auth.ts and control-plane/auth/github-routes.ts
  // — can migrate independently. Defaulting to the global fetch keeps
  // "no proxy configured" meaning direct egress.
  fetcher: Fetcher = fetch,
): Promise<CopilotTokenResponse> {
  const resp = await fetcher(`${githubApiOrigin(githubHost)}/copilot_internal/v2/token`, {
    headers: createGithubHeaders(githubToken),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Failed to exchange GitHub token (${resp.status}): ${text}`)
  }
  return (await resp.json()) as CopilotTokenResponse
}

export interface GetCopilotTokenOptions {
  /**
   * Ignore the cached entry and exchange again. Set by callers that watched the
   * cached token get rejected (401/403), so the clock-based freshness check
   * cannot be trusted. Subject to REFRESH_COOLDOWN_MS: within that window of the
   * last successful exchange the cached entry is returned unchanged, because a
   * token that new was almost certainly not revoked and the rejection is more
   * likely a genuine entitlement failure that a new token will not fix.
   */
  forceRefresh?: boolean
}

export async function getCachedCopilotToken(
  githubToken: string,
  accountType: AccountType,
  githubHost: string = GITHUB_DOTCOM_HOST,
  fetcher: Fetcher = fetch,
  opts: GetCopilotTokenOptions = {},
): Promise<CopilotSession> {
  // The key deliberately excludes the fetcher and any upstream id. A session
  // token's validity depends on the GitHub token and tenant, not on the egress
  // IP used to obtain it; keying on egress would make every upstream sharing
  // one GitHub token re-exchange needlessly.
  const cacheKey = await sha256Hex(`${githubHost}:${accountType}:${githubToken}`)
  const nowSec = Math.floor(Date.now() / 1000)
  const cached = memCache.get(cacheKey)

  if (!opts.forceRefresh && isFresh(cached, nowSec)) {
    return { token: cached!.token, apiEndpoint: cached!.apiEndpoint }
  }

  if (opts.forceRefresh && cached) {
    const last = lastExchangeAt.get(cacheKey)
    if (last !== undefined && Date.now() - last < REFRESH_COOLDOWN_MS) {
      return { token: cached.token, apiEndpoint: cached.apiEndpoint }
    }
  }

  // Share one exchange across concurrent callers. Without this a burst of
  // rejected requests — or a burst of ordinary requests arriving just as the
  // entry expires — each opens its own round trip to GitHub.
  const pending = inflight.get(cacheKey)
  if (pending) return pending

  const exchange = (async (): Promise<CopilotSession> => {
    const fresh = await exchangeGithubToken(githubToken, githubHost, fetcher)
    if (typeof fresh.token !== 'string' || !fresh.token || typeof fresh.expires_at !== 'number') {
      throw new Error('Malformed Copilot token exchange response')
    }
    const apiEndpoint = fresh.endpoints?.api ?? defaultApiEndpoint(accountType)
    const entry: CachedSession = { token: fresh.token, apiEndpoint, expiresAt: fresh.expires_at }
    memCache.set(cacheKey, entry)
    // Only on success: a failed exchange leaves the caller with nothing, so it
    // must not start a cooldown that suppresses the next attempt.
    lastExchangeAt.set(cacheKey, Date.now())
    return { token: entry.token, apiEndpoint: entry.apiEndpoint }
  })()

  inflight.set(cacheKey, exchange)
  try {
    return await exchange
  } finally {
    inflight.delete(cacheKey)
  }
}

export async function invalidateCopilotToken(
  githubToken: string,
  accountType: AccountType,
  githubHost: string,
): Promise<void> {
  const cacheKey = await sha256Hex(`${githubHost}:${accountType}:${githubToken}`)
  memCache.delete(cacheKey)
  lastExchangeAt.delete(cacheKey)
}
