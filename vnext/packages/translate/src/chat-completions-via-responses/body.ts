/**
 * Non-streaming translator: Responses upstream JSON → Chat Completion JSON.
 *
 * Direction: body = hub → client. Maps a single Responses object into a
 * `chat.completion` shape with one choice. `output_text` parts join into
 * `message.content`; `function_call` items map to `message.tool_calls`.
 * Finish reason: `incomplete_details.reason === 'max_output_tokens'` →
 * `length`; tool calls present → `tool_calls`; else `stop`. Usage tokens
 * are mapped (`input_tokens`/`output_tokens` → `prompt_tokens`/`completion_tokens`).
 */
interface ResponsesOutputItem {
  type: 'message' | 'function_call'
  role?: string
  content?: Array<{ type: string; text?: string }>
  call_id?: string
  name?: string
  arguments?: string
}

interface ResponsesBody {
  id: string
  model?: string
  created_at?: number
  status?: string
  incomplete_details?: { reason?: string }
  output?: ResponsesOutputItem[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: 0
    message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
    finish_reason: 'stop' | 'length' | 'tool_calls'
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export function translateResponsesToChatBody(body: unknown): ChatCompletion {
  const r = body as ResponsesBody
  const text: string[] = []
  const toolCalls: ChatToolCall[] = []
  for (const item of r.output ?? []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'output_text' && typeof part.text === 'string') text.push(part.text)
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? '',
        type: 'function',
        function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
      })
    }
  }

  let finish: 'stop' | 'length' | 'tool_calls' = 'stop'
  if (r.incomplete_details?.reason === 'max_output_tokens') finish = 'length'
  else if (toolCalls.length > 0) finish = 'tool_calls'

  const content = text.length > 0 ? text.join('') : (toolCalls.length > 0 ? null : '')
  const message: ChatCompletion['choices'][number]['message'] = { role: 'assistant', content }
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const out: ChatCompletion = {
    id: r.id,
    object: 'chat.completion',
    created: r.created_at ?? Math.floor(Date.now() / 1000),
    model: r.model ?? '',
    choices: [{ index: 0, message, finish_reason: finish }],
  }
  if (r.usage) {
    const p = r.usage.input_tokens ?? 0
    const c = r.usage.output_tokens ?? 0
    out.usage = { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }
  }
  return out
}
