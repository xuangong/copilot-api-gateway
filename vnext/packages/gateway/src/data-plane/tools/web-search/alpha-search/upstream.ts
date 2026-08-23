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

export type AlphaSearchDispatcher = (
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  headers: Headers,
) => Promise<Response>

const pickAlphaSearch = (endpoints: Record<string, unknown>): EndpointKey | null =>
  endpoints.alpha_search !== undefined ? 'alpha_search' : null

export const resolveAlphaSearchDispatcher = async (args: {
  config: { upstreamId: string; model: string }
  auth: DataPlaneAuthCtx
}): Promise<AlphaSearchDispatcher> => {
  const { config, auth } = args
  if (config.upstreamId === '') {
    throw new Error('OpenAI search passthrough has no upstream configured')
  }
  const { candidates } = await enumerateBindingCandidates({
    model: config.model,
    pickTarget: pickAlphaSearch as never,
    opts: { ownerId: auth.userId, copilot: auth.copilot, pin: config.upstreamId },
  })
  const candidate = candidates.find((c) => c.binding.upstream === config.upstreamId)
  if (candidate === undefined) {
    // Enumeration is already scoped to what this caller can see, so "not
    // found" covers both "no such pair" and "not yours". Say so — the
    // reference raises these separately and the merged message was too vague
    // to act on.
    throw new Error(
      `OpenAI search passthrough: upstream ${config.upstreamId} does not serve `
      + `${config.model} on alpha_search, or is outside this API key's scope`,
    )
  }
  if (candidate.binding.kind !== 'codex' && candidate.binding.kind !== 'custom') {
    throw new Error('Selected upstream does not support OpenAI search passthrough')
  }

  return async (body, signal, headers) => {
    // The configured model picked the candidate above and has to reach the
    // upstream too: only a specific (upstream, model) pair serves alpha_search,
    // and the codex provider reads `payload.model`. The reference passes it as
    // a separate argument to `callAlphaSearch`; routing everything through
    // `provider.fetch` left the model behind, so codex threw
    // "requires payload.model" while custom upstreams silently ignored it.
    // The caller's own `model`, if any, is not authoritative here.
    const { model: _callerModel, ...request } = body
    const response = await candidate.binding.provider.fetch({
      endpoint: 'alpha_search',
      payload: { ...request, model: config.model },
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
