/**
 * OpenAI Chat Completions ↔ IR (skeleton).
 * Round-trips text + tool_calls via Responses upstream for the FakeProvider gate.
 * Wire-level parity with src/translators/chat-completions-via-responses lands later.
 */
import type { IRRequest, IREvent, IRMessage, IRContentItem } from '@vnext/protocols/ir'
import type { ChatPayload } from '@vnext/protocols/chat'

export function chatToIR(payload: ChatPayload): IRRequest {
  const messages: IRMessage[] = []
  for (const m of payload.messages) {
    const role = m.role === 'developer' ? 'system' : m.role
    if (m.content == null && m.tool_calls?.length) {
      const items: IRContentItem[] = m.tool_calls.map((tc) => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        arguments: safeJson(tc.function.arguments),
      }))
      messages.push({ role, content: items })
      continue
    }
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : ''
      messages.push({
        role: 'tool',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', output: text }],
      })
      continue
    }
    if (typeof m.content === 'string') {
      messages.push({ role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: m.content }] })
    } else if (Array.isArray(m.content)) {
      const items: IRContentItem[] = []
      for (const p of m.content) {
        if ('type' in p && p.type === 'text') items.push({ type: 'input_text', text: p.text })
        else if ('type' in p && p.type === 'image_url') {
          const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url
          items.push({ type: 'input_image', image_url: url })
        }
      }
      messages.push({ role, content: items })
    } else {
      messages.push({ role, content: [] })
    }
  }
  return {
    model: payload.model,
    messages,
    tools: payload.tools?.map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      strict: t.function.strict,
    })),
    max_output_tokens: payload.max_completion_tokens ?? payload.max_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stream: payload.stream ?? false,
    parallel_tool_calls: payload.parallel_tool_calls,
    rawClientPayload: payload,
    meta: { flags: {}, binding: null, iteration: 0, privateState: {}, clientProtocol: 'chat' },
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}

export type ChatSSEChunk = {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: { role?: 'assistant'; content?: string; tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }> }
    finish_reason: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export function* irToChatSSE(events: Iterable<IREvent>): Generator<ChatSSEChunk> {
  let id = ''
  let started = false
  const created = Math.floor(Date.now() / 1000)
  let toolIndex = -1
  for (const e of events) {
    if (e.type === 'response.created') id = e.response.id || `chatcmpl_${Date.now()}`
    else if (e.type === 'response.output_text.delta') {
      if (!started) {
        started = true
        yield baseChunk(id, created, { role: 'assistant', content: '' }, null)
      }
      yield baseChunk(id, created, { content: e.delta }, null)
    } else if (e.type === 'response.tool_call.completed') {
      toolIndex += 1
      yield baseChunk(id, created, {
        tool_calls: [{
          index: toolIndex,
          id: e.itemId,
          type: 'function',
          function: { name: e.name, arguments: JSON.stringify(e.arguments ?? {}) },
        }],
      }, null)
    } else if (e.type === 'response.completed') {
      yield baseChunk(id, created, {}, mapStop(e.response.finish_reason))
      if (e.response.usage) {
        yield {
          ...baseChunk(id, created, {}, null),
          usage: {
            prompt_tokens: e.response.usage.input_tokens,
            completion_tokens: e.response.usage.output_tokens,
            total_tokens: e.response.usage.input_tokens + e.response.usage.output_tokens,
          },
        }
      }
    }
  }
}

function baseChunk(id: string, created: number, delta: ChatSSEChunk['choices'][number]['delta'], finish: string | null): ChatSSEChunk {
  return { id, object: 'chat.completion.chunk', created, model: '', choices: [{ index: 0, delta, finish_reason: finish }] }
}

function mapStop(r?: string): string {
  if (!r) return 'stop'
  if (r === 'tool_use' || r === 'tool_calls') return 'tool_calls'
  return r
}

export function irToChatBody(events: Iterable<IREvent>): unknown {
  let id = ''
  let text = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  let stop = 'stop'
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  for (const e of events) {
    if (e.type === 'response.created') id = e.response.id
    else if (e.type === 'response.output_text.delta') text += e.delta
    else if (e.type === 'response.tool_call.completed') {
      toolCalls.push({ id: e.itemId, type: 'function', function: { name: e.name, arguments: JSON.stringify(e.arguments ?? {}) } })
    } else if (e.type === 'response.completed') {
      stop = mapStop(e.response.finish_reason)
      if (e.response.usage) usage = { input_tokens: e.response.usage.input_tokens, output_tokens: e.response.usage.output_tokens }
    }
  }
  return {
    id: id || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: stop,
    }],
    usage: {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    },
  }
}
