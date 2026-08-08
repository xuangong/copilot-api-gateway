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
import type { UpstreamPlugin } from '@vibe-core/upstream'
import type { LlmModelProvider } from './types'

export interface ProviderPluginContext {
  /** Exchange a stored github_token for a short-lived copilot session.
   *  Returns both the token AND the tenant-advertised Copilot API endpoint
   *  (github.com accounts → https://api.githubcopilot.com family;
   *  GHE-with-data-residency tenants → e.g. https://copilot-api.msft.ghe.com).
   *  Copilot plugin only; other plugins ignore. */
  getCachedCopilotToken?: (
    githubToken: string,
    accountType: AccountType,
    githubHost?: string,
  ) => Promise<{ token: string; apiEndpoint: string }>
  /** Per-request token + accountType supplied by the caller. Used when the
   *  upstream row has no githubToken or token exchange fails. Copilot only. */
  copilotFallback?: { copilotToken: string; accountType: AccountType }
}

export interface LlmProviderPlugin
  extends UpstreamPlugin<UpstreamRecord<unknown>, ProviderPluginContext, LlmModelProvider> {
  readonly kind: UpstreamKind
}
