/**
 * CodexProvider — LlmModelProvider implementation over the codex ChatGPT
 * responses backend.
 *
 * Ported from copilot-gateway/packages/provider-codex/src/provider.ts, with
 * vNext adaptations:
 *   - `createCodexProvider(record) → Provider` factory replaced by a class
 *     that implements the vNext `LlmModelProvider` contract.
 *   - Reference project's per-endpoint methods (`callResponses(model, body,
 *     action, ...)`) collapse into a single `fetch(req: ProviderRequest)`.
 *     The `action` verb ('generate' | 'compact') travels on ProviderRequest,
 *     dispatched internally to `callCodexResponses` /
 *     `callCodexResponsesCompact`.
 *   - Boundary interceptor chain is empty in F3b — codex responses
 *     interceptors land in F5. The dispatch is inlined; runInterceptors is
 *     not invoked.
 *   - Access-token / quota / models / catalog logic is unchanged in shape.
 *   - Effects (persistRefreshTokenRotation, persistTerminalState) route
 *     through `getUpstreamRepo().saveState<CodexUpstreamState>` instead of
 *     `getProviderRepo().upstreams.saveState`.
 */
import { ensureCodexAccessToken, mintCodexAccessToken } from './access-token'
import { CodexOAuthSessionTerminatedError } from './auth/oauth'
import { assertCodexUpstreamRecord, type CodexUpstreamConfig } from './config'
import {
  callCodexResponses,
  callCodexResponsesCompact,
  toCompactPayloadShape,
  type CanonicalResponsesCompactPayload,
  type CodexCallEffects,
} from './fetch'
import { directFetcher, type Fetcher } from './fetcher'
import {
  codexRawToProviderModel,
  fetchCodexCatalog,
  type CodexProviderModel,
} from './models'
import { pricingForCodexModelKey } from './pricing'
import {
  assertCodexUpstreamState,
  findCodexAccountIndex,
  readCodexUpstreamState,
  replaceCodexAccount,
  type CodexAccountCredential,
  type CodexUpstreamState,
} from './state'
import { getUpstreamRepo, UpstreamGoneError } from '@vibe-core/upstream-repo'
import type { EndpointKey, ModelPricing, UpstreamRecord } from '@vibe-llm/protocols/common'
import {
  probeViaModels,
  type LlmModelProvider,
  type ProbeResult,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderModelsResponse,
} from '@vibe-llm/provider-llm'
import type { CanonicalResponsesPayload } from '@vibe-llm/protocols/responses'

const CODEX_SUPPORTED: readonly EndpointKey[] = ['responses']

export class CodexProvider implements LlmModelProvider {
  readonly kind = 'codex' as const
  readonly name: string
  readonly supportedEndpoints = CODEX_SUPPORTED
  private readonly upstreamId: string
  private readonly config: CodexUpstreamConfig
  private readonly fetcher: Fetcher
  private readonly effects: CodexCallEffects
  private catalogCache: CodexProviderModel[] | null = null

  constructor(record: UpstreamRecord<unknown>, fetcher: Fetcher = directFetcher) {
    assertCodexUpstreamRecord(record)
    assertCodexUpstreamState(record.state)
    this.upstreamId = record.id
    this.config = record.config
    this.name = record.name
    this.fetcher = fetcher
    this.effects = this.buildEffects()
  }

  private buildEffects(): CodexCallEffects {
    const accountId = this.config.accounts[0].chatgptAccountId
    const upstreamId = this.upstreamId
    const locate = (raw: unknown) => {
      const state = readCodexUpstreamState(raw)
      const idx = findCodexAccountIndex(state, accountId)
      if (idx < 0) {
        throw new Error(
          `Codex upstream ${upstreamId} state has no credential for account ${accountId}`,
        )
      }
      return { state, idx }
    }
    return {
      persistRefreshTokenRotation: async (newRefreshToken) => {
        const rotatedAt = new Date().toISOString()
        try {
          await getUpstreamRepo().saveState<CodexUpstreamState>(upstreamId, (current) => {
            const { state, idx } = locate(current)
            return replaceCodexAccount(state, idx, (account) => ({
              ...account,
              refresh_token: newRefreshToken,
              state_updated_at: rotatedAt,
            }))
          })
        } catch (err) {
          if (err instanceof UpstreamGoneError) return
          throw err
        }
      },
      persistTerminalState: async (newState, message) => {
        const flippedAt = new Date().toISOString()
        try {
          await getUpstreamRepo().saveState<CodexUpstreamState>(upstreamId, (current) => {
            const { state, idx } = locate(current)
            return replaceCodexAccount(state, idx, (account) => ({
              ...account,
              state: newState,
              state_message: message,
              state_updated_at: flippedAt,
              accessToken: null,
            }))
          })
        } catch (err) {
          if (err instanceof UpstreamGoneError) return
          throw err
        }
      },
    }
  }

  private async readActiveAccount(): Promise<CodexAccountCredential> {
    const fresh = await getUpstreamRepo().getById<CodexUpstreamState>(this.upstreamId)
    if (!fresh) throw new Error(`Codex upstream ${this.upstreamId} disappeared mid-request`)
    const state = readCodexUpstreamState(fresh.state)
    const idx = findCodexAccountIndex(state, this.config.accounts[0].chatgptAccountId)
    if (idx < 0) {
      throw new Error(
        `Codex upstream ${this.upstreamId} state has no credential for account ${this.config.accounts[0].chatgptAccountId}`,
      )
    }
    return state.accounts[idx]!
  }

  async getModels(): Promise<ProviderModelsResponse> {
    if (!this.catalogCache) {
      const accountId = this.config.accounts[0].chatgptAccountId
      let access: { token: string }
      try {
        access = await ensureCodexAccessToken(this.upstreamId, accountId, (refresh) =>
          mintCodexAccessToken(refresh, this.fetcher, this.effects.persistRefreshTokenRotation),
        )
      } catch (err) {
        if (err instanceof CodexOAuthSessionTerminatedError) {
          await this.effects.persistTerminalState('refresh_failed', err.upstreamMessage)
        }
        throw err
      }
      const raw = await fetchCodexCatalog({
        accessToken: access.token,
        accountId,
        fetcher: this.fetcher,
      })
      this.catalogCache = raw.map(codexRawToProviderModel)
    }
    return { object: 'list', data: this.catalogCache }
  }

  probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    return pricingForCodexModelKey(modelKey)
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.endpoint !== 'responses') {
      throw new Error(`CodexProvider does not support endpoint: ${req.endpoint}`)
    }
    const account = await this.readActiveAccount()
    const model = await this.resolveModel(req.payload)
    const { model: _ignored, ...wireBody } = req.payload as CanonicalResponsesPayload

    const backendCallBase = {
      upstreamId: this.upstreamId,
      account,
      model,
      headers: req.headers,
      signal: req.signal,
      effects: this.effects,
      fetcher: this.fetcher,
    }

    const upstreamResp =
      req.action === 'compact'
        ? await callCodexResponsesCompact({
            ...backendCallBase,
            body: toCompactPayloadShape(wireBody) as Omit<
              CanonicalResponsesCompactPayload,
              'model' | 'store'
            >,
          })
        : await callCodexResponses({ ...backendCallBase, body: wireBody })

    return {
      status: upstreamResp.status,
      headers: upstreamResp.headers,
      body: upstreamResp.body,
    }
  }

  // Codex fetch flow needs the resolved CodexProviderModel for id + limits.
  // The gateway sends the canonical payload with `model` as the slug string,
  // so we look it up in the catalog. Cache hit expected on the hot path
  // (getModels was called by the router when materializing bindings).
  private async resolveModel(payload: unknown): Promise<CodexProviderModel> {
    const modelId = (payload as { model?: unknown }).model
    if (typeof modelId !== 'string' || modelId === '') {
      throw new Error('CodexProvider.fetch requires payload.model')
    }
    if (!this.catalogCache) await this.getModels()
    const hit = this.catalogCache?.find((m) => m.id === modelId)
    if (!hit) throw new Error(`CodexProvider: unknown model '${modelId}'`)
    return hit
  }
}
