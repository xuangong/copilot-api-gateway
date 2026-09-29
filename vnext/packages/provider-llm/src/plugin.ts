/**
 * LlmProviderPlugin — per-package factory contract.
 *
 * Alias of the framework UpstreamPlugin with the third generic narrowed to
 * LlmModelProvider so createFromUpstream returns Promise<LlmModelProvider | null>
 * at the registry call site. ProviderPluginContext keeps its name — it's
 * a Copilot-flavored runtime hook context, not part of the Llm* parallel
 * rename.
 */
import type { AccountType, UpstreamKind, UpstreamRecord } from '@vibe-llm/protocols/common'
import type { Fetcher, UpstreamPlugin } from '@vibe-core/upstream'
import type { AffinityExecutionTarget } from './opaque-affinity'
import type { LlmModelProvider, ProviderRequest } from './types'

export type ExecutionFetcherForRequest = (request: Pick<ProviderRequest, 'endpoint' | 'action'>) => Fetcher

/** Diagnostic setup is best effort; a returned fetcher's transport failure is not swallowed. */
export function resolveExecutionFetcher(
  ordinary: Fetcher,
  executionFactory: ExecutionFetcherForRequest | undefined,
  request: Pick<ProviderRequest, 'endpoint' | 'action'>,
): Fetcher {
  if (!executionFactory) return ordinary
  try { return executionFactory(request) ?? ordinary } catch { return ordinary }
}

export interface ProviderAffinityAuthority {
  /** Immutable accepted configuration actually held by this provider instance.
   * Ordinary calls may capture provenance; owned replay must prepare/assert. */
  capture(model: string): AffinityExecutionTarget | undefined
  prepare(model: string): Promise<AffinityExecutionTarget | undefined>
  assertCurrent(target: AffinityExecutionTarget): Promise<void>
}

export interface ProviderPluginContext {
  affinityAuthority?: ProviderAffinityAuthority

  /** Gateway routing constructs providers before selection; defer credential I/O. */
  deferCredentials?: boolean
  /** Exchange a stored github_token for a short-lived copilot session.
   *  Returns both the token AND the tenant-advertised Copilot API endpoint
   *  (github.com accounts → https://api.githubcopilot.com family;
   *  GHE-with-data-residency tenants → e.g. https://copilot-api.msft.ghe.com).
   *  Copilot plugin only; other plugins ignore. */
  getCachedCopilotToken?: (
    githubToken: string,
    accountType: AccountType,
    githubHost?: string,
    /** Egress transport for the exchange itself. Without this, a proxy-only
     *  host routes inference through the proxy but refreshes the session token
     *  direct — so inference dies when the token expires, not at startup. */
    fetcher?: Fetcher,
    /** `{ forceRefresh: true }` demands a new exchange instead of the cached
     *  session. Set by the provider after the upstream rejected the cached
     *  token with 401/403 — `expires_at` alone cannot see a revocation. */
    opts?: { forceRefresh?: boolean },
  ) => Promise<{ token: string; apiEndpoint: string }>
  /** Per-request token + accountType supplied by the caller. Used when the
   *  upstream row has no githubToken or token exchange fails. Copilot only. */
  copilotFallback?: { copilotToken: string; accountType: AccountType }
  /** Egress transport for this upstream, resolved from its proxy fallback
   *  list. Absent means the provider keeps its `directFetcher` default. */
  fetcherForUpstream?: (upstreamId: string) => Fetcher
  /** Selected application call only. Discovery, OAuth and session refresh keep fetcherForUpstream. */
  executionFetcherForUpstream?: (upstreamId: string, request: Pick<ProviderRequest, 'endpoint' | 'action'>) => Fetcher
}

export interface LlmProviderPlugin
  extends UpstreamPlugin<UpstreamRecord<unknown>, ProviderPluginContext, LlmModelProvider> {
  readonly kind: UpstreamKind
}
