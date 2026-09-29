/**
 * Per-request egress fetcher factory.
 *
 * Lives in the gateway rather than `@vibe-core/dial` because it reaches for
 * `getRepo()` / `getSocketDial()`, which a framework-pure package must not.
 *
 * Parse failures on individual proxy rows are isolated to the upstreams that
 * actually reference them: a single malformed URL must not take down every
 * other upstream in the same request. A fetcher built against a bad row throws
 * at call time rather than build time, mirroring how the dial layer surfaces
 * other dial-time failures.
 *
 * `preFetchedUpstreams` lets a caller reuse a list it already loaded on this
 * request instead of paying a second `upstreams.list()` round-trip.
 */
import { getDataPlaneRepo as getRepo } from '../../repo/index.ts'
import { createFetcher, loadProxyCatalog, type DialObserver } from '@vibe-core/dial'
import { getSocketDial } from '@vibe-core/platform'
import { isDirectFallbackId } from '@vibe-core/proxy-repo'
import { runDirectConnectRequest, runProxiedRequest } from '@vibe-core/proxy'
import { directFetcher, type Fetcher } from '@vibe-core/upstream'
import type { Repo } from '../../repo/types.ts'
import type { ProxyRepo } from '@vibe-core/proxy-repo'
import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'

/** Only the two fields the dial layer needs, so both the framework
 *  `UpstreamRecord` and the gateway's `UpstreamRecord<TState>` fit. */
interface DialableUpstream {
  readonly id: string
  readonly proxyFallbackList: readonly ProxyFallbackEntry[]
}

export async function createPerRequestFetcher(
  runtimeLocation: string,
  preFetchedUpstreams?: readonly DialableUpstream[],
  source?: { proxies: Pick<ProxyRepo, "list">; proxyBackoffs: Repo["proxyBackoffs"] },
): Promise<(upstreamId: string, observer?: DialObserver) => Fetcher> {
  const repo = getRepo()
  const upstreams = preFetchedUpstreams ?? (await repo.upstreams.list())
  const fallbackById = new Map(upstreams.map((u) => [u.id, u.proxyFallbackList] as const))

  const referencedProxyIds = new Set<string>()
  for (const list of fallbackById.values()) {
    for (const entry of list) {
      if (!isDirectFallbackId(entry.id)) referencedProxyIds.add(entry.id)
    }
  }

  const { proxyById, parseErrors } = await loadProxyCatalog(source?.proxies ?? repo.proxies, referencedProxyIds)

  return (upstreamId, observer) => {
    // Fail loud on an unknown upstream id. Silently substituting `[]` would
    // route through direct-fetch only, masking a stale api-key→upstream binding
    // as a working proxy bypass.
    const list = fallbackById.get(upstreamId)
    if (list === undefined) {
      throw new Error(`unknown upstream id requested from per-request fetcher: ${upstreamId}`)
    }
    const badRef = list.find((entry) => parseErrors.has(entry.id))
    if (badRef !== undefined) {
      return async () => {
        // Report the id only, never the parse error's message — a ProxyUriError
        // echoes the offending URI and a trojan url embeds its password. This
        // message reaches 5xx response bodies and logs.
        throw new Error(`upstream ${upstreamId} references malformed proxy ${badRef.id}`)
      }
    }
    return createFetcher({
      proxyBackoffs: source?.proxyBackoffs ?? repo.proxyBackoffs,
      upstreamId,
      observer,
      fallbackList: list,
      runtimeLocation,
      proxyById,
      runProxied: runProxiedRequest,
      runDirectFetch: directFetcher,
      runDirectConnect: runDirectConnectRequest,
      socketDial: getSocketDial,
    })
  }
}

/** Request-token Copilot has no stored row and has always used runtime fetch. */
export function createObservedDirectFetcher(upstreamId: string, observer: DialObserver): Fetcher {
  return createFetcher({
    upstreamId,
    observer,
    fallbackList: [{ id: 'direct_fetch' }],
    proxyById: new Map(),
    proxyBackoffs: getRepo().proxyBackoffs,
    runtimeLocation: '',
    runProxied: runProxiedRequest,
    runDirectFetch: directFetcher,
    runDirectConnect: runDirectConnectRequest,
    socketDial: getSocketDial,
  })
}
