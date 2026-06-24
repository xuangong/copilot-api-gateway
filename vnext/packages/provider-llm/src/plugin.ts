/**
 * LlmProviderPlugin — per-package factory contract.
 *
 * Alias of the framework UpstreamPlugin with the third generic narrowed to
 * LlmModelProvider so createFromUpstream returns Promise<LlmModelProvider | null>
 * at the registry call site. ProviderPluginContext keeps its name — it's
 * a Copilot-flavored runtime hook context, not part of the Llm* parallel
 * rename.
 */
import type { AccountType, UpstreamRecord } from '@vnext-llm/protocols/common'
import type { UpstreamPlugin } from '@vnext-gateway/upstream'
import type { LlmModelProvider } from './types'

export interface ProviderPluginContext {
  /** Exchange a stored github_token for a short-lived copilot token.
   *  Copilot plugin only; other plugins ignore. */
  getCachedCopilotToken?: (githubToken: string, accountType: AccountType) => Promise<string>
  /** Per-request token + accountType supplied by the caller. Used when the
   *  upstream row has no githubToken or token exchange fails. Copilot only. */
  copilotFallback?: { copilotToken: string; accountType: AccountType }
}

export type LlmProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext, LlmModelProvider>
