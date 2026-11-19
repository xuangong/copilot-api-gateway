/**
 * Codex factory plugin — invoked by gateway's PROVIDER_PLUGINS table.
 *
 * Codex has no per-request token exchange (unlike Copilot). The upstream row
 * carries the operator-imported refresh_token in CodexUpstreamState; the
 * provider mints access tokens on demand.
 */
import { pickScalars, type LlmProviderPlugin } from '@vibe-llm/provider-llm'
import { publicCodexCredentialStatus } from './public-status'
import { CodexProvider } from './provider'

export const codexProviderPlugin: LlmProviderPlugin = {
  kind: 'codex',
  configManagedBy: 'credential-provider config is managed by authorization',
  publicStatus: record => {
    const credentialStatus = publicCodexCredentialStatus(record.state)
    return credentialStatus ? { credentialStatus } : {}
  },
  publicConfig: source => Array.isArray(source.accounts)
    ? { accounts: source.accounts.map(account => pickScalars(account, ['email', 'chatgptAccountId', 'chatgptUserId', 'planType'])) }
    : {},
  async createFromUpstream(upstream, ctx) {
    const executionFactory = ctx.executionFetcherForUpstream
    return new CodexProvider(
      upstream,
      ctx.fetcherForUpstream?.(upstream.id),
      executionFactory ? request => executionFactory(upstream.id, request) : undefined,
    )
  },
}
