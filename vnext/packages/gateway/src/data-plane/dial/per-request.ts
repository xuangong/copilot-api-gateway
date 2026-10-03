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
import { getDataPlaneConfiguration, getProxyHealth } from '../../repo/index.ts'
import { createFetcher, loadProxyCatalog, parseProxyCatalog, type DialObserver, type ProxyCatalog } from '@vibe-core/dial'
import { getSocketDial } from '@vibe-core/platform'
import { isDirectFallbackId } from '@vibe-core/proxy-repo'
import { runDirectConnectRequest, runProxiedRequest } from '@vibe-core/proxy'
import { directFetcher, type Fetcher } from '@vibe-core/upstream'
import type { Repo } from '../../repo/types.ts'
import type { ProxyRecord, ProxyRepo } from '@vibe-core/proxy-repo'
import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'

/** Only the two fields the dial layer needs, so both the framework
 *  `UpstreamRecord` and the gateway's `UpstreamRecord<TState>` fit. */
interface DialableUpstream {
  readonly id: string
  readonly proxyFallbackList: readonly ProxyFallbackEntry[]
}

type FetcherFactory = (upstreamId: string, observer?: DialObserver) => Fetcher
type DialSource = { proxies: Pick<ProxyRepo, "list">; proxyBackoffs: Repo["proxyBackoffs"] }

function proxyReferences(lists: Iterable<readonly ProxyFallbackEntry[]>): Set<string> {
  const ids = new Set<string>()
  for (const list of lists) {
    for (const entry of list) {
      if (!isDirectFallbackId(entry.id)) ids.add(entry.id)
    }
  }
  return ids
}

function fetcherForList(
  runtimeLocation: string,
  upstreamId: string,
  list: readonly ProxyFallbackEntry[],
  catalog: ProxyCatalog,
  observer?: DialObserver,
  proxyBackoffs?: Repo["proxyBackoffs"],
): Fetcher {
  const badRef = list.find(entry => catalog.parseErrors.has(entry.id))
  if (badRef !== undefined) {
    return async () => {
      // URI parse messages may contain credentials and reach 5xx/log paths.
      throw new Error(`upstream ${upstreamId} references malformed proxy ${badRef.id}`)
    }
  }
  return createFetcher({
    proxyBackoffs: proxyBackoffs ?? getProxyHealth(),
    upstreamId,
    observer,
    fallbackList: list,
    runtimeLocation,
    proxyById: catalog.proxyById,
    runProxied: runProxiedRequest,
    runDirectFetch: directFetcher,
    runDirectConnect: runDirectConnectRequest,
    socketDial: getSocketDial,
  })
}

function unknownUpstream(upstreamId: string): never {
  // A stale binding must never turn into working implicit direct egress.
  throw new Error(`unknown upstream id requested from per-request fetcher: ${upstreamId}`)
}

function factoryForCatalog(
  runtimeLocation: string,
  fallbackById: ReadonlyMap<string, readonly ProxyFallbackEntry[]>,
  catalog: ProxyCatalog,
  source?: Pick<DialSource, "proxyBackoffs">,
): FetcherFactory {
  return (upstreamId, observer) => {
    const list = fallbackById.get(upstreamId)
    if (list === undefined) return unknownUpstream(upstreamId)
    return fetcherForList(runtimeLocation, upstreamId, list, catalog, observer, source?.proxyBackoffs)
  }
}

export async function createPerRequestFetcher(
  runtimeLocation: string,
  preFetchedUpstreams?: readonly DialableUpstream[],
  source?: DialSource,
): Promise<FetcherFactory> {
  const configuration = getDataPlaneConfiguration()
  const upstreams = preFetchedUpstreams ?? (await configuration.upstreams.list())
  const fallbackById = new Map(upstreams.map((u) => [u.id, u.proxyFallbackList] as const))

  const catalog = await loadProxyCatalog(source?.proxies ?? configuration.proxies, proxyReferences(fallbackById.values()))
  return factoryForCatalog(runtimeLocation, fallbackById, catalog, source)
}

/** Routing keeps storage availability eager, but only request-token providers
 * consume this configuration; stored execution uses its accepted observation. */
export async function preparePerRequestFetcher(
  runtimeLocation: string,
  upstreams: readonly DialableUpstream[],
  source?: DialSource,
): Promise<FetcherFactory> {
  const configuration = getDataPlaneConfiguration()
  let referenced: Set<string> | undefined
  for (const upstream of upstreams) {
    for (const entry of upstream.proxyFallbackList) {
      if (!isDirectFallbackId(entry.id)) (referenced ??= new Set()).add(entry.id)
    }
  }
  const proxies = referenced ? await (source?.proxies ?? configuration.proxies).list() : []
  let materialized: FetcherFactory | undefined
  return (upstreamId, observer) => {
    materialized ??= factoryForCatalog(runtimeLocation,
      new Map(upstreams.map(upstream => [upstream.id, upstream.proxyFallbackList] as const)),
      parseProxyCatalog(proxies, id => referenced?.has(id) ?? false), source)
    return materialized(upstreamId, observer)
  }
}

/** The coordinator's exact single-upstream observation needs no repo adapter,
 * fallback lookup map, reference set, or cloned proxy-row array. */
export function createSingleUpstreamFetcher(
  runtimeLocation: string,
  upstream: DialableUpstream,
  proxies: readonly ProxyRecord[],
  proxyBackoffs: Repo["proxyBackoffs"],
): FetcherFactory {
  getDataPlaneConfiguration()
  const id = upstream.id
  const list = upstream.proxyFallbackList
  const catalog = parseProxyCatalog(proxies, proxyId => !isDirectFallbackId(proxyId) && list.some(entry => entry.id === proxyId))
  return (upstreamId, observer) => {
    if (upstreamId !== id) return unknownUpstream(upstreamId)
    return fetcherForList(runtimeLocation, upstreamId, list, catalog, observer, proxyBackoffs)
  }
}

/** Request-token Copilot has no stored row and has always used runtime fetch. */
export function createObservedDirectFetcher(upstreamId: string, observer: DialObserver): Fetcher {
  return createFetcher({
    upstreamId,
    observer,
    fallbackList: [{ id: 'direct_fetch' }],
    proxyById: new Map(),
    proxyBackoffs: getProxyHealth(),
    runtimeLocation: '',
    runProxied: runProxiedRequest,
    runDirectFetch: directFetcher,
    runDirectConnect: runDirectConnectRequest,
    socketDial: getSocketDial,
  })
}
