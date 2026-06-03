/**
 * Provider abstraction — aligned with old src/providers/types.ts contract.
 *
 * ModelProvider.fetch(endpoint, init, opts) is the single dispatch entry; per-plan
 * "不改 ModelProvider.fetch 签名（已经正确）" the vNext shape mirrors the old project.
 */
import type { EndpointKey, UpstreamKind } from '@vnext/protocols/common'
import type { ModelsResponse } from '../services/copilot/models.ts'

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
  sourceApi?: 'messages' | 'chat_completions' | 'responses'
  /** Pre-resolved flag set (defaults + overrides). Providers fall back to their kind catalog. */
  enabledFlags?: ReadonlySet<string>
}

export interface ProbeResult {
  ok: boolean
  status?: number
  modelCount?: number
  models?: string[]
  error?: string
  hint?: string
}

export interface ModelProvider {
  readonly kind: UpstreamKind
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  getModels(): Promise<ModelsResponse>
  probe(): Promise<ProbeResult>
  fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>
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

  async getModels(): Promise<ModelsResponse> {
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
