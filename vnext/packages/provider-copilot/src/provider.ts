/**
 * CopilotProvider — extracted to @vnext/provider-copilot in Plan 2c.
 *
 * Ports the dispatcher shape from the original gateway location verbatim:
 * per-endpoint interceptor chains feed into runInterceptors, whose terminal
 * is callCopilotAPI. All Copilot-specific imports now point at package-local
 * modules; cross-package contracts (@vnext/interceptor, @vnext/provider,
 * @vnext/protocols) are unchanged.
 *
 * Phase A Task 2 (X-2) added per-endpoint `call*` methods. They sit alongside
 * the existing `fetch()` (untouched, Phase B retires its callers) and return
 * UpstreamResponse — a discriminated union over streaming/non-streaming/error
 * — instead of a raw `Response`. The methods delegate to `this.fetch()` so
 * the interceptor chain and forward path are reused as-is.
 */
import type { AccountType } from './account-type'
import { defaultsForUpstream } from './flags'
import { callCopilotAPI } from './forward'
import { HTTPError } from './lib/error'
import { getModels, type ModelsResponse } from './models'
import { pricingForCopilotModelKey } from './pricing'
import type { EndpointKey, ModelPricing } from '@vnext/protocols/common'
import type { CopilotInterceptor, Invocation, RequestContext } from "@vnext/interceptor"
import { runInterceptors } from "@vnext/interceptor"
import type {
  ModelProvider,
  PerEndpointCallOptions,
  ProbeResult,
  ProviderFetchOptions,
  UpstreamResponse,
} from '@vnext/provider'
import { probeViaModels } from '@vnext/provider'
import { parseJsonBody, mergeHeaders } from '@vnext/shared-http'
import type { MessagesEvent } from '@vnext/protocols/messages'
import { createVariantAndBetaFilteringInterceptor } from './interceptors/shared/with-variant-and-beta-filtering'
import { withInitiatorHeader } from './interceptors/shared/with-initiator-header'
import { messagesPayloadInterceptors } from './interceptors/messages'
import { messagesCountTokensPayloadInterceptors } from './interceptors/messages-count-tokens'
import { responsesPayloadInterceptors } from './interceptors/responses'
import { chatCompletionsPayloadInterceptors } from './interceptors/chat-completions'
import { embeddingsPayloadInterceptors } from './interceptors/embeddings'
import { parseSSEStream } from './parse/messages-sse'
import { parseChatSSEStream } from './parse/chat-sse'
import { parseResponsesSSEStream } from './parse/responses-sse'

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
    this.messagesCountTokensChain = [variantFiltering, withInitiatorHeader, ...messagesCountTokensPayloadInterceptors]
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

  // ── per-endpoint call* methods (Phase A Task 2) ────────────────────────────

  callMessages(
    payload: unknown,
    opts: PerEndpointCallOptions = {},
  ): Promise<UpstreamResponse<MessagesEvent>> {
    return this.callImpl<MessagesEvent>(
      'messages',
      payload,
      opts,
      'stream',
      (body, signal) => parseSSEStream(body, signal),
    )
  }

  callMessagesCountTokens(
    payload: unknown,
    opts: PerEndpointCallOptions = {},
  ): Promise<UpstreamResponse<never>> {
    return this.callImpl<never>('messages_count_tokens', payload, opts, 'never', null)
  }

  callChatCompletions(
    payload: unknown,
    opts: PerEndpointCallOptions = {},
  ): Promise<UpstreamResponse<unknown>> {
    return this.callImpl<unknown>(
      'chat_completions',
      payload,
      opts,
      'stream',
      (body, signal) => parseChatSSEStream(body, signal),
    )
  }

  callResponses(
    payload: unknown,
    opts: PerEndpointCallOptions = {},
  ): Promise<UpstreamResponse<unknown>> {
    return this.callImpl<unknown>(
      'responses',
      payload,
      opts,
      'stream',
      (body, signal) => parseResponsesSSEStream(body, signal),
    )
  }

  callEmbeddings(
    payload: unknown,
    opts: PerEndpointCallOptions = {},
  ): Promise<UpstreamResponse<never>> {
    return this.callImpl<never>('embeddings', payload, opts, 'never', null)
  }

  callImagesGenerations(
    payload: unknown,
    opts: PerEndpointCallOptions = {},
  ): Promise<UpstreamResponse<never>> {
    return this.callImpl<never>('images_generations', payload, opts, 'never', null)
  }

  callImagesEdits(
    payload: unknown,
    opts: PerEndpointCallOptions = {},
  ): Promise<UpstreamResponse<never>> {
    return this.callImpl<never>('images_edits', payload, opts, 'never', null)
  }

  // ── shared call* implementation ────────────────────────────────────────────

  /**
   * Wraps `this.fetch()` and produces an UpstreamResponse:
   *   - HTTPError (4xx/5xx) → ok:false
   *   - unsupported endpoint or other Error → ok:false with synthesized 501
   *   - streaming (payload.stream===true && parser provided) → ok:true, AsyncIterable
   *   - otherwise → ok:true, parsed JSON body
   *
   * The interceptor chain runs inside `this.fetch`, so payload normalization
   * happens identically to the legacy path. `extraHeaders` carries the
   * `anthropic-beta` header (for callMessages) when set.
   */
  private async callImpl<TStream>(
    endpoint: EndpointKey,
    payload: unknown,
    opts: PerEndpointCallOptions,
    streamMode: 'stream' | 'never',
    parser:
      | ((body: ReadableStream<Uint8Array> | null, signal?: AbortSignal) => AsyncIterable<TStream>)
      | null,
  ): Promise<UpstreamResponse<TStream>> {
    const isStreaming = streamMode === 'stream' && readsStream(payload)
    const extraHeaders = buildExtraHeaders(opts)

    let res: Response
    try {
      res = await this.fetch(
        endpoint,
        { body: JSON.stringify(payload ?? {}), signal: opts.signal },
        {
          enabledFlags: opts.enabledFlags,
          sourceApi: opts.sourceApi,
          extraHeaders,
          operationName: opts.operationName,
        },
      )
    } catch (err) {
      if (err instanceof HTTPError) {
        return { ok: false, status: err.response.status, error: err }
      }
      // Unsupported endpoint, missing token, etc. — synthesize a 501-like error.
      const message = err instanceof Error ? err.message : String(err)
      const synthetic = new Response(JSON.stringify({ error: { message } }), {
        status: 501,
        headers: { 'content-type': 'application/json' },
      })
      return {
        ok: false,
        status: 501,
        error: new HTTPError(`CopilotProvider call ${endpoint} failed: ${message}`, synthetic),
      }
    }

    if (!res.ok) {
      // Defensive: callCopilotAPI throws on !ok; this branch is for any future
      // path that returns a non-ok Response without throwing.
      return {
        ok: false,
        status: res.status,
        error: new HTTPError(`CopilotProvider call ${endpoint} failed: ${res.status}`, res),
      }
    }

    if (isStreaming && parser) {
      return {
        ok: true,
        status: res.status,
        stream: true,
        body: parser(res.body, opts.signal),
        headers: res.headers,
      }
    }

    const body = await res.json() as TStream
    return {
      ok: true,
      status: res.status,
      stream: false,
      body,
      headers: res.headers,
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

function readsStream(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { stream?: unknown }).stream === true
}

function buildExtraHeaders(opts: PerEndpointCallOptions): Record<string, string> | undefined {
  const merged: Record<string, string> = { ...(opts.extraHeaders ?? {}) }
  if (opts.anthropicBeta) merged['anthropic-beta'] = opts.anthropicBeta
  return Object.keys(merged).length > 0 ? merged : undefined
}
