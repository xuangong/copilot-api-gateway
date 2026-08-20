/**
 * LLM API Passport client + cache (aka.ms/llmapi/passport).
 *
 * Passport issues a signed JWT carrying the request metadata LLM API now
 * demands — licenseType, allowedProviderIds, customerType. Those arrive as
 * one `x-metadata-passport` header rather than as three headers we could
 * make up ourselves, so this fetch is mandatory: without it Substrate
 * rejects the call with "Required taxonomy data x-metadata-license-type,
 * x-metadata-allowed-providers, x-metadata-customer-type not provided".
 *
 * Contract from the partner doc: call Passport ONCE per session, off the
 * hot path — calling it per request can trigger a live-site incident. The
 * reference implementation keys its cache by conversation id because it
 * calls with a per-user token. Ours is an app-only token whose passport
 * comes back tenant-scoped (`lvl: "tenant"`), so one entry per
 * (token, ring) covers every request and the cache key needs no session.
 *
 * Authorization is the same bearer we send to LLM API.
 */

import { directFetcher, type Fetcher } from '@vibe-core/upstream'

/** Passport type + contract version are encoded in the path. */
const PASSPORT_PATH = '/v1/passports/llm-api/v1'

/** Expire our copy early so a long-lived isolate re-fetches before LLM API sees a stale one. */
const REFRESH_MARGIN_SECONDS = 300

const FETCH_TIMEOUT_MS = 5_000

interface Entry {
  token: string
  expiresAtMs: number
}

/**
 * Module-level so it survives across requests within a Worker isolate (and
 * for the process lifetime under Bun). A miss costs one extra Passport call
 * on a cold isolate, which is the documented-acceptable rate.
 */
const cache = new Map<string, Entry>()
/**
 * Concurrent first callers all read an empty cache, so a cache-only guard
 * would still fan out N requests. Hold the in-flight promise instead.
 */
const inFlight = new Map<string, Promise<string | null>>()

function cacheKey(substrateToken: string, apiBase: string): string {
  // The tail is enough to distinguish tokens without holding a second copy
  // of the secret in a long-lived map key.
  //
  // The fetcher is deliberately not part of the key: it only decides how the
  // bytes leave this host, not which passport comes back, and (token, apiBase)
  // already scopes the entry to one tenant on one ring.
  return `${apiBase}|${substrateToken.slice(-16)}`
}

async function fetchPassport(
  substrateToken: string,
  apiBase: string,
  fetcher: Fetcher,
): Promise<Entry | null> {
  const url = `${apiBase.replace(/\/+$/, '')}${PASSPORT_PATH}`
  const res = await fetcher(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${substrateToken}`, 'Content-Type': 'application/json' },
    // Identity comes from the token; the body carries only optional session
    // hints, so an empty session object is a valid request.
    body: JSON.stringify({ session: {} }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    // Never log the body — it echoes request metadata.
    console.warn(`[sdf/passport] fetch failed: ${res.status}`)
    return null
  }
  const data = (await res.json()) as { passport?: unknown; expiresIn?: unknown }
  if (typeof data.passport !== 'string' || !data.passport || typeof data.expiresIn !== 'number') {
    console.warn('[sdf/passport] malformed response (missing passport/expiresIn)')
    return null
  }
  return {
    token: data.passport,
    expiresAtMs: Date.now() + Math.max(data.expiresIn - REFRESH_MARGIN_SECONDS, 1) * 1000,
  }
}

/**
 * Return a cached passport, fetching once if cold. Returns null on any
 * failure — the caller omits the header and lets Substrate produce the real
 * error, rather than this becoming a second failure mode of its own.
 *
 * `fetcher` carries the upstream's egress proxy chain. It defaults to
 * `directFetcher` to match SdfProvider's constructor default, so a caller with
 * no proxy configured needs no argument — but a proxied upstream MUST pass its
 * fetcher, or this hop leaves the host directly while the inference call that
 * needs the passport goes through the proxy.
 */
export async function getPassport(
  substrateToken: string,
  apiBase: string,
  fetcher: Fetcher = directFetcher,
): Promise<string | null> {
  const key = cacheKey(substrateToken, apiBase)
  const hit = cache.get(key)
  if (hit && hit.expiresAtMs > Date.now()) return hit.token

  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = fetchPassport(substrateToken, apiBase, fetcher)
    .then((entry) => {
      if (entry) cache.set(key, entry)
      return entry?.token ?? null
    })
    .catch((err: unknown) => {
      console.warn(`[sdf/passport] fetch error: ${err instanceof Error ? err.name : 'unknown'}`)
      return null
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, promise)
  return promise
}

/** Test seam — the cache is module-level and would otherwise leak across cases. */
export function __resetPassportCache(): void {
  cache.clear()
  inFlight.clear()
}
