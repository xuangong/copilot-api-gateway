/**
 * Resolve the proxy ids an upstream's fallback list references into parsed
 * dial configs. Parse failures are collected per-id instead of thrown so a
 * single malformed row cannot take down every upstream in the request.
 *
 * Ported from copilot-gateway/packages/gateway/src/dial/proxy-catalog.ts.
 */
import { parseProxyUri, type ProxyConfig, type ProxyUriError } from '@vibe-core/proxy'
import type { ProxyRepo } from '@vibe-core/proxy-repo'

/** Parsed wire config plus an optional per-proxy dial deadline. */
export interface ProxyEntry {
  config: ProxyConfig
  /** ms; null means "use the dialer's default". */
  dialTimeoutMs: number | null
}

export interface ProxyCatalog {
  readonly proxyById: Map<string, ProxyEntry>
  readonly parseErrors: Map<string, ProxyUriError>
}

export const loadProxyCatalog = async (
  proxies: Pick<ProxyRepo, 'list'>,
  referencedIds: ReadonlySet<string>,
): Promise<ProxyCatalog> => {
  const proxyById = new Map<string, ProxyEntry>()
  const parseErrors = new Map<string, ProxyUriError>()
  if (referencedIds.size === 0) return { proxyById, parseErrors }

  for (const proxy of await proxies.list()) {
    if (!referencedIds.has(proxy.id)) continue
    try {
      proxyById.set(proxy.id, {
        config: parseProxyUri(proxy.url),
        dialTimeoutMs:
          proxy.dialTimeoutSeconds === null ? null : proxy.dialTimeoutSeconds * 1000,
      })
    } catch (error) {
      parseErrors.set(proxy.id, error as ProxyUriError)
    }
  }
  return { proxyById, parseErrors }
}
