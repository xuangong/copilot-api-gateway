/**
 * Codex factory plugin — invoked by gateway's PROVIDER_PLUGINS table.
 *
 * Codex has no per-request token exchange (unlike Copilot). The upstream row
 * carries the operator-imported refresh_token in CodexUpstreamState; the
 * provider mints access tokens on demand.
 */
import type { LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { CodexProvider } from './provider'

export const codexProviderPlugin: LlmProviderPlugin = {
  kind: 'codex',
  async createFromUpstream(upstream, ctx) {
    return new CodexProvider(upstream, ctx.fetcherForUpstream?.(upstream.id))
  },
}
