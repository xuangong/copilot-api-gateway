/**
 * Claude Code factory plugin — invoked by gateway's PROVIDER_PLUGINS table.
 *
 * The upstream row carries operator-imported OAuth (or setup-token)
 * credential in ClaudeCodeUpstreamState; the provider mints access tokens
 * on demand.
 */
import { pickScalars, type LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { ClaudeCodeProvider } from './provider'

export const claudeCodeProviderPlugin: LlmProviderPlugin = {
  kind: 'claude-code',
  publicConfig: source => Array.isArray(source.accounts)
    ? { accounts: source.accounts.map(account => pickScalars(account, ['email', 'accountUuid', 'organizationUuid', 'subscriptionType', 'rateLimitTier'])) }
    : {},
  async createFromUpstream(upstream, ctx) {
    const executionFactory = ctx.executionFetcherForUpstream
    return new ClaudeCodeProvider(
      upstream,
      ctx.fetcherForUpstream?.(upstream.id),
      executionFactory ? request => executionFactory(upstream.id, request) : undefined,
    )
  },
}
