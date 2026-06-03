/**
 * OpenAI Responses ↔ IR (skeleton — Responses is IR's superset so this is mostly pass-through).
 */
import type { IRRequest, IREvent, IRMessage, IRContentItem } from '@vnext/protocols/ir'
import type { ResponsesPayload } from '@vnext/protocols/responses'

export function responsesToIR(payload: ResponsesPayload): IRRequest {
  const messages: IRMessage[] = []
  if (payload.instructions) {
    messages.push({ role: 'system', content: payload.instructions })
  }
  const input = payload.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: [{ type: 'input_text', text: input }] })
  } else {
    for (const item of input) {
      if ('type' in item && item.type === 'message' && 'role' in item) {
        const m = item as { role: 'user' | 'assistant' | 'system' | 'developer'; content: string | unknown[] }
        const role = m.role === 'developer' ? 'system' : m.role
        if (typeof m.content === 'string') {
          messages.push({ role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: m.content }] })
        } else {
          const items: IRContentItem[] = []
          for (const c of m.content) {
            const cc = c as { type: string; text?: string; image_url?: string }
            if (cc.type === 'input_text') items.push({ type: 'input_text', text: cc.text ?? '' })
            else if (cc.type === 'output_text') items.push({ type: 'output_text', text: cc.text ?? '' })
            else if (cc.type === 'input_image' && cc.image_url) items.push({ type: 'input_image', image_url: cc.image_url })
          }
          messages.push({ role, content: items })
        }
      }
      // function_call / function_call_output / reasoning preserved opaque for Week 3 skeleton
    }
  }
  const tools: Array<{ type: 'function' | 'web_search' | 'image_generation' | 'code_interpreter'; name: string; description?: string; parameters?: unknown; strict?: boolean }> = []
  for (const t of payload.tools ?? []) {
    const tt = t as { type: string; name?: string; description?: string; parameters?: unknown; strict?: boolean }
    if (tt.type === 'function' && tt.name) {
      tools.push({ type: 'function', name: tt.name, description: tt.description, parameters: tt.parameters, strict: tt.strict })
    } else if (tt.type === 'web_search' || tt.type === 'image_generation' || tt.type === 'code_interpreter') {
      tools.push({ type: tt.type, name: tt.type })
    }
  }
  return {
    model: payload.model,
    messages,
    tools: tools.length ? tools : undefined,
    max_output_tokens: payload.max_output_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stream: payload.stream ?? false,
    previous_response_id: payload.previous_response_id,
    parallel_tool_calls: payload.parallel_tool_calls,
    rawClientPayload: payload,
    meta: { flags: {}, binding: null, iteration: 0, privateState: {}, clientProtocol: 'responses' },
  }
}

/** Responses SSE is just IR events tagged with `type`. */
export function* irToResponsesSSE(events: Iterable<IREvent>): Generator<{ event: string; data: unknown }> {
  for (const e of events) {
    if (e.type.startsWith('orchestrator.')) continue
    yield { event: e.type, data: e }
  }
}

export function irToResponsesBody(events: Iterable<IREvent>): unknown {
  let id = ''
  let text = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  const toolItems: unknown[] = []
  for (const e of events) {
    if (e.type === 'response.created') id = e.response.id
    else if (e.type === 'response.output_text.delta') text += e.delta
    else if (e.type === 'response.tool_call.completed') {
      toolItems.push({ type: 'function_call', call_id: e.itemId, name: e.name, arguments: JSON.stringify(e.arguments ?? {}) })
    } else if (e.type === 'response.completed') {
      if (e.response.usage) usage = { input_tokens: e.response.usage.input_tokens, output_tokens: e.response.usage.output_tokens }
    }
  }
  const output: unknown[] = []
  if (text) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const t of toolItems) output.push(t)
  return {
    id: id || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: '',
    output,
    output_text: text,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens },
  }
}
