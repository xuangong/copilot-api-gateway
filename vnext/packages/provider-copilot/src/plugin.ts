/**
 * Copilot factory plugin — invoked by gateway's PROVIDER_PLUGINS table.
 *
 * Two construction paths:
 *   1. upstream.config.githubToken present → exchange via ctx hook
 *      (ctx.getCachedCopilotToken). On any failure, fall through.
 *   2. ctx.copilotFallback present → construct from per-request token.
 *
 * Returns null when neither path can produce a provider.
 */
import type { ProviderPlugin } from '@vnext/provider'
import type { AccountType } from '@vnext/protocols/common'
import { CopilotProvider } from './provider'

export const copilotProviderPlugin: ProviderPlugin = {
  kind: 'copilot',
  async createFromUpstream(upstream, ctx) {
    const config = upstream.config
    const accountType = (config.accountType as AccountType | undefined) ?? 'individual'
    const githubToken = config.githubToken
    if (typeof githubToken === 'string' && githubToken && ctx.getCachedCopilotToken) {
      try {
        const copilotToken = await ctx.getCachedCopilotToken(githubToken, accountType)
        return new CopilotProvider({ copilotToken, accountType })
      } catch {
        // fall through to fallback
      }
    }
    if (ctx.copilotFallback) {
      return new CopilotProvider(ctx.copilotFallback)
    }
    return null
  },
}
