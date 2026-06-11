/**
 * Backend adapter: IR → upstream Chat Completions (and back). Plan 1 minimum:
 * covers input_text / output_text / tool_use / tool_result. Wider IR coverage
 * (input_image, reasoning, opaque) and Claude-special fields are Plan 3 scope.
 */
import type { BackendAdapter } from '@vnext/translate/contract'
import type { IRRequest, IREvent, IRMessage, IRContentItem } from '@vnext/protocols/ir'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function messageText(content: IRContentItem[]): string {
  let out = ''
  for (const c of content) {
    if (c.type === 'input_text' || c.type === 'output_text') out += c.text
  }
  return out
}

function toChatMessages(messages: IRMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const toolCalls = m.content
      .filter((c): c is Extract<IRContentItem, { type: 'tool_use' }> => c.type === 'tool_use')
      .map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: {
          name: c.name,
          arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
        },
      }))
    const toolResults = m.content.filter((c): c is Extract<IRContentItem, { type: 'tool_result' }> => c.type === 'tool_result')
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const text = typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? '')
        out.push({ role: 'tool', content: text, tool_call_id: tr.tool_use_id })
      }
      continue
    }
    if (toolCalls.length > 0) {
      const text = messageText(m.content)
      out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls })
      continue
    }
    out.push({ role: m.role, content: messageText(m.content) })
  }
  return out
}

function translateToolChoice(tc: IRRequest['tool_choice']): unknown {
  if (tc === undefined) return undefined
  if (typeof tc === 'string') return tc
  return { type: 'function', function: { name: tc.name } }
}

export const chatOut: BackendAdapter = {
  toUpstream(req: IRRequest) {
    return {
      model: req.model,
      stream: req.stream,
      messages: toChatMessages(req.messages),
      max_tokens: req.max_output_tokens,
      temperature: req.temperature,
      top_p: req.top_p,
      tools: req.tools?.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: translateToolChoice(req.tool_choice),
      parallel_tool_calls: req.parallel_tool_calls,
    }
  },
  async *decodeSSE(): AsyncIterable<IREvent> {
    throw new Error('chatOut.decodeSSE: not implemented (Task 5)')
  },
  async *decodeBody(body: unknown): AsyncIterable<IREvent> {
    const r = body as {
      id?: string
      choices?: Array<{
        message?: { role?: string; content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
        finish_reason?: string
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    yield { type: 'response.created', response: { id: r.id ?? '' } }
    const choice = r.choices?.[0]
    const msg = choice?.message
    if (msg?.content && typeof msg.content === 'string') {
      yield { type: 'response.output_text.delta', delta: msg.content }
    }
    for (const tc of msg?.tool_calls ?? []) {
      if (!tc.function) continue
      let parsed: unknown = {}
      try { parsed = JSON.parse(tc.function.arguments) } catch { parsed = tc.function.arguments }
      yield {
        type: 'response.tool_call.completed',
        itemId: tc.id,
        name: tc.function.name,
        arguments: parsed,
      }
    }
    yield {
      type: 'response.completed',
      response: {
        id: r.id,
        finish_reason: choice?.finish_reason ?? 'stop',
        usage: r.usage ? {
          input_tokens: r.usage.prompt_tokens ?? 0,
          output_tokens: r.usage.completion_tokens ?? 0,
        } : undefined,
      },
    }
  },
}
