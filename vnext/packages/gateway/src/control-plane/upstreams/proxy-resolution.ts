/**
 * Fetcher resolution for control-plane operations.
 *
 * Two shapes of caller exist. A dashboard *add* flow has no persisted row yet
 * — a Copilot upstream id embeds the GitHub user id, which is only known after
 * login — so it submits the chain it picked as an `override`. Everything that
 * already has a row passes `upstreamId` and reuses the per-request fetcher the
 * data plane builds.
 *
 * The override path validates ids against the proxy catalog and throws on
 * unknown / malformed entries rather than degrading to a bare `fetch`: on a
 * host whose only egress is a proxy, a silent degrade reports "GitHub
 * unreachable" when the real cause is a misconfigured chain.
 *
 * Returns `undefined` when the effective chain is empty, meaning "the caller
 * keeps its default global fetch". Collapsing an empty chain to `direct_connect`
 * (as the data plane does in packages/dial/src/fetcher.ts) would swap the
 * transport of every control-plane call on every deployment that has no chain
 * configured, to no benefit: `direct_connect` exists to dodge fetch's body
 * timeout on long inference streams, and these are short JSON round-trips.
 */
import { getRepo } from '../../repo/index.ts'
import type { UpstreamId } from '../../repo/branded-ids.ts'
import { createPerRequestFetcher } from '../../data-plane/dial/per-request.ts'
import { createFetcher, loadProxyCatalog } from '@vibe-core/dial'
import { getSocketDial } from '@vibe-core/platform'
import { isDirectFallbackId, normalizeProxyFallbackList } from '@vibe-core/proxy-repo'
import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'
import { runDirectConnectRequest, runProxiedRequest } from '@vibe-core/proxy'
import { directFetcher, type Fetcher } from '@vibe-core/upstream'

export async function resolveControlPlaneFetcher(opts: {
  override?: readonly ProxyFallbackEntry[]
  upstreamId?: string
  runtimeLocation: string
}): Promise<Fetcher | undefined> {
  if (opts.override !== undefined) {
    const list = normalizeProxyFallbackList(opts.override)
    if (list.length === 0) return undefined
    return await buildOverrideFetcher(list, opts.upstreamId ?? 'draft', opts.runtimeLocation)
  }
  if (opts.upstreamId !== undefined) {
    // One rule: a chain that exists but cannot resolve throws; everything else
    // means direct. A missing row and an empty chain are both "no chain".
    const row = await getRepo().upstreams.getById(opts.upstreamId as UpstreamId)
    if (!row) return undefined
    if (normalizeProxyFallbackList(row.proxyFallbackList ?? []).length === 0) {
      return undefined
    }
    return (await createPerRequestFetcher(opts.runtimeLocation))(opts.upstreamId)
  }
  return undefined
}

async function buildOverrideFetcher(
  list: readonly ProxyFallbackEntry[],
  upstreamId: string,
  runtimeLocation: string,
): Promise<Fetcher> {
  const referenced = new Set(
    list.filter((entry) => !isDirectFallbackId(entry.id)).map((entry) => entry.id),
  )

  const repo = getRepo()
  const { proxyById, parseErrors } = await loadProxyCatalog(repo.proxies, referenced)

  const unknown = list.find(
    (entry) =>
      !isDirectFallbackId(entry.id) && !proxyById.has(entry.id) && !parseErrors.has(entry.id),
  )
  if (unknown !== undefined) {
    throw new Error(`unknown proxy id in fallback list: ${unknown.id}`)
  }
  const bad = list.find((entry) => parseErrors.has(entry.id))
  if (bad !== undefined) {
    // Report the id only, never the parse error's message — a ProxyUriError
    // echoes the offending URI and a trojan url embeds its password.
    throw new Error(`malformed proxy ${bad.id}`)
  }

  return createFetcher({
    proxyBackoffs: repo.proxyBackoffs,
    upstreamId,
    fallbackList: list,
    runtimeLocation,
    proxyById,
    runProxied: runProxiedRequest,
    runDirectFetch: directFetcher,
    runDirectConnect: runDirectConnectRequest,
    socketDial: getSocketDial,
  })
}
