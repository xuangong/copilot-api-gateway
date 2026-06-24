/**
 * ProviderPlugin — per-package factory contract.
 *
 * Spec 9 Part 1: `ProviderPlugin` is now an alias of the framework
 * `UpstreamPlugin<UpstreamRecord, ProviderPluginContext, ModelProvider>` so
 * the kind/createFromUpstream surface is preserved. The Copilot-flavored
 * context (token cache + per-request fallback) stays local to this package —
 * it is LLM-business shape and follows into @vnext-llm/provider-llm in Part 2.
 */
import type { AccountType, UpstreamRecord } from '@vnext-llm/protocols/common'
import type { UpstreamPlugin } from '@vnext-gateway/upstream'
import type { ModelProvider } from './types'

export interface ProviderPluginContext {
  /** Exchange a stored github_token for a short-lived copilot token.
   *  Copilot plugin only; other plugins ignore. */
  getCachedCopilotToken?: (githubToken: string, accountType: AccountType) => Promise<string>
  /** Per-request token + accountType supplied by the caller. Used when the
   *  upstream row has no githubToken or token exchange fails. Copilot only. */
  copilotFallback?: { copilotToken: string; accountType: AccountType }
}

export type ProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext, ModelProvider>
