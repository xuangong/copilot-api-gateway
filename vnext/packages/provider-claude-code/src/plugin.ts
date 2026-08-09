/**
 * Claude Code factory plugin — invoked by gateway's PROVIDER_PLUGINS table.
 *
 * The upstream row carries operator-imported OAuth (or setup-token)
 * credential in ClaudeCodeUpstreamState; the provider mints access tokens
 * on demand.
 */
import type { LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { ClaudeCodeProvider } from './provider'

export const claudeCodeProviderPlugin: LlmProviderPlugin = {
  kind: 'claude-code',
  async createFromUpstream(upstream, ctx) {
    return new ClaudeCodeProvider(upstream, ctx.fetcherForUpstream?.(upstream.id))
  },
}
