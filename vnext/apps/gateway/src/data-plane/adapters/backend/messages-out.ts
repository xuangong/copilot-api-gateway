/**
 * Backend adapter: IR → upstream Anthropic Messages (and back). Plan 1 minimum:
 * input_text / output_text / tool_use / tool_result. Plan 3 adds thinking and
 * citations round-trip.
 */
import type { BackendAdapter } from '@vnext/translate/contract'
import type { IRRequest, IREvent, IRMessage, IRContentItem } from '@vnext/protocols/ir'

interface AnthropicBlock { type: string; [k: string]: unknown }
interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicBlock[] }

function blocksFor(content: IRContentItem[]): AnthropicBlock[] {
  const out: AnthropicBlock[] = []
  for (const c of content) {
    if (c.type === 'input_text' || c.type === 'output_text') {
      out.push({ type: 'text', text: c.text })
    } else if (c.type === 'tool_use') {
      out.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} })
    } else if (c.type === 'tool_result') {
      const text = typeof c.output === 'string' ? c.output : JSON.stringify(c.output ?? '')
      out.push({ type: 'tool_result', tool_use_id: c.tool_use_id, content: text })
    }
  }
  return out
}

function toAnthropicMessages(messages: IRMessage[]): { system: string; messages: AnthropicMessage[] } {
  const sys: string[] = []
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      sys.push(typeof m.content === 'string' ? m.content : blocksFor(m.content).map((b) => (b.type === 'text' ? (b.text as string) : '')).join(''))
      continue
    }
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user'
    const content = typeof m.content === 'string'
      ? [{ type: 'text', text: m.content } as AnthropicBlock]
      : blocksFor(m.content)
    out.push({ role, content })
  }
  return { system: sys.join('\n\n'), messages: out }
}

function translateToolChoice(tc: IRRequest['tool_choice']): unknown {
  if (tc === undefined) return undefined
  if (tc === 'auto' || tc === 'none') return { type: tc }
  if (tc === 'required') return { type: 'any' }
  return { type: 'tool', name: tc.name }
}

export const messagesOut: BackendAdapter = {
  toUpstream(req: IRRequest) {
    const { system, messages } = toAnthropicMessages(req.messages)
    return {
      model: req.model,
      max_tokens: req.max_output_tokens ?? 4096,
      stream: req.stream,
      temperature: req.temperature,
      top_p: req.top_p,
      system: system || undefined,
      messages,
      tools: req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      tool_choice: translateToolChoice(req.tool_choice),
    }
  },
  async *decodeSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<IREvent> {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let respId = ''
    let createdEmitted = false
    let finishReason = 'stop'
    let inputTokens = 0
    let outputTokens = 0
    const blocks = new Map<number, { kind: 'text' | 'tool_use'; toolId?: string; toolName?: string; jsonBuf?: string }>()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const f of frames) {
        const dataLines = f.split('\n').filter((ln) => ln.startsWith('data:'))
        if (dataLines.length === 0) continue
        const data = dataLines.map((ln) => ln.slice(5).trim()).join('')
        if (!data) continue
        let evt: {
          type?: string
          message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } }
          index?: number
          content_block?: { type?: string; id?: string; name?: string }
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
          usage?: { output_tokens?: number }
        }
        try { evt = JSON.parse(data) } catch { continue }
        if (evt.type === 'message_start') {
          respId = evt.message?.id ?? ''
          if (evt.message?.usage?.input_tokens) inputTokens = evt.message.usage.input_tokens
          if (!createdEmitted) {
            yield { type: 'response.created', response: { id: respId } }
            createdEmitted = true
          }
        } else if (evt.type === 'content_block_start' && typeof evt.index === 'number') {
          const cb = evt.content_block
          if (cb?.type === 'tool_use') {
            blocks.set(evt.index, { kind: 'tool_use', toolId: cb.id, toolName: cb.name, jsonBuf: '' })
          } else {
            blocks.set(evt.index, { kind: 'text' })
          }
        } else if (evt.type === 'content_block_delta' && typeof evt.index === 'number') {
          const slot = blocks.get(evt.index)
          if (!slot) continue
          if (evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
            yield { type: 'response.output_text.delta', delta: evt.delta.text }
          } else if (evt.delta?.type === 'input_json_delta' && typeof evt.delta.partial_json === 'string') {
            slot.jsonBuf = (slot.jsonBuf ?? '') + evt.delta.partial_json
          }
        } else if (evt.type === 'content_block_stop' && typeof evt.index === 'number') {
          const slot = blocks.get(evt.index)
          if (slot?.kind === 'tool_use') {
            let parsed: unknown = {}
            try { parsed = JSON.parse(slot.jsonBuf ?? '{}') } catch { parsed = slot.jsonBuf ?? '' }
            yield {
              type: 'response.tool_call.completed',
              itemId: slot.toolId ?? '',
              name: slot.toolName ?? '',
              arguments: parsed,
            }
          }
        } else if (evt.type === 'message_delta') {
          if (evt.delta?.stop_reason) finishReason = evt.delta.stop_reason
          if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens
        }
      }
    }
    yield {
      type: 'response.completed',
      response: {
        id: respId,
        finish_reason: finishReason,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    }
  },
  async *decodeBody(body: unknown): AsyncIterable<IREvent> {
    const r = body as {
      id?: string
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
      stop_reason?: string
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    yield { type: 'response.created', response: { id: r.id ?? '' } }
    for (const block of r.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        yield { type: 'response.output_text.delta', delta: block.text }
      } else if (block.type === 'tool_use') {
        yield {
          type: 'response.tool_call.completed',
          itemId: block.id ?? '',
          name: block.name ?? '',
          arguments: block.input ?? {},
        }
      }
    }
    yield {
      type: 'response.completed',
      response: {
        id: r.id,
        finish_reason: r.stop_reason ?? 'stop',
        usage: r.usage ? {
          input_tokens: r.usage.input_tokens ?? 0,
          output_tokens: r.usage.output_tokens ?? 0,
        } : undefined,
      },
    }
  },
}
