/**
 * ClaudeCodeProvider — LlmModelProvider implementation over the Anthropic
 * /v1/messages backend on a Claude Code subscription OAuth bearer.
 *
 * vNext adaptations vs reference:
 *   - Factory function replaced with a class implementing LlmModelProvider.
 *   - Single endpoint 'messages'.
 *   - Interceptor chain empty in Gb (claude-code interceptors deferred).
 *   - Access-token / catalog / pricing routing lives on the class methods.
 */
import { ensureClaudeCodeAccessToken } from './access-token'
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth'
import { assertClaudeCodeUpstreamRecord, type ClaudeCodeUpstreamConfig } from './config'
import { callClaudeCodeMessages } from './fetch'
import { directFetcher, type Fetcher } from './fetcher'
import {
  buildClaudeCodeCatalog,
  fetchClaudeCodeModelsList,
  type ClaudeCodeProviderModel,
} from './models'
import { pricingForClaudeCodeModelKey } from './pricing'
import { assertClaudeCodeUpstreamState } from './state'
import type { EndpointKey, ModelPricing, UpstreamRecord } from '@vibe-llm/protocols/common'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'
import {
  probeViaModels,
  type LlmModelProvider,
  type ProbeResult,
  type ProviderModelsResponse,
  type ProviderRequest,
  type ProviderResponse,
} from '@vibe-llm/provider-llm'

const CLAUDE_CODE_SUPPORTED: readonly EndpointKey[] = ['messages']

export class ClaudeCodeProvider implements LlmModelProvider {
  readonly kind = 'claude-code' as const
  readonly name: string
  readonly supportedEndpoints = CLAUDE_CODE_SUPPORTED
  private readonly upstreamId: string
  private readonly config: ClaudeCodeUpstreamConfig
  private readonly fetcher: Fetcher
  private catalogCache: ClaudeCodeProviderModel[] | null = null

  constructor(record: UpstreamRecord<unknown>, fetcher: Fetcher = directFetcher) {
    assertClaudeCodeUpstreamRecord(record)
    assertClaudeCodeUpstreamState(record.state)
    this.upstreamId = record.id
    this.config = record.config
    this.name = record.name
    this.fetcher = fetcher
  }

  async getModels(): Promise<ProviderModelsResponse> {
    if (!this.catalogCache) {
      let access: { entry: { token: string } }
      try {
        access = await ensureClaudeCodeAccessToken({
          upstreamId: this.upstreamId,
          fetcher: this.fetcher,
        })
      } catch (err) {
        if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
          // ensureClaudeCodeAccessToken already flipped terminal state.
        }
        throw err
      }
      const raw = await fetchClaudeCodeModelsList(access.entry.token, this.fetcher)
      this.catalogCache = buildClaudeCodeCatalog(raw)
    }
    return { object: 'list', data: this.catalogCache }
  }

  probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    return pricingForClaudeCodeModelKey(modelKey)
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.endpoint !== 'messages') {
      throw new Error(`ClaudeCodeProvider does not support endpoint: ${req.endpoint}`)
    }
    try {
      const model = await this.resolveModel(req.payload)
      const { model: _ignored, ...wireBody } = req.payload as MessagesPayload

      const upstreamResp = await callClaudeCodeMessages({
        upstreamId: this.upstreamId,
        model,
        body: wireBody,
        signal: req.signal,
        fetcher: this.fetcher,
      })

      return {
        status: upstreamResp.status,
        headers: upstreamResp.headers,
        body: upstreamResp.body,
      }
    } catch (err) {
      if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
        // Terminal state has already been persisted by access-token layer.
        return {
          status: 503,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: new Response(
            JSON.stringify({
              error: {
                type: 'claude_code_upstream_unavailable',
                message: `Claude Code refresh failed: ${err.upstreamMessage}`,
              },
            }),
          ).body,
        }
      }
      throw err
    }
  }

  // Gateway sends the canonical payload with `model` as the public alias slug;
  // fetch flow needs the resolved ClaudeCodeProviderModel for the dated
  // upstream id + limits. Cache hit expected — router materializes bindings
  // via getModels before dispatching.
  private async resolveModel(payload: unknown): Promise<ClaudeCodeProviderModel> {
    const modelId = (payload as { model?: unknown }).model
    if (typeof modelId !== 'string' || modelId === '') {
      throw new Error('ClaudeCodeProvider.fetch requires payload.model')
    }
    if (!this.catalogCache) await this.getModels()
    const hit = this.catalogCache?.find((m) => m.id === modelId)
    if (!hit) throw new Error(`ClaudeCodeProvider: unknown model '${modelId}'`)
    return hit
  }
}
