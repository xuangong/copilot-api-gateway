/**
 * Fetcher resolution for control-plane operations.
 *
 * Which argument a caller passes is a choice about *when* a bad chain is
 * reported, not about whether the caller has a persisted row. `override`
 * validates the chain's proxy ids before returning and throws; `upstreamId`
 * loads the row's chain and never validates it, deferring every chain failure
 * to dial time, inside the fetcher that comes back.
 *
 * Pass `override` when chain-content errors must surface eagerly. Two callers
 * do. `egressFetcher` (control-plane/auth/github-routes.ts) has no persisted
 * row yet — a Copilot upstream id embeds the GitHub user id, which is only
 * known after login — so a submitted draft chain is all it has. `accountFetcher`
 * (control-plane/github-accounts/routes.ts) does have a row, and still reads
 * that row's chain itself and re-submits it here as an `override`: its two
 * outbound helpers swallow every dial-time failure into `quota: null` /
 * `token_valid: false`, so a deferred chain error would reach the operator as
 * "your token is dead". It passes `upstreamId` alongside — see the backoff-key
 * note below.
 *
 * Pass `upstreamId` when deferring to dial time is acceptable, i.e. the caller
 * turns a dial failure into an error rather than into data: `quotaFetcher`
 * (control-plane/copilot-quota/routes.ts), whose `relayQuota` maps a throw to
 * 502, and `upstreamFetcher` (control-plane/upstreams/routes.ts) behind the
 * admin Test / Models buttons. That branch reuses the per-request fetcher the
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
    // `draft` is only the fallback for an override caller that has no upstream
    // id. A draft flow is that caller, so every concurrent draft shares one
    // literal `draft` backoff key. Deliberate and bounded: `runFallbacks`' pass
    // 2 retries exactly the entries pass 1 skipped for backoff, so one admin's
    // failed dial never stops another's draft from reaching the proxy — it only
    // costs that draft the pass-1 latency. The cost is cosmetic: operators see
    // a `draft` row in the dashboard backoff panel matching no upstream.
    //
    // An override caller that does have an id passes it and keeps backoff keyed
    // per-upstream; `accountFetcher` in control-plane/github-accounts/routes.ts
    // is one. Hard-coding `draft` here would read as a simplification and would
    // silently pool that route's backoff state with every draft's.
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
    // Hand the row we already loaded to the per-request factory. Letting it
    // load its own list would filter `enabled = 1`, so a DISABLED upstream
    // with a chain would hit its fail-loud "unknown upstream id" throw — a
    // third behaviour beyond the two rules above, and reachable from the
    // normal admin loop (disable a flaky upstream, fix it, hit Test before
    // re-enabling). Passing `[row]` also skips a full `upstreams.list()` plus
    // a catalog load spanning every other upstream's proxy refs.
    return (await createPerRequestFetcher(opts.runtimeLocation, [row]))(opts.upstreamId)
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
