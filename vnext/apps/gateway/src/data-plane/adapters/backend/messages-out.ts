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
  async *decodeSSE(): AsyncIterable<IREvent> {
    throw new Error('messagesOut.decodeSSE: not implemented (Task 8)')
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
