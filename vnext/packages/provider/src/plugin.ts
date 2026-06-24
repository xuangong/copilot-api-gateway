/**
 * ProviderPlugin — per-package factory contract.
 *
 * Each @vnext/provider-* package exports a `ProviderPlugin` instance. The
 * gateway statically imports all of them and queries by `kind`. This replaces
 * the historical if/else chain in createProviderFromUpstream.
 *
 * ProviderPluginContext carries Copilot-specific hooks (token cache + per-
 * request fallback). Non-Copilot plugins ignore these fields. The shape is
 * Copilot-flavored deliberately because Copilot is the only provider that
 * needs request-time secrets resolved out of the upstream row.
 */
import type { AccountType, UpstreamKind, UpstreamRecord } from '@vnext-llm/protocols/common'
import type { ModelProvider } from './types'

export interface ProviderPluginContext {
  /** Exchange a stored github_token for a short-lived copilot token.
   *  Copilot plugin only; other plugins ignore. */
  getCachedCopilotToken?: (githubToken: string, accountType: AccountType) => Promise<string>
  /** Per-request token + accountType supplied by the caller. Used when the
   *  upstream row has no githubToken or token exchange fails. Copilot only. */
  copilotFallback?: { copilotToken: string; accountType: AccountType }
}

export interface ProviderPlugin {
  readonly kind: UpstreamKind
  /** Build a ModelProvider from a stored row. Return null when the row
   *  cannot produce a provider (e.g. Copilot without githubToken AND
   *  without copilotFallback). */
  createFromUpstream(
    upstream: UpstreamRecord,
    ctx: ProviderPluginContext,
  ): Promise<ModelProvider | null>
}
