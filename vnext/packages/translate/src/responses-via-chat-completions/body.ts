/**
 * Non-streaming translator: Chat Completion upstream JSON → Responses JSON.
 *
 * Direction: body = hub → client. Maps a single Chat completion into a
 * Responses object. Assistant text becomes a `message` item with one
 * `output_text` part; `tool_calls` become `function_call` items.
 * `finish_reason: 'length'` maps to `status: 'incomplete'` with
 * `incomplete_details.reason: 'max_output_tokens'`; otherwise `completed`.
 * Usage tokens are mapped (`prompt_tokens`/`completion_tokens` →
 * `input_tokens`/`output_tokens`).
 */
interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMessage { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
interface ChatBody {
  id: string
  model?: string
  created?: number
  choices: Array<{ index: number; message: ChatMessage; finish_reason: 'stop' | 'length' | 'tool_calls' | 'function_call' | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface ResponsesOutputItem {
  type: 'message' | 'function_call'
  role?: 'assistant'
  content?: Array<{ type: 'output_text'; text: string }>
  call_id?: string
  name?: string
  arguments?: string
}

interface ResponsesBody {
  id: string
  object: 'response'
  model: string
  created_at: number
  status: 'completed' | 'incomplete'
  incomplete_details?: { reason: string }
  output: ResponsesOutputItem[]
  usage?: { input_tokens: number; output_tokens: number }
}

export function translateChatToResponsesBody(body: unknown): ResponsesBody {
  const c = body as ChatBody
  const choice = c.choices[0]
  const output: ResponsesOutputItem[] = []
  if (choice && typeof choice.message.content === 'string' && choice.message.content.length > 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: choice.message.content }],
    })
  }
  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })
    }
  }

  const status: 'completed' | 'incomplete' = choice?.finish_reason === 'length' ? 'incomplete' : 'completed'
  const out: ResponsesBody = {
    id: c.id,
    object: 'response',
    model: c.model ?? '',
    created_at: c.created ?? Math.floor(Date.now() / 1000),
    status,
    output,
  }
  if (status === 'incomplete') out.incomplete_details = { reason: 'max_output_tokens' }
  if (c.usage) {
    out.usage = {
      input_tokens: c.usage.prompt_tokens ?? 0,
      output_tokens: c.usage.completion_tokens ?? 0,
    }
  }
  return out
}
