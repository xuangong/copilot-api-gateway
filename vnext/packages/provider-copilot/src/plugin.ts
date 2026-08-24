/**
 * Copilot factory plugin — invoked by gateway's PROVIDER_PLUGINS table.
 *
 * Two construction paths:
 *   1. upstream.config.githubToken present → exchange via ctx hook
 *      (ctx.getCachedCopilotToken). Passes upstream.config.githubHost so
 *      GHE-with-data-residency tenants exchange against their tenant API
 *      host and inherit endpoints.api from the response. On failure, fall
 *      through to the fallback if one exists, else rethrow — a swallowed
 *      exchange error surfaces as a bare "unable to construct provider",
 *      hiding whether GitHub returned 401 (dead token) or 5xx (outage).
 *      The provider also gets a `refreshSession` hook bound to the same
 *      credential, so a session revoked mid-life self-heals rather than
 *      requiring a manual re-auth.
 *   2. ctx.copilotFallback present → construct from per-request token.
 *      No refresh hook on this path: the caller supplied the session directly
 *      and there is no GitHub credential here to re-exchange from.
 *
 * Returns null when neither path can produce a provider.
 */
import type { LlmProviderPlugin } from '@vibe-llm/provider-llm'
import type { AccountType } from '@vibe-llm/protocols/common'
import { CopilotProvider } from './provider'

export const copilotProviderPlugin: LlmProviderPlugin = {
  kind: 'copilot',
  async createFromUpstream(upstream, ctx) {
    const config = upstream.config
    const accountType = (config.accountType as AccountType | undefined) ?? 'individual'
    const githubToken = config.githubToken
    const githubHost = typeof config.githubHost === 'string' ? config.githubHost : undefined
    const fetcher = ctx.fetcherForUpstream?.(upstream.id)
    if (typeof githubToken === 'string' && githubToken && ctx.getCachedCopilotToken) {
      const getToken = ctx.getCachedCopilotToken
      try {
        const session = await getToken(githubToken, accountType, githubHost, fetcher)
        return new CopilotProvider(
          {
            copilotToken: session.token,
            accountType,
            baseUrl: session.apiEndpoint,
            // Lets the provider recover from a session revoked before its
            // advertised expiry: on a 401/403 it demands a new exchange and
            // replays the request once, instead of failing until an operator
            // re-authorises the GitHub account by hand.
            refreshSession: async () => {
              const next = await getToken(githubToken, accountType, githubHost, fetcher, {
                forceRefresh: true,
              })
              return { token: next.token, baseUrl: next.apiEndpoint }
            },
          },
          fetcher,
        )
      } catch (err) {
        if (!ctx.copilotFallback) throw err
      }
    }
    if (ctx.copilotFallback) {
      return new CopilotProvider(ctx.copilotFallback, fetcher)
    }
    return null
  },
}
