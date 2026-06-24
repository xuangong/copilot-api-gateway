/**
 * CopilotProvider — extracted to @vnext-llm/provider-copilot in Plan 2c.
 *
 * Per-endpoint interceptor chains feed into runInterceptors, whose terminal
 * is callCopilotAPI. Cross-package contracts (@vnext-gateway/service,
 * @vnext-llm/protocols) are unchanged.
 *
 * After Plan B Task B2.8, the legacy `fetch(endpoint, init, opts)` overload
 * and the seven per-endpoint `call*` shim methods were retired. The provider
 * now exposes a single `fetch(req: ProviderRequest)` returning a
 * `ProviderResponse` — interceptor mutations happen on `req.payload`
 * directly; the terminal HTTP call serializes the final state.
 */
import type { AccountType } from './account-type'
import { defaultsForUpstream } from './flags'
import { callCopilotAPI } from './forward'
import { getModels, type ModelsResponse } from './models'
import { pricingForCopilotModelKey } from './pricing'
import type { EndpointKey, ModelPricing } from '@vnext-llm/protocols/common'
import type { CopilotInterceptor, Invocation, RequestContext } from "@vnext-llm/protocols/common"
import { runInterceptors } from "@vnext-gateway/service"
import type {
  LlmModelProvider,
  ProbeResult,
  ProviderRequest,
  ProviderResponse,
  SourceApi,
} from '@vnext-llm/provider-llm'
import { probeViaModels } from '@vnext-llm/provider-llm'
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
  private readonly copilotToken: string
  private readonly accountType: AccountType
  private readonly messagesChain: readonly CopilotInterceptor[]
  private readonly messagesCountTokensChain: readonly CopilotInterceptor[]
  private readonly responsesChain: readonly CopilotInterceptor[]
  private readonly chatCompletionsChain: readonly CopilotInterceptor[]
  private readonly embeddingsChain: readonly CopilotInterceptor[]

  constructor(cfg: CopilotProviderConfig) {
    this.copilotToken = cfg.copilotToken
    this.accountType = cfg.accountType
    this.name = cfg.name ?? 'copilot'

    const variantFiltering = createVariantAndBetaFilteringInterceptor(this.copilotToken, this.accountType)
    this.messagesChain = [variantFiltering, withContextManagementBetaAligned, withInitiatorHeader, ...messagesPayloadInterceptors]
    this.messagesCountTokensChain = [variantFiltering, withContextManagementBetaAligned, withInitiatorHeader, ...messagesCountTokensPayloadInterceptors]
    this.responsesChain = [variantFiltering, withInitiatorHeader, ...responsesPayloadInterceptors]
    this.chatCompletionsChain = [variantFiltering, withInitiatorHeader, ...chatCompletionsPayloadInterceptors]
    this.embeddingsChain = embeddingsPayloadInterceptors
  }

  getModels(): Promise<ModelsResponse> {
    return getModels(this.copilotToken, this.accountType)
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
      callCopilotAPI({
        endpoint: path,
        payload: inv.payload,
        operationName: req.operationName ?? `call ${req.endpoint}`,
        copilotToken: this.copilotToken,
        accountType: this.accountType,
        timeout: req.timeout,
        extraHeaders: inv.headers,
        requireModel,
      }),
    )
    return { status: response.status, headers: response.headers, body: response.body }
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
