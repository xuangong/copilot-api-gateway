/**
 * Provider abstraction — generic ModelProvider contract shared by every
 * upstream adapter (Copilot, Azure, Custom).
 *
 * `ProviderModelsResponse` is a minimal shim; concrete provider packages
 * (`@vnext/provider-copilot` etc.) may return richer subtypes assignable to
 * this shape.
 */
import type { EndpointKey, ModelPricing, UpstreamKind } from '@vnext/protocols/common'

export type { UpstreamKind }

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

export type SourceApi = 'anthropic' | 'openai' | 'gemini'

export interface ProviderRequestFlags {
  isStreaming: boolean
  hasWebSearch?: boolean
  hasImageGen?: boolean
}

export interface ProviderRequest {
  endpoint: EndpointKey
  /** Schema-validated JSON object. NOT a string. Interceptors mutate fields directly. */
  payload: unknown
  /** Mutable along the interceptor chain. Terminal HTTP reads the final state. */
  headers: Headers
  sourceApi: SourceApi
  flags?: ProviderRequestFlags
  signal?: AbortSignal
  /** Optional log-friendly label. Defaults to `call ${endpoint}` in the provider. */
  operationName?: string
  /** Defaults to true. Copilot-specific: count_tokens is the only endpoint where model is optional. Other providers ignore this field. */
  requireModel?: boolean
  /** Per-call timeout override in ms. */
  timeout?: number
}

export interface ProviderResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

export interface ModelProvider {
  readonly kind: UpstreamKind
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  getModels(): Promise<ProviderModelsResponse>
  probe(): Promise<ProbeResult>
  fetch(req: ProviderRequest): Promise<ProviderResponse>

  /** Resolve pricing for the given raw upstream model id. Returns null when
   *  this provider doesn't know the price (caller persists null unit_price). */
  getPricingForModelKey(modelKey: string): ModelPricing | null
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

  getPricingForModelKey(_modelKey: string): ModelPricing | null {
    return null
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.endpoint !== 'responses') {
      const body = JSON.stringify({ error: { message: `endpoint ${req.endpoint} not supported by fake` } })
      return {
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: stringToReadableStream(body),
      }
    }
    const payload = (req.payload ?? {}) as { stream?: boolean }
    const isStreaming = payload.stream === true
    if (!isStreaming) {
      const body = JSON.stringify({
        id: 'resp_fake_1',
        object: 'response',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: this.text }] }],
        output_text: this.text,
        usage: { input_tokens: 1, output_tokens: this.text.length },
      })
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: stringToReadableStream(body),
      }
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
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sse,
    }
  }
}

function stringToReadableStream(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(s))
      controller.close()
    },
  })
}
