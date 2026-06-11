/**
 * CopilotProvider — extracted to @vnext/provider-copilot in Plan 2c.
 *
 * Ports the dispatcher shape from the original gateway location verbatim:
 * per-endpoint interceptor chains feed into runInterceptors, whose terminal
 * is callCopilotAPI. All Copilot-specific imports now point at package-local
 * modules; cross-package contracts (@vnext/interceptor, @vnext/provider,
 * @vnext/protocols) are unchanged.
 */
import type { AccountType } from './account-type'
import { defaultsForUpstream } from './flags'
import { callCopilotAPI } from './forward'
import { getModels, type ModelsResponse } from './models'
import type { EndpointKey } from '@vnext/protocols/common'
import type { CopilotInterceptor, Invocation, RequestContext } from "@vnext/interceptor"
import { runInterceptors } from "@vnext/interceptor"
import type { ModelProvider, ProbeResult, ProviderFetchOptions } from '@vnext/provider'
import { probeViaModels } from '@vnext/provider'
import { createVariantAndBetaFilteringInterceptor } from './interceptors/shared/with-variant-and-beta-filtering'
import { withInitiatorHeader } from './interceptors/shared/with-initiator-header'
import { messagesPayloadInterceptors } from './interceptors/messages'
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

export class CopilotProvider implements ModelProvider {
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
    this.messagesChain = [variantFiltering, withInitiatorHeader, ...messagesPayloadInterceptors]
    this.messagesCountTokensChain = [variantFiltering, withInitiatorHeader, ...messagesPayloadInterceptors]
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

  async fetch(endpoint: EndpointKey, init: RequestInit, opts: ProviderFetchOptions = {}): Promise<Response> {
    const path = COPILOT_PATHS[endpoint]
    if (!path) throw new Error(`CopilotProvider does not support endpoint: ${endpoint}`)

    const inv: Invocation = {
      endpoint,
      enabledFlags: opts.enabledFlags ?? defaultsForUpstream('copilot'),
      sourceApi: opts.sourceApi,
      payload: parseJsonBody(init.body),
      headers: mergeHeaders(init.headers, opts.extraHeaders),
    }
    const ctx: RequestContext = {
      requestStartedAt: Date.now(),
      downstreamAbortSignal: init.signal ?? undefined,
    }

    const interceptors = this.interceptorsFor(endpoint)
    const requireModel = opts.requireModel ?? endpoint !== 'messages_count_tokens'

    return runInterceptors(inv, ctx, interceptors, () =>
      callCopilotAPI({
        endpoint: path,
        payload: inv.payload,
        operationName: opts.operationName ?? `call ${endpoint}`,
        copilotToken: this.copilotToken,
        accountType: this.accountType,
        timeout: opts.timeout,
        extraHeaders: inv.headers,
        requireModel,
      }),
    )
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

function parseJsonBody(body: RequestInit['body'] | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') {
    throw new Error('CopilotProvider.fetch: body must be a JSON string')
  }
  return JSON.parse(body) as Record<string, unknown>
}

function mergeHeaders(
  initHeaders: RequestInit['headers'] | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (initHeaders) {
    const h = new Headers(initHeaders)
    h.forEach((v, k) => { out[k] = v })
  }
  if (extra) Object.assign(out, extra)
  return out
}
