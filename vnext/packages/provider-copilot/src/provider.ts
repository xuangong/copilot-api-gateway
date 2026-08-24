/**
 * CopilotProvider — extracted to @vibe-llm/provider-copilot in Plan 2c.
 *
 * Per-endpoint interceptor chains feed into runInterceptors, whose terminal
 * is callCopilotAPI. Cross-package contracts (@vibe-core/service,
 * @vibe-llm/protocols) are unchanged.
 *
 * After Plan B Task B2.8, the legacy `fetch(endpoint, init, opts)` overload
 * and the seven per-endpoint `call*` shim methods were retired. The provider
 * now exposes a single `fetch(req: ProviderRequest)` returning a
 * `ProviderResponse` — interceptor mutations happen on `req.payload`
 * directly; the terminal HTTP call serializes the final state.
 */
import type { AccountType } from './account-type'
import { defaultsForUpstream } from '@vibe-llm/protocols/flags'
import { callCopilotAPI } from './forward'
import { getModels, type ModelsResponse } from './models'
import { pricingForCopilotModelKey } from './pricing'
import type { EndpointKey, ModelPricing } from '@vibe-llm/protocols/common'
import type { CopilotInterceptor, Invocation, RequestContext } from "@vibe-llm/protocols/common"
import { runInterceptors } from "@vibe-core/service"
import type {
  LlmModelProvider,
  ProbeResult,
  ProviderRequest,
  ProviderResponse,
  SourceApi,
} from '@vibe-llm/provider-llm'
import { probeViaModels } from '@vibe-llm/provider-llm'
import { HTTPError } from '@vibe-llm/provider-llm'
import { directFetcher, type Fetcher } from '@vibe-core/upstream'
import { invalidateRawModelsForToken } from './raw-models-cache'
import { createVariantAndBetaFilteringInterceptor } from './interceptors/shared/with-variant-and-beta-filtering'
import { withContextManagementBetaAligned } from './interceptors/shared/with-context-management-beta-aligned'
import { withInitiatorHeader } from './interceptors/shared/with-initiator-header'
import { messagesPayloadInterceptors } from './interceptors/messages'
import { messagesCountTokensPayloadInterceptors } from './interceptors/messages-count-tokens'
import { responsesPayloadInterceptors } from './interceptors/responses'
import { chatCompletionsPayloadInterceptors } from './interceptors/chat-completions'
import { embeddingsPayloadInterceptors } from './interceptors/embeddings'

export interface CopilotProviderConfig {
  copilotToken: string
  accountType: AccountType
  name?: string
  /** Override the Copilot API base URL. When present, replaces the accountType-
   *  derived default. Set by the token cache when a tenant advertises a
   *  per-tenant Copilot host (e.g. copilot-api.msft.ghe.com). */
  baseUrl?: string
  /**
   * Exchange a fresh Copilot session, bypassing whatever is cached. Injected by
   * the plugin when the upstream owns a GitHub token; absent on the
   * per-request-token path, which has no credential to re-exchange from.
   *
   * Copilot can revoke a session token before its advertised `expires_at`, and
   * the token cache is clock-driven, so without this the provider serves a dead
   * token until it ages out — every request 401/403 until the operator
   * re-authorises the account by hand.
   */
  refreshSession?: () => Promise<{ token: string; baseUrl?: string }>
}

const COPILOT_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
  embeddings: '/embeddings',
}

const COPILOT_SUPPORTED: readonly EndpointKey[] = [
  'chat_completions',
  'responses',
  'messages',
  'messages_count_tokens',
  'embeddings',
]

export class CopilotProvider implements LlmModelProvider {
  readonly kind = 'copilot' as const
  readonly name: string
  readonly supportedEndpoints = COPILOT_SUPPORTED
  // Mutable: withAuthRetry swaps both in place when a revoked session is
  // re-exchanged, so later requests on this provider use the live credential.
  private copilotToken: string
  private readonly accountType: AccountType
  private baseUrl?: string
  private readonly fetcher: Fetcher
  private readonly refreshSession?: () => Promise<{ token: string; baseUrl?: string }>
  private readonly messagesChain: readonly CopilotInterceptor[]
  private readonly messagesCountTokensChain: readonly CopilotInterceptor[]
  private readonly responsesChain: readonly CopilotInterceptor[]
  private readonly chatCompletionsChain: readonly CopilotInterceptor[]
  private readonly embeddingsChain: readonly CopilotInterceptor[]

  constructor(cfg: CopilotProviderConfig, fetcher: Fetcher = directFetcher) {
    this.copilotToken = cfg.copilotToken
    this.accountType = cfg.accountType
    this.baseUrl = cfg.baseUrl
    this.name = cfg.name ?? 'copilot'
    this.fetcher = fetcher
    this.refreshSession = cfg.refreshSession

    const variantFiltering = createVariantAndBetaFilteringInterceptor(() => this.copilotToken, this.accountType, () => this.baseUrl, this.fetcher)
    this.messagesChain = [variantFiltering, withContextManagementBetaAligned, withInitiatorHeader, ...messagesPayloadInterceptors]
    this.messagesCountTokensChain = [variantFiltering, withContextManagementBetaAligned, withInitiatorHeader, ...messagesCountTokensPayloadInterceptors]
    this.responsesChain = [variantFiltering, withInitiatorHeader, ...responsesPayloadInterceptors]
    this.chatCompletionsChain = [variantFiltering, withInitiatorHeader, ...chatCompletionsPayloadInterceptors]
    this.embeddingsChain = embeddingsPayloadInterceptors
  }

  getModels(): Promise<ModelsResponse> {
    return this.withAuthRetry(() =>
      getModels(this.copilotToken, this.accountType, this.baseUrl, this.fetcher),
    )
  }

  probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    return pricingForCopilotModelKey(modelKey)
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    const path = COPILOT_PATHS[req.endpoint]
    if (!path) throw new Error(`CopilotProvider does not support endpoint: ${req.endpoint}`)

    // Headers→Record at chain boundary; Invocation.headers is Record.
    const headerRecord: Record<string, string> = {}
    req.headers.forEach((v, k) => { headerRecord[k] = v })

    const inv: Invocation = {
      endpoint: req.endpoint,
      enabledFlags: defaultsForUpstream('copilot'),
      sourceApi: mapSourceApi(req.sourceApi),
      payload: req.payload as Record<string, unknown>,
      headers: headerRecord,
    }
    const ctx: RequestContext = {
      requestStartedAt: Date.now(),
      downstreamAbortSignal: req.signal,
    }
    const interceptors = this.interceptorsFor(req.endpoint)
    const requireModel = req.requireModel ?? req.endpoint !== 'messages_count_tokens'

    const response = await runInterceptors(inv, ctx, interceptors, () =>
      // Only the terminal call is retried, not the whole chain: interceptors
      // mutate inv.payload in place, so re-running them would apply their
      // rewrites twice. By this point the payload is final, and callCopilotAPI
      // throws on a non-2xx before any body reaches the caller — so a streaming
      // request has emitted nothing yet and the retry is invisible downstream.
      this.withAuthRetry(() =>
        callCopilotAPI({
          endpoint: path,
          payload: inv.payload,
          operationName: req.operationName ?? `call ${req.endpoint}`,
          copilotToken: this.copilotToken,
          accountType: this.accountType,
          baseUrl: this.baseUrl,
          timeout: req.timeout,
          extraHeaders: inv.headers,
          requireModel,
          fetcher: this.fetcher,
        }),
      ),
    )
    return { status: response.status, headers: response.headers, body: response.body }
  }

  /**
   * Run `op`, and if the upstream rejects the session token, re-exchange it and
   * run `op` exactly once more.
   *
   * 403 is treated as an auth failure alongside 401 because that is what a
   * revoked Copilot session actually returns ("apiKey is valid but lacks
   * permission for this resource"). 403 is ambiguous — a model the tenant is
   * not entitled to answers the same way — so the cost of guessing wrong is
   * bounded on both sides: the token cache rate-limits the exchange itself, and
   * when it declines to issue a new token (cooldown) the unchanged token tells
   * us to give up rather than repeat a request that will fail identically.
   */
  private async withAuthRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op()
    } catch (err) {
      if (!this.refreshSession || !isAuthRejection(err)) throw err

      const staleToken = this.copilotToken
      let refreshed: { token: string; baseUrl?: string }
      try {
        refreshed = await this.refreshSession()
      } catch {
        // Surface the upstream's rejection, not the refresh failure: the former
        // is what the caller actually needs to see.
        throw err
      }
      if (refreshed.token === staleToken) throw err

      // The variant catalog is keyed by session token; drop the dead entry so
      // the next request refetches it instead of inheriting a 403-poisoned miss.
      invalidateRawModelsForToken(staleToken, this.accountType, this.baseUrl)
      this.copilotToken = refreshed.token
      if (refreshed.baseUrl) this.baseUrl = refreshed.baseUrl
      return await op()
    }
  }

  private interceptorsFor(endpoint: EndpointKey): readonly CopilotInterceptor[] {
    switch (endpoint) {
      case 'messages': return this.messagesChain
      case 'messages_count_tokens': return this.messagesCountTokensChain
      case 'responses': return this.responsesChain
      case 'chat_completions': return this.chatCompletionsChain
      case 'embeddings': return this.embeddingsChain
      default: return []
    }
  }
}

function mapSourceApi(src: SourceApi): 'messages' | 'chat_completions' | 'responses' | 'gemini' {
  if (src === 'anthropic') return 'messages'
  if (src === 'openai') return 'chat_completions'
  return src
}

/** Both callCopilotAPI (forward.ts) and getRawModels (models.ts) report a
 *  non-2xx as an HTTPError carrying the upstream Response, so one check covers
 *  the inference and catalog paths alike. */
function isAuthRejection(err: unknown): boolean {
  if (!(err instanceof HTTPError)) return false
  const status = err.response.status
  return status === 401 || status === 403
}
