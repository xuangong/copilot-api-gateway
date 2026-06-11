/**
 * Provider abstraction — generic ModelProvider contract shared by every
 * upstream adapter (Copilot, Azure, Custom).
 *
 * `ProviderModelsResponse` is a minimal shim; concrete provider packages
 * (`@vnext/provider-copilot` etc.) may return richer subtypes assignable to
 * this shape.
 */
import type { EndpointKey, UpstreamKind } from '@vnext/protocols/common'
import type { MessagesEvent } from '@vnext/protocols/messages'
import type { UpstreamResponse } from './upstream-response'

export type { UpstreamKind }

export interface ProviderCallOptions {
  signal?: AbortSignal
  extraHeaders?: Record<string, string>
  timeout?: number
  operationName?: string
}

export interface ProviderFetchOptions extends ProviderCallOptions {
  /** Defaults to true. count_tokens is the only endpoint where model is optional. */
  requireModel?: boolean
  /** Original client protocol shape — lets providers gate translation-aware transforms. */
  sourceApi?: 'messages' | 'chat_completions' | 'responses' | 'gemini'
  /** Pre-resolved flag set (defaults + overrides). Providers fall back to their kind catalog. */
  enabledFlags?: ReadonlySet<string>
}

/**
 * Per-endpoint call options for the new `call*` methods (Phase A Task 2).
 * Mirrors `ProviderFetchOptions` minus `requireModel` (each method already
 * knows whether model is required) and `timeout` (handled per-method).
 */
export interface PerEndpointCallOptions {
  signal?: AbortSignal
  enabledFlags?: ReadonlySet<string>
  sourceApi?: 'messages' | 'chat_completions' | 'responses' | 'gemini'
  extraHeaders?: Record<string, string>
  operationName?: string
  /** Anthropic-only: forwarded as `anthropic-beta` header. */
  anthropicBeta?: string
}

export interface ProbeResult {
  ok: boolean
  status?: number
  modelCount?: number
  models?: string[]
  error?: string
  hint?: string
}

/** Minimal shape every ModelProvider.getModels must satisfy. */
export interface ProviderModelsResponse {
  object: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Array<any>
}

export interface ModelProvider {
  readonly kind: UpstreamKind
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  getModels(): Promise<ProviderModelsResponse>
  probe(): Promise<ProbeResult>
  fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>

  /**
   * Per-endpoint methods — Phase A Task 2 (X-2). Each is OPTIONAL so existing
   * implementations (`FakeProvider`) keep compiling without churn. New code
   * (Phase B) will prefer these over `fetch()` because the discriminated
   * UpstreamResponse union expresses streaming/non-streaming/error states
   * without exception propagation and without a raw Response wrapper.
   *
   * `payload` is `unknown` because each call-site has already parsed/built
   * its own request shape; the provider just forwards it. Streaming is
   * triggered by `payload.stream === true` (chat/messages/responses).
   */
  callMessages?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<MessagesEvent>>
  callMessagesCountTokens?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<never>>
  callChatCompletions?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<unknown>>
  callResponses?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<unknown>>
  callEmbeddings?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<never>>
  callImagesGenerations?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<never>>
  callImagesEdits?(payload: unknown, opts?: PerEndpointCallOptions): Promise<UpstreamResponse<never>>
}

/** In-memory deterministic provider for tests + dev. Returns synthetic Responses output. */
export class FakeProvider implements ModelProvider {
  readonly kind: UpstreamKind = 'custom'
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[] = ['responses']
  private readonly text: string
  constructor(opts: { name?: string; text?: string } = {}) {
    this.name = opts.name ?? 'fake'
    this.text = opts.text ?? 'Hello from FakeProvider.'
  }

  async getModels(): Promise<ProviderModelsResponse> {
    return {
      object: 'list',
      data: [{
        id: 'fake-model',
        name: 'Fake Model',
        object: 'model',
        vendor: 'fake',
        version: '1',
        preview: false,
        model_picker_enabled: true,
        capabilities: { family: 'fake', limits: {}, object: 'model_capabilities', supports: {}, tokenizer: 'cl100k_base', type: 'chat' },
      }],
    }
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, modelCount: 1, models: ['fake-model'] }
  }

  async fetch(endpoint: EndpointKey, init: RequestInit, _opts: ProviderFetchOptions = {}): Promise<Response> {
    if (endpoint !== 'responses') {
      return new Response(JSON.stringify({ error: { message: `endpoint ${endpoint} not supported by fake` } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    }
    let stream = false
    try {
      const body = JSON.parse((init.body as string) ?? '{}') as { stream?: boolean }
      stream = body.stream === true
    } catch { /* noop */ }
    if (!stream) {
      return Response.json({
        id: 'resp_fake_1',
        object: 'response',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: this.text }] }],
        output_text: this.text,
        usage: { input_tokens: 1, output_tokens: this.text.length },
      })
    }
    const enc = new TextEncoder()
    const text = this.text
    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        const w = (e: string, d: unknown) =>
          controller.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`))
        w('response.created', { type: 'response.created', response: { id: 'resp_fake_1' } })
        for (const ch of text) w('response.output_text.delta', { type: 'response.output_text.delta', delta: ch })
        w('response.completed', {
          type: 'response.completed',
          response: { id: 'resp_fake_1', usage: { input_tokens: 1, output_tokens: text.length }, finish_reason: 'stop' },
        })
        controller.close()
      },
    })
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
  }
}
