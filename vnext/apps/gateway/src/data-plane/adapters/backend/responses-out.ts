/** Backend adapter: IR ↔ upstream Responses API. Skeleton: emit IR events directly. */
import type { BackendAdapter } from '@vnext/translate/contract'
import type { IRRequest, IREvent } from '@vnext/protocols/ir'

export const responsesOut: BackendAdapter = {
  toUpstream(req: IRRequest) {
    // Skeleton: map IR messages to Responses input items. Not wire-faithful yet.
    const input: unknown[] = []
    for (const m of req.messages) {
      if (m.role === 'system') {
        input.push({ type: 'message', role: 'system', content: typeof m.content === 'string' ? m.content : '' })
      } else if (typeof m.content === 'string') {
        input.push({ type: 'message', role: m.role, content: [{ type: 'input_text', text: m.content }] })
      } else {
        const parts: unknown[] = []
        for (const c of m.content) {
          if (c.type === 'input_text' || c.type === 'output_text') {
            parts.push({ type: 'input_text', text: c.text })
          } else if (c.type === 'input_image') {
            parts.push({ type: 'input_image', image_url: c.image_url })
          }
        }
        input.push({ type: 'message', role: m.role, content: parts })
      }
    }
    return {
      model: req.model,
      input,
      stream: req.stream,
      max_output_tokens: req.max_output_tokens,
      temperature: req.temperature,
      top_p: req.top_p,
      tools: req.tools?.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }
  },
  async *decodeSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<IREvent> {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const f of frames) {
        const lines = f.split('\n')
        let eventName = ''
        let data = ''
        for (const ln of lines) {
          if (ln.startsWith('event:')) eventName = ln.slice(6).trim()
          else if (ln.startsWith('data:')) data += ln.slice(5).trim()
        }
        if (!data || data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data) as { type?: string; [k: string]: unknown }
          const t = parsed.type ?? eventName
          if (t === 'response.created' || t === 'response.output_text.delta' || t === 'response.completed' || t === 'response.error') {
            yield parsed as unknown as IREvent
          }
        } catch {
          // ignore malformed frame
        }
      }
    }
  },
  async *decodeBody(body: unknown): AsyncIterable<IREvent> {
    const r = body as { id?: string; output_text?: string; output?: unknown[]; usage?: { input_tokens?: number; output_tokens?: number } }
    yield { type: 'response.created', response: { id: r.id ?? '' } }
    if (typeof r.output_text === 'string' && r.output_text) {
      yield { type: 'response.output_text.delta', delta: r.output_text }
    }
    yield {
      type: 'response.completed',
      response: {
        id: r.id,
        usage: r.usage ? { input_tokens: r.usage.input_tokens ?? 0, output_tokens: r.usage.output_tokens ?? 0 } : undefined,
        finish_reason: 'stop',
      },
    }
  },
}
