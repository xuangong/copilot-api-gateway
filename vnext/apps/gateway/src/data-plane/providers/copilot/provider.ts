/**
 * CopilotProvider — Week 3d scaffold.
 *
 * Ports the dispatcher shape from old src/providers/copilot/provider.ts
 * verbatim: per-endpoint interceptor chains feed into runInterceptors,
 * whose terminal is callCopilotAPI.
 *
 * Interceptor chains are EMPTY at this scaffold stage. Each per-endpoint
 * payload interceptor (~22 files, ~420 LOC) is its own follow-up granular
 * task in Week 4 — porting them in one shot would mix unrelated transforms
 * with the contract migration and lose review granularity.
 */
import type { AccountType } from '../../../shared/config/constants.ts'
import { defaultsForUpstream } from '../../flags/catalog.ts'
import { callCopilotAPI } from '../../services/copilot/forward.ts'
import { getModels, type ModelsResponse } from '../../services/copilot/models.ts'
import type { EndpointKey } from '@vnext/protocols/common'
import type { CopilotInterceptor, Invocation, RequestContext } from "@vnext/interceptor"
import { runInterceptors } from "@vnext/interceptor"
import type { ModelProvider, ProbeResult, ProviderFetchOptions } from '../types.ts'
import { probeViaModels } from '../probe.ts'
import { createVariantAndBetaFilteringInterceptor } from './interceptors/shared/with-variant-and-beta-filtering.ts'
import { withInitiatorHeader } from './interceptors/shared/with-initiator-header.ts'
import { messagesPayloadInterceptors } from './interceptors/messages/index.ts'
import { responsesPayloadInterceptors } from './interceptors/responses/index.ts'
import { chatCompletionsPayloadInterceptors } from './interceptors/chat-completions/index.ts'
import { embeddingsPayloadInterceptors } from './interceptors/embeddings/index.ts'

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

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') {
    throw new Error('CopilotProvider.fetch: body must be a JSON string')
  }
  return JSON.parse(body) as Record<string, unknown>
}

function mergeHeaders(
  initHeaders: HeadersInit | undefined,
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
