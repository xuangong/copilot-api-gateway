/**
 * Passthrough dispatcher for alpha_search. Resolves the configured
 * OpenAI-search upstream (codex or custom kind) via the shared binding
 * enumerator, then adapts the provider's ProviderResponse into a Fetch
 * Response ready for `relayFetchedResponse`.
 *
 * vNext delta vs reference: reference chose upstream via
 * `enumerateModelCandidates({upstreamIds:[config.upstreamId], model, kind:'chat'})`
 * and dispatched through `provider.instance.callAlphaSearch(...)`. vNext
 * routes every endpoint through `provider.fetch({endpoint:'alpha_search'})`
 * (H1) and enumerates through `enumerateBindingCandidates` (pinning via
 * `opts.pin`). No wrapper/scheduler plumbing — see H2 plan §3 for context.
 */
import type { EndpointKey } from '@vibe-llm/protocols/common'
import { enumerateBindingCandidates } from '../../../routing/candidates.ts'
import type { DataPlaneAuthCtx } from '../../../models/routes.ts'
import type { SearchConfig } from '../../../../shared/web-search-providers.ts'

export type AlphaSearchDispatcher = (
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  headers: Headers,
) => Promise<Response>

const pickAlphaSearch = (endpoints: Record<string, unknown>): EndpointKey | null =>
  endpoints.alpha_search !== undefined ? 'alpha_search' : null

export const resolveAlphaSearchDispatcher = async (args: {
  config: Pick<SearchConfig['passthroughOpenAiSearch'], 'upstreamId' | 'model'>
  auth: DataPlaneAuthCtx
}): Promise<AlphaSearchDispatcher> => {
  const { config, auth } = args
  const { candidates } = await enumerateBindingCandidates({
    model: config.model,
    pickTarget: pickAlphaSearch as never,
    opts: { ownerId: auth.userId, copilot: auth.copilot, pin: config.upstreamId },
  })
  const candidate = candidates.find((c) => c.binding.upstream === config.upstreamId)
  if (candidate === undefined) {
    throw new Error(`Selected OpenAI search model ${config.model} is unavailable`)
  }
  if (candidate.binding.kind !== 'codex' && candidate.binding.kind !== 'custom') {
    throw new Error('Selected upstream does not support OpenAI search passthrough')
  }

  return async (body, signal, headers) => {
    const response = await candidate.binding.provider.fetch({
      endpoint: 'alpha_search',
      payload: body,
      headers,
      sourceApi: 'openai',
      action: 'generate',
      signal,
    })
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    })
  }
}
