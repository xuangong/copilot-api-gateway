/**
 * FakeProvider — in-memory deterministic LlmModelProvider for tests + dev.
 * Returns synthetic Responses output. Extracted from types.ts during Spec 9
 * so the types module stays interface-only.
 */
import type { EndpointKey, ModelPricing, UpstreamKind } from '@vnext-llm/protocols/common'
import type {
  LlmModelProvider,
  ProbeResult,
  ProviderModelsResponse,
  ProviderRequest,
  ProviderResponse,
} from './types'

export class FakeProvider implements LlmModelProvider {
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
